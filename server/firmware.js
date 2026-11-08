// Changement / mise à jour du firmware du Flipper, par Bluetooth via le téléphone (comme l'app officielle).
// Le VPS télécharge le paquet de mise à jour (update_tgz, cible f7) UNIQUEMENT depuis l'index officiel ou
// celui de Momentum, vérifie son empreinte SHA-256 publiée dans l'index, le décompresse et sert ses fichiers
// au téléphone (/fw/<tâche>/<fichier>, adresse non devinable, 3 h). Le téléphone les copie dans
// /ext/update/<dossier>/, demande la mise à jour au Flipper puis le redémarre. Mikha valide toujours.
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { parseTar } from './github.js';

export const FIRMWARES = {
  official: { label: 'Officiel', index: 'https://update.flipperzero.one/firmware/directory.json' },
  momentum: { label: 'Momentum', index: 'https://up.momentum-fw.dev/firmware/directory.json' },
};
const CHANNELS = ['release', 'rc', 'development'];
const MAX_PKG = 120 * 1024 * 1024;
const MAX_UNPACKED = 400 * 1024 * 1024;
const JOB_TTL = 3 * 3600 * 1000;
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export function createFirmware({ log, callPhone, indexes = {}, fetchImpl = fetch, now = () => Date.now() }) {
  const jobs = new Map(); // id -> { key, at, dir, files: Map(name -> { data, sha256 }), ... }

  const indexOf = (fw) => indexes[fw] || FIRMWARES[fw].index;

  async function fetchOk(url, what, limit) {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'flipper-bridge' }, redirect: 'follow', signal: AbortSignal.timeout(600000) });
    if (!res.ok) throw new Error(what + ' : HTTP ' + res.status + ' (' + url + ')');
    const len = Number(res.headers.get('content-length') || 0);
    if (limit && len > limit) throw new Error(what + ' trop gros (' + Math.round(len / 1048576) + ' Mo)');
    const buf = Buffer.from(await res.arrayBuffer());
    if (limit && buf.length > limit) throw new Error(what + ' trop gros');
    return buf;
  }

  function sweep() {
    for (const [id, j] of jobs) if (now() - j.at > JOB_TTL) jobs.delete(id);
  }

  async function prepare(fw, channel) {
    sweep();
    const url = indexOf(fw);
    let index;
    try { index = JSON.parse((await fetchOk(url, 'index des versions', 8 * 1024 * 1024)).toString('utf8')); }
    catch (e) { throw new Error('index ' + FIRMWARES[fw].label + ' illisible : ' + e.message); }
    const ch = (index.channels || []).find((c) => c.id === channel);
    const v = ch && (ch.versions || [])[0];
    if (!v) throw new Error('aucune version dans le canal « ' + channel + ' » de ' + FIRMWARES[fw].label + ' (canaux : ' + (index.channels || []).map((c) => c.id).join(', ') + ')');
    const file = (v.files || []).find((f) => f.type === 'update_tgz' && f.target === 'f7');
    if (!file || typeof file.url !== 'string') throw new Error('pas de paquet de mise à jour f7 pour ' + v.version);
    if (!/^[a-f0-9]{64}$/i.test(file.sha256 || '')) throw new Error('l\'index ne publie pas l\'empreinte du paquet : refusé');
    if (!/^https:\/\//.test(file.url)) throw new Error('adresse du paquet non HTTPS : refusé');
    const key = fw + '|' + channel + '|' + v.version + '|' + file.sha256.toLowerCase();
    for (const [id, j] of jobs) if (j.key === key) { j.at = now(); return { id, job: j }; }

    const gz = await fetchOk(file.url, 'paquet ' + v.version, MAX_PKG);
    const got = sha256(gz);
    if (got !== file.sha256.toLowerCase()) throw new Error('empreinte du paquet incorrecte (' + got.slice(0, 12) + '… au lieu de ' + file.sha256.slice(0, 12) + '…) : refusé');
    const entries = parseTar(gunzipSync(gz, { maxOutputLength: MAX_UNPACKED }))
      .map((e) => ({ name: e.name.replace(/^\.\//, ''), data: e.data }));
    // Un paquet = un seul dossier (ex. f7-update-1.5.1/) avec des fichiers à plat, dont update.fuf.
    const tops = new Set(entries.map((e) => e.name.split('/')[0]));
    if (tops.size !== 1) throw new Error('paquet inattendu (' + tops.size + ' dossiers racine)');
    const dir = [...tops][0];
    if (!NAME.test(dir)) throw new Error('nom de dossier du paquet refusé : ' + dir);
    const files = new Map();
    for (const e of entries) {
      const rest = e.name.slice(dir.length + 1);
      if (!rest) continue;
      if (rest.includes('/') || !NAME.test(rest)) throw new Error('fichier inattendu dans le paquet : ' + e.name);
      files.set(rest, { data: e.data, sha256: sha256(e.data) });
    }
    if (!files.has('update.fuf')) throw new Error('paquet sans manifeste update.fuf');
    const id = randomBytes(16).toString('hex');
    const job = { key, at: now(), fw, channel, version: v.version, dir, source: file.url, sha256: file.sha256.toLowerCase(), files };
    // Une seule tâche gardée (un paquet Momentum pèse des dizaines de Mo en mémoire).
    jobs.clear();
    jobs.set(id, job);
    const total = [...files.values()].reduce((s, f) => s + f.data.length, 0);
    log('INFO', 'firmware ' + FIRMWARES[fw].label + ' ' + v.version + ' prêt : ' + files.size + ' fichiers, ' + total + ' octets');
    return { id, job };
  }

  async function update(args, origin) {
    const a = args && typeof args === 'object' ? args : {};
    const fw = typeof a.firmware === 'string' ? a.firmware.toLowerCase() : '';
    if (!Object.hasOwn(FIRMWARES, fw)) return { ok: false, error: 'firmware : « official » ou « momentum » (aucune autre source)' };
    const channel = a.channel === undefined ? 'release' : a.channel;
    if (!CHANNELS.includes(channel)) return { ok: false, error: 'channel : ' + CHANNELS.join(', ') };
    let p;
    try { p = await prepare(fw, channel); }
    catch (e) { return { ok: false, error: e.message }; }
    const { id, job } = p;
    return callPhone('install_firmware', {
      job: id, dir: job.dir, firmware: fw, label: FIRMWARES[fw].label, version: String(job.version).slice(0, 64), channel,
      source: job.source, sha256: job.sha256,
      files: [...job.files].map(([name, f]) => ({ name, size: f.data.length, sha256: f.sha256 })),
    }, origin, { timeoutMs: JOB_TTL });
  }

  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-max-age': '600' };
  // GET /fw/<tâche>/<fichier> : sert un fichier du paquet préparé.
  function serve(req, res, path) {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const m = /^\/fw\/([a-f0-9]{32})\/([A-Za-z0-9._-]{1,64})$/.exec(path);
    const job = m && jobs.get(m[1]);
    const f = job && now() - job.at <= JOB_TTL ? job.files.get(m[2]) : null;
    if (!f) { res.writeHead(404, { ...CORS, 'content-type': 'text/plain' }); return res.end('introuvable'); }
    res.writeHead(200, { ...CORS, 'content-type': 'application/octet-stream', 'content-length': f.data.length, 'cache-control': 'no-store' });
    res.end(f.data);
  }

  return { update, serve, prepare };
}
