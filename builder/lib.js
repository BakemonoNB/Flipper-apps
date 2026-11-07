// Fonctions pures du builder : validation des fichiers reçus, archive tar (écriture et lecture).
import { createHash, timingSafeEqual } from 'node:crypto';

export const LIMITS = {
  maxFiles: 50,
  maxTotal: 512 * 1024, // octets décodés, tous fichiers confondus
  maxPath: 100, // champ « name » d'un en-tête tar ustar
  maxFap: 1024 * 1024,
  maxLog: 64 * 1024,
};

const sha = (s) => createHash('sha256').update(String(s)).digest();

// Comparaison à temps constant (via hachage, donc indépendante de la longueur).
export function tokenOk(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  return timingSafeEqual(sha(given), sha(expected));
}

// Chemin relatif simple : segments [A-Za-z0-9._-], ni absolu, ni « . » / « .. », ni segment vide.
export function pathError(p) {
  if (typeof p !== 'string' || !p) return 'chemin vide';
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return 'chemin absolu interdit : ' + p;
  if (Buffer.byteLength(p) > LIMITS.maxPath) return 'chemin trop long (100 octets max) : ' + p;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '..') return '« .. » interdit : ' + p;
    if (s === '' || s === '.') return 'segment vide ou « . » interdit : ' + p;
    if (!/^[A-Za-z0-9._-]+$/.test(s)) return 'caractère interdit dans le chemin : ' + p;
  }
  return null;
}

// { chemin: "texte" | { base64: "..." } } -> [{ path, data: Buffer }] ; lève une Error lisible sinon.
export function validateFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('« files » doit être un objet');
  const entries = Object.entries(files);
  if (entries.length === 0) throw new Error('aucun fichier');
  if (entries.length > LIMITS.maxFiles) throw new Error(`trop de fichiers (${entries.length} > ${LIMITS.maxFiles})`);
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const [path, v] of entries) {
    const err = pathError(path);
    if (err) throw new Error(err);
    let data;
    if (typeof v === 'string') data = Buffer.from(v, 'utf8');
    else if (v && typeof v === 'object' && typeof v.base64 === 'string') {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(v.base64)) throw new Error('base64 invalide : ' + path);
      data = Buffer.from(v.base64, 'base64');
    } else throw new Error('contenu invalide (texte ou {"base64": ...}) : ' + path);
    total += data.length;
    if (total > LIMITS.maxTotal) throw new Error(`fichiers trop gros (plus de ${LIMITS.maxTotal} octets au total)`);
    seen.add(path);
    out.push({ path, data });
  }
  // Un fichier ne peut pas être aussi un dossier (ex. « a » et « a/b »).
  for (const { path } of out) {
    const segs = path.split('/');
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      if (seen.has(dir)) throw new Error('« ' + dir + ' » est à la fois fichier et dossier');
    }
  }
  if (!seen.has('application.fam')) throw new Error('application.fam manquant à la racine');
  return out;
}

// Archive tar ustar minimale : fichiers ordinaires 0644, propriétaire 0, date fixe.
export function makeTar(files) {
  const parts = [];
  for (const { path, data } of files) {
    const h = Buffer.alloc(512);
    h.write(path, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148); // somme de contrôle calculée avec des espaces
    h.write('0', 156);
    h.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// Lecture d'une archive tar (sortie du conteneur) : { nom: Buffer } pour les fichiers ordinaires.
export function readTar(buf) {
  const out = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, n) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const name = (prefix ? prefix + '/' : '') + field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    if (!Number.isFinite(size) || size < 0) throw new Error('archive de sortie invalide');
    const start = off + 512;
    if (start + size > buf.length) throw new Error('archive de sortie tronquée');
    if (type === '0') out[name.replace(/^\.\//, '')] = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

// Journal limité à maxLog octets : début et fin.
export function truncateLog(s, max = LIMITS.maxLog) {
  if (Buffer.byteLength(s) <= max) return s;
  const b = Buffer.from(s);
  const mark = '\n[... journal tronqué ...]\n';
  const head = 8192;
  return b.subarray(0, head).toString() + mark + b.subarray(b.length - (max - head - mark.length - 16)).toString();
}
