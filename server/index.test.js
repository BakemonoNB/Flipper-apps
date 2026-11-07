import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LOGS_TOKEN = 'jeton-logs';
process.env.API_TOKEN = 'jeton-api';
process.env.PHONE_TOKEN = 'jeton-tel';
process.env.STATE_DIR = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/fb-test-');
const { server, log } = await import('./index.js');

let base, wsUrl;
before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  base = 'http://127.0.0.1:' + port;
  wsUrl = 'ws://127.0.0.1:' + port + '/ws';
  r();
})));
after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));

const api = (path, opts = {}) => fetch(base + path, {
  ...opts,
  headers: { authorization: 'Bearer jeton-api', 'content-type': 'application/json', ...(opts.headers || {}) },
});

// Faux téléphone : se connecte, s'authentifie, répond aux appels avec `handler`.
function phone(token = 'jeton-tel', handler = (m) => ({ ok: true, result: { tool: m.tool, args: m.args } })) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = { ws, calls: [], closed: null };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'welcome') resolve(t);
      if (m.type === 'call') {
        t.calls.push(m);
        const r = await handler(m);
        if (r) ws.send(JSON.stringify({ type: 'result', id: m.id, ...r }));
      }
    };
    ws.onclose = (ev) => { t.closed = ev.code; resolve(t); };
    ws.onerror = () => {};
    setTimeout(() => reject(new Error('délai dépassé')), 3000);
  });
}
const closedWith = (t) => new Promise((r) => {
  if (t.closed !== null) return r(t.closed);
  t.ws.addEventListener('close', (ev) => r(ev.code));
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('/health répond sans authentification', async () => {
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('/logs : 401 sans jeton, 200 avec LOGS_TOKEN, API_TOKEN ou X-Flipper-Token', async () => {
  log('INFO', 'ligne-test');
  assert.equal((await fetch(base + '/logs')).status, 401);
  assert.equal((await fetch(base + '/logs', { headers: { authorization: 'Bearer faux' } })).status, 401);
  const a = await fetch(base + '/logs?n=5', { headers: { authorization: 'Bearer jeton-logs' } });
  assert.equal(a.status, 200);
  assert.ok((await a.json()).lines.length <= 5);
  assert.equal((await fetch(base + '/logs', { headers: { authorization: 'Bearer jeton-api' } })).status, 200);
  assert.equal((await fetch(base + '/logs', { headers: { 'x-flipper-token': 'jeton-api' } })).status, 200);
});

test('/api : 401 sans jeton, et le jeton du téléphone ne suffit pas', async () => {
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal((await fetch(base + '/api/status', { headers: { authorization: 'Bearer jeton-tel' } })).status, 401);
});

test('/api/call sans téléphone -> 409', async () => {
  const r = await api('/api/call', { method: 'POST', body: JSON.stringify({ tool: 'ping' }) });
  assert.equal(r.status, 409);
});

test('WebSocket : mauvais jeton -> fermeture 4003', async () => {
  const t = await phone('mauvais');
  assert.equal(await closedWith(t), 4003);
});

test('appel de bout en bout : API -> téléphone -> API', async () => {
  const t = await phone();
  assert.equal(t.closed, null);
  t.ws.send(JSON.stringify({ type: 'state', state: { flipper: { connected: true, name: 'Flipper Test', battery: 91 } } }));
  await wait(50);
  const s = await (await api('/api/status')).json();
  assert.deepEqual(s.phone.state, { flipper: { connected: true, name: 'Flipper Test', battery: 91 } });

  const r = await api('/api/call', { method: 'POST', body: JSON.stringify({ tool: 'ping', args: { n: 1 } }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, result: { tool: 'ping', args: { n: 1 } } });
  assert.equal(t.calls.at(-1).origin, 'api');
  await api('/api/call', { method: 'POST', body: JSON.stringify({ tool: 'ping', origin: 'claude' }) });
  assert.equal(t.calls.at(-1).origin, 'claude');
  await api('/api/call', { method: 'POST', body: JSON.stringify({ tool: 'ping', origin: '<script>' }) });
  assert.equal(t.calls.at(-1).origin, 'api');
  t.ws.close();
  await closedWith(t);
});

test('erreur renvoyée par le téléphone', async () => {
  const t = await phone(undefined, () => ({ ok: false, error: 'refusé par l\'utilisateur' }));
  const r = await api('/api/call', { method: 'POST', body: JSON.stringify({ tool: 'write_file' }) });
  assert.deepEqual(await r.json(), { ok: false, error: 'refusé par l\'utilisateur' });
  t.ws.close();
  await closedWith(t);
});

test('nom d\'outil invalide -> 400 ; JSON invalide -> 400', async () => {
  const t = await phone();
  assert.equal((await api('/api/call', { method: 'POST', body: JSON.stringify({ tool: '../x' }) })).status, 400);
  assert.equal((await api('/api/call', { method: 'POST', body: '{pas du json' })).status, 400);
  assert.equal(t.calls.length, 0);
  t.ws.close();
  await closedWith(t);
});

test('nouvelle connexion du téléphone : l\'ancienne est fermée (4000)', async () => {
  const a = await phone();
  const b = await phone();
  assert.equal(await closedWith(a), 4000);
  assert.equal(b.closed, null);
  b.ws.close();
  await closedWith(b);
});

test('téléphone déconnecté pendant un appel -> 502', async () => {
  const t = await phone(undefined, () => null); // ne répond jamais
  const pending = api('/api/call', { method: 'POST', body: JSON.stringify({ tool: 'ping' }) });
  await wait(50);
  t.ws.close();
  assert.equal((await pending).status, 502);
});

test('gros message (longueur sur 64 bits) accepté, message > 1 Mo refusé (1009)', async () => {
  const t = await phone();
  t.ws.send(JSON.stringify({ type: 'state', state: { pad: 'x'.repeat(200000) } }));
  const r = await api('/api/call', { method: 'POST', body: JSON.stringify({ tool: 'ping' }) });
  assert.equal(r.status, 200);
  t.ws.send('x'.repeat((1 << 20) + 10));
  assert.equal(await closedWith(t), 1009);
});

test('route inconnue -> 404', async () => {
  assert.equal((await fetch(base + '/nimporte')).status, 404);
});

// ---- Trames brutes : fragmentation et trame non masquée ----
import net from 'node:net';

function rawFrame(opcode, payload, { fin = true, mask = true } = {}) {
  const p = Buffer.from(payload);
  const head = [((fin ? 0x80 : 0) | opcode), (mask ? 0x80 : 0) | p.length]; // p.length < 126 ici
  const key = Buffer.from([1, 2, 3, 4]);
  const body = mask ? Buffer.from(p.map((b, i) => b ^ key[i & 3])) : p;
  return Buffer.concat([Buffer.from(head), mask ? key : Buffer.alloc(0), body]);
}
function rawConnect() {
  return new Promise((resolve) => {
    const s = net.connect(new URL(base).port, '127.0.0.1', () => {
      s.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = Buffer.alloc(0);
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); s.received = buf; });
    s.once('data', () => resolve(s));
  });
}

test('trames brutes : réponse 101 conforme, message fragmenté accepté', async () => {
  const s = await rawConnect();
  assert.match(s.received.toString(), /101 Switching Protocols[\s\S]*Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  const auth = JSON.stringify({ type: 'auth', token: 'jeton-tel' });
  s.write(rawFrame(0x1, auth.slice(0, 10), { fin: false }));
  s.write(rawFrame(0x0, auth.slice(10)));
  await wait(100);
  assert.match(s.received.toString(), /"type":"welcome"/);
  s.destroy();
});

test('trames brutes : trame non masquée -> fermeture 1002', async () => {
  const s = await rawConnect();
  s.write(rawFrame(0x1, '{"type":"auth"}', { mask: false }));
  await wait(100);
  assert.ok(s.received.includes(Buffer.from([0x88])), 'trame de fermeture attendue');
  assert.ok(s.received.includes(Buffer.from([0x03, 0xea])), 'code 1002 attendu');
  s.destroy();
});
