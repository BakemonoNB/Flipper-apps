// WebSocket côté serveur (RFC 6455), sans dépendance : messages texte, ping/pong, fermeture.
// Volontairement minimal : pas d'extensions (compression), un message fait au plus MAX_PAYLOAD octets.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_PAYLOAD = 1 << 20; // 1 Mo

// Accepte la mise à niveau HTTP -> WebSocket. Renvoie une WsConnection, ou null si la requête est invalide.
export function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const isWs = (req.headers.upgrade || '').toLowerCase() === 'websocket';
  if (!isWs || !key || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  return new WsConnection(socket, head);
}

// Évènements : 'message' (texte), 'pong', 'close' (code, raison).
export class WsConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.frags = [];
    this.fragOpcode = 0;
    this.fragSize = 0;
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
    socket.on('close', () => this._finish(1006, 'connexion coupée'));
    socket.on('error', () => socket.destroy());
    // Laisse l'appelant brancher ses écouteurs avant de traiter les octets déjà reçus.
    queueMicrotask(() => this._parse());
  }

  send(text) {
    this._frame(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    this._frame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(String(reason), 'utf8').subarray(0, 123);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._frame(0x8, p);
    this._finish(code, reason);
  }

  _parse() {
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      if (b[0] & 0x70) return this.close(1002, 'bits réservés non nuls');
      if (!(b[1] & 0x80)) return this.close(1002, 'trame client non masquée');
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.close(1009, 'message trop gros');
        len = Number(big);
        off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009, 'message trop gros');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);

      if (opcode >= 0x8) {
        if (!fin || len > 125) return this.close(1002, 'trame de contrôle invalide');
        if (opcode === 0x8) {
          const code = len >= 2 ? payload.readUInt16BE(0) : 1005;
          this._frame(0x8, len >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
          return this._finish(code, payload.subarray(2).toString('utf8'));
        }
        if (opcode === 0x9) this._frame(0xa, payload);
        else if (opcode === 0xa) this.emit('pong');
        else return this.close(1002, 'opcode inconnu');
        continue;
      }

      if (opcode === 0x0) {
        if (!this.fragOpcode) return this.close(1002, 'continuation inattendue');
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragOpcode) return this.close(1002, 'message fragmenté interrompu');
        this.fragOpcode = opcode;
        this.frags = [];
        this.fragSize = 0;
      } else {
        return this.close(1002, 'opcode inconnu');
      }
      this.fragSize += payload.length;
      if (this.fragSize > MAX_PAYLOAD) return this.close(1009, 'message trop gros');
      this.frags.push(payload);
      if (fin) {
        const data = Buffer.concat(this.frags);
        const op = this.fragOpcode;
        this.frags = [];
        this.fragOpcode = 0;
        this.fragSize = 0;
        if (op === 0x1) this.emit('message', data.toString('utf8'));
        else return this.close(1003, 'messages binaires non acceptés');
      }
    }
  }

  _frame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.emit('close', code, reason);
  }
}
