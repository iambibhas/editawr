'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { extractLargestJpegPreview, findEmbeddedPreviews } = require('../src/main/tiff-preview');

function fakeJpeg(size) {
  const buf = Buffer.alloc(size, 0xaa);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  buf[2] = 0xff;
  buf[3] = 0xe0;
  buf[Math.min(size - 2, 200)] = 0xff;
  buf[Math.min(size - 1, 201)] = 0xd9;
  return buf;
}

/** Build a little-endian TIFF with one jpeg preview per IFD. */
function buildTiff(entries) {
  const count = entries.length;
  const ifdSize = 2 + 12 * 5 + 4;
  const ifdOffsets = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    ifdOffsets.push(off);
    off += ifdSize;
  }
  let dataOff = off;
  const dataOffsets = [];
  for (const e of entries) {
    dataOffsets.push(dataOff);
    dataOff += e.jpeg.length;
  }
  const buf = Buffer.alloc(dataOff, 0);
  buf.write('II', 0, 'ascii');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdOffsets[0], 4);
  const tags = ['width', 'height', 'compression', 'jpegOffset', 'jpegLength'];
  for (let i = 0; i < count; i++) {
    const e = entries[i];
    let p = ifdOffsets[i];
    buf.writeUInt16LE(5, p);
    p += 2;
    const values = {
      0x0100: e.width,
      0x0101: e.height,
      0x0103: 6,
      0x0201: dataOffsets[i],
      0x0202: e.jpeg.length,
    };
    let n = 0;
    for (const [tagStr, value] of Object.entries(values)) {
      const tag = Number(tagStr);
      buf.writeUInt16LE(tag, p);
      buf.writeUInt16LE(tag === 0x0103 ? 3 : 4, p + 2);
      buf.writeUInt32LE(1, p + 4);
      if (tag === 0x0103) buf.writeUInt16LE(value, p + 8);
      else buf.writeUInt32LE(value, p + 8);
      p += 12;
      n++;
    }
    buf.writeUInt32LE(i + 1 < count ? ifdOffsets[i + 1] : 0, p);
    entries[i].jpeg.copy(buf, dataOffsets[i]);
  }
  return buf;
}

test('extracts the largest embedded preview', () => {
  const small = fakeJpeg(1200);
  const big = fakeJpeg(60000);
  const tiff = buildTiff([
    { jpeg: small, width: 160, height: 120 },
    { jpeg: big, width: 6016, height: 4016 },
  ]);
  const preview = extractLargestJpegPreview(tiff);
  assert.ok(preview);
  assert.equal(preview.width, 6016);
  assert.equal(preview.height, 4016);
  assert.equal(preview.data.length, 60000);
  assert.equal(preview.data[0], 0xff);
  assert.equal(preview.data[1], 0xd8);
});

test('returns null for non-TIFF data', () => {
  assert.equal(extractLargestJpegPreview(Buffer.from('not a tiff at all')), null);
});

test('ignores entries that are not real JPEGs', () => {
  const notJpeg = Buffer.alloc(5000, 0);
  const tiff = buildTiff([{ jpeg: notJpeg, width: 100, height: 100 }]);
  assert.equal(extractLargestJpegPreview(tiff), null);
});

test('real NEF preview extraction (fixture)', { skip: !process.env.EDITAWR_TEST_NEF }, () => {
  const file = process.env.EDITAWR_TEST_NEF;
  if (!fs.existsSync(file)) return;
  const preview = extractLargestJpegPreview(fs.readFileSync(file));
  assert.ok(preview);
  assert.ok(preview.width >= 1000);
  assert.equal(preview.data[0], 0xff);
  assert.equal(preview.data[1], 0xd8);
});

test('findEmbeddedPreviews reports previews beyond a partial header buffer', () => {
  const small = fakeJpeg(1200);
  const big = fakeJpeg(60000);
  const tiff = buildTiff([
    { jpeg: small, width: 160, height: 120 },
    { jpeg: big, width: 6016, height: 4016 },
  ]);
  const head = tiff.subarray(0, 8 + (2 + 12 * 5 + 4) * 2 + 32);
  const found = findEmbeddedPreviews(head);
  assert.equal(found.length, 2);
  assert.equal(found[0].width, 6016);
  assert.equal(found[0].length, 60000);
});

test('real NEF: previews are found in a 4 MB header (partial read path)', { skip: !process.env.EDITAWR_TEST_NEF }, () => {
  const file = process.env.EDITAWR_TEST_NEF;
  if (!fs.existsSync(file)) return;
  const fd = fs.openSync(file, 'r');
  const st = fs.fstatSync(fd);
  const len = Math.min(st.size, 4 * 1024 * 1024);
  const head = Buffer.alloc(len);
  fs.readSync(fd, head, 0, len, 0);
  fs.closeSync(fd);
  const found = findEmbeddedPreviews(head);
  assert.ok(found.length >= 1);
  assert.ok(found[0].width >= 1600);
  assert.ok(found[0].length > 100000);
});
