import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createBackups } from './backups.js';

// Faux Flipper : arborescence /ext/dolphin avec un fichier binaire et un texte.
const BIN = Buffer.from([0, 1, 2, 250, 255]);
const FS = {
  '/ext/dolphin': [{ name: 'manifest.txt', type: 'file', size: 36 }, { name: 'L1_Tv_128x47', type: 'dir' }],
  '/ext/dolphin/L1_Tv_128x47': [{ name: 'meta.txt', type: 'file', size: 10 }, { name: 'frame_0.bm', type: 'file', size: 5 }],
};
const FILES = { '/ext/dolphin/manifest.txt': 'Filetype: Flipper Animation Manifest', '/ext/dolphin/L1_Tv_128x47/meta.txt': 'Width: 128', '/ext/dolphin/L1_Tv_128x47/frame_0.bm': BIN };

function make() {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  const calls = [];
  const callPhone = async (tool, args, origin) => {
    calls.push({ tool, args, origin });
    if (tool === 'list_files') return FS[args.path] ? { ok: true, result: { path: args.path, entries: FS[args.path], truncated: false } } : { ok: false, error: 'introuvable' };
    if (tool === 'read_file') {
      const v = FILES[args.path];
      return Buffer.isBuffer(v) ? { ok: true, result: { base64: v.toString('base64') } } : { ok: true, result: { text: v } };
    }
    if (tool === 'restore_files') return { ok: true, result: { restored: args.files.length } };
    return { ok: false, error: 'outil inconnu' };
  };
  let t = 0;
  const bk = createBackups({ dir, log: () => {}, callPhone, now: () => new Date(Date.UTC(2026, 10, 8, 3, 30 + t++)) });
  return { bk, calls, dir };
}
const fakeRes = () => { const r = {}; r.writeHead = (s, h) => { r.status = s; r.headers = h; }; r.end = (b) => { r.body = b; }; return r; };

test('sauvegarde : dossier complet, binaire intact, liste, restauration servie fichier par fichier', async () => {
  const { bk, calls, dir } = make();
  try {
    const s = await bk.run({ action: 'save', path: '/ext/dolphin/' }, 'claude');
    assert.equal(s.ok, true, s.error);
    assert.equal(s.result.files, 3);
    assert.equal(s.result.name, 'dolphin-2026-11-08-03-30');
    const l = await bk.run({ action: 'list' });
    assert.equal(l.result.backups[0].files, 3);
    const r = await bk.run({ action: 'restore', name: s.result.name }, 'claude');
    assert.equal(r.ok, true);
    const call = calls.find((c) => c.tool === 'restore_files');
    assert.equal(call.args.dest, '/ext/dolphin');
    const bin = call.args.files.find((f) => f.path === 'L1_Tv_128x47/frame_0.bm');
    assert.equal(bin.sha256, createHash('sha256').update(BIN).digest('hex'));
    const res = fakeRes();
    bk.serve({ method: 'GET' }, res, '/bk/' + call.args.job + '/' + encodeURIComponent('L1_Tv_128x47/frame_0.bm'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, BIN);
    const out = fakeRes();
    bk.serve({ method: 'GET' }, out, '/bk/' + call.args.job + '/' + encodeURIComponent('../../manifest.json'));
    assert.equal(out.status, 404);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sauvegarde : refus (hors carte SD, dossier absent, nom inconnu, action inconnue)', async () => {
  const { bk, dir } = make();
  try {
    assert.match((await bk.run({ action: 'save', path: '/int' })).error, /carte SD/);
    assert.match((await bk.run({ action: 'save', path: '/ext/../int' })).error, /carte SD/);
    assert.match((await bk.run({ action: 'save', path: '/ext/absent' })).error, /interrompue.*introuvable/);
    // Erreur définitive : pas de nouvel essai.
    assert.ok(Date.now());
    assert.match((await bk.run({ action: 'restore', name: '../x' })).error, /inconnue/);
    assert.match((await bk.run({ action: 'zip' })).error, /action/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sauvegarde : survit à une coupure du téléphone (même lecture refaite)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  try {
    let cuts = 2;
    const reads = [];
    const callPhone = async (tool, args) => {
      if (tool === 'read_file' && args.path.endsWith('frame_0.bm') && cuts-- > 0) {
        throw new Error(cuts ? 'téléphone déconnecté pendant l\'appel' : 'téléphone non connecté');
      }
      if (tool === 'list_files') return { ok: true, result: { entries: FS[args.path], truncated: false } };
      reads.push(args.path);
      const v = FILES[args.path];
      return Buffer.isBuffer(v) ? { ok: true, result: { base64: v.toString('base64') } } : { ok: true, result: { text: v } };
    };
    const msgs = [];
    const bk = createBackups({ dir, log: () => {}, callPhone, progress: (t) => msgs.push(t), RETRY_MS: 5 });
    const s = await bk.run({ action: 'save', path: '/ext/dolphin' }, 'claude');
    assert.equal(s.ok, true, s.error);
    assert.equal(s.result.files, 3);
    assert.ok(msgs.some((m) => m && /reprise/.test(m)));
    const bk2 = createBackups({ dir: join(dir, 'autre'), log: () => {}, RETRY_MS: 5, RECONNECT_MS: 20, callPhone: async () => { throw new Error('téléphone non connecté'); } });
    assert.match((await bk2.run({ action: 'save', path: '/ext/dolphin' })).error, /interrompue.*non connecté/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sauvegarde : reprise après échec, seuls les fichiers manquants sont relus', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  try {
    let fail = true;
    const reads = [];
    const callPhone = async (tool, args) => {
      if (tool === 'list_files') return { ok: true, result: { entries: FS[args.path], truncated: false } };
      if (args.path.endsWith('frame_0.bm') && fail) return { ok: false, error: 'fichier introuvable' }; // définitive : échec tout de suite
      reads.push(args.path);
      const v = FILES[args.path];
      return Buffer.isBuffer(v) ? { ok: true, result: { base64: v.toString('base64') } } : { ok: true, result: { text: v } };
    };
    const bk = createBackups({ dir, log: () => {}, callPhone, RETRY_MS: 5 });
    const r1 = await bk.run({ action: 'save', path: '/ext/dolphin' });
    assert.match(r1.error, /2 fichiers copiés, gardés.*reprendra/);
    assert.equal((await bk.run({ action: 'list' })).result.backups.length, 0);
    fail = false;
    reads.length = 0;
    const r2 = await bk.run({ action: 'save', path: '/ext/dolphin' });
    assert.equal(r2.ok, true, r2.error);
    assert.equal(r2.result.files, 3);
    assert.equal(r2.result.reused, 2);
    assert.deepEqual(reads, ['/ext/dolphin/L1_Tv_128x47/frame_0.bm']);
    assert.equal((await bk.run({ action: 'list' })).result.backups[0].files, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sauvegarde : « Pas de réponse du Flipper » est passager (nouvel essai)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  try {
    let slow = 2;
    const callPhone = async (tool, args) => {
      if (tool === 'list_files') return { ok: true, result: { entries: FS[args.path], truncated: false } };
      if (args.path.endsWith('meta.txt') && slow-- > 0) return { ok: false, error: 'Pas de réponse du Flipper (commande 24)' };
      const v = FILES[args.path];
      return Buffer.isBuffer(v) ? { ok: true, result: { base64: v.toString('base64') } } : { ok: true, result: { text: v } };
    };
    const bk = createBackups({ dir, log: () => {}, callPhone, RETRY_MS: 5 });
    const r = await bk.run({ action: 'save', path: '/ext/dolphin' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.result.files, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
