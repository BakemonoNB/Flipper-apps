import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---- Faux Ollama : 1er appel -> demande l'outil ping ; appel suivant -> texte en deux morceaux ----
const ollamaRequests = [];
const ollama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const r = JSON.parse(body);
    ollamaRequests.push(r);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const line = (o) => res.write(JSON.stringify(o) + '\n');
    const last = r.messages[r.messages.length - 1];
    if (last.role === 'user' && last.content.includes('panne')) {
      res.end(JSON.stringify({ error: 'modèle indisponible' }) + '\n');
      return;
    }
    if (last.role === 'user') {
      const tool = last.content.includes('écran') ? 'get_screen' : 'ping';
      line({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: tool, arguments: {} } }] }, done: false });
      line({ done: true });
    } else {
      line({ message: { role: 'assistant', content: 'Le Flipper ' }, done: false });
      line({ message: { role: 'assistant', content: 'répond. ' + last.content }, done: false });
      line({ done: true });
    }
    res.end();
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));

process.env.PHONE_TOKEN = 'tel';
process.env.API_TOKEN = 'api';
process.env.STATE_DIR = mkdtempSync(tmpdir() + '/fb-chat-');
process.env.OLLAMA_URL = 'http://127.0.0.1:' + ollama.address().port;
process.env.CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
// Le serveur MCP appelle l'API sur PORT : on fixe un port libre connu à l'avance.
const probe = http.createServer();
await new Promise((r) => probe.listen(0, '127.0.0.1', r));
process.env.PORT = String(probe.address().port);
await new Promise((r) => probe.close(r));

const { server } = await import('./index.js');
let wsUrl;
before(() => new Promise((r) => server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  wsUrl = 'ws://127.0.0.1:' + process.env.PORT + '/ws';
  r();
})));
after(() => new Promise((r) => { server.closeAllConnections(); ollama.closeAllConnections(); server.close(() => ollama.close(r)); }));

// Écran de test : ligne du haut allumée et pixel (127,63).
const screenBytes = new Uint8Array(1024);
for (let x = 0; x < 128; x++) screenBytes[x] = 1;
screenBytes[1023] = 0x80;
const SCREEN_B64 = Buffer.from(screenBytes).toString('base64');

// Faux téléphone : répond aux appels d'outils, collecte les évènements du chat.
function phone() {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const t = { ws, welcome: null, events: [], histories: {}, calls: [] };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: 'tel' }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'welcome') { t.welcome = m; setTimeout(() => resolve(t), 50); }
      if (m.type === 'chat_history') t.histories[m.model] = m.items;
      if (m.type === 'chat_event') t.events.push(m);
      if (m.type === 'call') {
        t.calls.push(m);
        const result = m.tool === 'get_screen' ? { width: 128, height: 64, orientation: 0, data: SCREEN_B64 } : { latencyMs: 42 };
        ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
      }
    };
  });
}
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('délai dépassé');
};
const chat = (t, model, text, id) => t.ws.send(JSON.stringify({ type: 'chat', id, model, text }));
const eventsOf = (t, id) => t.events.filter((e) => e.id === id);

test('welcome annonce les modèles', async () => {
  const t = await phone();
  assert.deepEqual(t.welcome.models.map((m) => m.id), ['claude', 'gpt-oss']);
  t.ws.close();
});

test('gpt-oss : appel d\'outil via le téléphone, puis réponse en morceaux', async () => {
  const t = await phone();
  chat(t, 'gpt-oss', 'Le Flipper va bien ?', 'g1');
  await until(() => eventsOf(t, 'g1').some((e) => e.event === 'done' || e.event === 'error'));
  const ev = eventsOf(t, 'g1');
  assert.deepEqual(ev.map((e) => e.event), ['tool', 'text', 'text', 'done'], JSON.stringify(ev));
  assert.equal(ev[0].tool, 'ping');
  assert.equal(t.calls.length, 1);
  assert.match(ev.filter((e) => e.event === 'text').map((e) => e.text).join(''), /Le Flipper répond\. .*"latencyMs":42/);
  const req = ollamaRequests[0];
  assert.equal(req.model, 'gpt-oss:20b');
  assert.equal(req.options.num_ctx, 8192);
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.tools.length, 14);
  assert.ok(req.tools.some((x) => x.function.name === 'run_script'));
  assert.equal(t.calls[0].origin, 'gpt-oss');
  assert.equal(ollamaRequests[1].messages.at(-1).role, 'tool');
  t.ws.close();
});

test('gpt-oss : erreur d\'Ollama remontée, contexte du tour raté oublié', async () => {
  const t = await phone();
  const nBefore = ollamaRequests.length;
  chat(t, 'gpt-oss', 'panne', 'g2');
  const err = await until(() => eventsOf(t, 'g2').find((e) => e.event === 'error'));
  assert.match(err.error, /modèle indisponible/);
  chat(t, 'gpt-oss', 'encore ?', 'g3');
  await until(() => eventsOf(t, 'g3').some((e) => e.event === 'done'));
  const msgs = ollamaRequests[nBefore + 1].messages;
  assert.ok(!msgs.some((m) => m.content === 'panne'), 'le message raté ne doit pas rester dans le contexte');
  t.ws.close();
});

