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
      line({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'ping', arguments: {} } }] }, done: false });
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
        ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result: { latencyMs: 42 } }));
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
  assert.deepEqual(req.tools.map((x) => x.function.name), ['ping', 'press_button']);
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
  assert.match(ev[1].text, /outils=ping,press_button proto=2025-06-18 ping=\{"latencyMs":42\}/);
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
