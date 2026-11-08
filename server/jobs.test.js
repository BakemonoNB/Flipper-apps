import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobs } from './jobs.js';

test('tâches de fond : réponse immédiate, une seule à la fois, résultat et échec remontés', async () => {
  const done = [];
  const jobs = createJobs({ log: () => {}, onDone: (j) => done.push(j) });
  let release;
  const r = jobs.start('Sauvegarde de /ext/dolphin', 'claude', () => new Promise((ok) => { release = ok; }));
  assert.equal(r.ok, true);
  assert.equal(r.result.started, true);
  assert.match(r.result.info, /Ne la relance pas/);
  const busy = jobs.start('Autre', 'claude', async () => ({ ok: true }));
  assert.equal(busy.ok, false);
  assert.match(busy.error, /déjà en cours.*Sauvegarde/);
  await new Promise((s) => setTimeout(s, 0));
  release({ ok: true, result: { files: 412 } });
  await new Promise((s) => setTimeout(s, 10));
  assert.equal(done.length, 1);
  assert.equal(done[0].ok, true);
  assert.equal(done[0].origin, 'claude');
  assert.match(done[0].text, /Sauvegarde de \/ext\/dolphin : terminé .*"files":412/);
  jobs.start('Firmware', 'gpt-oss', async () => { throw new Error('Flipper non connecté'); });
  await new Promise((s) => setTimeout(s, 10));
  assert.equal(done[1].ok, false);
  assert.match(done[1].text, /Firmware : échec .*Flipper non connecté/);
});
