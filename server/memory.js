// Mémoire partagée des modèles : lecture des notes Flipper du brain, brouillons dans l'inbox du curateur.
// Lecture limitée aux notes du projet flipper (ou étiquetées flipper) : le reste du brain (prospection,
// clients…) n'est jamais exposé aux modèles. Écriture : uniquement de NOUVEAUX fichiers dans _drafts/inbox/.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP_DIRS = new Set(['_drafts', '_meta', '_archived', 'graphify-out', '.git', '.obsidian']);
const MAX_READ = 8000;
const MAX_NOTE = 4000;
const NOTES_PER_HOUR = 10;

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function frontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  const fm = end > 0 ? text.slice(3, end) : '';
  const get = (k) => { const m = new RegExp('^' + k + ':\\s*(.*)$', 'm').exec(fm); return m ? m[1].trim() : ''; };
  let summary = get('summary');
  if (/^\|-?$|^>-?$/.test(summary)) {
    const m = /^summary:\s*[|>]-?\s*\n((?:[ \t]+.*\n?)+)/m.exec(fm + '\n');
    summary = m ? m[1].replace(/^[ \t]+/gm, '').trim() : '';
  }
  return { id: get('id'), project: get('project'), tags: get('tags'), summary: summary.replace(/^"|"$/g, '') };
}

export function createMemory({ brainDir, log, now = () => new Date() }) {
  let cache = null;
  let cacheAt = 0;
  const written = [];

  function index() {
    if (cache && Date.now() - cacheAt < 60000) return cache;
    const notes = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name)); continue; }
        if (!e.name.endsWith('.md')) continue;
        const full = join(dir, e.name);
        let text;
        try { text = readFileSync(full, 'utf8'); } catch { continue; }
        const fm = frontmatter(text);
        const flipper = fm.project === 'flipper' || /flipper/i.test(fm.tags) || fm.id === 'HUB-flipper';
        if (!flipper) continue;
        const title = (/^# (.+)$/m.exec(text) || [])[1] || e.name;
        notes.push({ path: relative(brainDir, full).split(sep).join('/'), title, summary: fm.summary, text });
      }
    };
    walk(brainDir);
    cache = notes;
    cacheAt = Date.now();
    return notes;
  }

  function unavailable(e) {
    return { ok: false, error: 'mémoire indisponible : le brain n\'est pas lisible (' + (e.code || e.message) + ')' };
  }

  function search(args) {
    const q = typeof args.query === 'string' ? args.query : '';
    const words = norm(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    let notes;
    try { notes = index(); } catch (e) { return unavailable(e); }
    const scored = notes.map((n) => {
      const head = norm(n.title + ' ' + n.summary);
      const body = norm(n.text);
      let score = n.path.includes('HUB-flipper') ? 0.5 : 0;
      for (const w of words) {
        score += 3 * (head.split(w).length - 1) + Math.min(5, body.split(w).length - 1);
      }
      return { n, score };
    }).filter((x) => !words.length || x.score > 0.5).sort((a, b) => b.score - a.score).slice(0, 8);
    return {
      ok: true,
      result: {
        notes: scored.map(({ n }) => ({ path: n.path, title: n.title, summary: n.summary.slice(0, 300) })),
        hint: 'memory_read avec path pour lire une note',
      },
    };
  }

  function read(args) {
    let notes;
    try { notes = index(); } catch (e) { return unavailable(e); }
    const n = notes.find((x) => x.path === args.path);
    if (!n) return { ok: false, error: 'note inconnue ou hors du projet flipper : utilise memory_search' };
    const text = n.text.length > MAX_READ ? n.text.slice(0, MAX_READ) + '\n…(coupé)' : n.text;
    return { ok: true, result: { path: n.path, text } };
  }

  function note(args, origin) {
    const title = typeof args.title === 'string' ? args.title.trim().replace(/\s+/g, ' ') : '';
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!title || title.length > 120) return { ok: false, error: 'title requis (120 caractères max)' };
    if (!content || content.length > MAX_NOTE) return { ok: false, error: 'content requis (' + MAX_NOTE + ' caractères max)' };
    const hourAgo = Date.now() - 3600000;
    while (written.length && written[0] < hourAgo) written.shift();
    if (written.length >= NOTES_PER_HOUR) return { ok: false, error: 'trop de notes cette heure-ci (' + NOTES_PER_HOUR + ' max)' };
    const d = now();
    const stamp = d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const who = /^[a-z0-9-]{1,20}$/.test(origin || '') ? origin : 'modele';
    const slug = norm(title).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'note';
    const name = 'flipper-' + who + '-' + stamp + '-' + slug + '.md';
    const body = [
      '---',
      'type: draft',
      'project: flipper',
      'date: ' + d.toISOString().slice(0, 10),
      'tags: [proj/flipper, draft, source/' + who + ']',
      'agent-written: true',
      'source-agent: ' + who,
      'summary: |-',
      '  ' + title,
      '---',
      '',
      '# ' + title,
      '',
      content,
      '',
    ].join('\n');
    try {
      writeFileSync(join(brainDir, '_drafts', 'inbox', name), body, { flag: 'wx', mode: 0o644 });
    } catch (e) {
      return { ok: false, error: 'note non écrite (' + (e.code || e.message) + ')' };
    }
    written.push(Date.now());
    log('INFO', 'mémoire : brouillon ' + name + ' (' + who + ')');
    return { ok: true, result: { draft: '_drafts/inbox/' + name, note: 'le curateur la relira (chaque nuit à 4 h)' } };
  }

  return { search, read, note };
}
