'use strict';

/**
 * Import engine: scan a card/folder, expand the path template, and copy files
 * into the library with conflict handling, verification and progress reporting.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const { walkFiles, sha1File, ensureDir, uniquePath, pathExists, formatBytes } = require('./util');
const { readMetadata, isImage, isRaw } = require('./metadata');
const { expand, validateRelPath, normalizeDateFormat } = require('./template');

function ensureExtension(relPath, sourcePath) {
  const ext = path.extname(sourcePath);
  if (!ext) return relPath;
  const last = path.posix.basename(relPath);
  if (path.posix.extname(last)) return relPath;
  return `${relPath}${ext}`;
}

function appendSuffix(file, n) {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  return `${base} (${n})${ext}`;
}

function makeTokenizerDate(meta) {
  if (!meta?.capturedAt) return new Date();
  // Reconstruct local wall-clock components from the EXIF string.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(meta.capturedAt);
  if (!m) return new Date(meta.capturedEpoch || Date.now());
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

class Importer {
  constructor({ metaCacheSize = 20000 } = {}) {
    this.metaCache = new Map();
    this.cacheLimit = metaCacheSize;
    this.jobs = new Map();
    this.seq = 1;
  }

  cacheKey(file, st) {
    return `${file}|${Math.round(st.size)}|${Math.round(st.mtimeMs)}`;
  }

  async getMeta(file, st) {
    const key = this.cacheKey(file, st);
    const cached = this.metaCache.get(key);
    if (cached) return cached;
    const meta = await readMetadata(file, { stat: st });
    if (this.metaCache.size > this.cacheLimit) {
      const first = this.metaCache.keys().next().value;
      this.metaCache.delete(first);
    }
    this.metaCache.set(key, meta);
    return meta;
  }

  /** Collect image files from a source folder. */
  async collect(source, { recursive = true, maxDepth = 8 } = {}) {
    const out = [];
    for await (const file of walkFiles(source, { maxDepth: recursive ? maxDepth : 1, maxFiles: 50000 })) {
      if (!isImage(file)) continue;
      out.push(file);
    }
    out.sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }),
    );
    return out;
  }

  /**
   * Scan + build a plan.
   * @returns {Promise<object>}
   */
  async prepare({
    source,
    dest,
    template,
    duplicateMode = 'rename',
    includeSubdirs = true,
    verify = false,
    dateFormat = 'YYYY-MM-DD',
    onProgress,
  }) {
    if (!source) throw new Error('Choose a source folder or card');
    if (!dest) throw new Error('Choose a library folder first');
    const files = await this.collect(source, { recursive: includeSubdirs });
    const total = files.length;
    const items = [];
    const errors = [];
    const seenTargets = new Map();
    let bytesTotal = 0;
    let done = 0;
    const started = Date.now();
    const resolvedDateFormat = normalizeDateFormat(dateFormat);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let st;
      try {
        st = await fsp.stat(file);
      } catch (err) {
        errors.push({ file, error: err.message });
        continue;
      }
      let meta;
      try {
        meta = await this.getMeta(file, st);
      } catch {
        meta = null;
      }
      const relFromSource = path.relative(source, file).split(path.sep).join('/');
      const dirRel = path.posix.dirname(relFromSource);
      const ctx = {
        date: makeTokenizerDate(meta),
        dateFormat: resolvedDateFormat,
        epoch: meta?.capturedEpoch,
        filename: path.basename(file, path.extname(file)),
        name: path.basename(file),
        ext: path.extname(file),
        folder: dirRel === '.' ? path.basename(path.dirname(file)) : path.basename(dirRel),
        original: relFromSource,
        relPath: relFromSource,
        camera: meta?.camera,
        lens: meta?.lens,
        iso: meta?.iso,
        aperture: meta?.aperture,
        focalLength: meta?.focalLength,
        shutter: meta?.shutter,
        seq: i + 1,
      };
      const { relPath: expanded, error } = expand(template, ctx);
      const targetRel = expanded && !error ? ensureExtension(expanded, file) : expanded;
      const item = {
        sourcePath: file,
        relFromSource,
        size: st.size,
        mtimeMs: st.mtimeMs,
        meta: meta
          ? {
              capturedAt: meta.capturedAt,
              capturedEpoch: meta.capturedEpoch,
              camera: meta.camera,
              iso: meta.iso,
              aperture: meta.aperture,
              shutter: meta.shutter,
              focalLength: meta.focalLength,
              width: meta.width,
              height: meta.height,
            }
          : null,
        isRaw: isRaw(file),
        selected: true,
        targetRel: targetRel || null,
        error: error || null,
        exists: false,
        duplicateInBatch: false,
        seq: i + 1,
      };
      if (item.targetRel) {
        const check = validateRelPath(item.targetRel);
        if (!check.ok) item.error = check.error;
        item.targetPath = check.ok ? path.join(dest, item.targetRel) : null;
        if (item.targetPath) {
          if (seenTargets.has(item.targetRel.toLowerCase())) {
            item.duplicateInBatch = true;
            item.duplicateOf = seenTargets.get(item.targetRel.toLowerCase());
          } else {
            seenTargets.set(item.targetRel.toLowerCase(), file);
          }
          item.exists = await pathExists(item.targetPath);
        }
      }
      if (item.error) errors.push({ file, error: item.error });
      bytesTotal += st.size;
      items.push(item);

      done++;
      if (onProgress && (done % 25 === 0 || done === total)) {
        onProgress({ phase: 'scanning', done, total, bytesTotal, current: path.basename(file) });
      }
    }

    let freeSpace = null;
    try {
      await ensureDir(dest);
      const st = await fsp.statfs(dest);
      freeSpace = Number(st.bavail) * Number(st.bsize);
    } catch {
      freeSpace = null;
    }

    const valid = items.filter((it) => it.targetRel && !it.error);
    const conflicts = valid.filter((it) => it.exists || it.duplicateInBatch).length;
    const samples = valid.slice(0, 8).map((it) => it.targetRel);

    return {
      source,
      dest,
      template,
      duplicateMode,
      verify,
      dateFormat: resolvedDateFormat,
      items,
      errors,
      samples,
      stats: {
        total,
        valid: valid.length,
        conflicts,
        bytesTotal,
        freeSpace,
        bytesFree: freeSpace,
        freeSpaceText: freeSpace == null ? null : formatBytes(freeSpace),
        enoughSpace: freeSpace == null ? null : freeSpace > bytesTotal * 1.05,
        ms: Date.now() - started,
      },
    };
  }

  /**
   * Execute a plan. Returns a job object that emits 'progress', 'done'.
   * @param {Array} items
   * @param {{dest:string, duplicateMode:string, verify?:boolean, onProgress?:Function, onDone?:Function}} opts
   */
  async run({ items, dest, duplicateMode = 'rename', verify = false, concurrency = 2 }, hooks = {}) {
    const job = {
      id: `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      cancelled: false,
      done: 0,
      total: items.length,
      bytesDone: 0,
      bytesTotal: items.reduce((n, it) => n + (it.size || 0), 0),
      copied: [],
      skipped: [],
      failed: [],
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);

    const channels = [];
    const report = () => {
      if (hooks.onProgress) hooks.onProgress(job);
    };
    let lastReport = 0;
    const throttled = () => {
      const now = Date.now();
      if (now - lastReport > 120 || job.done === job.total) {
        lastReport = now;
        report();
      }
    };

    const active = new Set();
    const queue = items.slice();
    const claimed = new Set();
    const reserveTarget = async (baseTarget, { overwrite = false } = {}) => {
      let candidate = baseTarget;
      for (let i = 0; i < 10000; ) {
        const key = candidate.toLowerCase();
        if (overwrite || !claimed.has(key)) {
          if (!overwrite) claimed.add(key);
          // eslint-disable-next-line no-await-in-loop
          if (overwrite || !(await pathExists(candidate))) return candidate;
          claimed.delete(key);
        }
        i++;
        candidate = appendSuffix(baseTarget, i);
      }
      throw new Error(`Could not find a free filename for ${baseTarget}`);
    };

    const processItem = async (item) => {
      if (job.cancelled) return;
      if (item.selected === false) {
        job.skipped.push({ sourcePath: item.sourcePath, reason: 'deselected' });
        job.done++;
        throttled();
        return;
      }
      if (!item.targetRel || item.error) {
        job.failed.push({ sourcePath: item.sourcePath, error: item.error || 'Invalid target' });
        job.done++;
        throttled();
        return;
      }
      const baseTarget = path.join(dest, item.targetRel);
      const relCheck = path.relative(path.resolve(dest), path.resolve(baseTarget));
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        job.failed.push({ sourcePath: item.sourcePath, error: 'Target escapes library root' });
        job.done++;
        throttled();
        return;
      }
      let target = baseTarget;
      try {
        const exists = await pathExists(target);
        if (exists && duplicateMode === 'skip') {
          let identical = true;
          if (verify) {
            const [a, b] = await Promise.all([sha1File(item.sourcePath, 65536), sha1File(target, 65536)]);
            identical = a === b;
          }
          if (identical) {
            job.skipped.push({ sourcePath: item.sourcePath, target, reason: 'exists' });
            job.done++;
            job.bytesDone += item.size || 0;
            throttled();
            return;
          }
        }
        target = await reserveTarget(target, { overwrite: duplicateMode === 'overwrite' && exists });

        await ensureDir(path.dirname(target));
        const tmp = `${target}.${process.pid}.importing`;
        await fsp.copyFile(item.sourcePath, tmp);
        const [srcStat, tmpStat] = await Promise.all([fsp.stat(item.sourcePath), fsp.stat(tmp)]);
        if (srcStat.size !== tmpStat.size) {
          throw new Error(`Size mismatch after copy (${tmpStat.size} != ${srcStat.size})`);
        }
        await fsp.utimes(tmp, new Date(), new Date(srcStat.mtimeMs));
        await fsp.rename(tmp, target);
        job.copied.push({ sourcePath: item.sourcePath, target, size: srcStat.size });
      } catch (err) {
        job.failed.push({ sourcePath: item.sourcePath, target, error: err.message });
      } finally {
        job.done++;
        job.bytesDone += item.size || 0;
        throttled();
      }
    };

    let cursor = 0;
    const worker = async () => {
      while (!job.cancelled) {
        const idx = cursor++;
        if (idx >= items.length) return;
        await processItem(items[idx]);
      }
    };
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker);
    await Promise.all(workers);

    job.finishedAt = Date.now();
    job.ms = job.finishedAt - job.startedAt;
    this.jobs.delete(job.id);
    report();
    if (hooks.onDone) hooks.onDone(job);
    return job;
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (job) job.cancelled = true;
    return !!job;
  }
}

module.exports = { Importer, ensureExtension };
