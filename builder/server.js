// Builder Flipper : compile des apps .fap dans un conteneur Docker jetable.
// Tourne en root (pilote Docker), écoute sur 127.0.0.1 seulement.
// Variables : BUILD_TOKEN (obligatoire), PORT (3050), HOST (127.0.0.1), IMAGE (flipper-builder),
//   BUILD_TIMEOUT_S (120), DOCKER_BIN (docker),
//   IMAGE_MOMENTUM (vide = pas de SDK Momentum) : image construite avec le SDK Momentum (même Dockerfile, autres --build-arg).
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { LIMITS, tokenOk, validateFiles, makeTar, readTar, truncateLog } from './lib.js';

const PORT = Number(process.env.PORT || 3050);
const HOST = process.env.HOST || '127.0.0.1';
const IMAGE = process.env.IMAGE || 'flipper-builder';
// Un SDK par firmware : le pont envoie « sdk » selon le firmware lu sur le Flipper.
const IMAGES = { official: IMAGE, momentum: process.env.IMAGE_MOMENTUM || '' };
const TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_S || 120) * 1000;
const DOCKER = process.env.DOCKER_BIN || 'docker';
const BUILD_TOKEN = process.env.BUILD_TOKEN || '';
const LABEL = 'flipper-builder.job=1';
const MAX_BODY = 1024 * 1024; // JSON brut (le base64 grossit les données de 4/3)
const MAX_STDOUT = LIMITS.maxFap + LIMITS.maxLog + 64 * 1024;

if (BUILD_TOKEN.length < 32) {
  console.error('BUILD_TOKEN absent ou trop court, arrêt');
  process.exit(1);
}

const log = (msg) => console.log(new Date().toISOString() + ' ' + msg);

function docker(args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(DOCKER, args, { timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout, stderr: String(stderr || '') }),
    );
  });
}

// Supprime les conteneurs de build restants (crash ou kill du service pendant un build).
async function cleanupStale() {
  const r = await docker(['ps', '-aq', '--filter', 'label=' + LABEL]);
  const ids = String(r.stdout).split(/\s+/).filter(Boolean);
  if (ids.length) {
    await docker(['rm', '-f', ...ids]);
    log('nettoyage : ' + ids.length + ' conteneur(s) supprimé(s)');
  }
}

// Versions lues dans l'image (/etc/flipper-sdk.json, écrit et vérifié à la construction), sans l'exécuter.
const sdkCache = new Map(); // image -> { id, info }
async function readSdkInfo(image = IMAGE) {
  const id = await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  if (!id.ok) throw new Error('image ' + image + ' introuvable');
  const imageId = String(id.stdout).trim();
  const cached = sdkCache.get(image);
  if (cached && cached.id === imageId) return cached.info;
  const name = 'flipper-builder-info-' + randomBytes(6).toString('hex');
  const c = await docker(['create', '--name', name, '--label', LABEL, '--network', 'none', image]);
  if (!c.ok) throw new Error('docker create a échoué');
  try {
    const cp = await docker(['cp', name + ':/etc/flipper-sdk.json', '-']);
    if (!cp.ok) throw new Error('docker cp a échoué');
    const info = JSON.parse(readTar(cp.stdout)['flipper-sdk.json'].toString());
    const sdkInfo = { firmware: String(info.firmware), api: String(info.api) };
    sdkCache.set(image, { id: imageId, info: sdkInfo });
    return sdkInfo;
  } finally {
    await docker(['rm', '-f', name]);
  }
}

// Lance un conteneur neuf, envoie les sources en tar sur stdin, récupère le tar de sortie sur stdout.
function runBuild(tar, image = IMAGE) {
  return new Promise((resolve) => {
    const name = 'flipper-build-' + randomBytes(8).toString('hex');
    const args = [
      'run', '--rm', '-i', '--name', name, '--label', LABEL,
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/work:rw,exec,nosuid,nodev,size=64m,mode=1777',
      '--user', '10001:10001',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '256',
      '--memory', '1g', '--memory-swap', '1g',
      '--cpus', '2',
      '--log-driver', 'none',
      image,
    ];
    const started = Date.now();
    const child = spawn(DOCKER, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    let reason = '';
    const kill = (why) => {
      if (reason) return;
      reason = why;
      // Kill côté service : le conteneur est arrêté par le démon Docker, pas seulement le client.
      execFile(DOCKER, ['kill', name], () => execFile(DOCKER, ['rm', '-f', name], () => {}));
    };
    const timer = setTimeout(() => kill(`temps dépassé (${TIMEOUT_MS / 1000} s), conteneur tué`), TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > MAX_STDOUT) return kill('sortie du conteneur trop grosse, conteneur tué');
      chunks.push(d);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 8192) stderr += d;
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      // Filet de sécurité : --rm ne s'applique pas toujours si le client est tué.
      execFile(DOCKER, ['rm', '-f', name], () => {});
      resolve({ code, reason, stderr, out: Buffer.concat(chunks), ms: Date.now() - started });
    });
    child.stdin.end(tar);
  });
}

