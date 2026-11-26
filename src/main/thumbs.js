'use strict';

/**
 * Thumbnail + preview cache.
 *
 * RAW thumbnails are built from the embedded full-size JPEG preview, which is
 * both much faster and much more reliable than demosaicing sensor data (and it
 * is the only option for compressed formats the bundled LibRaw cannot decode,
 * e.g. Nikon HE/HE*).
 */
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { extractLargestJpegPreview, findEmbeddedPreviews, jpegDimensions } = require('./tiff-preview');
const { atomicWrite, sha1, Semaphore, ensureDir } = require('./util');
const { isRaw } = require('./metadata');

sharp.cache({ files: 0, items: 64, memory: 128 });
sharp.concurrency(Math.max(1, Math.min(4, require('node:os').cpus().length - 1)));

class Thumbs {
  constructor({ thumbDir, previewDir, maxCacheBytes = 900 * 1024 * 1024 }) {
    this.thumbDir = thumbDir;
    this.previewDir = previewDir;
    this.maxCacheBytes = maxCacheBytes;
    this.sem = new Semaphore(3);
    this.inFlight = new Map();
    this.ready = Promise.all([ensureDir(thumbDir), ensureDir(previewDir)]);
  }

  keyFor(file, mtimeMs, size, px) {
    return `${sha1(`${file}|${Math.round(mtimeMs)}|${size}|${px}`, 24)}.jpg`;
  }

  urlFor(key) {
    return `thumb://cache/${encodeURIComponent(key)}`;
  }

  pathFor(key) {
    return path.join(this.thumbDir, key);
  }

  /**
   * Extract the embedded JPEG preview from a RAW file while reading as little
   * as possible: a 4 MB header is enough for the IFD tree on every camera we
   * have seen, then only the JPEG itself is read. This turns thumbnail creation
   * on a slow HDD from a 20-30 MB read into ~2-4 MB.
   */
  static extractPreview(file) {
    const HEAD_BYTES = 4 * 1024 * 1024;
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const st = fs.fstatSync(fd);
      let candidates = [];
      const headLen = Math.min(st.size, HEAD_BYTES);
      if (headLen >= 16) {
        const head = Buffer.alloc(headLen);
        fs.readSync(fd, head, 0, headLen, 0);
        candidates = findEmbeddedPreviews(head);
      }
      if (!candidates.length && st.size > HEAD_BYTES) {
        // IFD tree lives beyond the header (rare) — fall back to the full file.
        fs.closeSync(fd);
        fd = null;
        return extractLargestJpegPreview(fs.readFileSync(file));
      }
      for (const best of candidates) {
        const length = Math.min(best.length, Math.max(0, st.size - best.offset));
        if (length < 4) continue;
        const data = Buffer.alloc(length);
        fs.readSync(fd, data, 0, length, best.offset);
        if (data[0] !== 0xff || data[1] !== 0xd8) continue;
        const dims = jpegDimensions(data, 0, data.length) || { width: best.width, height: best.height };
        return { data, width: dims.width, height: dims.height, offset: best.offset };
      }
      return null;
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Get (or build) a thumbnail.
   * @param {{file:string, mtimeMs:number, size:number, raw?:boolean}} photo
   * @param {number} px longest edge in pixels
   */
  async get(photo, px = 384) {
    await this.ready;
    const key = this.keyFor(photo.file, photo.mtimeMs ?? 0, photo.size ?? 0, px);
    const dest = this.pathFor(key);

    if (await fs.promises.access(dest).then(() => true, () => false)) {
      return { key, url: this.urlFor(key), path: dest, source: null };
    }

    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const task = this.sem
      .run(async () => {
        let pipeline;
        let input;
        if (photo.raw ?? isRaw(photo.file)) {
          const pv = Thumbs.extractPreview(photo.file);
          if (!pv) throw new Error('No embedded preview found in RAW file');
          input = pv.data;
        } else {
          input = photo.file;
        }
        const srcMeta = await sharp(input, { failOn: 'none' }).metadata();
        const swap = srcMeta.orientation >= 5;
        const source = {
          width: (swap ? srcMeta.height : srcMeta.width) || null,
          height: (swap ? srcMeta.width : srcMeta.height) || null,
          orientation: srcMeta.orientation || 1,
        };
        pipeline = sharp(input, { failOn: 'none' }).rotate();
        const out = await pipeline
          .resize({ width: px, height: px, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: '4:4:4' })
          .toBuffer();
        await atomicWrite(dest, out);
        return { key, url: this.urlFor(key), path: dest, source };
      })
      .finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, task);
    return task;
  }

  /**
   * Build (or return) a full-size JPEG preview for RAW editing fallback.
   * Cached separately so opening a RAW is instant the second time.
   */
  async getRawPreview(photo, maxEdge = 0) {
    await this.ready;
    const key = `${sha1(`full|${photo.file}|${Math.round(photo.mtimeMs ?? 0)}|${photo.size ?? 0}|${maxEdge}`, 24)}.jpg`;
    const dest = path.join(this.previewDir, key);
    if (await fs.promises.access(dest).then(() => true, () => false)) {
      return { path: dest, key, url: this.urlFor(key) };
    }
    return this.sem.run(async () => {
      const pv = Thumbs.extractPreview(photo.file);
      if (!pv) throw new Error('No embedded preview found in RAW file');
      let pipeline = sharp(pv.data, { failOn: 'none' }).rotate();
      if (maxEdge) pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
      const out = await pipeline
        .jpeg({ quality: 93, mozjpeg: true, chromaSubsampling: '4:4:4' })
        .toBuffer();
      await atomicWrite(dest, out);
      return { path: dest, key, url: this.urlFor(key), buffer: out };
    });
  }

  /** Full-size (or capped) JPEG preview for formats Chromium cannot decode (TIFF/HEIC). */
  async getDisplayPreview(photo, maxEdge = 4000) {
    await this.ready;
    const key = `${sha1(`disp|${photo.file}|${Math.round(photo.mtimeMs ?? 0)}|${photo.size ?? 0}|${maxEdge}`, 24)}.jpg`;
    const dest = path.join(this.previewDir, key);
    if (await fs.promises.access(dest).then(() => true, () => false)) {
      return { path: dest, key, url: this.urlFor(key) };
    }
    return this.sem.run(async () => {
      const out = await sharp(photo.file, { failOn: 'none' })
        .rotate()
        .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 93, mozjpeg: true, chromaSubsampling: '4:4:4' })
        .toBuffer();
      await atomicWrite(dest, out);
      return { path: dest, key, url: this.urlFor(key) };
    });
  }

  /** Raw embedded JPEG bytes (no cache) — used by the importer for speed hints. */
  static async embeddedJpeg(file) {
    const buf = await fsp.readFile(file);
    return extractLargestJpegPreview(buf);
  }

  /** Trim the thumbnail + preview cache to maxCacheBytes (LRU by mtime). */
  async prune() {
    await this.ready;
    for (const dir of [this.thumbDir, this.previewDir]) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const files = [];
      let total = 0;
      for (const e of entries) {
        if (!e.isFile()) continue;
        try {
          const st = await fsp.stat(path.join(dir, e.name));
          total += st.size;
          files.push({ path: path.join(dir, e.name), size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
      if (total <= this.maxCacheBytes) continue;
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let remaining = total;
      for (const f of files) {
        if (remaining <= this.maxCacheBytes * 0.7) break;
        try {
          await fsp.unlink(f.path);
          remaining -= f.size;
        } catch {
          /* ignore */
        }
      }
    }
  }
}

module.exports = { Thumbs };
