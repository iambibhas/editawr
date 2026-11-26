'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

sharp.cache(false);

const { exportImage } = require('../src/main/exporter');

async function pngBuffer(width = 64, height = 48) {
  return sharp({ create: { width, height, channels: 3, background: '#aa3355' } }).png().toBuffer();
}

test('exporter: jpeg with date template and unique file names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-export-'));
  const buf = await pngBuffer(64, 48);
  const ctx = {
    date: new Date(2026, 7, 19, 6, 54, 53),
    filename: 'BCD_1030',
    name: 'BCD_1030.NEF',
    ext: '.NEF',
  };
  const first = await exportImage({ buffer: buf, format: 'jpeg', quality: 90, targetDir: dir, filenameTemplate: '<date>/<filename>', ctx });
  const second = await exportImage({ buffer: buf, format: 'jpeg', quality: 90, targetDir: dir, filenameTemplate: '<date>/<filename>', ctx });
  assert.match(first.path, /2026-08-19[/\\]BCD_1030\.jpg$/);
  assert.notEqual(first.path, second.path);
  assert.ok(fs.existsSync(first.path) && fs.existsSync(second.path));
  const meta = await sharp(first.path).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 64);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('exporter: png/tiff/webp formats + resize', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-export2-'));
  const buf = await pngBuffer(400, 300);
  for (const format of ['png', 'tiff', 'webp']) {
    const res = await exportImage({ buffer: buf, format, targetDir: dir, filenameTemplate: `out_${format}`, ctx: { filename: 'x' }, resizeLongEdge: 200 });
    const meta = await sharp(res.path).metadata();
    assert.equal(meta.width, 200, `${format} width`);
    assert.equal(meta.format, format === 'tiff' ? 'tiff' : format);
  }
  await new Promise((r) => setTimeout(r, 150));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 80 });
});

test('exporter: rejects unsupported formats and empty data', async () => {
  await assert.rejects(() => exportImage({ buffer: Buffer.alloc(0), format: 'jpeg', targetDir: os.tmpdir() }), /No image data/);
  await assert.rejects(() => exportImage({ buffer: Buffer.from('x'), format: 'gif', targetDir: os.tmpdir() }), /Unsupported format/);
});
