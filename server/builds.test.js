import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBuilds } from './builds.js';

// Faux builder : imite builder/server.js (POST /build, X-Build-Token).
const seen = [];
let mode = 'ok';
const fake = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    seen.push({ token: req.headers['x-build-token'], body: JSON.parse(b || '{}') });
    const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers['x-build-token'] !== 'bt') return send(401, { ok: false, log: 'jeton invalide' });
    if (mode === 'busy') return send(429, { ok: false, log: 'occupé' });
    if (mode === 'fail') return send(200, { ok: false, log: 'hello.c:3: error: expected ;' });
    if (mode === 'badid') return send(200, { ok: true, appid: '../evil', fap: 'AAAA', log: 'ok' });
    send(200, { ok: true, appid: 'hello', fap: Buffer.from('FAPDATA').toString('base64'), log: 'CC hello.c\ncode de sortie : 0' });
  });
});
let url;
before(() => new Promise((r) => fake.listen(0, '127.0.0.1', () => { url = 'http://127.0.0.1:' + fake.address().port; r(); })));
after(() => new Promise((r) => { fake.closeAllConnections(); fake.close(r); }));

const phoneCalls = [];
const make = (token = 'bt') => createBuilds({
  url, token, log: () => {},
  callPhone: async (tool, args, origin, opts) => { phoneCalls.push({ tool, args, origin, opts }); return { ok: true, result: { path: args.path } }; },
});
const files = { 'application.fam': 'App(appid="hello")', 'hello.c': 'int32_t hello_app(void* p) { return 0; }' };

test('compilation réussie puis installation via le téléphone', async () => {
  const b = make();
  const r = await b.build({ files });
  assert.equal(r.ok, true);
  assert.equal(r.result.appid, 'hello');
  assert.equal(r.result.size, 7);
  assert.equal(seen.at(-1).token, 'bt');
  assert.deepEqual(seen.at(-1).body.files, files);
  const i = await b.install({ build_id: r.result.build_id }, 'claude');
  assert.equal(i.ok, true);
  const c = phoneCalls.at(-1);
  assert.equal(c.tool, 'install_fap');
  assert.equal(c.args.path, '/ext/apps/Tools/hello.fap');
  assert.equal(Buffer.from(c.args.base64, 'base64').toString(), 'FAPDATA');
  assert.match(c.args.source, /hello_app/);
  assert.equal(c.origin, 'claude');
  assert.equal(c.opts.timeoutMs, 300000);
  await b.install({ build_id: r.result.build_id, category: 'Games' }, 'claude');
  assert.equal(phoneCalls.at(-1).args.path, '/ext/apps/Games/hello.fap');
});

test('refus : catégorie System ou invalide, build_id inconnu', async () => {
  const b = make();
  const r = await b.build({ files });
  for (const category of ['System', 'system', '../x', 'a/b', '']) {
    assert.equal((await b.install({ build_id: r.result.build_id, category }, 'x')).ok, false, category);
  }
  assert.match((await b.install({ build_id: 'b00000000' }, 'x')).error, /inconnu/);
});

test('échec de compilation : journal renvoyé au modèle', async () => {
  mode = 'fail';
  const r = await make().build({ files });
  mode = 'ok';
  assert.equal(r.ok, false);
  assert.match(r.log, /expected ;/);
});

test('builder occupé, jeton faux, appid invalide, files absent, builder non configuré', async () => {
  mode = 'busy';
  assert.match((await make().build({ files })).error, /déjà en cours/);
  mode = 'badid';
  assert.match((await make().build({ files })).error, /appid invalide/);
  mode = 'ok';
  assert.match((await make('faux').build({ files })).error, /jeton/);
  assert.equal((await make().build({})).ok, false);
  assert.equal((await make().build({ files: [] })).ok, false);
  assert.match((await make('').build({ files })).error, /non configuré/);
});
