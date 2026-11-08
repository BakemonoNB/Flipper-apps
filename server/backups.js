// Sauvegardes de dossiers de la carte SD du Flipper sur le VPS (ex. /ext/dolphin : animations du dauphin),
// et restauration. Lecture : outils list_files / read_file du téléphone (niveau lecture). Restauration :
// un seul outil restore_files côté téléphone (une validation pour tout le lot), qui télécharge les fichiers
// depuis /bk/<tâche>/<chemin> (adresse aléatoire, 3 h).
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MAX_FILES = 3000;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_DEPTH = 10;
const JOB_TTL = 3 * 3600 * 1000;
const BACKUP_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
// Segment de nom de fichier du Flipper accepté (FAT) : ni « / », ni « .. », ni caractère de contrôle.
const segOk = (s) => typeof s === 'string' && s.length > 0 && s.length <= 128 && s !== '.' && s !== '..' && !/[\u0000-\u001f/\\]/.test(s);
const DEFINITIVE = /introuvable|trop gros|c'est un dossier|refusé par Mikha|invalide|interdit|seule la carte SD|outil inconnu/;
const relOk = (rel) => typeof rel === 'string' && rel.split('/').every(segOk);

// progress(texte, pourcentage | null) : affiché sur le téléphone pendant une sauvegarde (null, null : fin).
export function createBackups({ dir, log, callPhone, progress = () => {}, now = () => new Date(), RECONNECT_MS = 180000, RETRY_MS = 3000 }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jobs = new Map(); // id -> { at, root, files: Map(rel -> abs) }

  // Appel au téléphone qui survit aux coupures du WebSocket (5G, app brièvement en arrière-plan) : on attend
  // le retour du téléphone et on refait la même lecture, jusqu'à 3 min sans réponse.
  async function phone(tool, args, origin) {
    const until = Date.now() + RECONNECT_MS;
    for (;;) {
      let r;
      try {
        r = await callPhone(tool, args, origin);
      } catch (e) {
        if (!/déconnecté|non connecté|pas de réponse/.test(e.message) || Date.now() > until) throw e;
        progress('Connexion au téléphone coupée : reprise dès son retour…', null);
        await new Promise((s) => setTimeout(s, RETRY_MS));
        continue;
      }
      if (!r || r.ok === false) {
        const err = (r && r.error) || 'échec';
        // Erreurs définitives : inutile de refaire. Les autres (Flipper qui ne répond pas à temps, Bluetooth
        // décroché, app rechargée) sont passagères : même attente, même lecture.
        if (DEFINITIVE.test(err) || Date.now() > until) throw new Error(tool + ' ' + (args.path || '') + ' : ' + err);
        progress('Le Flipper ne répond pas (' + err.slice(0, 60) + ') : nouvel essai…', null);
        await new Promise((s) => setTimeout(s, RETRY_MS));
        continue;
      }
      return r.result;
    }
  }

  async function save(a, origin) {
    const src = typeof a.path === 'string' ? a.path.replace(/\/+$/, '') : '';
    if (!/^\/ext(\/|$)/i.test(src) || !src.split('/').slice(1).every(segOk)) return { ok: false, error: 'path : un dossier de la carte SD, ex. /ext/dolphin' };
    const slug = (src.split('/').filter(Boolean).slice(1).join('_') || 'sd').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 50);
    // Copie en cours dans <slug>.partial : gardée si la sauvegarde échoue, et reprise au prochain essai
    // (un fichier déjà copié avec la même taille n'est pas relu).
    const root = join(dir, slug + '.partial');
    const files = [];
    let reused = 0;
    let total = 0;
    const queue = [{ path: src, rel: '', depth: 0 }];
    let lastTick = 0;
    progress('Sauvegarde de ' + src + ' : lecture…', null);
    try {
      while (queue.length) {
        const d = queue.shift();
        const list = await phone('list_files', { path: d.path }, origin);
        if (list.truncated) throw new Error('plus de 300 éléments dans ' + d.path);
        for (const e of list.entries || []) {
          if (!segOk(e.name)) throw new Error('nom refusé : ' + d.path + '/' + e.name);
          const path = d.path + '/' + e.name;
          const rel = d.rel ? d.rel + '/' + e.name : e.name;
          if (e.type === 'dir') {
            if (d.depth + 1 > MAX_DEPTH) throw new Error('dossiers trop imbriqués : ' + path);
            queue.push({ path, rel, depth: d.depth + 1 });
            continue;
          }
          if (files.length >= MAX_FILES) throw new Error('plus de ' + MAX_FILES + ' fichiers');
          const abs = join(root, 'files', ...rel.split('/'));
          let data;
          if (Number.isInteger(e.size) && existsSync(abs) && statSync(abs).size === e.size) {
            data = readFileSync(abs);
            reused++;
          } else {
            const r = await phone('read_file', { path }, origin);
            data = typeof r.base64 === 'string' ? Buffer.from(r.base64, 'base64') : Buffer.from(String(r.text ?? ''), 'utf8');
            mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
            writeFileSync(abs, data, { mode: 0o600 });
          }
          total += data.length;
          if (total > MAX_TOTAL) throw new Error('plus de ' + MAX_TOTAL / 1048576 + ' Mo');
          files.push({ path: rel, size: data.length, sha256: sha256(data) });
          if (Date.now() - lastTick > 1000) { lastTick = Date.now(); progress('Sauvegarde de ' + src + ' : ' + files.length + ' fichiers lus', null); }
        }
      }
    } catch (e) {
      progress(null, null);
      return { ok: false, error: 'sauvegarde interrompue (' + files.length + ' fichiers copiés, gardés) : ' + e.message
        + '. Relance backup action=save avec le même path : elle reprendra là où elle s\'est arrêtée.' };
    }
    progress(null, null);
    const stamp = now().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    let name = slug + '-' + stamp;
    for (let i = 2; existsSync(join(dir, name)); i++) name = slug + '-' + stamp + '-' + i;
    mkdirSync(join(root, 'files'), { recursive: true, mode: 0o700 });
    renameSync(root, join(dir, name));
    const manifest = { name, source: src, created: now().toISOString(), files };
    writeFileSync(join(dir, name, 'manifest.json'), JSON.stringify(manifest, null, 1), { mode: 0o600 });
    log('INFO', 'sauvegarde ' + name + ' : ' + files.length + ' fichiers (' + reused + ' repris d\'un essai précédent), ' + total + ' octets');
    return { ok: true, result: { name, source: src, files: files.length, reused: reused || undefined, bytes: total, hint: 'backup action=restore name=' + name + ' pour la remettre' } };
  }

  function manifestOf(name) {
    if (!BACKUP_NAME.test(name || '')) return null;
    try { return JSON.parse(readFileSync(join(dir, name, 'manifest.json'), 'utf8')); } catch { return null; }
  }

  function list() {
    const out = [];
    for (const n of readdirSync(dir)) {
      const m = manifestOf(n);
      if (m) out.push({ name: m.name, source: m.source, created: m.created, files: m.files.length, bytes: m.files.reduce((s, f) => s + f.size, 0) });
    }
    out.sort((x, y) => (x.created < y.created ? 1 : -1));
    return { ok: true, result: { backups: out } };
  }

  async function restore(a, origin) {
    const m = manifestOf(a.name);
    if (!m) return { ok: false, error: 'sauvegarde inconnue (backup action=list)' };
    if (!m.files.every((f) => relOk(f.path))) return { ok: false, error: 'sauvegarde abîmée (chemins)' };
    for (const [id, j] of jobs) if (Date.now() - j.at > JOB_TTL) jobs.delete(id);
    const id = randomBytes(16).toString('hex');
    jobs.set(id, { at: Date.now(), root: join(dir, m.name, 'files'), files: new Set(m.files.map((f) => f.path)) });
    return callPhone('restore_files', { job: id, name: m.name, dest: m.source, created: m.created, files: m.files }, origin, { timeoutMs: JOB_TTL });
  }

  // Vérification immédiate (avant de lancer la tâche de fond) : message d'erreur, ou null.
  function check(args) {
    const a = args && typeof args === 'object' ? args : {};
    if (a.action === 'save') return typeof a.path === 'string' && /^\/ext(\/|$)/i.test(a.path) ? null : 'path : un dossier de la carte SD, ex. /ext/dolphin';
    if (a.action === 'restore') return manifestOf(a.name) ? null : 'sauvegarde inconnue (backup action=list)';
    if (a.action === 'list') return null;
    return 'action : save (path), list, restore (name)';
  }

  async function run(args, origin) {
    const a = args && typeof args === 'object' ? args : {};
    if (a.action === 'save') return save(a, origin);
    if (a.action === 'list') return list();
    if (a.action === 'restore') return restore(a, origin);
    return { ok: false, error: 'action : save (path), list, restore (name)' };
  }

  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '600' };
  // GET /bk/<tâche>/<chemin encodé> : un fichier de la sauvegarde en cours de restauration.
  function serve(req, res, path) {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const m = /^\/bk\/([a-f0-9]{32})\/(.+)$/.exec(path);
    const job = m && jobs.get(m[1]);
    let rel = null;
    try { rel = m ? decodeURIComponent(m[2]) : null; } catch { rel = null; }
    if (!job || Date.now() - job.at > JOB_TTL || !rel || !job.files.has(rel) || !relOk(rel)) {
      res.writeHead(404, { ...CORS, 'content-type': 'text/plain' });
      return res.end('introuvable');
    }
    const data = readFileSync(join(job.root, ...rel.split('/')));
    res.writeHead(200, { ...CORS, 'content-type': 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-store' });
    res.end(data);
  }

  return { run, serve, check };
}
