// Relais entre l'API (modèles, sessions Claude) et le téléphone connecté en WebSocket.
// Le téléphone reste seul juge : il connaît le niveau de chaque outil et demande la validation.
//
// Protocole WebSocket (JSON, un objet par message) :
//   téléphone -> serveur : {type:'auth', token}            premier message, sous 5 s
//                          {type:'state', state}           état du Flipper (connecté, nom, batterie)
//                          {type:'result', id, ok, result|error}
//   serveur -> téléphone : {type:'welcome', commit}
//                          {type:'call', id, tool, args}
import { tokenOk } from './auth.js';

const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 25000;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createBridge({ phoneToken, commit, log, callTimeoutMs = 120000 }) {
  let phone = null; // { ws, since, state }
  let nextId = 1;
  const pending = new Map(); // id -> { ws, resolve, reject, timer }

  function rejectPendingOf(ws, err) {
    for (const [id, p] of pending) {
      if (p.ws !== ws) continue;
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  function onConnection(ws, remote) {
    let authed = false;
    let alive = true;
    const authTimer = setTimeout(() => { if (!authed) ws.close(4001, 'authentification requise'); }, AUTH_TIMEOUT_MS);
    const heartbeat = setInterval(() => {
      if (!alive) { ws.close(4008, 'pas de réponse au ping'); return; }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref();
    ws.on('pong', () => { alive = true; });

    ws.on('message', (text) => {
      alive = true;
      let msg;
      try { msg = JSON.parse(text); } catch { ws.close(4002, 'JSON invalide'); return; }
      if (!msg || typeof msg !== 'object') { ws.close(4002, 'message invalide'); return; }

      if (!authed) {
        if (msg.type !== 'auth' || !tokenOk(msg.token, phoneToken)) {
          log('WARN', 'téléphone refusé (' + remote + ')');
          ws.close(4003, 'jeton invalide');
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        if (phone) {
          log('INFO', 'nouvelle connexion du téléphone : l\'ancienne est fermée');
          phone.ws.close(4000, 'remplacée par une nouvelle connexion');
        }
        phone = { ws, since: new Date().toISOString(), state: null };
        ws.send(JSON.stringify({ type: 'welcome', commit }));
        log('INFO', 'téléphone connecté (' + remote + ')');
        return;
      }

      if (msg.type === 'state') {
        if (phone && phone.ws === ws) phone.state = cleanState(msg.state);
      } else if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p || p.ws !== ws) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg.ok
          ? { ok: true, result: msg.result === undefined ? null : msg.result }
          : { ok: false, error: String(msg.error || 'erreur inconnue').slice(0, 500) });
      }
    });

    ws.on('close', (code) => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      rejectPendingOf(ws, new HttpError(502, 'téléphone déconnecté pendant l\'appel'));
      if (phone && phone.ws === ws) {
        phone = null;
        log('INFO', 'téléphone déconnecté (code ' + code + ')');
      }
    });
  }

  // Demande au téléphone d'exécuter un outil. Résout {ok, result|error}.
  function call(tool, args = {}) {
    if (typeof tool !== 'string' || !TOOL_NAME.test(tool)) return Promise.reject(new HttpError(400, 'nom d\'outil invalide'));
    if (!args || typeof args !== 'object' || Array.isArray(args)) return Promise.reject(new HttpError(400, 'args doit être un objet'));
    if (!phone) return Promise.reject(new HttpError(409, 'téléphone non connecté'));
    const id = nextId++;
    const ws = phone.ws;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new HttpError(504, 'pas de réponse du téléphone'));
      }, callTimeoutMs);
      pending.set(id, { ws, resolve, reject, timer });
      ws.send(JSON.stringify({ type: 'call', id, tool, args }));
      log('INFO', 'appel ' + id + ' -> téléphone : ' + tool);
    });
  }

  function status() {
    return { phone: phone ? { since: phone.since, state: phone.state } : null };
  }

  return { onConnection, call, status };
}

function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  const f = s.flipper && typeof s.flipper === 'object' ? s.flipper : {};
  return {
    flipper: {
      connected: f.connected === true,
      name: typeof f.name === 'string' ? f.name.slice(0, 64) : null,
      battery: Number.isInteger(f.battery) ? f.battery : null,
    },
  };
}
