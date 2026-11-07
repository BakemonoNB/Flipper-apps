// Pont VPS <-> téléphone pour le Flipper.
// Variables : PORT (3040), HOST (127.0.0.1),
//   PHONE_TOKEN : jeton de l'app téléphone (WebSocket /ws),
//   API_TOKEN   : jeton des appelants de l'API (/api/*, et /logs),
//   LOGS_TOKEN  : jeton de lecture du journal (/logs).
// Chat : STATE_DIR (~/.flipper-bridge), CLAUDE_BIN (claude), CLAUDE_MODEL (vide = modèle par défaut),
//   OLLAMA_URL (http://127.0.0.1:11434), OLLAMA_MODEL (gpt-oss:20b), OLLAMA_NUM_CTX (8192, celui du prospecteur).
//   Claude sous l'utilisateur flipper : CLAUDE_CODE_OAUTH_TOKEN (claude setup-token).
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptUpgrade } from './ws.js';
import { createBridge, HttpError } from './bridge.js';
import { requestAuthorized } from './auth.js';
import { createChat } from './chat.js';

const PORT = Number(process.env.PORT || 3040);
const HOST = process.env.HOST || '127.0.0.1';
const PHONE_TOKEN = process.env.PHONE_TOKEN || '';
const API_TOKEN = process.env.API_TOKEN || '';
const LOGS_TOKEN = process.env.LOGS_TOKEN || '';
const WANTED_STATE_DIR = process.env.STATE_DIR || join(homedir(), '.flipper-bridge');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gpt-oss:20b';
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);
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

const hooks = {};
export const bridge = createBridge({ phoneToken: PHONE_TOKEN, commit, log, hooks });

// Dossier d'état (historique du chat, config MCP). Repli dans /tmp plutôt que de planter au démarrage.
const STATE_DIR = (() => {
  try {
    mkdirSync(WANTED_STATE_DIR, { recursive: true, mode: 0o700 });
    return WANTED_STATE_DIR;
  } catch (e) {
    const fallback = join(tmpdir(), 'flipper-bridge-' + (process.getuid ? process.getuid() : 'x'));
    mkdirSync(fallback, { recursive: true, mode: 0o700 });
    log('WARN', 'STATE_DIR ' + WANTED_STATE_DIR + ' inutilisable (' + e.code + ') : repli sur ' + fallback + ', historique perdu au redémarrage');
    return fallback;
  }
})();

// Configuration MCP pour Claude : seul le serveur Flipper, qui appelle l'API locale avec API_TOKEN.
const mcpConfigPath = join(STATE_DIR, 'mcp-flipper.json');
writeFileSync(mcpConfigPath, JSON.stringify({
  mcpServers: {
    flipper: {
      type: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-flipper.js', import.meta.url))],
      env: { FLIPPER_API_URL: 'http://127.0.0.1:' + PORT, API_TOKEN, FLIPPER_ORIGIN: 'claude' },
    },
  },
}), { mode: 0o600 });

export const chat = createChat({
  models: {
    claude: { label: 'Claude', kind: 'claude', model: CLAUDE_MODEL },
    'gpt-oss': { label: 'gpt-oss 20b (local)', kind: 'ollama', model: OLLAMA_MODEL },
  },
  systemPrompt: readFileSync(new URL('./prompt.md', import.meta.url), 'utf8'),
  stateDir: STATE_DIR,
  mcpConfigPath,
  claudeBin: CLAUDE_BIN,
  ollamaUrl: OLLAMA_URL,
  ollamaNumCtx: OLLAMA_NUM_CTX,
  log,
  sendToPhone: (obj) => bridge.send(obj),
  callTool: (name, args, origin) => bridge.call(name, args, origin),
});
hooks.onChat = (msg) => { chat.handle(msg); };
hooks.onChatReset = (model) => chat.reset(model);
hooks.welcome = () => ({ models: chat.list(), histories: chat.histories() });

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
      const r = await bridge.call(body.tool, body.args === undefined ? {} : body.args, body.origin);
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
