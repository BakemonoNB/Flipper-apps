import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from './memory.js';
import { fitContext } from './models/ollama.js';

function fakeBrain() {
  const dir = mkdtempSync(join(tmpdir(), 'brain-'));
  for (const d of ['Lessons', 'Hubs', 'References', '_drafts/inbox', '_archived']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'Lessons/L-1-bluefy.md'), '---\nid: L-1\nproject: flipper\ntags: [proj/flipper, ios]\nsummary: |-\n  Bluefy envoie tout le tampon des vues.\n  Passer des copies.\n---\n# Bluefy et les vues\n\nCorps avec writeValue et subarray.\n');
  writeFileSync(join(dir, 'Lessons/L-2-hid.md'), '---\nid: L-2\nproject: global\ntags: [proj/global, flipper-zero, hid]\nsummary: "Latence HID mesurée"\n---\n# Latence HID\n\nF24 et voyant.\n');
  writeFileSync(join(dir, 'Hubs/HUB-flipper.md'), '---\nid: HUB-flipper\nproject: flipper\ntags: [proj/flipper, hub]\nsummary: |-\n  Point d\'entrée Flipper.\n---\n# Flipper\n');
  writeFileSync(join(dir, 'References/R-9-prospects.md'), '---\nid: R-9\nproject: limpeo\ntags: [proj/limpeo]\nsummary: "Liste de prospects SECRET"\n---\n# Prospects\n\nSECRET email@client.fr\n');
  writeFileSync(join(dir, '_archived/old-flipper.md'), '---\nproject: flipper\n---\n# Archivé\n');
  return dir;
}

test('recherche : seulement les notes Flipper, jamais le reste du brain', () => {
  const m = createMemory({ brainDir: fakeBrain(), log: () => {} });
  const r = m.search({ query: 'bluefy tampon' });
  assert.equal(r.ok, true);
  assert.equal(r.result.notes[0].path, 'Lessons/L-1-bluefy.md');
  assert.match(r.result.notes[0].summary, /tout le tampon/);
  const all = m.search({ query: '' }).result.notes.map((n) => n.path).sort();
  assert.deepEqual(all, ['Hubs/HUB-flipper.md', 'Lessons/L-1-bluefy.md', 'Lessons/L-2-hid.md']);
  assert.equal(m.search({ query: 'prospects secret' }).result.notes.length, 0);
});

test('lecture : note Flipper oui ; note hors projet, archive ou chemin bricolé : non', () => {
  const m = createMemory({ brainDir: fakeBrain(), log: () => {} });
  assert.match(m.read({ path: 'Lessons/L-1-bluefy.md' }).result.text, /subarray/);
  for (const path of ['References/R-9-prospects.md', '_archived/old-flipper.md', '../etc/passwd', 'Lessons/../References/R-9-prospects.md']) {
    assert.equal(m.read({ path }).ok, false, path);
  }
});

test('note : nouveau brouillon dans _drafts/inbox, jamais d\'écrasement, limite horaire', () => {
  const dir = fakeBrain();
  const m = createMemory({ brainDir: dir, log: () => {}, now: () => new Date('2026-11-07T12:00:00Z') });
  const r = m.note({ title: 'Les écrans 2048 se lisent mal en texte', content: 'Utiliser Claude pour les jeux.' }, 'gpt-oss');
  assert.equal(r.ok, true);
  const files = readdirSync(join(dir, '_drafts/inbox'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^flipper-gpt-oss-20261107-120000-les-ecrans-2048-se-lisent-mal-en-texte\.md$/);
  const text = readFileSync(join(dir, '_drafts/inbox', files[0]), 'utf8');
  assert.match(text, /^---\ntype: draft\nproject: flipper\n/);
  assert.match(text, /source-agent: gpt-oss/);
  assert.equal(m.note({ title: 'Les écrans 2048 se lisent mal en texte', content: 'x' }, 'gpt-oss').ok, false); // même nom : pas d'écrasement
  assert.equal(m.note({ title: '', content: 'x' }, 'claude').ok, false);
  assert.equal(m.note({ title: 't', content: 'x'.repeat(4001) }, 'claude').ok, false);
  assert.match(m.note({ title: 't', content: 'x' }, '../evil').result.draft, /flipper-modele-/);
  const m2 = createMemory({ brainDir: dir, log: () => {}, now: (() => { let s = 0; return () => new Date(Date.UTC(2026, 10, 7, 13, 0, s++)); })() });
  const res = Array.from({ length: 11 }, (_, i) => m2.note({ title: 'n' + i, content: 'x' }, 'claude').ok);
  assert.deepEqual(res.filter(Boolean).length, 10);
});

test('brain illisible : erreur claire', () => {
  const m = createMemory({ brainDir: '/nonexistent/brain', log: () => {} });
  assert.match(m.search({ query: 'x' }).error, /indisponible/);
});

test('contexte gpt-oss : dernière capture gardée, anciennes retirées, dernier message de Mikha jamais retiré', () => {
  const screen = '#'.repeat(9000);
  const msgs = [
    { role: 'user', content: 'ancien' }, { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'joue' },
    { role: 'tool', tool_name: 'get_screen', content: screen },
    { role: 'tool', tool_name: 'press_button', content: 'ok' },
    { role: 'tool', tool_name: 'get_screen', content: screen },
  ];
  fitContext(msgs, 3000); // budget trop petit pour tout garder
  assert.equal(msgs[0].content, 'joue');
  assert.equal(msgs.filter((m) => m.content === screen).length, 1);
  assert.equal(msgs.at(-1).content, screen);
  assert.equal(msgs.find((m) => m.tool_name === 'get_screen').content, '(capture précédente retirée)');
});
