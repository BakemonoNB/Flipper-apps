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
  storageList: 7, storageListResponse: 8,
  storageRead: 9, storageReadResponse: 10,
  storageWrite: 11,
  storageDelete: 12,
  storageMkdir: 13,
  storageStat: 24, storageStatResponse: 25,
  appStart: 16,
  appGetError: 63, appGetErrorResponse: 64,
};

// Taille des données par message d'écriture de fichier (comme qFlipper).
const FILE_CHUNK = 512;
const utf8 = (s) => new TextEncoder().encode(s);

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

// Taille des morceaux écrits. 20 octets tiennent toujours dans une seule écriture Bluetooth.
// Au-delà, iOS peut faire une « écriture longue » que le Flipper refuse (code 2 vu dans Bluefy),
// et la connexion reste ensuite bloquée. probeChunk() mesure la plus grande taille acceptée.
export const MIN_CHUNK = 20;
export const PROBE_SIZES = [20, 32, 48, 64, 96, 128, 160, 180, 240];

// Texte lisible pour toute erreur, y compris les codes bruts (nombres) que renvoie parfois Bluefy.
export function errText(e) {
  if (e instanceof Error || (e && typeof e === 'object' && 'message' in e)) {
    const name = e.name && e.name !== 'Error' ? e.name : '';
    return [name, e.message].filter(Boolean).join(' : ') || 'erreur sans message';
  }
  return 'code brut ' + String(e);
}

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
export function encodeRequest(id, field, body = new Uint8Array(0), hasNext = false) {
  const main = concat(fieldVarint(F.commandId, id), fieldVarint(F.hasNext, hasNext ? 1 : 0), fieldBytes(field, body));
  return concat(varint(main.length), main);
}

// PB_Storage.File : type=1 (0 fichier, 1 dossier), name=2, size=3, data=4.
export function decodeFile(bytes) {
  const f = decodeFields(bytes);
  const name = getField(f, 2);
  const data = getField(f, 4);
  return {
    type: getValue(f, 1) === 1 ? 'dir' : 'file',
    name: name ? new TextDecoder().decode(name.bytes) : '',
    size: getValue(f, 3),
    data: data ? data.bytes : new Uint8Array(0),
  };
}

