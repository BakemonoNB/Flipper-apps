// Pont VPS <-> téléphone pour le Flipper.
// Variables : PORT (3040), HOST (127.0.0.1),
//   PHONE_TOKEN : jeton de l'app téléphone (WebSocket /ws),
//   API_TOKEN   : jeton des appelants de l'API (/api/*, et /logs),
//   LOGS_TOKEN  : jeton de lecture du journal (/logs).
// Catalogue : CATALOG_URL, FLIPPER_API (88.2 = firmware 1.5.1), CATALOG_TARGET (f7).
// Mémoire : BRAIN_DIR (/srv/brain/_Claude) : lecture des notes flipper, écriture dans _drafts/inbox/.
// Compilation : BUILD_URL (http://127.0.0.1:3050), BUILD_TOKEN (service builder/).
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
import { createBuilds } from './builds.js';
import { createMemory } from './memory.js';
import { createCatalog } from './catalog.js';
import { createGithub } from './github.js';
import { createFirmware } from './firmware.js';
import { createBackups } from './backups.js';

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
const BUILD_URL = process.env.BUILD_URL || 'http://127.0.0.1:3050';
const BUILD_TOKEN = process.env.BUILD_TOKEN || '';
const BRAIN_DIR = process.env.BRAIN_DIR || '/srv/brain/_Claude';
const CATALOG_URL = process.env.CATALOG_URL || 'https://catalog.flipperzero.one/api/v0';
const FLIPPER_API = process.env.FLIPPER_API || '88.2';
const CATALOG_TARGET = process.env.CATALOG_TARGET || 'f7';
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

// Outils exécutés sur le VPS ; les autres sont relayés au téléphone.
// install_fap est interne : seul install_app (donc un .fap sorti du builder) peut l'appeler.
// Firmware du Flipper tel que le téléphone l'a lu à la connexion (null si inconnu).
const liveFirmware = () => {
  const ph = bridge.status().phone;
  const f = ph && ph.state && ph.state.firmware;
  return f && (f.api || f.version) ? f : null;
};
const isMomentum = () => { const f = liveFirmware() || {}; return /momentum/i.test(f.fork || '') || /^mntm/i.test(f.version || ''); };
const builds = createBuilds({ url: BUILD_URL, token: BUILD_TOKEN, log, sdk: () => (isMomentum() ? 'momentum' : 'official'), callPhone: (t, a, o, opts) => bridge.call(t, a, o, opts) });
const memory = createMemory({ brainDir: BRAIN_DIR, log });
const catalog = createCatalog({ url: CATALOG_URL, target: CATALOG_TARGET, api: () => (liveFirmware() || {}).api || FLIPPER_API, log, callPhone: (t, a, o, opts) => bridge.call(t, a, o, opts) });
const github = createGithub({ build: (a, meta) => builds.build(a, meta), log });
const firmware = createFirmware({ log, callPhone: (t, a, o, opts) => bridge.call(t, a, o, opts),
  indexes: { official: process.env.FW_INDEX_OFFICIAL, momentum: process.env.FW_INDEX_MOMENTUM, unleashed: process.env.FW_INDEX_UNLEASHED } });
let backups = null; // créé une fois STATE_DIR connu (plus bas)
const INTERNAL_TOOLS = new Set(['install_fap', 'install_firmware']);
export async function callTool(name, args, origin) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (name === 'memory_search') return memory.search(a);
  if (name === 'memory_read') return memory.read(a);
  if (name === 'memory_note') return memory.note(a, origin);
  if (name === 'catalog_search') return catalog.search(a);
  if (name === 'install_catalog_app') return catalog.install(a, origin);
  if (name === 'build_app') return builds.build(args);
  if (name === 'github_build') return github.build(a);
  if (name === 'update_firmware') return firmware.update(a, origin);
  if (name === 'backup') return backups.run(a, origin);
  if (name === 'install_app') return builds.install(args, origin);
  if (INTERNAL_TOOLS.has(name)) return { ok: false, error: 'outil interne : passe par build_app puis install_app' };
  return bridge.call(name, args, origin);
}

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

backups = createBackups({ dir: join(STATE_DIR, 'backups'), log, callPhone: (t, a, o, opts) => bridge.call(t, a, o, opts) });

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
  ollamaPrompt: readFileSync(new URL('./prompt-gptoss.md', import.meta.url), 'utf8'),
  ollamaThink: process.env.OLLAMA_THINK || 'medium',
  stateDir: STATE_DIR,
  workDir: fileURLToPath(new URL('./workspace', import.meta.url)),
  mcpConfigPath,
  claudeBin: CLAUDE_BIN,
  ollamaUrl: OLLAMA_URL,
  ollamaNumCtx: OLLAMA_NUM_CTX,
  log,
  sendToPhone: (obj) => bridge.send(obj),
  callTool: (name, args, origin) => callTool(name, args, origin),
  contextLine: () => {
    const f = liveFirmware();
    return 'Firmware actuel du Flipper : ' + (f ? (f.fork || '?') + ' ' + (f.version || '') + (f.api ? ' (API ' + f.api + ')' : '') : 'inconnu (Flipper pas encore connecté au téléphone)') + '.';
  },
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

  // Fichiers d'un paquet de firmware préparé (adresse non devinable, valable 3 h) : lus par le téléphone.
  if ((req.method === 'GET' || req.method === 'OPTIONS') && p.startsWith('/fw/')) return firmware.serve(req, res, p);
  if ((req.method === 'GET' || req.method === 'OPTIONS') && p.startsWith('/bk/')) return backups.serve(req, res, p);

  if (p.startsWith('/api/')) {
    if (!API_TOKEN) return send(res, 503, { error: 'API_TOKEN non configuré' });
    if (!requestAuthorized(req, API_TOKEN)) {
      log('WARN', 'accès ' + p + ' refusé (' + remoteOf(req) + ')');
      return send(res, 401, { error: 'non autorisé' });
    }
    if (req.method === 'GET' && p === '/api/status') return send(res, 200, bridge.status());
    if (req.method === 'POST' && p === '/api/call') {
      const body = await readJson(req);
      const r = await callTool(body.tool, body.args === undefined ? {} : body.args, body.origin);
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
