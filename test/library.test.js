'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { Library, buildFolderTree } = require('../src/main/library');
const { Thumbs } = require('../src/main/thumbs');

sharp.cache(false);

test('library: scans folders, indexes metadata, generates thumbs and skips Exports', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-lib-'));
  const libDir = path.join(dir, 'lib');
  fs.mkdirSync(path.join(libDir, '2026', '08', '19'), { recursive: true });
  fs.mkdirSync(path.join(libDir, 'Exports'), { recursive: true });
  fs.mkdirSync(path.join(libDir, 'System Volume Information'), { recursive: true });
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#123456' } })
    .jpeg()
    .toFile(path.join(libDir, '2026', '08', '19', 'photo.jpg'));
  await sharp({ create: { width: 400, height: 400, channels: 3, background: '#654321' } })
    .jpeg()
    .toFile(path.join(libDir, 'Exports', 'should-not-be-indexed.jpg'));
  fs.writeFileSync(path.join(libDir, 'System Volume Information', 'junk.jpg'), 'not an image');

  const thumbs = new Thumbs({ thumbDir: path.join(dir, 'thumbs'), previewDir: path.join(dir, 'previews') });
  const lib = new Library({
    root: libDir,
    userDataDir: path.join(dir, 'data'),
    thumbs,
    concurrency: 2,
    lazyThumbs: false,
    scanSubfolders: true,
  });
  await lib.open();
  const events = [];
  lib.on('photo', (p) => events.push(p));
  const stats = await lib.scan();
  assert.equal(stats.total, 1);
  assert.equal(events.length, 1);
  const entry = lib.list()[0];
  assert.equal(entry.rel, '2026/08/19/photo.jpg');
  assert.equal(entry.width, 800);
  assert.equal(entry.height, 600);
  assert.ok(entry.thumbKey);
  assert.ok(fs.existsSync(thumbs.pathFor(entry.thumbKey)));

  // A second scan should be a no-op (no re-indexing).
  const before = lib.list()[0].indexedAt;
  await lib.scan();
  assert.equal(lib.list()[0].indexedAt, before);

  // Edits + rating persist through the catalog.
  await lib.update(entry.rel, { rating: 4, flag: 'picked', edits: { exposure: 1 } });
  await lib.close();
  const lib2 = new Library({ root: libDir, userDataDir: path.join(dir, 'data'), thumbs, lazyThumbs: false });
  await lib2.open();
  const reloaded = lib2.list()[0];
  assert.equal(reloaded.rating, 4);
  assert.equal(reloaded.flag, 'picked');
  assert.equal(reloaded.edits.exposure, 1);
  await lib2.close();

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 });
});

test('library: skip subfolders — hidden entries are kept and restored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-scope-'));
  const libDir = path.join(dir, 'lib');
  fs.mkdirSync(path.join(libDir, '2024', 'day1'), { recursive: true });
  fs.mkdirSync(path.join(libDir, '2025'), { recursive: true });
  await sharp({ create: { width: 100, height: 80, channels: 3, background: '#112233' } }).jpeg().toFile(path.join(libDir, 'root.jpg'));
  await sharp({ create: { width: 100, height: 80, channels: 3, background: '#223344' } }).jpeg().toFile(path.join(libDir, '2024', 'day1', 'a.jpg'));
  await sharp({ create: { width: 100, height: 80, channels: 3, background: '#334455' } }).jpeg().toFile(path.join(libDir, '2025', 'b.jpg'));

  const thumbs = new Thumbs({ thumbDir: path.join(dir, 't'), previewDir: path.join(dir, 'p') });
  const lib = new Library({
    root: libDir,
    userDataDir: path.join(dir, 'data'),
    thumbs,
    lazyThumbs: true,
    scanSubfolders: false,
  });
  await lib.open();
  const res = await lib.scan();
  assert.equal(res.total, 1);
  assert.equal(res.all, 1, 'only the root file is catalogued while subfolders are skipped');
  assert.equal(lib.list().length, 1);

  assert.equal(lib.setScanOptions({ scanSubfolders: true }), true);
  const res2 = await lib.scan();
  assert.equal(res2.total, 3);
  assert.equal(lib.list().length, 3);

  lib.setScanOptions({ scanSubfolders: false });
  assert.equal(lib.list().length, 1);
  assert.equal(lib.stats().hidden, 2);
  assert.equal(lib.stats().all, 3);
  await lib.close();

  const lib3 = new Library({
    root: libDir,
    userDataDir: path.join(dir, 'data'),
    thumbs,
    lazyThumbs: true,
    scanSubfolders: true,
    excludedFolders: ['day1'],
  });
  await lib3.open();
  assert.equal(lib3.list().length, 2);
  assert.equal(lib3._isExcluded('2024/day1/a.jpg'), true);
  assert.equal(lib3._isExcluded('2025/b.jpg'), false);
  lib3.setScanOptions({ excludedFolders: ['2025'] });
  assert.equal(lib3.list().length, 2);
  lib3.setScanOptions({ excludedFolders: ['2024/day1'] });
  assert.equal(lib3.list().length, 2);
  await lib3.close();

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 });
});

test('library: fast metadata mode defers EXIF until browsed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-fast-'));
  const libDir = path.join(dir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#556677' } }).jpeg().toFile(path.join(libDir, 'a.jpg'));

  const thumbs = new Thumbs({ thumbDir: path.join(dir, 't'), previewDir: path.join(dir, 'p') });
  const lib = new Library({
    root: libDir,
    userDataDir: path.join(dir, 'data'),
    thumbs,
    lazyThumbs: true,
    fastMetadata: true,
  });
  await lib.open();
  const res = await lib.scan();
  assert.equal(res.total, 1);
  const entry = lib.list()[0];
  assert.equal(entry.metaLoaded, false);
  assert.equal(entry.thumbKey, null);
  assert.ok(entry.capturedAt, 'mtime date is used as a provisional capture date');

  const { readMetadata } = require('../src/main/metadata');
  const meta = await readMetadata(path.join(libDir, 'a.jpg'));
  await lib.update(entry.rel, { ...meta, metaLoaded: true }, { persist: false });
  assert.equal(lib.list()[0].metaLoaded, true);
  await lib.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 60 });
});

test('buildFolderTree: direct and recursive counts', () => {
  const tree = buildFolderTree(
    [
      { rel: 'root.jpg' },
      { rel: '2024/a.jpg' },
      { rel: '2024/08/b.jpg' },
      { rel: '2024/08/c.jpg' },
      { rel: '2024/09/d.jpg' },
      { rel: 'backup/e.jpg' },
    ],
    'lib',
  );
  assert.equal(tree.all, 6);
  assert.equal(tree.root.direct, 1);
  assert.equal(tree.root.total, 6);
  assert.deepEqual(tree.root.children.map((c) => c.name), ['2024', 'backup']);
  const y2024 = tree.root.children[0];
  assert.equal(y2024.direct, 1);
  assert.equal(y2024.total, 4);
  assert.deepEqual(y2024.children.map((c) => c.name), ['08', '09']);
  assert.equal(y2024.children[0].direct, 2);
  assert.equal(y2024.children[0].total, 2);
  assert.equal(y2024.children[1].direct, 1);
  assert.equal(tree.root.children[1].total, 1);
});
