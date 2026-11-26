'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { expand, unknownTokens, validateRelPath } = require('../src/main/template');
const { ensureExtension } = require('../src/main/importer');

const date = new Date(2026, 7, 19, 6, 54, 53);

test('template: <date> defaults to YYYY-MM-DD', () => {
  const { relPath, error } = expand('<date>/<filename>', { date, filename: 'BCD_1030' });
  assert.equal(error, undefined);
  assert.equal(relPath, '2026-08-19/BCD_1030');
});

test('template: configurable date format + inline overrides', () => {
  assert.equal(expand('<date>', { date, dateFormat: 'YYYY-MM-DD' }).relPath, '2026-08-19');
  assert.equal(expand('<date>', { date, dateFormat: 'YYYY/MM/DD' }).relPath, '2026/08/19');
  assert.equal(expand('<date>', { date, dateFormat: 'YYYY/MM' }).relPath, '2026/08');
  assert.equal(expand('<date>', { date, dateFormat: 'YYYYMMDD' }).relPath, '20260819');
  assert.equal(expand('<date>', { date, dateFormat: 'DD-MM-YYYY' }).relPath, '19-08-2026');
  // Invalid patterns fall back to the default, never create weird folders.
  assert.equal(expand('<date>', { date, dateFormat: 'garbage' }).relPath, '2026-08-19');
  // Inline overrides work without changing the setting.
  assert.equal(expand('<date:YYYY.MM.DD>/<filename>', { date, filename: 'a' }).relPath, '2026.08.19/a');
  assert.equal(expand('<date:YYYY/MM/DD>/<filename>', { date, filename: 'a' }).relPath, '2026/08/19/a');
  assert.equal(expand('<date:YYYY-MM-DD_HHmmss>/<filename>', { date, filename: 'a' }).relPath, '2026-08-19_065453/a');
});

test('template: all date tokens', () => {
  const { relPath } = expand('<yyyy>-<mm>-<dd>_<hh><mi><ss>', { date });
  assert.equal(relPath, '2026-08-19_065453');
});

test('template: camera/lens keep readable spaces and strip illegal characters', () => {
  const { relPath } = expand('<camera>/<filename>', {
    date,
    filename: 'shot:01?',
    camera: 'Nikon Z50_2',
    lens: 'VR 200-500mm f/5.6E',
  });
  assert.equal(relPath, 'Nikon Z50_2/shot01');
});

test('template: original preserves relative folders, sanitized', () => {
  const { relPath } = expand('<original>', { date, original: 'DCIM/100NIKON/DSC_0001.NEF' });
  assert.equal(relPath, 'DCIM/100NIKON/DSC_0001.NEF');
});

test('template: rejects unknown tokens instead of silently dropping them', () => {
  const unknown = unknownTokens('<date>/<filname>');
  assert.deepEqual(unknown, ['<filname>']);
  const { relPath, error } = expand('<date>/<filname>', { date, filename: 'x' });
  assert.equal(relPath, null);
  assert.match(error, /Unknown token/);
});

test('template: seq padding', () => {
  assert.equal(expand('<seq:3>/<filename>', { date, filename: 'a', seq: 7 }).relPath, '007/a');
  assert.equal(expand('<seq>', { date, seq: 12 }).relPath, '0012');
});

test('template: empty template and traversal-safe output', () => {
  assert.equal(expand('', { date }).relPath, null);
  assert.equal(expand('<filename>', { date, filename: '../../etc/passwd' }).relPath, 'etc-passwd');
  assert.ok(!expand('<filename>', { date, filename: '../../etc/passwd' }).relPath.includes('..'));
});

test('template: validateRelPath limits', () => {
  assert.ok(validateRelPath('2026/08/19/a.jpg').ok);
  assert.ok(!validateRelPath('').ok);
  assert.ok(!validateRelPath('x'.repeat(300)).ok);
});

test('extension is preserved when the template omits one', () => {
  assert.equal(ensureExtension('2026/08/19/BCD_1030', 'C:/card/BCD_1030.NEF'), '2026/08/19/BCD_1030.NEF');
  assert.equal(ensureExtension('2026/08/19/BCD_1030.jpg', 'C:/card/BCD_1030.NEF'), '2026/08/19/BCD_1030.jpg');
  assert.equal(ensureExtension('2026/08/19/a.', 'C:/card/a.ARW'), '2026/08/19/a.');
});

test('path separator normalisation', () => {
  const { relPath } = expand('incoming\\<date>\\<filename>', { date, filename: 'a' });
  assert.equal(relPath, 'incoming/2026-08-19/a');
  assert.equal(path.posix.basename(relPath), 'a');
});
