'use strict';

/**
 * Image metadata: EXIF via exifr, with careful handling of camera wall-clock
 * timestamps (EXIF dates have no timezone; we keep them as written and use the
 * optional OffsetTime* to compute a sortable UTC epoch).
 */
const path = require('node:path');
const exifr = require('exifr');

const RAW_EXT = new Set([
  '.nef', '.nrw', '.cr2', '.cr3', '.crw', '.arw', '.srf', '.sr2', '.dng', '.raf',
  '.orf', '.rw2', '.pef', '.srw', '.x3f', '.3fr', '.fff', '.iiq', '.mos', '.mrw',
  '.erf', '.kdc', '.dcr', '.raw', '.rwl', '.sraw', '.heic', '.heif',
]);

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp', '.gif', '.tif', '.tiff',
]);

const SUPPORTED_EXT = new Set([...RAW_EXT, ...IMAGE_EXT]);

const EDITABLE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.nef', '.nrw', '.cr2', '.cr3',
  '.arw', '.srf', '.sr2', '.dng', '.raf', '.orf', '.rw2', '.pef', '.srw', '.x3f',
  '.3fr', '.fff', '.iiq', '.mos', '.mrw', '.erf', '.kdc', '.dcr', '.raw', '.rwl',
]);

function extOf(file) {
  return path.extname(file).toLowerCase();
}

function isRaw(file) {
  return RAW_EXT.has(extOf(file));
}

function isImage(file) {
  return SUPPORTED_EXT.has(extOf(file));
}

function isEditable(file) {
  return EDITABLE_EXT.has(extOf(file));
}

/** "2026:08:19 06:54:53" -> "2026-08-19T06:54:53" (no TZ interpretation). */
function exifDateToString(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}T${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;
  }
  const m = String(value).match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

/** Convert a wall-clock string + optional offset into a UTC epoch (ms). */
function wallClockToEpoch(wall, offset) {
  if (!wall) return null;
  const base = Date.parse(wall + 'Z'); // treat wall clock as if UTC
  if (Number.isNaN(base)) return null;
  let ms = base;
  const m = offset && String(offset).match(/^([+-])(\d{2}):?(\d{2})/);
  if (m) {
    const sign = m[1] === '-' ? -1 : 1;
    const mins = Number(m[2]) * 60 + Number(m[3]);
    ms = base - sign * mins * 60000;
  }
  return ms;
}

