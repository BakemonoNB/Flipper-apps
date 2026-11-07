// Client Flipper Zero : Bluetooth (service série) + RPC protobuf.
// Numéros de champs vérifiés contre les définitions officielles (flipper.proto, system.proto, gui.proto).

export const UUID = {
  service: '8fe5b3d5-2e7f-4a98-2a48-7acc60fe0000',
  rx: '19ed82ae-ed21-4c9d-4145-228e62fe0000',   // téléphone -> Flipper (write)
  tx: '19ed82ae-ed21-4c9d-4145-228e61fe0000',   // Flipper -> téléphone (indicate)
  flow: '19ed82ae-ed21-4c9d-4145-228e63fe0000', // place libre dans le tampon du Flipper (uint32 big-endian)
};

// Champs de PB.Main utilisés ici.
export const F = {
  commandId: 1,
  commandStatus: 2,
  hasNext: 3,
  pingRequest: 5,
  pingResponse: 6,
  guiStartScreenStream: 20,
  guiStopScreenStream: 21,
  guiScreenFrame: 22,
  guiSendInput: 23,
};

export const Key = { UP: 0, DOWN: 1, RIGHT: 2, LEFT: 3, OK: 4, BACK: 5 };
export const InputType = { PRESS: 0, RELEASE: 1, SHORT: 2, LONG: 3, REPEAT: 4 };

const STATUS = {
  1: 'ERROR', 2: 'ERROR_DECODE', 3: 'ERROR_NOT_IMPLEMENTED', 4: 'ERROR_BUSY',
  5: 'ERROR_STORAGE_NOT_READY', 6: 'ERROR_STORAGE_EXIST', 7: 'ERROR_STORAGE_NOT_EXIST',
  8: 'ERROR_STORAGE_INVALID_PARAMETER', 9: 'ERROR_STORAGE_DENIED', 10: 'ERROR_STORAGE_INVALID_NAME',
  11: 'ERROR_STORAGE_INTERNAL', 12: 'ERROR_STORAGE_NOT_IMPLEMENTED', 13: 'ERROR_STORAGE_ALREADY_OPEN',
  14: 'ERROR_CONTINUOUS_COMMAND_INTERRUPTED', 15: 'ERROR_INVALID_PARAMETERS', 16: 'ERROR_APP_CANT_START',
  17: 'ERROR_APP_SYSTEM_LOCKED', 18: 'ERROR_STORAGE_DIR_NOT_EMPTY', 21: 'ERROR_APP_NOT_RUNNING',
  22: 'ERROR_APP_CMD_ERROR',
};

// Taille des morceaux écrits : sous la MTU que négocie iOS, pour éviter les écritures longues.
const WRITE_CHUNK = 180;

// ---------- Protobuf minimal ----------

export function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Uint8Array.from(out);
}

