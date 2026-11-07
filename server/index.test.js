import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LOGS_TOKEN = 'jeton-de-test';
const { server, log } = await import('./index.js');
let base;
before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; r(); })));
after(() => new Promise((r) => server.close(r)));

test('/health répond sans authentification', async () => {
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(j.commit);
});

test('/logs refuse sans jeton ou avec un mauvais jeton', async () => {
  assert.equal((await fetch(base + '/logs')).status, 401);
  assert.equal((await fetch(base + '/logs', { headers: { authorization: 'Bearer faux' } })).status, 401);
});

test('/logs renvoie les dernières lignes avec le bon jeton', async () => {
  log('INFO', 'ligne-test');
  const r = await fetch(base + '/logs?n=5', { headers: { authorization: 'Bearer jeton-de-test' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.lines.some((l) => l.includes('ligne-test')));
  assert.ok(j.lines.length <= 5);
});

test('route inconnue -> 404', async () => {
  assert.equal((await fetch(base + '/nimporte')).status, 404);
});
