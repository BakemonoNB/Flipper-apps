import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCatalog } from './catalog.js';

const reqs = [];
const fap = Buffer.from('FAPBINARY');
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  reqs.push(u.pathname + '?' + u.searchParams.toString());
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/category') return json([{ _id: 'c1', name: 'Sub-GHz' }, { _id: 'c2', name: 'Tools' }]);
  if (u.pathname === '/0/application') {
    assert.equal(u.searchParams.get('target'), 'f7');
    assert.equal(u.searchParams.get('api'), '88.2');
    // Le vrai catalogue répond 400 si is_latest_release_version accompagne api/target.
    if (u.searchParams.has('is_latest_release_version')) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ detail: 'is_latest_release_version avec api' })); }
    assert.equal(u.searchParams.get('sort_by'), 'updated_at');
    return json([
      { _id: 'a1', alias: 'marauder', author: 'me', category_id: 'c1', current_version: { _id: 'v1', name: 'WiFi Marauder', version: '1.2', short_description: 'scan wifi', current_build: { _id: 'b1', sdk: { api: '88.2' } } } },
      { _id: 'a2', alias: 'oldapp', author: 'x', category_id: 'c2', current_version: { _id: 'v2', name: 'Old', version: '0.1', current_build: null } },
    ]);
  }
  if (u.pathname.startsWith('/application/a') && u.searchParams.has('is_latest_release_version')) { res.writeHead(400); return res.end('{}'); }
  if (u.pathname === '/application/a1') return json({ _id: 'a1', alias: 'marauder', author: 'me', category_id: 'c1', current_version: { _id: 'v1', name: 'WiFi Marauder', version: '1.2', current_build: { _id: 'b1', sdk: { api: '88.2' } } } });
  if (u.pathname === '/application/a2') return json({ _id: 'a2', alias: 'oldapp', author: 'x', category_id: 'c2', current_version: { _id: 'v2', name: 'Old', current_build: null } });
  if (u.pathname === '/application/version/v1/build/compatible') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(fap); }
  if (u.pathname === '/application/version/v2/build/compatible') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ detail: { code: 404 } })); }
  res.writeHead(404); res.end('{}');
});
let url, phoneCalls;
before(() => new Promise((r) => fake.listen(0, '127.0.0.1', () => { url = 'http://127.0.0.1:' + fake.address().port; r(); })));
after(() => new Promise((r) => { fake.closeAllConnections(); fake.close(r); }));
const make = () => { phoneCalls = []; return createCatalog({ url, log: () => {}, callPhone: async (t, a, o, opts) => { phoneCalls.push({ t, a, o, opts }); return { ok: true, result: { path: a.path } }; } }); };

test('recherche : apps compatibles, catégorie nommée, installable', async () => {
  const c = make();
  const r = await c.search({ query: 'wifi' });
  assert.equal(r.ok, true);
  assert.equal(r.result.api, '88.2');
  assert.deepEqual(r.result.apps[0], { id: 'a1', name: 'WiFi Marauder', author: 'me', category: 'Sub-GHz', version: '1.2', description: 'scan wifi', build_api: '88.2', installable: true });
  assert.equal(r.result.apps[1].installable, false);
});

test('installation : télécharge le build et passe par install_fap avec les métadonnées', async () => {
  const c = make();
  const r = await c.install({ id: 'a1' }, 'claude');
  assert.equal(r.ok, true);
  const call = phoneCalls[0];
  assert.equal(call.t, 'install_fap');
  assert.equal(call.a.path, '/ext/apps/Sub-GHz/marauder.fap');
  assert.equal(Buffer.from(call.a.base64, 'base64').toString(), 'FAPBINARY');
  assert.equal(call.a.source, undefined);
  assert.deepEqual(call.a.catalog, { name: 'WiFi Marauder', author: 'me', category: 'Sub-GHz', version: '1.2', build_api: '88.2' });
  assert.equal(call.o, 'claude');
});

test('app sans build compatible -> erreur claire, pas d\'appel au téléphone', async () => {
  const c = make();
  const r = await c.install({ id: 'a2' }, 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /pas de version compatible avec l'API 88\.2/);
  assert.equal(phoneCalls.length, 0);
});

test('id manquant -> erreur', async () => {
  assert.equal((await make().install({}, 'x')).ok, false);
});

test('catalogue injoignable -> erreur, pas de crash', async () => {
  const c = createCatalog({ url: 'http://127.0.0.1:1', log: () => {}, callPhone: async () => ({ ok: true }) });
  assert.match((await c.search({ query: 'x' })).error, /injoignable/);
});
