// Apps C depuis GitHub : télécharge l'archive d'un dépôt public, garde le dossier de l'app (celui qui contient
// application.fam) et le compile avec le builder (conteneur sans réseau, lecture seule). L'installation reste
// install_app : Mikha valide sur le téléphone et voit le code. Aucun binaire tout fait n'est jamais installé.
import { gunzipSync } from 'node:zlib';

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._\/-]{1,100}$/;
const SUBPATH = /^[A-Za-z0-9._\/-]{1,200}$/;
const SEG = /^[A-Za-z0-9._-]+$/;
const MAX_ARCHIVE = 25 * 1024 * 1024;   // .tar.gz téléchargé
const MAX_UNPACKED = 150 * 1024 * 1024; // une fois décompressé
// Limites du builder (builder/lib.js) : vérifiées ici pour donner une erreur claire au modèle.
export const LIMITS = { maxFiles: 50, maxTotal: 512 * 1024, maxPath: 100 };
const SKIP_DIRS = new Set(['.git', '.github', '.vscode', '.catalog', '.ufbt', 'screenshots', 'docs', 'dist', 'build']);
const SKIP_FILE = /(\.(md|markdown)$)|(^(license|licence|copying)(\..*)?$)/i;

// Archive tar (ustar + en-têtes pax et GNU des archives GitHub) -> [{ name, data }] pour les fichiers ordinaires.
export function parseTar(buf) {
  const out = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (a, n) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('archive invalide');
    const type = field(156, 1) || '0';
    const start = off + 512;
    if (start + size > buf.length) throw new Error('archive tronquée');
    const data = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === 'x') { // pax : « longueur path=valeur\n »
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'g') continue;
    const prefix = field(345, 155);
    const name = longName || (prefix ? prefix + '/' : '') + field(0, 100);
    longName = null;
    if (type === '0' || type === '7') out.push({ name, data });
  }
  return out;
}

const isText = (data) => !data.includes(0) && Buffer.from(data.toString('utf8'), 'utf8').equals(data);

// Choisit le dossier de l'app et prépare { chemin relatif: texte | {base64} } pour le builder.
export function pickApp(entries, subpath = '') {
  // Les archives GitHub ont un dossier racine « owner-repo-sha/ » : on le retire.
  const files = entries
    .map((e) => ({ path: e.name.split('/').slice(1).join('/'), data: e.data }))
    .filter((e) => e.path);
  const sub = subpath.replace(/^\/+|\/+$/g, '');
  const fams = files.filter((e) => e.path === 'application.fam' || e.path.endsWith('/application.fam'))
    .map((e) => e.path.slice(0, -'application.fam'.length).replace(/\/$/, ''));
  if (!fams.length) throw new Error('aucun application.fam dans ce dépôt : ce n\'est pas une app C pour Flipper (ou elle est générée)');
  let dir;
  if (sub) {
    if (!fams.includes(sub)) throw new Error('pas d\'application.fam dans « ' + sub + ' ». Dossiers possibles : ' + fams.map((d) => d || '(racine)').join(', '));
    dir = sub;
  } else if (fams.includes('')) dir = '';
  else if (fams.length === 1) dir = fams[0];
  else throw new Error('plusieurs apps dans ce dépôt : précise path parmi ' + fams.slice(0, 20).join(', '));

  const prefix = dir ? dir + '/' : '';
  const kept = {};
  const skipped = [];
  let total = 0;
  let count = 0;
  const sizes = [];
  for (const e of files) {
    if (!e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    const segs = rel.split('/');
    // Une autre app dans un sous-dossier : on ne la mélange pas avec celle-ci.
    if (segs.some((s) => s.startsWith('.') || SKIP_DIRS.has(s.toLowerCase())) || SKIP_FILE.test(segs[segs.length - 1])) continue;
    if (fams.some((d) => d !== dir && (d + '/').startsWith(prefix) && e.path.startsWith(d + '/'))) continue;
    if (Buffer.byteLength(rel) > LIMITS.maxPath || !segs.every((s) => SEG.test(s) && s !== '..')) { skipped.push(rel); continue; }
    kept[rel] = isText(e.data) ? e.data.toString('utf8') : { base64: e.data.toString('base64') };
    total += e.data.length;
    count++;
    sizes.push([rel, e.data.length]);
  }
  if (!('application.fam' in kept)) throw new Error('application.fam inutilisable (nom de chemin refusé)');
  if (count > LIMITS.maxFiles || total > LIMITS.maxTotal) {
    const big = sizes.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => p + ' (' + Math.round(n / 1024) + ' Ko)').join(', ');
    throw new Error('app trop grosse pour le compilateur : ' + count + ' fichiers, ' + Math.round(total / 1024)
      + ' Ko (max ' + LIMITS.maxFiles + ' fichiers, ' + LIMITS.maxTotal / 1024 + ' Ko). Plus gros : ' + big);
  }
  return { dir, files: kept, count, total, skipped };
}

export function createGithub({ build, log, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  const base = apiUrl.replace(/\/$/, '');

  async function download(repo, ref) {
    const u = base + '/repos/' + repo + '/tarball' + (ref ? '/' + ref : '');
    const res = await fetchImpl(u, {
      headers: { 'user-agent': 'flipper-bridge', accept: 'application/vnd.github+json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 404) throw new Error('dépôt ou ref introuvable (dépôt privé ?) : ' + repo + (ref ? '@' + ref : ''));
    if (res.status === 403 || res.status === 429) throw new Error('GitHub limite les téléchargements (HTTP ' + res.status + '), réessaie plus tard');
    if (!res.ok) throw new Error('GitHub : HTTP ' + res.status);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_ARCHIVE) throw new Error('dépôt trop gros (' + Math.round(len / 1048576) + ' Mo)');
    const gz = Buffer.from(await res.arrayBuffer());
    if (gz.length > MAX_ARCHIVE) throw new Error('dépôt trop gros (' + Math.round(gz.length / 1048576) + ' Mo)');
    return gunzipSync(gz, { maxOutputLength: MAX_UNPACKED });
  }

  async function buildFromGithub(args) {
    const a = args && typeof args === 'object' ? args : {};
    const repo = typeof a.repo === 'string' ? a.repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$|\/$/g, '') : '';
    if (!REPO.test(repo)) return { ok: false, error: 'repo doit être « owner/nom » (dépôt GitHub public)' };
    const ref = typeof a.ref === 'string' && a.ref ? a.ref : '';
    if (ref && (!REF.test(ref) || ref.split('/').includes('..'))) return { ok: false, error: 'ref invalide (branche, tag ou commit)' };
    const path = typeof a.path === 'string' && a.path ? a.path : '';
    if (path && (!SUBPATH.test(path) || path.split('/').includes('..'))) return { ok: false, error: 'path invalide (dossier relatif dans le dépôt)' };
    let app;
    try {
      app = pickApp(parseTar(await download(repo, ref)), path);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const source = 'https://github.com/' + repo + (ref ? ' (' + ref + ')' : '') + (app.dir ? ' — dossier ' + app.dir : '');
    log('INFO', 'github : ' + source + ', ' + app.count + ' fichiers, ' + app.total + ' octets');
    const r = await build({ files: app.files }, { source });
    if (r && r.ok) r.result = { ...r.result, source, files: app.count, skipped: app.skipped.length ? app.skipped : undefined };
    else if (r) r.source = source;
    return r;
  }

  return { build: buildFromGithub };
}
