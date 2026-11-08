import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createFirmware } from './firmware.js';

function header(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136); h.write('        ', 148); h.write(type, 156); h.write('ustar\0' + '00', 257);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const tgz = (files) => {
  const parts = [];
  for (const [n, c] of Object.entries(files)) {
    const d = Buffer.from(c);
    parts.push(header(n, d.length, n.endsWith('/') ? '5' : '0'), d, Buffer.alloc((512 - (d.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

const good = tgz({ './f7-update-mntm-012/': '', './f7-update-mntm-012/update.fuf': 'Filetype: Flipper firmware upgrade configuration', './f7-update-mntm-012/firmware.dfu': 'DFU'.repeat(1000) });
const evil = tgz({ 'f7-update-x/update.fuf': 'x', 'f7-update-x/../../etc/passwd': 'x' });
let url;
let downloads = 0;
let indexSha = sha(good);
const fake = http.createServer((req, res) => {
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const idx = (pkg, s) => json({ channels: [{ id: 'release', versions: [{ version: 'mntm-012', files: [
    { type: 'sdk_zip', target: 'f7', url: url + '/sdk.zip', sha256: 'a'.repeat(64) },
    { type: 'update_tgz', target: 'f7', url: url.replace('http:', 'https:') + pkg, sha256: s },
  ] }] }, { id: 'development', versions: [] }] });
  if (req.url === '/mntm/directory.json') return idx('/good.tgz', indexSha);
  if (req.url === '/nosha/directory.json') return idx('/good.tgz', '');
  if (req.url === '/evil/directory.json') return idx('/evil.tgz', sha(evil));
  res.writeHead(404); res.end();
});
// Le paquet est annoncé en https : la fausse fonction fetch le redirige vers le serveur de test.
const fetchImpl = (u, o) => {
  if (u.startsWith('https://127.0.0.1')) { downloads++; u = u.replace('https:', 'http:'); }
  if (u.endsWith('/good.tgz')) return Promise.resolve(new Response(good));
  if (u.endsWith('/evil.tgz')) return Promise.resolve(new Response(evil));
  return fetch(u, o);
};
before(() => new Promise((r) => fake.listen(0, '127.0.0.1', () => { url = 'http://127.0.0.1:' + fake.address().port; r(); })));
after(() => new Promise((r) => { fake.closeAllConnections(); fake.close(r); }));

const make = (index) => {
  const calls = [];
  const fw = createFirmware({ log: () => {}, fetchImpl, indexes: { momentum: url + index, official: url + index },
    callPhone: async (t, a, o, opts) => { calls.push({ t, a, o, opts }); return { ok: true, result: 'copié' }; } });
  return { fw, calls };
};
// Réponse HTTP minimale pour serve().
const fakeRes = () => { const r = { status: 0, headers: {}, body: null }; r.writeHead = (s, h) => { r.status = s; r.headers = h; }; r.end = (b) => { r.body = b; }; return r; };

test('firmware : paquet Momentum vérifié, envoyé au téléphone, fichiers servis', async () => {
  const { fw, calls } = make('/mntm/directory.json');
  const r = await fw.update({ firmware: 'Momentum' }, 'claude');
  assert.equal(r.ok, true, r.error);
  const c = calls[0];
  assert.equal(c.t, 'install_firmware');
  assert.equal(c.o, 'claude');
  assert.equal(c.a.dir, 'f7-update-mntm-012');
  assert.equal(c.a.label, 'Momentum');
  assert.equal(c.a.version, 'mntm-012');
  assert.match(c.a.job, /^[a-f0-9]{32}$/);
  assert.deepEqual(c.a.files.map((f) => f.name).sort(), ['firmware.dfu', 'update.fuf']);
  const dfu = c.a.files.find((f) => f.name === 'firmware.dfu');
  assert.equal(dfu.size, 3000);
  assert.equal(dfu.sha256, sha(Buffer.from('DFU'.repeat(1000))));
  const res = fakeRes();
  fw.serve({ method: 'GET' }, res, '/fw/' + c.a.job + '/firmware.dfu');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.body.toString(), 'DFU'.repeat(1000));
  const miss = fakeRes();
  fw.serve({ method: 'GET' }, miss, '/fw/' + 'f'.repeat(32) + '/firmware.dfu');
  assert.equal(miss.status, 404);
  // Même version demandée à nouveau : pas de second téléchargement.
  const before = downloads;
  await fw.update({ firmware: 'momentum' }, 'claude');
  assert.equal(downloads, before);
  assert.equal(calls[1].a.job, c.a.job);
});

test('firmware : refus (source inconnue, empreinte absente ou fausse, paquet piégé, canal vide)', async () => {
  const { fw, calls } = make('/mntm/directory.json');
  assert.match((await fw.update({ firmware: 'roguemaster' })).error, /official.*momentum/);
  assert.match((await fw.update({ firmware: 'momentum', channel: 'nightly' })).error, /channel/);
  assert.match((await fw.update({ firmware: 'momentum', channel: 'development' })).error, /aucune version/);
  assert.match((await make('/nosha/directory.json').fw.update({ firmware: 'momentum' })).error, /empreinte/);
  assert.match((await make('/evil/directory.json').fw.update({ firmware: 'momentum' })).error, /inattendu/);
  indexSha = 'b'.repeat(64);
  try {
    assert.match((await make('/mntm/directory.json').fw.update({ firmware: 'official' })).error, /empreinte du paquet incorrecte/);
  } finally { indexSha = sha(good); }
  assert.equal(calls.length, 0);
});
