'use strict';

/**
 * Import path template engine.
 *
 * Supported tokens (case-insensitive):
 *   <date>            -> 2026/08/19        (YYYY/MM/DD)
 *   <yyyy> <yy> <mm> <dd> <hh> <mi> <ss>
 *   <filename>        -> BCD_1030 (no extension)
 *   <name>            -> BCD_1030.NEF
 *   <ext>             -> NEF
 *   <folder>          -> 100NIKON (immediate source folder)
 *   <original>        -> DCIM/100NIKON/BCD_1030.NEF (source-relative path)
 *   <camera> <lens> <iso> <aperture> <focal> <shutter>
 *   <seq> / <seq:4>   -> 1, 0001 (batch counter)
 *
 * Unknown tokens are rejected so typos never silently create weird folders.
 */

const TOKEN_RE = /<([a-z]+)(?::([^<>]{1,64}))?>/gi;

const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';

/** Common date patterns offered by the UI. `/<date>` uses one of these. */
const DATE_FORMATS = [
  { value: 'YYYY-MM-DD', label: '2026-08-19' },
  { value: 'YYYY/MM/DD', label: '2026/08/19 (nested folders)' },
  { value: 'YYYY/MM', label: '2026/08 (year/month folders)' },
  { value: 'YYYY', label: '2026 (year folder)' },
  { value: 'YYYYMMDD', label: '20260819' },
  { value: 'DD-MM-YYYY', label: '19-08-2026' },
  { value: 'MM-DD-YYYY', label: '08-19-2026' },
];