test('Claude : options de sécurité, outil ping via le serveur MCP, puis reprise de session', async () => {
  const t = await phone();
  chat(t, 'claude', 'ping le flipper', 'c1');
  await until(() => eventsOf(t, 'c1').some((e) => e.event === 'done' || e.event === 'error'));
  let ev = eventsOf(t, 'c1');
  assert.deepEqual(ev.map((e) => e.event), ['tool', 'text', 'done'], JSON.stringify(ev));
  assert.equal(ev[0].tool, 'ping');
  assert.match(ev[1].text, /outils=ping,get_screen,press_button,list_files,read_file,write_file,delete_file,run_script,build_app,install_app,memory_search,memory_read,memory_note,start_app proto=2025-06-18 ping=\{"latencyMs":42\}/);
  assert.equal(t.calls.at(-1).origin, 'claude');

  chat(t, 'claude', 'et maintenant ?', 'c2');
  await until(() => eventsOf(t, 'c2').some((e) => e.event === 'done' || e.event === 'error'));
  ev = eventsOf(t, 'c2');
  assert.match(ev.find((e) => e.event === 'text').text, /^\[reprise sess-1\]/);
  t.ws.close();
});

test('Claude : échec remonté et session oubliée', async () => {
  const t = await phone();
  chat(t, 'claude', 'ÉCHEC demandé', 'c3');
  const err = await until(() => eventsOf(t, 'c3').find((e) => e.event === 'error'));
  assert.match(err.error, /erreur simulée/);
  chat(t, 'claude', 'repart', 'c4');
  await until(() => eventsOf(t, 'c4').some((e) => e.event === 'done'));
  assert.doesNotMatch(eventsOf(t, 'c4').find((e) => e.event === 'text').text, /reprise/);
  t.ws.close();
});

test('historique renvoyé à la reconnexion, remis à zéro sur demande', async () => {
  const t = await phone();
  const h = t.histories['gpt-oss'];
  assert.ok(h.some((x) => x.role === 'user' && x.text === 'Le Flipper va bien ?'));
  assert.ok(h.some((x) => x.role === 'tool' && x.text.startsWith('ping')));
  assert.ok(h.some((x) => x.role === 'error'));
  t.ws.send(JSON.stringify({ type: 'chat_reset', model: 'gpt-oss' }));
  await until(() => t.histories['gpt-oss'].length === 0);
  t.ws.close();
});

test('refus : modèle inconnu, message vide, deux réponses en même temps', async () => {
  const t = await phone();
  chat(t, 'gpt-5', 'x', 'r1');
  chat(t, 'gpt-oss', '   ', 'r2');
  await until(() => eventsOf(t, 'r2').length);
  assert.match(eventsOf(t, 'r1')[0].error, /modèle inconnu/);
  assert.match(eventsOf(t, 'r2')[0].error, /vide/);
  chat(t, 'claude', 'long', 'r3');
  chat(t, 'gpt-oss', 'en même temps', 'r4');
  const busy = await until(() => eventsOf(t, 'r4').find((e) => e.event === 'error'));
  assert.match(busy.error, /répond déjà/);
  await until(() => eventsOf(t, 'r3').some((e) => e.event === 'done'));
  t.ws.close();
});

test('gpt-oss : get_screen lui arrive en texte', async () => {
  const t = await phone();
  const n = ollamaRequests.length;
  chat(t, 'gpt-oss', 'Que montre l\'écran ?', 's1');
  await until(() => eventsOf(t, 's1').some((e) => e.event === 'done' || e.event === 'error'));
  const toolMsg = ollamaRequests[n + 1].messages.at(-1);
  assert.equal(toolMsg.role, 'tool');
  const r = JSON.parse(toolMsg.content);
  assert.equal(r.ok, true);
  const lines = r.result.ecran.split('\n');
  assert.equal(lines.length, 64);           // pleine résolution : les chiffres restent lisibles
  assert.equal(lines[0], '#'.repeat(128));
  assert.equal(lines[63], '.'.repeat(127) + '#');
  t.ws.close();
});

test('serveur MCP : get_screen renvoie une image PNG à Claude', async () => {
  const t = await phone();
  const { spawn } = await import('node:child_process');
  const { inflateSync } = await import('node:zlib');
  const mcp = spawn(process.execPath, [fileURLToPath(new URL('./mcp-flipper.js', import.meta.url))], {
    env: { ...process.env, FLIPPER_API_URL: 'http://127.0.0.1:' + process.env.PORT, API_TOKEN: 'api', FLIPPER_ORIGIN: 'claude' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  const answer = new Promise((resolve) => mcp.stdout.on('data', (d) => {
    buf += d;
    const line = buf.split('\n').find((l) => l.includes('"id":2'));
    if (line) resolve(JSON.parse(line));
  }));
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_screen', arguments: {} } }) + '\n');
  const r = await answer;
  mcp.kill();
  const img = r.result.content[0];
  assert.equal(img.type, 'image');
  assert.equal(img.mimeType, 'image/png');
  const png = Buffer.from(img.data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 512);  // largeur 128 x 4
  assert.equal(png.readUInt32BE(20), 256);  // hauteur 64 x 4
  const idatLen = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, (512 * 3 + 1) * 256);
  assert.deepEqual([...raw.subarray(1, 4)], [26, 16, 0]);       // pixel (0,0) allumé
  assert.deepEqual([...raw.subarray(1 + 3 * 4 * 2, 4 + 3 * 4 * 2)], [26, 16, 0]);
  const row8 = 8 * 4 * (512 * 3 + 1);
  assert.deepEqual([...raw.subarray(row8 + 1, row8 + 4)], [255, 139, 26]); // pixel (0,8) éteint
  assert.equal(r.result.content[1].type, 'text');
  assert.equal(t.calls.at(-1).origin, 'claude');
  t.ws.close();
});