function parseWallFromEpoch(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatShutter(exposure) {
  if (!exposure || !Number.isFinite(exposure) || exposure <= 0) return null;
  if (exposure >= 0.5) return `${Number(exposure.toFixed(1))}s`;
  const denom = Math.round(1 / exposure);
  return `1/${denom}`;
}

function formatFocal(focal) {
  if (!focal || !Number.isFinite(focal)) return null;
  return `${Math.round(focal)}mm`;
}

function cleanString(v) {
  if (v == null) return null;
  const s = String(v).replace(/\u0000/g, '').trim();
  return s || null;
}

/**
 * Read metadata for a file.
 * @returns {Promise<object>} Metadata object (never throws).
 */
async function readMetadata(file, { stat } = {}) {
  const st = stat || (await require('node:fs/promises').stat(file));
  // Node reports sub-millisecond mtimes on some filesystems (notably Linux);
  // capturedEpoch is consumed as an integer-millisecond timestamp.
  const mtimeMs = Math.round(st.mtimeMs);
  const result = {
    width: null,
    height: null,
    orientation: 1,
    capturedAt: null,
    capturedOffset: null,
    capturedEpoch: mtimeMs,
    camera: null,
    cameraMake: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    hasExif: false,
    dateSource: 'mtime',
  };

  let exif = null;
  try {
    exif = await exifr.parse(file, {
      tiff: true,
      exif: true,
      ifd0: true,
      gps: false,
      interop: false,
      reviveValues: false,
      translateValues: false,
      pick: [
        'Make', 'Model', 'LensModel', 'Lens', 'LensInfo', 'DateTimeOriginal', 'CreateDate',
        'ModifyDate', 'OffsetTime', 'OffsetTimeOriginal', 'OffsetTimeDigitized',
        'ISO', 'ISOSpeedRatings', 'FNumber', 'ApertureValue', 'ExposureTime', 'ShutterSpeedValue',
        'FocalLength', 'FocalLengthIn35mmFormat', 'Orientation', 'ExifImageWidth',
        'ExifImageHeight', 'ImageWidth', 'ImageHeight', 'PixelXDimension', 'PixelYDimension',
      ],
    });
  } catch {
    exif = null;
  }

  if (exif) {
    result.hasExif = true;
    const make = cleanString(exif.Make);
    const model = cleanString(exif.Model);
    result.cameraMake = make;
    // "NIKON CORPORATION" + "NIKON Z50_2" -> "Nikon Z50_2"
    if (model) {
      const m = model.replace(/\s+/g, ' ');
      const pretty = m
        .replace(/^NIKON\s+/i, 'Nikon ')
        .replace(/^NIKON CORPORATION\s+/i, 'Nikon ')
        .replace(/^CANON\s+/i, 'Canon ')
        .replace(/^SONY\s+/i, 'Sony ')
        .replace(/^FUJIFILM\s+/i, 'Fujifilm ')
        .replace(/^OLYMPUS\s+/i, 'Olympus ')
        .replace(/^PANASONIC\s+/i, 'Panasonic ')
        .replace(/^PENTAX\s+/i, 'Pentax ');
      result.camera = pretty;
    } else if (make) {
      result.camera = make;
    }
    result.lens = cleanString(exif.LensModel || exif.Lens || exif.LensInfo);
    const iso = exif.ISO || exif.ISOSpeedRatings;
    if (typeof iso === 'number') result.iso = Math.round(iso);
    else if (Array.isArray(iso) && iso.length) result.iso = Math.round(iso[0]);
    if (typeof exif.FNumber === 'number') result.aperture = exif.FNumber;
    else if (typeof exif.ApertureValue === 'number') result.aperture = Math.pow(2, exif.ApertureValue / 2);
    if (typeof exif.ExposureTime === 'number') result.shutter = exif.ExposureTime;
    let focal = exif.FocalLength;
    if (typeof focal !== 'number' && focal && typeof focal === 'object') focal = focal.value;
    if (typeof focal === 'number') result.focalLength = focal;

    const orient = Number(exif.Orientation);
    if (orient >= 1 && orient <= 8) result.orientation = orient;

    const width = exif.ExifImageWidth || exif.PixelXDimension || exif.ImageWidth;
    const height = exif.ExifImageHeight || exif.PixelYDimension || exif.ImageHeight;
    if (typeof width === 'number' && width > 0) result.width = width;
    if (typeof height === 'number' && height > 0) result.height = height;

    const wall =
      exifDateToString(exif.DateTimeOriginal) ||
      exifDateToString(exif.CreateDate) ||
      exifDateToString(exif.ModifyDate);
    const offset = cleanString(exif.OffsetTimeOriginal || exif.OffsetTimeDigitized || exif.OffsetTime);
    if (wall) {
      result.capturedAt = wall;
      result.capturedOffset = offset;
      result.dateSource = 'exif';
      const epoch = wallClockToEpoch(wall, offset);
      if (epoch != null) result.capturedEpoch = epoch;
    }
  }

  if (!result.capturedAt) {
    result.capturedAt = parseWallFromEpoch(mtimeMs);
    result.capturedEpoch = mtimeMs;
    result.dateSource = 'mtime';
  }

  return result;
}

/** Unix-mtime in ms for a catalog entry (from EXIF date when available). */
function mtimeForEntry(file, entry) {
  const epoch = entry && entry.capturedEpoch;
  return typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : null;
}

module.exports = {
  RAW_EXT,
  IMAGE_EXT,
  SUPPORTED_EXT,
  EDITABLE_EXT,
  extOf,
  isRaw,
  isImage,
  isEditable,
  readMetadata,
  exifDateToString,
  wallClockToEpoch,
  formatShutter,
  formatFocal,
  mtimeForEntry,
  wallFromEpoch: parseWallFromEpoch,
};
