import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createGithub, parseTar, pickApp } from './github.js';

// Archive façon GitHub : en-tête pax global, dossier racine « owner-repo-sha/ », nom long en pax.
function header(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136); h.write('        ', 148); h.write(type, 156); h.write('ustar\0' + '00', 257);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function tarOf(files) {
  const parts = [];
  const g = Buffer.from('52 comment=0123456789abcdef0123456789abcdef01234567\n');
  parts.push(header('pax_global_header', g.length, 'g'), pad(g));
  parts.push(header('me-repo-0123abc/', 0, '5'));
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const full = 'me-repo-0123abc/' + name;
    if (full.length > 100) {
      const rec = ' path=' + full + '\n';
      let len = rec.length + String(rec.length).length; // la longueur compte ses propres chiffres
      if (String(len).length !== String(rec.length).length) len = rec.length + String(len).length;
      const pax = Buffer.from(len + rec);
      parts.push(header('PaxHeader', pax.length, 'x'), pad(pax));
    }
    parts.push(header(full, data.length), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const REPOS = {
  'me/solo': { 'application.fam': 'App(appid="solo")', 'solo.c': 'int main(){}', 'README.md': '# x', '.github/workflows/b.yml': 'x', 'images/icon.png': Buffer.from([0x89, 0x50, 0, 1, 2]) },
  'me/multi': { 'README.md': '# x', 'apps/a/application.fam': 'App(appid="a")', 'apps/a/a.c': 'a', 'apps/b/application.fam': 'App(appid="b")', 'apps/b/b.c': 'b' },
  'me/big': Object.fromEntries([['application.fam', 'App()'], ...Array.from({ length: 60 }, (_, i) => ['f' + i + '.c', 'x'])]),
  'me/long': { ['deep/' + 'd'.repeat(90) + '/application.fam']: 'App(appid="l")', ['deep/' + 'd'.repeat(90) + '/l.c']: 'l' },
};
let url;
const seen = [];
const fake = http.createServer((req, res) => {
  seen.push(req.url + ' ua=' + req.headers['user-agent']);
  const m = /^\/repos\/([^/]+\/[^/]+)\/tarball(?:\/(.+))?$/.exec(req.url);
  if (m && m[1] === 'me/solo' && m[2] === undefined) { res.writeHead(302, { location: url + '/codeload/solo' }); return res.end(); }
  if (req.url === '/codeload/solo') { res.writeHead(200); return res.end(gzipSync(tarOf(REPOS['me/solo']))); }
  if (m && REPOS[m[1]]) { res.writeHead(200); return res.end(gzipSync(tarOf(REPOS[m[1]]))); }
  res.writeHead(404); res.end('{}');
});
before(() => new Promise((r) => fake.listen(0, '127.0.0.1', () => { url = 'http://127.0.0.1:' + fake.address().port; r(); })));
after(() => new Promise((r) => { fake.closeAllConnections(); fake.close(r); }));

const make = () => {
  const calls = [];
  const gh = createGithub({ apiUrl: url, log: () => {}, build: async (a, meta) => { calls.push({ a, meta }); return { ok: true, result: { build_id: 'b1', appid: 'x' } }; } });
  return { gh, calls };
};

test('github : app à la racine, redirection suivie, Markdown et .github ignorés, image en base64', async () => {
  const { gh, calls } = make();
  const r = await gh.build({ repo: 'https://github.com/me/solo.git' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(calls[0].a.files).sort(), ['application.fam', 'images/icon.png', 'solo.c']);
  assert.equal(calls[0].a.files['solo.c'], 'int main(){}');
  assert.deepEqual(calls[0].a.files['images/icon.png'], { base64: Buffer.from([0x89, 0x50, 0, 1, 2]).toString('base64') });
  assert.equal(calls[0].meta.source, 'https://github.com/me/solo');
  assert.equal(r.result.build_id, 'b1');
  assert.match(seen.find((s) => s.startsWith('/repos/me/solo')), /ua=flipper-bridge/);
});

test('github : plusieurs apps -> liste des dossiers ; path choisit la bonne, sans mélanger', async () => {
  const { gh, calls } = make();
  const r = await gh.build({ repo: 'me/multi', ref: 'main' });
  assert.equal(r.ok, false);
  assert.match(r.error, /apps\/a, apps\/b/);
  const r2 = await gh.build({ repo: 'me/multi', ref: 'main', path: 'apps/b/' });
  assert.equal(r2.ok, true, r2.error);
  assert.deepEqual(Object.keys(calls[0].a.files).sort(), ['application.fam', 'b.c']);
  assert.match(calls[0].meta.source, /me\/multi \(main\) — dossier apps\/b/);
  const r3 = await gh.build({ repo: 'me/multi', path: 'apps/c' });
  assert.match(r3.error, /Dossiers possibles : apps\/a, apps\/b/);
});

test('github : limites du compilateur, noms longs (pax), entrées refusées', async () => {
  const { gh } = make();
  assert.match((await gh.build({ repo: 'me/big' })).error, /trop grosse.*61 fichiers/);
  const { gh: gh2, calls } = make();
  const r = await gh2.build({ repo: 'me/long' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.keys(calls[0].a.files).sort(), ['application.fam', 'l.c']);
  assert.match((await gh.build({ repo: 'me/absent' })).error, /introuvable/);
  assert.match((await gh.build({ repo: '../etc' })).error, /owner\/nom/);
  assert.match((await gh.build({ repo: 'me/solo', ref: 'a/../b' })).error, /ref invalide/);
  assert.match((await gh.build({ repo: 'me/solo', path: '../x' })).error, /path invalide/);
});

test('github : parseTar et pickApp directement', () => {
  const entries = parseTar(tarOf({ 'application.fam': 'A', 'x.c': 'x' }));
  assert.deepEqual(entries.map((e) => e.name), ['me-repo-0123abc/application.fam', 'me-repo-0123abc/x.c']);
  assert.throws(() => pickApp(parseTar(tarOf({ 'main.py': 'x' }))), /aucun application.fam/);
});
