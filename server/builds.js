// Outils exécutés sur le VPS, pas sur le téléphone : compilation des apps C par le builder (builder/),
// puis installation du .fap via le téléphone (outil interne install_fap, validé par Mikha).
import { randomBytes } from 'node:crypto';

const MAX_KEEP = 10;           // compilations gardées en mémoire
const MAX_LOG = 5000;          // journal renvoyé au modèle (le contexte de gpt-oss est petit)
const APPID = /^[A-Za-z0-9_]{1,40}$/;
const CATEGORY = /^[A-Za-z0-9_]{1,20}$/;

function trimLog(s) {
  s = String(s || '');
  return s.length > MAX_LOG ? s.slice(0, 800) + '\n[... journal coupé ...]\n' + s.slice(-(MAX_LOG - 800)) : s;
}

// Extrait du code C montré à Mikha au moment de l'installation.
function sourcePreview(files) {
  const parts = Object.entries(files)
    .filter(([p, v]) => typeof v === 'string' && /\.(c|h|fam)$/.test(p))
    .map(([p, v]) => '// ' + p + '\n' + v);
  const text = parts.join('\n\n');
  return text.length > 8000 ? text.slice(0, 8000) + '\n… (' + (text.length - 8000) + ' caractères de plus)' : text;
}

// sdk() : « official » ou « momentum », selon le firmware lu par le téléphone (le builder a un SDK par firmware).
export function createBuilds({ url, token, log, callPhone, sdk = () => 'official', now = () => Date.now() }) {
  const builds = new Map(); // build_id -> { appid, fap, files, preview, at }

  // meta.source : provenance montrée à Mikha avec le code (ex. dépôt GitHub).
  async function build(args, meta = {}) {
    if (!token) return { ok: false, error: 'compilateur non configuré (BUILD_TOKEN absent)' };
    const files = args && args.files;
    if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) {
      return { ok: false, error: 'files doit être un objet {"chemin": "contenu"}, avec au moins application.fam et un .c' };
    }
    let res;
    try {
      res = await fetch(url.replace(/\/$/, '') + '/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-build-token': token },
        body: JSON.stringify({ files, sdk: sdk() }),
        signal: AbortSignal.timeout(180000),
      });
    } catch (e) {
      return { ok: false, error: 'compilateur injoignable : ' + e.message };
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) return { ok: false, error: 'une compilation est déjà en cours, réessaie dans un moment' };
    if (res.status === 401) { log('ERROR', 'builder : jeton refusé'); return { ok: false, error: 'compilateur mal configuré (jeton)' }; }
    if (!res.ok) return { ok: false, error: 'compilateur : ' + (body.log || 'HTTP ' + res.status) };
    if (!body.ok) return { ok: false, error: 'la compilation a échoué : lis le journal', log: trimLog(body.log) };
    if (!APPID.test(body.appid || '')) return { ok: false, error: 'appid invalide (lettres, chiffres, _ ; 40 max)', log: trimLog(body.log) };
    const fap = Buffer.from(body.fap, 'base64');
    const id = 'b' + randomBytes(4).toString('hex');
    const preview = (meta.source ? '// Source : ' + meta.source + '\n\n' : '') + sourcePreview(files);
    builds.set(id, { appid: body.appid, fap, files: Object.keys(files), preview, at: now() });
    while (builds.size > MAX_KEEP) builds.delete(builds.keys().next().value);
    log('INFO', 'compilation ' + id + ' : ' + body.appid + ' (' + fap.length + ' octets)');
    return { ok: true, result: { build_id: id, appid: body.appid, size: fap.length, log: trimLog(body.log) } };
  }

  async function install(args, origin) {
    const b = builds.get(args && args.build_id);
    if (!b) return { ok: false, error: 'build_id inconnu (les compilations ne sont gardées qu\'en mémoire : recompile)' };
    const category = args.category === undefined ? 'Tools' : args.category;
    if (typeof category !== 'string' || !CATEGORY.test(category) || category.toLowerCase() === 'system') {
      return { ok: false, error: 'category invalide (ex. Tools, Games, GPIO, Misc)' };
    }
    const path = '/ext/apps/' + category + '/' + b.appid + '.fap';
    return callPhone('install_fap', {
      path, appid: b.appid, size: b.fap.length, files: b.files, source: b.preview, base64: b.fap.toString('base64'),
    }, origin, { timeoutMs: 300000 });
  }

  return { build, install };
}
