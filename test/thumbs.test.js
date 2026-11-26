'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { Thumbs } = require('../src/main/thumbs');

async function makeJpeg(file, width = 640, height = 480) {
  await sharp({ create: { width, height, channels: 3, background: '#4477aa' } })
    .jpeg({ quality: 80 })
    .toFile(file);
}

test('thumbs: generates a cached thumbnail and reports source dimensions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-thumbs-'));
  const file = path.join(dir, 'photo.jpg');
  await makeJpeg(file, 640, 480);
  const st = fs.statSync(file);
  const thumbs = new Thumbs({ thumbDir: path.join(dir, 't'), previewDir: path.join(dir, 'p') });
  const got = await thumbs.get({ file, mtimeMs: st.mtimeMs, size: st.size }, 120);
  assert.ok(got.key.endsWith('.jpg'));
  assert.ok(fs.existsSync(got.path));
  const meta = await sharp(got.path).metadata();
  assert.ok(meta.width <= 120 && meta.height <= 120);
  assert.equal(got.source.width, 640);
  assert.equal(got.source.height, 480);

  // Second call must hit the cache (same key, no regeneration).
  const again = await thumbs.get({ file, mtimeMs: st.mtimeMs, size: st.size }, 120);
  assert.equal(again.key, got.key);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('thumbs: display preview for TIFF', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-preview-'));
  const file = path.join(dir, 'scan.tif');
  await sharp({ create: { width: 200, height: 100, channels: 3, background: '#999999' } }).tiff().toFile(file);
  const st = fs.statSync(file);
  const thumbs = new Thumbs({ thumbDir: path.join(dir, 't'), previewDir: path.join(dir, 'p') });
  const prev = await thumbs.getDisplayPreview({ file, mtimeMs: st.mtimeMs, size: st.size }, 1200);
  assert.ok(fs.existsSync(prev.path));
  const meta = await sharp(prev.path).metadata();
  assert.equal(meta.width, 200);
  assert.equal(meta.format, 'jpeg');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('thumbs: RAW preview uses embedded JPEG', { skip: !process.env.EDITAWR_TEST_NEF }, async () => {
  const file = process.env.EDITAWR_TEST_NEF;
  if (!fs.existsSync(file)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-rawthumb-'));
  const st = fs.statSync(file);
  const thumbs = new Thumbs({ thumbDir: path.join(dir, 't'), previewDir: path.join(dir, 'p') });
  const got = await thumbs.get({ file, mtimeMs: st.mtimeMs, size: st.size, raw: true }, 160);
  const meta = await sharp(got.path).metadata();
  assert.ok(meta.width <= 160);
  assert.ok(got.source.width >= 2000);
  const full = await thumbs.getRawPreview({ file, mtimeMs: st.mtimeMs, size: st.size }, 0);
  const fmeta = await sharp(full.path).metadata();
  assert.ok(fmeta.width >= 2000);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});