export const encodePath = (path) => fieldBytes(1, utf8(path));
export function encodeWriteChunks(path, data) {
  const chunks = [];
  for (let o = 0; o === 0 || o < data.length; o += FILE_CHUNK) {
    const part = data.subarray(o, o + FILE_CHUNK);
    const file = part.length ? fieldBytes(4, part) : new Uint8Array(0);
    chunks.push(concat(fieldBytes(1, utf8(path)), fieldBytes(2, file)));
  }
  return chunks;
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
    this.chunk = MIN_CHUNK;
    this.flowFree = null;      // place libre annoncée par le Flipper (octets), null = inconnue
    this.flowWaiters = [];
    this._onFlow = (ev) => {
      this.flowFree = ev.target.value.getUint32(0, false);
      const w = this.flowWaiters; this.flowWaiters = [];
      for (const r of w) r();
    };
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
    this.flowFree = null;
    if (this.flow) {
      try {
        this.flowFree = (await this.flow.readValue()).getUint32(0, false);
        this.flow.addEventListener('characteristicvaluechanged', this._onFlow);
        await this.flow.startNotifications();
      } catch {
        this.flowFree = null; // sans contrôle de débit : on écrit sans attendre
      }
    }
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
  // bodies : un tableau pour envoyer la commande en plusieurs messages (has_next sur tous sauf le dernier).
  request(field, body = new Uint8Array(0), { timeout = 5000 } = {}) {
    if (!this.connected) return Promise.reject(new Error('Flipper non connecté'));
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1;
    const bodies = Array.isArray(body) ? body : [body];
    const frame = concat(...bodies.map((b, i) => encodeRequest(id, field, b, i < bodies.length - 1)));
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

  // Envoie des pings de taille croissante, chacun en UNE écriture, et renvoie la plus grande taille acceptée.
  // Après un refus, la connexion peut rester bloquée : il faut se reconnecter.
  async probeChunk(onStep = () => {}) {
    let best = 0;
    for (const size of PROBE_SIZES) {
      const id = this.nextId;
      this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1;
      // Trame ping = longueur + command_id + champ 5 { champ 1 = données } : plus grande trame <= size.
      let frame = null;
      for (let n = 1; n <= size; n++) {
        const f = encodeRequest(id, F.pingRequest, fieldBytes(1, crypto.getRandomValues(new Uint8Array(n))));
        if (f.length > size) break;
        frame = f;
      }
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('pas de réponse')); }, 4000);
        this.pending.set(id, { parts: [], resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      });
      reply.catch(() => {}); // évite un rejet non traité si l'écriture échoue avant
      try {
        const w = this.writeChain.then(async () => {
          if (this.rx.writeValueWithResponse) await this.rx.writeValueWithResponse(frame);
          else await this.rx.writeValue(frame);
        });
        this.writeChain = w.catch(() => {});
        await w;
        await reply;
        best = frame.length;
        onStep(frame.length, true);
      } catch (e) {
        const p = this.pending.get(id);
        this.pending.delete(id);
        if (p) p.resolve(null); // arrête son minuteur
        onStep(frame.length, false, errText(e));
        break;
      }
    }
    return best;
  }

  startScreen() { return this.request(F.guiStartScreenStream); }
  stopScreen() { return this.request(F.guiStopScreenStream); }

  input(key, type) {
    return this.request(F.guiSendInput, concat(fieldVarint(1, key), fieldVarint(2, type)));
  }

  // ---------- Fichiers (carte SD) ----------

  async list(path) {
    const parts = await this.request(F.storageList, encodePath(path), { timeout: 15000 });
    const out = [];
    for (const p of parts) {
      for (const f of p.filter((x) => x.field === F.storageListResponse)) {
        for (const e of decodeFields(f.bytes).filter((x) => x.field === 1)) {
          const file = decodeFile(e.bytes);
          out.push({ name: file.name, type: file.type, size: file.size });
        }
      }
    }
    return out;
  }

  async stat(path) {
    const parts = await this.request(F.storageStat, encodePath(path));
    const r = getField(parts[0], F.storageStatResponse);
    const file = r ? getField(decodeFields(r.bytes), 1) : null;
    if (!file) return null;
    const d = decodeFile(file.bytes);
    return { type: d.type, size: d.size };
  }

  async read(path) {
    const parts = await this.request(F.storageRead, encodePath(path), { timeout: 30000 });
    const chunks = [];
    for (const p of parts) {
      const r = getField(p, F.storageReadResponse);
      const file = r ? getField(decodeFields(r.bytes), 1) : null;
      if (file) chunks.push(decodeFile(file.bytes).data);
    }
    return concat(...chunks);
  }

  write(path, data) {
    return this.request(F.storageWrite, encodeWriteChunks(path, data), { timeout: 30000 + data.length * 5 });
  }

  delete(path, recursive = false) {
    return this.request(F.storageDelete, concat(encodePath(path), fieldVarint(2, recursive ? 1 : 0)));
  }

  // Crée le dossier et ses parents (ignore « existe déjà »).
  async mkdirs(path) {
    const parts = path.split('/').filter(Boolean);
    for (let i = 2; i <= parts.length; i++) {
      const p = '/' + parts.slice(0, i).join('/');
      try { await this.request(F.storageMkdir, encodePath(p)); }
      catch (e) { if (!(e instanceof RpcError && e.status === 6)) throw e; }
    }
  }

  // ---------- Apps ----------

  async startApp(name, args = '') {
    const body = concat(fieldBytes(1, utf8(name)), args ? fieldBytes(2, utf8(args)) : new Uint8Array(0));
    try {
      await this.request(F.appStart, body, { timeout: 10000 });
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      let detail = '';
      try {
        const parts = await this.request(F.appGetError);
        const r = getField(parts[0], F.appGetErrorResponse);
        const text = r ? getField(decodeFields(r.bytes), 2) : null;
        if (text) detail = ' : ' + new TextDecoder().decode(text.bytes);
      } catch { /* pas de détail */ }
      throw new Error(e.message + detail);
    }
  }

  // ---------- interne ----------

  _write(bytes) {
    // Une seule opération GATT à la fois : Web Bluetooth refuse les écritures simultanées.
    // TODO étape 5 : respecter la place libre annoncée par `flow` pour les gros transferts.
    const run = async () => {
      let o = 0;
      while (o < bytes.length) {
        if (!this.rx) throw new Error('Flipper déconnecté');
        const part = bytes.subarray(o, o + this.chunk);
        await this._waitFlow(part.length);
        try {
          if (this.rx.writeValueWithResponse) await this.rx.writeValueWithResponse(part);
          else await this.rx.writeValue(part);
        } catch (e) {
          // Écriture avec réponse refusée : les octets n'ont pas été pris, on peut les renvoyer plus petits.
          if (this.chunk > MIN_CHUNK && this.rx) {
            this.chunk = MIN_CHUNK;
            this.dispatchEvent(new CustomEvent('notice', { detail: 'écriture de ' + part.length + ' octets refusée (' + errText(e) + ') : passage à des morceaux de ' + MIN_CHUNK + ' octets' }));
            continue;
          }
          throw new Error('écriture Bluetooth refusée (' + part.length + ' octets) : ' + errText(e));
        }
        if (this.flowFree !== null) this.flowFree = Math.max(0, this.flowFree - part.length);
        o += part.length;
      }
    };
    const p = this.writeChain.then(run);
    this.writeChain = p.catch(() => {});
    return p;
  }

  // Attend que le tampon du Flipper ait la place d'accueillir n octets.
  // Sécurité : si aucune notification n'arrive, on relit la valeur, puis on continue quand même.
  async _waitFlow(n) {
    for (let tries = 0; this.flowFree !== null && this.flowFree < n && tries < 3; tries++) {
      const notified = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 2000);
        this.flowWaiters.push(() => { clearTimeout(t); resolve(true); });
      });
      if (!notified && this.flow) {
        try { this.flowFree = (await this.flow.readValue()).getUint32(0, false); } catch { /* on continue */ }
      }
    }
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
    if (this.flow) this.flow.removeEventListener('characteristicvaluechanged', this._onFlow);
    this.flowFree = null;
    for (const r of this.flowWaiters) r();
    this.flowWaiters = [];
    this.rx = this.tx = this.flow = null;
    for (const p of this.pending.values()) p.reject(new Error('Flipper déconnecté'));
    this.pending.clear();
    this.writeChain = Promise.resolve();
    this.dispatchEvent(new Event('disconnected'));
  }
}
