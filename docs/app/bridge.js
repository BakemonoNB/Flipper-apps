// Client WebSocket vers le pont du VPS (server/ dans ce repo).
// Évènements : 'status' (detail: statut), 'call' (detail: {id, tool, args}),
// 'message' (detail: welcome, chat_event ou chat_history, voir server/chat.js).
// Statuts : off (non configuré), connecting, online, refused (jeton refusé), replaced, offline.

const MAX_BACKOFF_MS = 30000;

export class BridgeClient extends EventTarget {
  constructor() {
    super();
    this.url = '';
    this.token = '';
    this.ws = null;
    this.status = 'off';
    this.backoff = 1000;
    this.retryTimer = null;
  }

  configure(url, token) {
    this.stop();
    this.url = url;
    this.token = token;
    if (url && token) this.start();
    else this._set('off');
  }

  start() {
    clearTimeout(this.retryTimer);
    if (!this.url || !this.token) { this._set('off'); return; }
    if (this.ws && this.ws.readyState <= 1) return; // déjà en cours ou ouvert
    this._set('connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this._set('offline');
      this._retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.token }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'welcome') {
        this.backoff = 1000;
        this._set('online');
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      } else if (msg.type === 'chat_event' || msg.type === 'chat_history') {
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      } else if (msg.type === 'call' && Number.isInteger(msg.id) && typeof msg.tool === 'string') {
        this.dispatchEvent(new CustomEvent('call', { detail: { id: msg.id, tool: msg.tool, args: msg.args || {} } }));
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4003) { this._set('refused'); return; }   // jeton invalide : inutile de réessayer
      if (ev.code === 4000) { this._set('replaced'); return; }  // un autre appareil a pris la place
      this._set('offline');
      this._retry();
    };
    ws.onerror = () => {};
  }

  stop() {
    clearTimeout(this.retryTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(1000, 'arrêt'); } catch { /* déjà fermé */ }
    }
  }

  // Reconnexion immédiate (retour au premier plan, par exemple).
  wake() {
    if (this.status === 'offline' || this.status === 'replaced') {
      this.backoff = 1000;
      this.start();
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1 && this.status === 'online') {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  reply(id, ok, payload) {
    return this.send(ok ? { type: 'result', id, ok: true, result: payload } : { type: 'result', id, ok: false, error: String(payload) });
  }

  _retry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  _set(status) {
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }
}
