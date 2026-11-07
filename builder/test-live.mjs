// Tests de bout en bout contre le service réel (en root sur le VPS) :
//   node builder/test-live.mjs [/etc/flipper-builder.env] [http://127.0.0.1:3050]
// Le jeton est lu dans le fichier env et n'est jamais affiché.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const envFile = process.argv[2] || '/etc/flipper-builder.env';
const BASE = process.argv[3] || 'http://127.0.0.1:3050';
const TOKEN = /^BUILD_TOKEN=(.+)$/m.exec(readFileSync(envFile, 'utf8'))?.[1]?.trim() || '';
if (!TOKEN) throw new Error('BUILD_TOKEN introuvable dans ' + envFile);

const FAM = (extra = '') => `${extra}
App(
    appid="hello_builder",
    name="Hello Builder",
    apptype=FlipperAppType.EXTERNAL,
    entry_point="hello_main",
    fap_category="Examples",
)
`;
const HELLO_C = `#include <furi.h>

int32_t hello_main(void* p) {
    UNUSED(p);
    FURI_LOG_I("hello", "Hello world");
    return 0;
}
`;

async function build(files, token = TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-build-token'] = token;
  const t = Date.now();
  const r = await fetch(BASE + '/build', { method: 'POST', headers, body: JSON.stringify({ files }) });
  return { status: r.status, body: await r.json(), s: (Date.now() - t) / 1000 };
}
const containers = () => execFileSync('docker', ['ps', '-aq', '--filter', 'label=flipper-builder.job=1']).toString().trim();
let failed = 0;
const check = (name, cond, info = '') => {
  console.log((cond ? 'OK    ' : 'ÉCHEC ') + name + (info ? ' : ' + info : ''));
  if (!cond) failed++;
};

const h = await (await fetch(BASE + '/health')).json();
check('health', h.ok && h.firmware === '1.5.1' && h.api === '88.2', JSON.stringify(h));

let r = await build({ 'application.fam': FAM() }, '');
check('sans jeton -> 401', r.status === 401);
r = await build({ 'application.fam': FAM() }, 'x'.repeat(64));
check('mauvais jeton -> 401', r.status === 401);
r = await build({ 'application.fam': FAM(), '../x': 'a' });
check('chemin « ../x » refusé', r.status === 400 && !r.body.ok, r.body.log);
r = await build({ 'application.fam': FAM(), '/etc/x': 'a' });
check('chemin absolu refusé', r.status === 400 && !r.body.ok, r.body.log);

// a) hello world
r = await build({ 'application.fam': FAM(), 'hello.c': HELLO_C });
const fap = r.body.fap ? Buffer.from(r.body.fap, 'base64') : Buffer.alloc(0);
check('a) hello world compilé', r.body.ok && r.body.appid === 'hello_builder' && fap.subarray(1, 4).toString() === 'ELF',
  `${fap.length} octets, appid ${r.body.appid}, ${r.s.toFixed(1)} s`);
console.log(r.body.log.split('\n').slice(0, 15).map((l) => '      | ' + l).join('\n'));

// b) pas de réseau
r = await build({ 'application.fam': FAM('import socket; socket.create_connection(("1.1.1.1", 80), timeout=10)'), 'hello.c': HELLO_C });
const netErr = r.body.log.split('\n').filter((l) => /Error|unreachable|socket/i.test(l)).slice(-3).join(' / ');
check('b) réseau coupé', !r.body.ok && /unreachable|Errno/i.test(r.body.log), netErr);

// c) boucle infinie, tuée à 120 s ; pendant ce temps, un second build doit recevoir 429.
const loop = build({ 'application.fam': FAM('while True: pass'), 'hello.c': HELLO_C });
await new Promise((ok) => setTimeout(ok, 3000));
const during = containers();
const second = await build({ 'application.fam': FAM(), 'hello.c': HELLO_C });
check('second build en parallèle -> 429', second.status === 429);
r = await loop;
await new Promise((ok) => setTimeout(ok, 2000));
const left = containers();
check('c) boucle tuée vers 120 s', !r.body.ok && /temps dépassé/.test(r.body.log) && r.s >= 119 && r.s < 135, `${r.s.toFixed(1)} s`);
check('c) conteneur présent pendant le build', during.split('\n').filter(Boolean).length === 1);
check('c) aucun conteneur restant', left === '', left || 'docker ps -a vide');

process.exit(failed ? 1 : 0);