let busy = false;

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      // Au-delà de la limite, on jette la suite sans couper la connexion, pour pouvoir répondre 413.
      if (size > MAX_BODY) chunks.length = 0;
      else chunks.push(d);
    });
    req.on('end', () =>
      size > MAX_BODY
        ? reject(Object.assign(new Error('corps trop gros (1 Mo max)'), { status: 413 }))
        : resolve(Buffer.concat(chunks)),
    );
    req.on('error', reject);
  });
}

async function handleBuild(req, res) {
  if (!tokenOk(req.headers['x-build-token'], BUILD_TOKEN)) return send(res, 401, { ok: false, log: 'jeton invalide' });
  if (busy) return send(res, 429, { ok: false, log: 'un build est déjà en cours, réessayer plus tard' });
  busy = true;
  try {
    let files;
    let sdk = 'official';
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      files = validateFiles(body && body.files);
      if (body.sdk !== undefined) sdk = body.sdk;
      if (!Object.hasOwn(IMAGES, sdk)) throw new Error('sdk : official ou momentum');
    } catch (e) {
      return send(res, e.status || 400, { ok: false, log: 'requête refusée : ' + e.message });
    }
    if (!IMAGES[sdk]) return send(res, 200, { ok: false, log: '[builder] SDK ' + sdk + ' non installé sur le VPS (IMAGE_MOMENTUM vide) : il faut construire son image.' });
    const r = await runBuild(makeTar(files), IMAGES[sdk]);
    let parts = {};
    let parseErr = '';
    try {
      parts = readTar(r.out);
    } catch (e) {
      parseErr = e.message;
    }
    let buildLog = parts['build.log'] ? parts['build.log'].toString('utf8') : '';
    if (r.reason) buildLog += '\n[builder] ' + r.reason + '\n';
    else if (r.code !== 0) buildLog += `\n[builder] conteneur terminé avec le code ${r.code}\n${r.stderr}`;
    if (parseErr) buildLog += '\n[builder] ' + parseErr + '\n';
    buildLog = truncateLog(buildLog);
    const fap = parts['app.fap'];
    const appid = parts['appid'] ? parts['appid'].toString('utf8').trim() : '';
    log(`build ${appid || '?'} (${sdk}) : ${fap && !r.reason ? 'ok' : 'échec'} en ${r.ms} ms${r.reason ? ' (' + r.reason + ')' : ''}`);
    if (r.reason || !fap) return send(res, 200, { ok: false, log: buildLog });
    if (fap.length > LIMITS.maxFap)
      return send(res, 200, { ok: false, log: buildLog + `\n[builder] .fap trop gros (${fap.length} octets > 1 Mo)\n` });
    return send(res, 200, { ok: true, appid, fap: fap.toString('base64'), log: buildLog });
  } finally {
    busy = false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const info = await readSdkInfo();
      let momentum = null;
      if (IMAGES.momentum) {
        try { momentum = await readSdkInfo(IMAGES.momentum); } catch (e) { momentum = { error: e.message }; }
      }
      return send(res, 200, { ok: true, firmware: info.firmware, api: info.api, momentum });
    }
    if (req.method === 'POST' && url.pathname === '/build') return await handleBuild(req, res);
    send(res, 404, { ok: false, log: 'introuvable' });
  } catch (e) {
    log('erreur : ' + e.message);
    if (!res.headersSent) send(res, 500, { ok: false, log: 'erreur interne : ' + e.message });
  }
});
server.requestTimeout = TIMEOUT_MS + 60000;

await cleanupStale();
server.listen(PORT, HOST, () => log(`flipper-builder sur http://${HOST}:${PORT} (images ${IMAGE}${IMAGES.momentum ? ', ' + IMAGES.momentum : ''})`));
