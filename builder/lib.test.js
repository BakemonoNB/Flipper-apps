import test from 'node:test';
import assert from 'node:assert/strict';
import { pathError, validateFiles, makeTar, readTar, tokenOk, truncateLog, LIMITS } from './lib.js';

test('chemins refusés', () => {
  for (const p of ['../x', '/etc/passwd', 'a/../b', 'a//b', './a', 'a\\b', 'C:x', 'a b', '']) assert.ok(pathError(p), p);
  for (const p of ['application.fam', 'images/x.png', 'a-b_c.1/d.c']) assert.equal(pathError(p), null, p);
});

test('limites des fichiers', () => {
  assert.throws(() => validateFiles({ 'app.c': 'x' }), /application.fam/);
  const many = { 'application.fam': '' };
  for (let i = 0; i < 50; i++) many['f' + i] = '';
  assert.throws(() => validateFiles(many), /trop de fichiers/);
  assert.throws(() => validateFiles({ 'application.fam': 'x'.repeat(LIMITS.maxTotal + 1) }), /trop gros/);
  assert.throws(() => validateFiles({ 'application.fam': '', a: '', 'a/b': '' }), /fichier et dossier/);
  assert.throws(() => validateFiles({ 'application.fam': '', 'x.png': { base64: '@@' } }), /base64/);
});

test('tar aller-retour', () => {
  const files = validateFiles({ 'application.fam': 'App()', 'images/x.png': { base64: Buffer.from([1, 2, 3]).toString('base64') } });
  const t = readTar(makeTar(files));
  assert.equal(t['application.fam'].toString(), 'App()');
  assert.deepEqual([...t['images/x.png']], [1, 2, 3]);
});

test('jeton et journal', () => {
  assert.ok(tokenOk('abc', 'abc'));
  assert.ok(!tokenOk('abd', 'abc'));
  assert.ok(!tokenOk(undefined, 'abc'));
  assert.ok(!tokenOk('', ''));
  assert.ok(Buffer.byteLength(truncateLog('é'.repeat(100000))) <= LIMITS.maxLog);
});
