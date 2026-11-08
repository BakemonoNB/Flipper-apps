// Relais entre l'API (modèles, sessions Claude) et le téléphone connecté en WebSocket.
// Le téléphone reste seul juge : il connaît le niveau de chaque outil et demande la validation.
//
// Protocole WebSocket (JSON, un objet par message) :
//   téléphone -> serveur : {type:'auth', token}            premier message, sous 5 s
//                          {type:'state', state}           état du Flipper (connecté, nom, batterie)
//                          {type:'result', id, ok, result|error}
//                          {type:'chat', …} {type:'chat_reset', …}   voir chat.js
//   serveur -> téléphone : {type:'welcome', commit, models}
//                          {type:'call', id, tool, args, origin}   origin : modèle à l'origine (affichage seulement)
//                          {type:'chat_event', …} {type:'chat_history', …}   voir chat.js
import { tokenOk } from './auth.js';

const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 25000;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const ORIGIN = /^[a-z0-9-]{1,20}$/;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// hooks (facultatifs, branchés après coup) : onChat(msg), onChatReset(model), welcome() -> {models, histories}
export function createBridge({ phoneToken, commit, log, callTimeoutMs = 120000, hooks = {} }) {
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
        const extra = hooks.welcome ? hooks.welcome() : { models: [], histories: [] };
        ws.send(JSON.stringify({ type: 'welcome', commit, models: extra.models }));
        for (const h of extra.histories) ws.send(JSON.stringify(h));
        log('INFO', 'téléphone connecté (' + remote + ')');
        return;
      }

      if (msg.type === 'chat') {
        if (hooks.onChat) hooks.onChat(msg);
      } else if (msg.type === 'chat_reset') {
        if (hooks.onChatReset) hooks.onChatReset(msg.model);
      } else if (msg.type === 'state') {
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
  // origin sert uniquement à l'affichage sur le téléphone ; il ne donne aucun droit.
  function call(tool, args = {}, origin = 'api', { timeoutMs = callTimeoutMs } = {}) {
    if (typeof tool !== 'string' || !TOOL_NAME.test(tool)) return Promise.reject(new HttpError(400, 'nom d\'outil invalide'));
    if (!args || typeof args !== 'object' || Array.isArray(args)) return Promise.reject(new HttpError(400, 'args doit être un objet'));
    if (!phone) return Promise.reject(new HttpError(409, 'téléphone non connecté'));
    const id = nextId++;
    const ws = phone.ws;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new HttpError(504, 'pas de réponse du téléphone'));
      }, timeoutMs);
      pending.set(id, { ws, resolve, reject, timer });
      const from = typeof origin === 'string' && ORIGIN.test(origin) ? origin : 'api';
      ws.send(JSON.stringify({ type: 'call', id, tool, args, origin: from }));
      // Lectures en rafale (sauvegarde : des centaines) : pas journalisées, elles videraient le journal.
      if (tool !== 'read_file' && tool !== 'list_files') log('INFO', 'appel ' + id + ' -> téléphone : ' + tool + ' (' + from + ')');
    });
  }

  // Envoie un message au téléphone s'il est connecté. Renvoie false sinon.
  function send(obj) {
    if (!phone) return false;
    phone.ws.send(JSON.stringify(obj));
    return true;
  }

  function status() {
    return { phone: phone ? { since: phone.since, state: phone.state } : null };
  }

  return { onConnection, call, status, send };
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
    firmware: cleanFirmware(s.firmware),
  };
}

// Firmware lu par le téléphone (system_device_info) : fork (Official, Momentum…), version, API « 87.1 ».
function cleanFirmware(fw) {
  if (!fw || typeof fw !== 'object') return null;
  const str = (v) => (typeof v === 'string' && /^[\w .+-]{1,40}$/.test(v) ? v : null);
  const api = typeof fw.api === 'string' && /^\d{1,3}\.\d{1,3}$/.test(fw.api) ? fw.api : null;
  return api || str(fw.version) ? { fork: str(fw.fork), version: str(fw.version), api } : null;
}
