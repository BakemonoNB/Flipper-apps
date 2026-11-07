// Pont VPS <-> téléphone pour le Flipper. Étape 3 : santé et journal uniquement.
// Variables : PORT (3040), HOST (127.0.0.1), LOGS_TOKEN (obligatoire pour /logs).
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3040);
const HOST = process.env.HOST || '127.0.0.1';
const LOGS_TOKEN = process.env.LOGS_TOKEN || '';
const RING_SIZE = 1000;

const startedAt = new Date();
const commit = (() => {
  try {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'inconnu';
  }
})();

// Journal en mémoire, lisible via /logs. Copié aussi sur la sortie standard (journald).
const ring = [];
export function log(level, msg) {
  const line = new Date().toISOString() + ' ' + level + ' ' + msg;
  ring.push(line);
  if (ring.length > RING_SIZE) ring.shift();
  (level === 'ERROR' ? console.error : console.log)(line);
}

const sha = (s) => createHash('sha256').update(s).digest();
function bearerOk(req, expected) {
  if (!expected) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return !!m && timingSafeEqual(sha(m[1]), sha(expected)); // hachage : comparaison à longueur fixe
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

export const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      ok: true,
      commit,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  }
  if (req.method === 'GET' && url.pathname === '/logs') {
    if (!LOGS_TOKEN) return send(res, 503, { error: 'LOGS_TOKEN non configuré' });
    if (!bearerOk(req, LOGS_TOKEN)) {
      log('WARN', 'accès /logs refusé depuis ' + (req.headers['x-forwarded-for'] || req.socket.remoteAddress));
      return send(res, 401, { error: 'non autorisé' });
    }
    const n = Math.min(Math.max(parseInt(url.searchParams.get('n') || '200', 10) || 200, 1), RING_SIZE);
    return send(res, 200, { commit, lines: ring.slice(-n) });
  }
  send(res, 404, { error: 'introuvable' });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => log('INFO', `flipper-bridge ${commit} en écoute sur ${HOST}:${PORT}`));
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { log('INFO', 'arrêt (' + sig + ')'); server.close(() => process.exit(0)); });
  }
}