/** Accept only sane date patterns; anything else falls back to YYYY-MM-DD. */
function normalizeDateFormat(fmt) {
  const s = String(fmt ?? '').trim();
  if (!s || s.length > 48) return DEFAULT_DATE_FORMAT;
  if (!/(YYYY|YY|MM|DD)/.test(s)) return DEFAULT_DATE_FORMAT;
  if (/[<>:"|?*\u0000-\u001f]/.test(s)) return DEFAULT_DATE_FORMAT;
  return s;
}

const KNOWN = new Set([
  'date', 'yyyy', 'yy', 'mm', 'dd', 'hh', 'mi', 'ss',
  'filename', 'basename', 'name', 'ext', 'folder', 'original', 'relpath',
  'camera', 'lens', 'iso', 'aperture', 'focal', 'shutter', 'seq',
]);

const ILLEGAL = /[<>:"|?*\u0000-\u001f]/g;
const RESERVED_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function slug(value, { keepSpaces = false } = {}) {
  let s = String(value ?? '')
    .replace(ILLEGAL, '')
    .replace(/[\/\\]+/g, '-')
    .replace(/\s+/g, keepSpaces ? ' ' : '')
    .replace(/^[.\s-]+|[.\s-]+$/g, '');
  if (RESERVED_WIN.test(s)) s = `_${s}`;
  return s;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** Format a Date using YYYY, YY, MM, DD, HH, mm (minutes), ss. */
function formatDatePattern(date, fmt) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const parts = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };
  return normalizeDateFormat(fmt)
    .replace(/YYYY/g, parts.YYYY)
    .replace(/YY/g, parts.YY)
    .replace(/MM/g, parts.MM)
    .replace(/DD/g, parts.DD)
    .replace(/HH/g, parts.HH)
    .replace(/mm/g, parts.mm)
    .replace(/ss/g, parts.ss);
}

function getParts(ctx) {
  const d = ctx.date instanceof Date && !Number.isNaN(ctx.date.getTime()) ? ctx.date : new Date(ctx.epoch || Date.now());
  return {
    yyyy: String(d.getFullYear()),
    yy: String(d.getFullYear()).slice(-2),
    mm: pad(d.getMonth() + 1),
    dd: pad(d.getDate()),
    hh: pad(d.getHours()),
    mi: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
  };
}

function tokenValue(token, arg, ctx) {
  const parts = getParts(ctx);
  switch (token) {
    case 'date': {
      const inline = arg && /(YYYY|YY|MM|DD|HH|mm|ss)/.test(arg) ? arg : null;
      return formatDatePattern(ctx.date, inline || ctx.dateFormat);
    }
    case 'yyyy':
    case 'yy':
    case 'mm':
    case 'dd':
    case 'hh':
    case 'mi':
    case 'ss':
      return parts[token];
    case 'filename':
    case 'basename':
      return slug(ctx.filename || '');
    case 'name':
      return slug(ctx.name || '');
    case 'ext':
      return slug((ctx.ext || '').replace(/^\./, ''));
    case 'folder':
      return slug(ctx.folder || '');
    case 'original':
      return String(ctx.original || '')
        .split(/[\\/]+/)
        .filter(Boolean)
        .map((s) => slug(s))
        .join('/');
    case 'relpath':
      return String(ctx.relPath || '')
        .split(/[\\/]+/)
        .filter(Boolean)
        .map((s) => slug(s))
        .join('/');
    case 'camera':
      return slug(ctx.camera || 'UnknownCamera', { keepSpaces: true });
    case 'lens':
      return slug(ctx.lens || 'UnknownLens', { keepSpaces: true });
    case 'iso':
      return ctx.iso ? `ISO${ctx.iso}` : 'ISO';
    case 'aperture':
      return ctx.aperture ? `f${Number(ctx.aperture).toFixed(1).replace(/\.0$/, '')}` : 'f';
    case 'focal':
      return ctx.focalLength ? `${Math.round(ctx.focalLength)}mm` : '';
    case 'shutter':
      return slug(ctx.shutter || '');
    case 'seq': {
      const width = /^\d{1,3}$/.test(String(arg || '')) ? Number(arg) : 4;
      return pad(ctx.seq ?? 1, Math.min(12, Math.max(1, width)));
    }
    default:
      return null;
  }
}

/** List unknown tokens in a template (for validation + UI feedback). */
function unknownTokens(template) {
  const found = [];
  for (const m of String(template || '').matchAll(TOKEN_RE)) {
    const token = m[1].toLowerCase();
    if (!KNOWN.has(token)) found.push(m[0]);
  }
  return found;
}

/**
 * Expand a template to a relative path (POSIX separators).
 * @param {string} template
 * @param {object} ctx
 * @returns {{ relPath: string|null, error?: string }}
 */
function expand(template, ctx) {
  const tpl = String(template ?? '').trim();
  if (!tpl) return { relPath: null, error: 'Template is empty' };
  const unknown = unknownTokens(tpl);
  if (unknown.length) return { relPath: null, error: `Unknown token(s): ${unknown.join(', ')}` };

  let out = tpl.replace(TOKEN_RE, (_m, token, arg) => {
    const v = tokenValue(token.toLowerCase(), arg, ctx);
    return v == null ? '' : v;
  });

  out = out.replace(/\\/g, '/').replace(/\/+/g, '/');
  const segments = out.split('/').filter((s) => s.length > 0);
  const safe = [];
  for (const raw of segments) {
    const s = slug(raw, { keepSpaces: true });
    if (!s || s === '.' || s === '..') continue;
    safe.push(s);
  }
  if (!safe.length) return { relPath: null, error: 'Template produced an empty path' };
  return { relPath: safe.join('/') };
}

/** Windows-safe check: no segment exceeds 255 chars, total < 240 by default. */
function validateRelPath(relPath, maxLength = 240) {
  if (!relPath) return { ok: false, error: 'Empty path' };
  if (relPath.length > maxLength) return { ok: false, error: `Path too long (${relPath.length} > ${maxLength} chars)` };
  for (const seg of relPath.split('/')) {
    if (seg.length > 255) return { ok: false, error: 'A path segment is longer than 255 characters' };
    if (/[<>:"|?*]/.test(seg)) return { ok: false, error: `Illegal character in "${seg}"` };
  }
  return { ok: true };
}

module.exports = {
  expand,
  unknownTokens,
  validateRelPath,
  slug,
  TOKEN_RE,
  KNOWN,
  DEFAULT_DATE_FORMAT,
  DATE_FORMATS,
  normalizeDateFormat,
  formatDatePattern,
};
