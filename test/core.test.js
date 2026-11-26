'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Settings } = require('../src/main/settings');
const { Catalog } = require('../src/main/catalog');
const { walkFiles, uniquePath, safeJoin, sha1File, Semaphore, formatBytes, normalizeExclusions } = require('../src/main/util');

test('settings: defaults, deep merge, persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-set-'));
  const file = path.join(dir, 'settings.json');
  const s = new Settings(file);
  await s.load();
  assert.equal(s.get('importTemplate'), '<date>/<filename>');
  s.set({ autoDetectCards: false, editor: { previewMaxEdge: 2000 } });
  await s.save();
  const s2 = new Settings(file);
  await s2.load();
  assert.equal(s2.get('autoDetectCards'), false);
  assert.equal(s2.get('editor').previewMaxEdge, 2000);
  assert.equal(s2.get('thumbnailSize'), 384);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('catalog: set/patch/persist/reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-cat-'));
  const cat = new Catalog({ userDataDir: dir, root: path.join(dir, 'lib') });
  await cat.load();
  cat.set('a/b.jpg', { rel: 'a/b.jpg', name: 'b.jpg', size: 10 });
  cat.patch('a/b.jpg', { rating: 4 });
  await cat.save();
  const cat2 = new Catalog({ userDataDir: dir, root: path.join(dir, 'lib') });
  await cat2.load();
  assert.equal(cat2.get('a/b.jpg').rating, 4);
  assert.equal(cat2.get('a/b.jpg').name, 'b.jpg');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('util: walkFiles skips hidden/system dirs and is deterministic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-walk-'));
  fs.mkdirSync(path.join(dir, 'DCIM', '100NIKON'), { recursive: true });
  fs.mkdirSync(path.join(dir, '$RECYCLE.BIN'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'DCIM', '100NIKON', 'b.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'DCIM', '100NIKON', 'a.jpg'), 'x');
  fs.writeFileSync(path.join(dir, '$RECYCLE.BIN', 'junk.jpg'), 'x');
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'x');
  const files = [];
  for await (const f of walkFiles(dir)) files.push(path.relative(dir, f));
  assert.deepEqual(files, [path.join('DCIM', '100NIKON', 'a.jpg'), path.join('DCIM', '100NIKON', 'b.jpg')]);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('util: uniquePath and safeJoin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-uniq-'));
  const f = path.join(dir, 'photo.jpg');
  fs.writeFileSync(f, 'x');
  const alt = await uniquePath(f);
  assert.equal(path.basename(alt), 'photo (1).jpg');
  assert.throws(() => safeJoin(dir, '../../etc/passwd'));
  assert.equal(safeJoin(dir, 'a/b.jpg'), path.join(dir, 'a/b.jpg'));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('util: sha1File sample mode detects identical small files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-hash-'));
  const a = path.join(dir, 'a.bin');
  const b = path.join(dir, 'b.bin');
  fs.writeFileSync(a, Buffer.alloc(200000, 7));
  fs.writeFileSync(b, Buffer.alloc(200000, 7));
  assert.equal(await sha1File(a, 65536), await sha1File(b, 65536));
  fs.writeFileSync(b, Buffer.alloc(200000, 8));
  assert.notEqual(await sha1File(a, 65536), await sha1File(b, 65536));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('util: semaphore enforces concurrency limit', async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      }),
    ),
  );
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.equal(formatBytes(1536), '1.5 KB');
});

test('util: walkFiles shouldEnter can skip directories', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-skip-'));
  fs.mkdirSync(path.join(dir, 'keep'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skip-me'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keep', 'a.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'skip-me', 'b.jpg'), 'x');
  const files = [];
  for await (const f of walkFiles(dir, { shouldEnter: (full) => !full.endsWith('skip-me') })) files.push(f);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('a.jpg'));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 });
});

test('util: normalizeExclusions handles names, paths, case and separators', () => {
  assert.deepEqual(normalizeExclusions(' Backup, 2023/Originals; .cache '), ['backup', '2023/originals', '.cache']);
  assert.deepEqual(normalizeExclusions(['A/B', 'a/b', '']), ['a/b']);
  assert.deepEqual(normalizeExclusions('..'), []);
  assert.deepEqual(normalizeExclusions('bad|name'), []);
});