// -> [valeur, position après], ou null si le tampon s'arrête avant la fin du varint.
export function readVarint(b, p) {
  let v = 0, s = 0;
  while (p < b.length) {
    const x = b[p++];
    v += (x & 0x7f) * 2 ** s;
    if (!(x & 0x80)) return [v, p];
    s += 7;
    if (s > 49) throw new Error('varint invalide');
  }
  return null;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Champ varint ; omis s'il vaut 0, comme le fait protobuf.
export const fieldVarint = (field, value) =>
  value ? concat(varint(field * 8), varint(value)) : new Uint8Array(0);

export const fieldBytes = (field, bytes) =>
  concat(varint(field * 8 + 2), varint(bytes.length), bytes);

export function decodeFields(b) {
  const out = [];
  let p = 0;
  while (p < b.length) {
    const t = readVarint(b, p);
    if (!t) throw new Error('message tronqué');
    p = t[1];
    const field = Math.floor(t[0] / 8), wt = t[0] & 7;
    if (wt === 0) {
      const v = readVarint(b, p);
      if (!v) throw new Error('message tronqué');
      out.push({ field, wt, value: v[0] });
      p = v[1];
    } else if (wt === 2) {
      const l = readVarint(b, p);
      if (!l || l[1] + l[0] > b.length) throw new Error('message tronqué');
      p = l[1];
      out.push({ field, wt, bytes: b.slice(p, p + l[0]) });
      p += l[0];
    } else if (wt === 1 || wt === 5) {
      const n = wt === 1 ? 8 : 4;
      if (p + n > b.length) throw new Error('message tronqué');
      out.push({ field, wt, bytes: b.slice(p, p + n) });
      p += n;
    } else {
      throw new Error('wire type non géré : ' + wt);
    }
  }
  return out;
}

export const getField = (fields, n) => fields.find((f) => f.field === n);
const getValue = (fields, n) => { const f = getField(fields, n); return f ? f.value : 0; };

// Requête PB.Main complète, préfixée par sa longueur.
export function encodeRequest(id, field, body = new Uint8Array(0)) {
  const main = concat(fieldVarint(F.commandId, id), fieldBytes(field, body));
  return concat(varint(main.length), main);
}

// Écran 128x64, 1 bit par pixel, rangé par pages de 8 lignes (bit 0 = ligne du haut de la page).
export const SCREEN_W = 128, SCREEN_H = 64;
export function pixelOn(data, x, y) {
  return (data[(y >> 3) * SCREEN_W + x] >> (y & 7)) & 1;
}

export class RpcError extends Error {
  constructor(status) {
    super('Le Flipper a répondu ' + (STATUS[status] || 'statut ' + status));
    this.status = status;
  }
}

// ---------- Client ----------
// Évènements : 'connected', 'disconnected', 'screen' (detail: {data, orientation}),
// 'unsolicited' (detail: {id, fields}), 'error' (detail: Error).

export class Flipper extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.rx = this.tx = this.flow = null;
    this.buf = new Uint8Array(0);
    this.nextId = 1;
    this.pending = new Map();
    this.writeChain = Promise.resolve();
    this._onValue = (ev) => {
      const v = ev.target.value;
      this._onBytes(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    };
  }

  get connected() {
    return !!(this.device && this.device.gatt.connected && this.rx && this.tx);
  }

  get name() {
    return this.device ? this.device.name || 'Flipper' : null;
  }

  // Doit être appelé directement depuis un geste de l'utilisateur (tap).
  async pick({ all = false } = {}) {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth absent : ouvre la page dans Bluefy.');
    const optionalServices = [UUID.service, 'battery_service'];
    const device = await navigator.bluetooth.requestDevice(all
      ? { acceptAllDevices: true, optionalServices }
      : { filters: [{ namePrefix: 'Flipper' }], optionalServices });
    if (this.device && this.device !== device && this.device.gatt.connected) this.device.gatt.disconnect();
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => { if (this.device === device) this._onDisconnect(); });
    return device;
  }

  async connect() {
    if (!this.device) throw new Error('Aucun Flipper choisi');
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(UUID.service);
    const chars = await svc.getCharacteristics();
    const byUuid = (u) => chars.find((c) => c.uuid.toLowerCase() === u) || null;
    this.rx = byUuid(UUID.rx);
    this.tx = byUuid(UUID.tx);
    this.flow = byUuid(UUID.flow);
    if (!this.rx || !this.tx) throw new Error('Service série incomplet sur ce Flipper');
    this.buf = new Uint8Array(0);
    this.tx.addEventListener('characteristicvaluechanged', this._onValue);
    await this.tx.startNotifications(); // peut déclencher l'appairage (code affiché sur le Flipper)
    this.dispatchEvent(new Event('connected'));
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
  }

  async battery() {
    try {
      const svc = await this.device.gatt.getPrimaryService('battery_service');
      const c = await svc.getCharacteristic('battery_level');
      return (await c.readValue()).getUint8(0);
    } catch {
      return null;
    }
  }

  // Envoie une commande et attend la réponse complète (plusieurs messages si has_next).
  request(field, body = new Uint8Array(0), { timeout = 5000 } = {}) {
    if (!this.connected) return Promise.reject(new Error('Flipper non connecté'));
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1;
    const frame = encodeRequest(id, field, body);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Pas de réponse du Flipper (commande ' + field + ')'));
      }, timeout);
      this.pending.set(id, {
        parts: [],
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._write(frame).catch((e) => {
        const p = this.pending.get(id);
        if (p) { this.pending.delete(id); p.reject(e); }
      });
    });
  }

  async ping(data = crypto.getRandomValues(new Uint8Array(4))) {
    const t = performance.now();
    const parts = await this.request(F.pingRequest, fieldBytes(1, data));
    const pong = getField(parts[0], F.pingResponse);
    const echoed = pong ? getField(decodeFields(pong.bytes), 1) : null;
    const same = !!echoed && echoed.bytes.length === data.length && echoed.bytes.every((b, i) => b === data[i]);
    if (!same) throw new Error('Réponse au ping incorrecte');
    return performance.now() - t;
  }

  startScreen() { return this.request(F.guiStartScreenStream); }
  stopScreen() { return this.request(F.guiStopScreenStream); }

  input(key, type) {
    return this.request(F.guiSendInput, concat(fieldVarint(1, key), fieldVarint(2, type)));
  }

  // ---------- interne ----------

  _write(bytes) {
    // Une seule opération GATT à la fois : Web Bluetooth refuse les écritures simultanées.
    // TODO étape 5 : respecter la place libre annoncée par `flow` pour les gros transferts.
    const run = async () => {
      for (let o = 0; o < bytes.length; o += WRITE_CHUNK) {
        if (!this.rx) throw new Error('Flipper déconnecté');
        const part = bytes.subarray(o, o + WRITE_CHUNK);
        if (this.rx.writeValueWithResponse) await this.rx.writeValueWithResponse(part);
        else await this.rx.writeValue(part);
      }
    };
    const p = this.writeChain.then(run);
    this.writeChain = p.catch(() => {});
    return p;
  }

  _onBytes(chunk) {
    this.buf = concat(this.buf, chunk);
    try {
      for (;;) {
        const lv = readVarint(this.buf, 0);
        if (!lv || this.buf.length < lv[1] + lv[0]) return;
        const msg = this.buf.slice(lv[1], lv[1] + lv[0]);
        this.buf = this.buf.slice(lv[1] + lv[0]);
        this._onMessage(decodeFields(msg));
      }
    } catch (e) {
      this.buf = new Uint8Array(0);
      this.dispatchEvent(new CustomEvent('error', { detail: e }));
    }
  }

  _onMessage(fields) {
    const frame = getField(fields, F.guiScreenFrame);
    if (frame) {
      const ff = decodeFields(frame.bytes);
      const data = getField(ff, 1);
      if (data && data.bytes.length >= SCREEN_W * SCREEN_H / 8) {
        this.dispatchEvent(new CustomEvent('screen', { detail: { data: data.bytes, orientation: getValue(ff, 2) } }));
      }
      return;
    }
    const id = getValue(fields, F.commandId);
    const p = this.pending.get(id);
    if (!p) {
      this.dispatchEvent(new CustomEvent('unsolicited', { detail: { id, fields } }));
      return;
    }
    p.parts.push(fields);
    const status = getValue(fields, F.commandStatus);
    if (status !== 0) {
      this.pending.delete(id);
      p.reject(new RpcError(status));
    } else if (!getValue(fields, F.hasNext)) {
      this.pending.delete(id);
      p.resolve(p.parts);
    }
  }

  _onDisconnect() {
    if (this.tx) this.tx.removeEventListener('characteristicvaluechanged', this._onValue);
    this.rx = this.tx = this.flow = null;
    for (const p of this.pending.values()) p.reject(new Error('Flipper déconnecté'));
    this.pending.clear();
    this.writeChain = Promise.resolve();
    this.dispatchEvent(new Event('disconnected'));
  }
}
