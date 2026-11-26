'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { readMetadata } = require('../src/main/metadata');

test('metadata: falls back to file mtime when there is no EXIF', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-meta-'));
  const file = path.join(dir, 'plain.png');
  await sharp({ create: { width: 8, height: 6, channels: 3, background: '#336699' } }).png().toFile(file);
  const st = fs.statSync(file);
  const meta = await readMetadata(file, { stat: st });
  assert.equal(meta.dateSource, 'mtime');
  assert.equal(meta.capturedEpoch, Math.round(st.mtimeMs));
  assert.match(meta.capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.equal(meta.width, null);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('metadata: mtime fallback rounds sub-millisecond values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-meta-'));
  const file = path.join(dir, 'plain.bin');
  fs.writeFileSync(file, 'not an image');
  const st = fs.statSync(file);
  const meta = await readMetadata(file, {
    stat: { ...st, mtimeMs: 1795688915272.232 },
  });
  assert.equal(meta.dateSource, 'mtime');
  assert.equal(meta.capturedEpoch, 1795688915272);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('metadata: real NEF (fixture)', { skip: !process.env.EDITAWR_TEST_NEF }, async () => {
  const file = process.env.EDITAWR_TEST_NEF;
  if (!fs.existsSync(file)) return;
  const meta = await readMetadata(file);
  assert.equal(meta.dateSource, 'exif');
  assert.match(meta.capturedAt, /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d$/);
  assert.ok(meta.capturedEpoch > 0);
  assert.match(meta.camera, /Nikon/i);
  assert.ok(meta.lens);
  assert.ok(meta.iso > 0);
  assert.ok(meta.aperture > 0);
  assert.ok(meta.shutter > 0);
  assert.ok(meta.focalLength > 0);
});
