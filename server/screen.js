// Conversion de l'écran du Flipper (1024 octets, 128x64, pages de 8 lignes) en PNG ou en texte.
import { deflateSync, crc32 } from 'node:zlib';

export const W = 128, H = 64;
const pixel = (d, x, y) => (d[(y >> 3) * W + x] >> (y & 7)) & 1;

export function decodeScreen(result) {
  const d = Buffer.from(result.data, 'base64');
  if (d.length < W * H / 8) throw new Error('image d\'écran incomplète');
  const flip = result.orientation === 1;
  return (x, y) => (flip ? pixel(d, W - 1 - x, H - 1 - y) : pixel(d, x, y));
}

// PNG en niveaux de gris 8 bits, agrandi `scale` fois (pixels allumés en noir sur orange clair).
export function screenToPng(result, scale = 4) {
  const on = decodeScreen(result);
  const w = W * scale, h = H * scale;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // pas de filtre
    for (let x = 0; x < w; x++) {
      const lit = on(Math.floor(x / scale), Math.floor(y / scale));
      const o = row + 1 + x * 3;
      raw[o] = lit ? 26 : 255; raw[o + 1] = lit ? 16 : 139; raw[o + 2] = lit ? 0 : 26;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8 bits, RVB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Texte : '#' = pixel allumé. step=2 divise la taille par deux (une case allumée si un des 4 pixels l'est).
export function screenToText(result, step = 2) {
  const on = decodeScreen(result);
  const lines = [];
  for (let y = 0; y < H; y += step) {
    let line = '';
    for (let x = 0; x < W; x += step) {
      let lit = 0;
      for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) lit |= on(x + dx, y + dy);
      line += lit ? '#' : '.';
    }
    lines.push(line.replace(/\.+$/, ''));
  }
  return lines.join('\n');
}
