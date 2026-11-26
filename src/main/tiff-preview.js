'use strict';

/**
 * Embedded-preview extraction for TIFF-based RAW files (NEF, CR2, ARW, DNG,
 * ORF, RW2, PEF, SRW, ...).
 *
 * Almost every camera-written RAW file embeds one or more JPEG previews. Using
 * the embedded preview is 10-50x faster than demosaicing the sensor data, which
 * makes it the right choice for library thumbnails and for instant previews
 * while the full RAW decode runs.
 *
 * This module intentionally has no dependencies: it walks the TIFF IFD tree and
 * returns the largest embedded JPEG found (SOI..EOI validated).
 */

const TAG = {
  NEW_SUBFILE_TYPE: 0x00fe,
  IMAGE_WIDTH: 0x0100,
  IMAGE_LENGTH: 0x0101,
  STRIP_OFFSETS: 0x0111,
  STRIP_BYTE_COUNTS: 0x0117,
  JPEG_IF_OFFSET: 0x0201,
  JPEG_IF_BYTE_COUNT: 0x0202,
  SUB_IFDS: 0x014a,
  EXIF_IFD: 0x8769,
  GPS_IFD: 0x8825,
  COMPRESSION: 0x0103,
};

const COMPRESSION_JPEG = 6;
const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

/** Read a TIFF-type value array from a buffer. */
function readValues(buf, type, count, offset, littleEndian) {
  const size = TYPE_SIZES[type];
  if (!size) return null;
  const bytes = size * count;
  if (offset < 0 || offset + bytes > buf.length) return null;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const p = offset + i * size;
    switch (type) {
      case 1:
      case 7:
        out[i] = buf[p];
        break;
      case 2:
        out[i] = buf.readUInt8(p);
        break;
      case 3:
        out[i] = littleEndian ? buf.readUInt16LE(p) : buf.readUInt16BE(p);
        break;
      case 4:
        out[i] = littleEndian ? buf.readUInt32LE(p) : buf.readUInt32BE(p);
        break;
      case 5:
        out[i] = [
          littleEndian ? buf.readUInt32LE(p) : buf.readUInt32BE(p),
          littleEndian ? buf.readUInt32LE(p + 4) : buf.readUInt32BE(p + 4),
        ];
        break;
      case 6:
        out[i] = buf.readInt8(p);
        break;
      case 8:
        out[i] = littleEndian ? buf.readInt16LE(p) : buf.readInt16BE(p);
        break;
      case 9:
        out[i] = littleEndian ? buf.readInt32LE(p) : buf.readInt32BE(p);
        break;
      case 10:
        out[i] = [
          littleEndian ? buf.readInt32LE(p) : buf.readInt32BE(p),
          littleEndian ? buf.readInt32LE(p + 4) : buf.readInt32BE(p + 4),
        ];
        break;
      case 11:
        out[i] = littleEndian ? buf.readFloatLE(p) : buf.readFloatBE(p);
        break;
      case 12:
        out[i] = littleEndian ? buf.readDoubleLE(p) : buf.readDoubleBE(p);
        break;
      default:
        return null;
    }
  }
  return out;
}

/** Parse one IFD; returns { tags, next } or null. */
function parseIFD(buf, offset, littleEndian, opts = {}) {
  const maxEntries = opts.maxEntries ?? 4096;
  if (offset < 8 || offset + 2 > buf.length) return null;
  const count = littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
  if (count === 0 || count > maxEntries) return null;
  const tags = new Map();
  let p = offset + 2;
  for (let i = 0; i < count; i++, p += 12) {
    if (p + 12 > buf.length) break;
    const tag = littleEndian ? buf.readUInt16LE(p) : buf.readUInt16BE(p);
    const type = littleEndian ? buf.readUInt16LE(p + 2) : buf.readUInt16BE(p + 2);
    const num = littleEndian ? buf.readUInt32LE(p + 4) : buf.readUInt32BE(p + 4);
    const size = (TYPE_SIZES[type] || 0) * num;
    if (!size) continue;
    let valueOffset;
    if (size <= 4) valueOffset = p + 8;
    else valueOffset = littleEndian ? buf.readUInt32LE(p + 8) : buf.readUInt32BE(p + 8);
    // Skip huge inline payloads (e.g. big maker notes) unless explicitly wanted.
    const values = readValues(buf, type, num, valueOffset, littleEndian);
    if (values) tags.set(tag, { type, count: num, values });
  }
  const nextPos = p;
  const next =
    nextPos + 4 <= buf.length
      ? littleEndian
        ? buf.readUInt32LE(nextPos)
        : buf.readUInt32BE(nextPos)
      : 0;
  return { tags, next };
}

