// Pont VPS <-> téléphone pour le Flipper.
// Variables : PORT (3040), HOST (127.0.0.1),
//   PHONE_TOKEN : jeton de l'app téléphone (WebSocket /ws),
//   API_TOKEN   : jeton des appelants de l'API (/api/*, et /logs),
//   LOGS_TOKEN  : jeton de lecture du journal (/logs).
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acceptUpgrade } from './ws.js';
import { createBridge, HttpError } from './bridge.js';
import { requestAuthorized } from './auth.js';

const PORT = Number(process.env.PORT || 3040);
const HOST = process.env.HOST || '127.0.0.1';
const PHONE_TOKEN = process.env.PHONE_TOKEN || '';
const API_TOKEN = process.env.API_TOKEN || '';
const LOGS_TOKEN = process.env.LOGS_TOKEN || '';
const RING_SIZE = 1000;
const MAX_BODY = 64 * 1024;

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

export const bridge = createBridge({ phoneToken: PHONE_TOKEN, commit, log });

const remoteOf = (req) => req.headers['x-forwarded-for'] || req.socket.remoteAddress;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'corps trop gros')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'JSON invalide')); }
    });
    req.on('error', reject);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/health') {
    return send(res, 200, {
      ok: true,
      commit,
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
  }

  if (req.method === 'GET' && p === '/logs') {
    if (!LOGS_TOKEN && !API_TOKEN) return send(res, 503, { error: 'aucun jeton configuré pour /logs' });
    if (!requestAuthorized(req, LOGS_TOKEN, API_TOKEN)) {
      log('WARN', 'accès /logs refusé (' + remoteOf(req) + ')');
      return send(res, 401, { error: 'non autorisé' });
    }
    const n = Math.min(Math.max(parseInt(url.searchParams.get('n') || '200', 10) || 200, 1), RING_SIZE);
    return send(res, 200, { commit, lines: ring.slice(-n) });
  }

  if (p.startsWith('/api/')) {
    if (!API_TOKEN) return send(res, 503, { error: 'API_TOKEN non configuré' });
    if (!requestAuthorized(req, API_TOKEN)) {
      log('WARN', 'accès ' + p + ' refusé (' + remoteOf(req) + ')');
      return send(res, 401, { error: 'non autorisé' });
    }
    if (req.method === 'GET' && p === '/api/status') return send(res, 200, bridge.status());
    if (req.method === 'POST' && p === '/api/call') {
      const body = await readJson(req);
      const r = await bridge.call(body.tool, body.args === undefined ? {} : body.args);
      return send(res, 200, r);
    }
  }

  send(res, 404, { error: 'introuvable' });
}

export const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) log('ERROR', (e && e.stack) || String(e));
    if (!res.headersSent) send(res, status, { error: e.message || 'erreur interne' });
  });
});

server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://local').pathname;
  if (p !== '/ws' || !PHONE_TOKEN) {
    socket.end('HTTP/1.1 ' + (PHONE_TOKEN ? '404 Not Found' : '503 Service Unavailable') + '\r\nConnection: close\r\n\r\n');
    return;
  }
  const ws = acceptUpgrade(req, socket, head);
  if (ws) bridge.onConnection(ws, remoteOf(req));
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => log('INFO', `flipper-bridge ${commit} en écoute sur ${HOST}:${PORT}`));
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { log('INFO', 'arrêt (' + sig + ')'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
  }
}
