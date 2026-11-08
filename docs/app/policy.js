// Règles de chemins appliquées par le TÉLÉPHONE aux demandes des modèles.
// La carte SD est en FAT : insensible à la casse, donc toutes les comparaisons se font en minuscules.

export const MAX_READ_BYTES = 64 * 1024;
export const MAX_WRITE_BYTES = 64 * 1024;
export const SCRIPTS_DIR = '/ext/apps/Scripts';

// Lecture soumise à validation : copies de badges, cartes, télécommandes, clés U2F.
const SENSITIVE = ['/ext/nfc', '/ext/lfrfid', '/ext/ibutton', '/ext/subghz', '/ext/u2f'];
// Seuls endroits où un modèle peut écrire ou supprimer.
// /ext/asset_packs : packs d'animations, d'icônes et de polices de Momentum (personnalisation).
const WRITABLE = ['/ext/apps/scripts', '/ext/apps_data', '/ext/asset_packs'];

const under = (p, dir) => p === dir || p.startsWith(dir + '/');

// Valide et normalise un chemin de la carte SD. Lève une Error lisible sinon.
export function normPath(p) {
  if (typeof p !== 'string' || !p) throw new Error('chemin manquant');
  if (p.length > 255) throw new Error('chemin trop long');
  if (/[\u0000-\u001f\\]/.test(p)) throw new Error('caractère interdit dans le chemin');
  let q = p.replace(/\/+$/, '');
  if (!under(q.toLowerCase(), '/ext')) throw new Error('seule la carte SD (/ext) est accessible');
  const parts = q.split('/').slice(1);
  if (parts.some((x) => x === '' || x === '.' || x === '..')) throw new Error('chemin invalide');
  return q;
}

export const isSensitive = (p) => SENSITIVE.some((d) => under(p.toLowerCase(), d));

export function checkWritable(p) {
  const q = normPath(p);
  const l = q.toLowerCase();
  if (!WRITABLE.some((d) => under(l, d) && l !== d)) {
    throw new Error('écriture autorisée seulement dans ' + SCRIPTS_DIR + '/, /ext/apps_data/ et /ext/asset_packs/');
  }
  return q;
}

export function checkScript(p) {
  const q = normPath(p);
  if (!under(q.toLowerCase(), SCRIPTS_DIR.toLowerCase()) || !q.toLowerCase().endsWith('.js')) {
    throw new Error('un script doit être un fichier .js dans ' + SCRIPTS_DIR + '/');
  }
  return q;
}

export const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));

// Installation d'une app : /ext/apps/<Catégorie>/<appid>.fap uniquement (jamais System).
export const MAX_FAP_BYTES = 1024 * 1024;
export function checkFapPath(p) {
  const q = normPath(p);
  const m = /^\/ext\/apps\/([A-Za-z0-9_-]{1,24})\/([A-Za-z0-9_-]{1,48})\.fap$/.exec(q);
  if (!m || m[1].toLowerCase() === 'system') throw new Error('une app s\'installe dans /ext/apps/<Catégorie>/<appid>.fap (pas System)');
  return q;
}
export const isFap = (name) => typeof name === 'string' && name.toLowerCase().endsWith('.fap');
