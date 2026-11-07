import { createHash, timingSafeEqual } from 'node:crypto';

const sha = (s) => createHash('sha256').update(String(s)).digest();

// Comparaison à temps constant (via hachage, donc indépendante de la longueur).
export function tokenOk(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  return timingSafeEqual(sha(given), sha(expected));
}

// Jeton d'une requête HTTP : « Authorization: Bearer … » ou « X-Flipper-Token: … ».
export function requestToken(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (m) return m[1];
  const h = req.headers['x-flipper-token'];
  return typeof h === 'string' ? h : '';
}

// Vrai si la requête porte l'un des jetons attendus (les jetons vides sont ignorés).
export function requestAuthorized(req, ...expected) {
  const given = requestToken(req);
  return expected.some((e) => tokenOk(given, e));
}