/** Read JPEG dimensions from the SOFn segment (works when TIFF tags lie/are absent). */
function jpegDimensions(buf, offset, length) {
  const end = Math.min(offset + length, buf.length);
  let p = offset + 2;
  let guard = 0;
  while (p + 9 < end && guard++ < 512) {
    if (buf[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = buf[p + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      p += marker === 0xff ? 1 : 2;
      continue;
    }
    if (p + 4 > end) break;
    const segLen = buf.readUInt16BE(p + 2);
    if (segLen < 2) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (p + 9 <= end) {
        return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
      }
      break;
    }
    p += 2 + segLen;
  }
  return null;
}

function isJpeg(buf, offset, length) {
  if (offset <= 0 || length < 4 || offset + 4 > buf.length) return false;
  if (buf[offset] !== 0xff || buf[offset + 1] !== 0xd8) return false;
  const end = Math.min(offset + length, buf.length);
  // Look for EOI in the last few bytes (some files pad the strip).
  const tail = Math.min(end, offset + length);
  for (let i = tail - 2; i >= Math.max(offset + 2, tail - 64); i--) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd9) return true;
  }
  // Tolerate missing EOI when the declared length is sane.
  return length > 1024;
}

/**
 * Find all embedded JPEG previews in a TIFF-based RAW buffer without slicing
 * them. Works on a partial (head) buffer too: candidates whose payload lies
 * beyond the buffer are still reported, so callers can read just that range
 * instead of the whole multi-megabyte file.
 * @returns {Array<{offset:number,length:number,width:number,height:number}>}
 */
function findEmbeddedPreviews(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return [];
  const b0 = buf[0];
  const b1 = buf[1];
  let littleEndian;
  if (b0 === 0x49 && b1 === 0x49) littleEndian = true;
  else if (b0 === 0x4d && b1 === 0x4d) littleEndian = false;
  else return [];
  const magic = littleEndian ? buf.readUInt16LE(2) : buf.readUInt16BE(2);
  if (magic !== 42) return []; // BigTIFF (43) unsupported for previews
  const ifd0 = littleEndian ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  if (!ifd0 || ifd0 >= buf.length) return [];

  const candidates = [];
  const visited = new Set();
  const queue = [ifd0];
  let guard = 0;

  while (queue.length && guard++ < 64) {
    const offset = queue.shift();
    if (!offset || offset >= buf.length || visited.has(offset)) continue;
    visited.add(offset);
    const ifd = parseIFD(buf, offset, littleEndian);
    if (!ifd) continue;
    const { tags, next } = ifd;

    const get = (tag) => tags.get(tag)?.values?.[0];
    const width = get(TAG.IMAGE_WIDTH) || 0;
    const height = get(TAG.IMAGE_LENGTH) || 0;
    const compression = get(TAG.COMPRESSION);

    let jpegOffset = get(TAG.JPEG_IF_OFFSET);
    let jpegLength = get(TAG.JPEG_IF_BYTE_COUNT);
    if (!jpegOffset || !jpegLength) {
      const strips = tags.get(TAG.STRIP_OFFSETS)?.values;
      const counts = tags.get(TAG.STRIP_BYTE_COUNTS)?.values;
      if (compression === COMPRESSION_JPEG && strips?.length === 1 && counts?.length === 1) {
        jpegOffset = strips[0];
        jpegLength = counts[0];
      }
    }
    const full = jpegOffset + jpegLength <= buf.length;
    const startsInside = jpegOffset + 2 <= buf.length;
    const acceptable = full
      ? isJpeg(buf, jpegOffset, jpegLength)
      : startsInside
        ? buf[jpegOffset] === 0xff && buf[jpegOffset + 1] === 0xd8
        : true; // payload lies past the header buffer; verified when it is read
    if (jpegOffset && jpegLength && acceptable) {
      let dims = { width, height };
      if (!dims.width || !dims.height) {
        dims = (full ? jpegDimensions(buf, jpegOffset, jpegLength) : null) || dims;
      }
      candidates.push({ offset: jpegOffset, length: jpegLength, width: dims.width, height: dims.height });
    }

    for (const tag of [TAG.SUB_IFDS, TAG.EXIF_IFD, TAG.GPS_IFD]) {
      const vals = tags.get(tag)?.values;
      if (vals) for (const v of vals) if (typeof v === 'number' && v) queue.push(v);
    }
    if (next) queue.push(next);
  }

  // Prefer pixel area when known, otherwise byte size.
  candidates.sort((a, b) => {
    const aa = a.width * a.height || a.length;
    const bb = b.width * b.height || b.length;
    return bb - aa || b.length - a.length;
  });
  return candidates;
}

/** Extract the largest embedded JPEG preview from a complete RAW file buffer. */
function extractLargestJpegPreview(buf) {
  const candidates = findEmbeddedPreviews(buf);
  for (const best of candidates) {
    if (best.offset + best.length > buf.length) continue;
    const data = buf.subarray(best.offset, best.offset + best.length);
    if (data[0] !== 0xff || data[1] !== 0xd8) continue;
    const dims = jpegDimensions(data, 0, data.length) || { width: best.width, height: best.height };
    return { data: Buffer.from(data), width: dims.width, height: dims.height, offset: best.offset };
  }
  return null;
}

module.exports = { extractLargestJpegPreview, findEmbeddedPreviews, parseIFD, jpegDimensions, TAG };
