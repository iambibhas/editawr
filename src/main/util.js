'use strict';

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Simple async semaphore for bounded concurrency. */
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit | 0);
    this.active = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function sha1(input, len = 40) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, len);
}

async function sha1File(file, sample = 0) {
  const hash = crypto.createHash('sha1');
  if (!sample) {
    const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
  }
  const st = await fsp.stat(file);
  const size = Math.min(sample, st.size);
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    hash.update(buf);
    if (st.size > size) {
      const tail = Buffer.alloc(size);
      await fh.read(tail, 0, size, Math.max(0, st.size - size));
      hash.update(tail);
    }
    hash.update(String(st.size));
    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** Write via temp file + rename so a crash cannot leave a half-written file. */
async function atomicWrite(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

/** Append " (1)", " (2)", ... until the path does not exist. */
async function uniquePath(file) {
  if (!(await pathExists(file))) return file;
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free filename for ${file}`);
}

/** Ensure a relative path stays inside root (throws otherwise). */
function safeJoin(root, rel) {
  const abs = path.resolve(root, rel);
  const relCheck = path.relative(path.resolve(root), abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error('Path escapes root');
  }
  return abs;
}

const SKIP_DIRS = new Set([
  'system volume information',
  '$recycle.bin',
  'recycler',
  '.trash',
  '.trashes',
  '.spotlight-v100',
  '.fseventsd',
  'node_modules',
  '.git',
  '.editawr',
]);

const DEFAULT_SKIP_DIR_RE = /^(\.|@)/;

/**
 * Recursively walk a directory yielding files.
 * @param {string} root
 * @param {{maxDepth?: number, maxFiles?: number, onFile?: Function, filterDir?: Function}} opts
 */
async function* walkFiles(root, opts = {}) {
  const maxDepth = opts.maxDepth ?? 16;
  const maxFiles = opts.maxFiles ?? 200000;
  let count = 0;
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const subdirs = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        if (DEFAULT_SKIP_DIR_RE.test(entry.name) && depth === 0) continue;
        if (opts.shouldEnter && !(await opts.shouldEnter(full, entry.name))) continue;
        subdirs.push(full);
      } else if (entry.isFile()) {
        count++;
        if (count > maxFiles) return;
        yield full;
      }
    }
    // Push in reverse so alphabetical order is preserved (stack is LIFO).
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push({ dir: subdirs[i], depth: depth + 1 });
  }
}

/** Normalise user-supplied folder exclusions to lowercase relative paths. */
function normalizeExclusions(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,;\n]/);
  const out = [];
  for (const item of raw) {
    const s = String(item).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
    if (!s || s === '.' || s === '..') continue;
    if (/[<>:"|?*]/.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 100) break;
  }
  return out;
}

function parseNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

module.exports = {
  Semaphore,
  pathExists,
  sha1,
  sha1File,
  ensureDir,
  atomicWrite,
  uniquePath,
  safeJoin,
  walkFiles,
  normalizeExclusions,
  parseNumber,
  formatBytes,
  SKIP_DIRS,
};
