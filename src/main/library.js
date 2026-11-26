'use strict';

/**
 * Library: scans a folder, keeps a catalog, and lazily generates thumbnails
 * and metadata in the background so the UI is usable immediately.
 *
 * Scanning is configurable for large/slow libraries:
 *   - scanSubfolders: false indexes only the library root
 *   - excludedFolders: names or relative paths to skip (e.g. "backup", "2023/Originals")
 *   - lazyThumbs: thumbnails are generated on demand for visible tiles
 *   - fastMetadata: skip EXIF during scan; metadata is loaded when a photo is
 *     browsed/opened (great for 10k+ files on a slow HDD)
 */
const EventEmitter = require('node:events');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { Catalog } = require('./catalog');
const { readMetadata, isImage, isRaw, wallFromEpoch } = require('./metadata');
const { walkFiles, Semaphore, safeJoin, normalizeExclusions } = require('./util');

const THUMB_PX = 384;
const MAX_SCAN_DEPTH = 16;

class Library extends EventEmitter {
  constructor({
    root,
    userDataDir,
    thumbs,
    concurrency = 2,
    scanSubfolders = true,
    excludedFolders = [],
    lazyThumbs = true,
    fastMetadata = false,
  }) {
    super();
    this.root = path.resolve(root);
    this.thumbs = thumbs;
    this.catalog = new Catalog({ userDataDir, root: this.root });
    this.concurrency = Math.max(1, Math.min(8, Number(concurrency) || 2));
    this.sem = new Semaphore(this.concurrency);
    this.scanning = false;
    this.cancelled = false;
    this.indexing = 0;
    this.pending = [];
    this.scanSubfolders = scanSubfolders !== false;
    this.excludedFolders = normalizeExclusions(excludedFolders);
    this.lazyThumbs = lazyThumbs !== false;
    this.fastMetadata = !!fastMetadata;
  }

  async open() {
    await this.catalog.load();
    return this.list();
  }

  /** Visible catalog entries with absolute paths, newest capture first. */
  list() {
    return this.catalog
      .list()
      .filter((e) => this._isVisible(e.rel))
      .map((e) => ({ ...e, path: safeJoin(this.root, e.rel) }))
      .sort((a, b) => (b.capturedEpoch || 0) - (a.capturedEpoch || 0) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  }

  stats() {
    const all = this.catalog.list();
    const visible = all.filter((e) => this._isVisible(e.rel));
    return {
      root: this.root,
      total: visible.length,
      all: all.length,
      hidden: all.length - visible.length,
      missing: visible.filter((e) => e.missing).length,
      pending: this.pending.length,
      indexing: this.indexing,
      scanning: this.scanning,
      scanSubfolders: this.scanSubfolders,
      excludedFolders: [...this.excludedFolders],
      lazyThumbs: this.lazyThumbs,
      fastMetadata: this.fastMetadata,
    };
  }

  /** Update scan scope/flags without rescanning. Returns true when something changed. */
  setScanOptions({ scanSubfolders, excludedFolders, lazyThumbs, fastMetadata } = {}) {
    let changed = false;
    if (typeof scanSubfolders === 'boolean' && scanSubfolders !== this.scanSubfolders) {
      this.scanSubfolders = scanSubfolders;
      changed = true;
    }
    if (excludedFolders !== undefined) {
      const next = normalizeExclusions(excludedFolders);
      if (next.join('|') !== this.excludedFolders.join('|')) {
        this.excludedFolders = next;
        changed = true;
      }
    }
    if (typeof lazyThumbs === 'boolean' && lazyThumbs !== this.lazyThumbs) {
      this.lazyThumbs = lazyThumbs;
      changed = true;
    }
    if (typeof fastMetadata === 'boolean' && fastMetadata !== this.fastMetadata) {
      this.fastMetadata = fastMetadata;
      changed = true;
    }
    return changed;
  }

  _isExcluded(rel) {
    if (!this.excludedFolders.length) return false;
    const lower = String(rel).replace(/\\/g, '/').toLowerCase();
    const segs = lower.split('/');
    for (const ex of this.excludedFolders) {
      if (ex.includes('/')) {
        if (lower === ex || lower.startsWith(ex + '/')) return true;
      } else if (segs.length > 1) {
        for (let i = 0; i < segs.length - 1; i++) {
          if (segs[i] === ex) return true;
        }
      }
    }
    return false;
  }

  _isVisible(rel) {
    if (this._isExcluded(rel)) return false;
    if (!this.scanSubfolders && String(rel).includes('/')) return false;
    return true;
  }

  cancelScan() {
    if (!this.scanning) return false;
    this.cancelled = true;
    return true;
  }

  /**
   * Scan the library root.
   * @param {{emitExisting?: boolean}} opts
   */
  async scan(opts = {}) {
    if (this.scanning) return { alreadyRunning: true, ...this.stats() };
    this.scanning = true;
    this.cancelled = false;
    const started = Date.now();
    let done = 0;
    let total = 0;

    try {
      if (opts.emitExisting !== false) this.emit('snapshot', this.list());
      this.emit('progress', { phase: 'walking', done: 0, total: 0 });

      const found = new Set();
      const pending = [];
      let seen = 0;
      const maxDepth = this.scanSubfolders ? MAX_SCAN_DEPTH : 0;
      const shouldEnter = (dir) => {
        const rel = path.relative(this.root, dir).split(path.sep).join('/');
        return !this._isExcluded(rel);
      };

      for await (const file of walkFiles(this.root, { maxFiles: 300000, maxDepth, shouldEnter })) {
        if (this.cancelled) break;
        if (!isImage(file)) continue;
        const rel = path.relative(this.root, file).split(path.sep).join('/');
        // Never catalogue our own Exports folder.
        const first = rel.split('/')[0];
        if (first === 'Exports' || first === '_Exports') continue;
        seen++;
        found.add(rel);
        const entry = this.catalog.get(rel);
        let st;
        try {
          st = await fsp.stat(file);
        } catch {
          continue;
        }
        if (entry && entry.size === st.size && Math.round(entry.mtimeMs) === Math.round(st.mtimeMs) && !entry.missing) {
          const needsMeta = !this.fastMetadata && entry.metaLoaded === false;
          const needsThumb = !this.lazyThumbs && !entry.thumbKey && !entry.thumbFailed;
          if (!needsMeta && !needsThumb) continue;
        }
        pending.push({ rel, file, st, entry });
        if (seen % 50 === 0) this.emit('progress', { phase: 'walking', done: seen, total: 0 });
      }

      if (!this.cancelled) {
        // Only mark vanished files when the walk completed (a cancelled walk
        // would otherwise mark everything it did not reach as missing).
        for (const entry of this.catalog.list()) {
          if (!this._isVisible(entry.rel)) continue;
          if (!found.has(entry.rel) && !entry.missing) this.catalog.patch(entry.rel, { missing: true });
        }
      }

      this.emit('snapshot', this.list());
      total = pending.length;
      this.pending = pending;
      this.emit('progress', { phase: 'indexing', done: 0, total });
      if (total > 3000 && !this.fastMetadata) {
        this.emit('scan:tip', { count: total });
      }

      let cursor = 0;
      const worker = async () => {
        while (!this.cancelled) {
          const idx = cursor++;
          if (idx >= pending.length) return;
          const item = pending[idx];
          try {
            await this.indexOne(item.rel, item.file, item.st, item.entry);
          } catch (err) {
            console.error('[library] index failed', item.rel, err.message);
          } finally {
            done++;
            if (done % 4 === 0 || done === total) {
              this.emit('progress', { phase: 'indexing', done, total });
            }
          }
        }
      };
      const workers = Array.from({ length: Math.max(1, Math.min(this.concurrency, total || 1)) }, worker);
      await Promise.all(workers);
      this.pending = [];
      await this.catalog.save();

      const cancelled = this.cancelled;
      this.scanning = false;
      this.cancelled = false;
      const result = { ...this.stats(), ms: Date.now() - started, indexed: done, cancelled, walked: seen };
      this.emit(cancelled ? 'scan:cancelled' : 'scan:done', result);
      return result;
    } catch (err) {
      this.pending = [];
      this.scanning = false;
      this.cancelled = false;
      this.emit('scan:error', { error: err.message });
      throw err;
    }
  }

  async indexOne(rel, file, st, previous) {
    const raw = isRaw(file);
    const entry = {
      ...(previous || {}),
      rel,
      name: path.basename(file),
      ext: path.extname(file).toLowerCase(),
      size: st.size,
      mtimeMs: st.mtimeMs,
      isRaw: raw,
      thumbKey: previous?.thumbKey || null,
      missing: false,
      indexedAt: Date.now(),
    };

    if (!this.fastMetadata) {
      const meta = await readMetadata(file, { stat: st });
      entry.metaLoaded = true;
      entry.orientation = meta.orientation || previous?.orientation || 1;
      entry.capturedAt = meta.capturedAt;
      entry.capturedOffset = meta.capturedOffset;
      entry.capturedEpoch = meta.capturedEpoch;
      entry.dateSource = meta.dateSource;
      entry.camera = meta.camera;
      entry.lens = meta.lens;
      entry.iso = meta.iso;
      entry.aperture = meta.aperture;
      entry.shutter = meta.shutter;
      entry.focalLength = meta.focalLength;
      entry.width = meta.width || previous?.width || null;
      entry.height = meta.height || previous?.height || null;
    } else if (!previous || previous.metaLoaded !== true) {
      entry.metaLoaded = false;
      entry.capturedAt = previous?.capturedAt || wallFromEpoch(st.mtimeMs);
      entry.capturedOffset = previous?.capturedOffset || null;
      entry.capturedEpoch = previous?.capturedEpoch || st.mtimeMs;
      entry.dateSource = previous?.dateSource || 'mtime';
    }

    if (!this.lazyThumbs) {
      try {
        const info = await this.thumbs.get({ file, mtimeMs: st.mtimeMs, size: st.size, raw }, THUMB_PX);
        entry.thumbKey = info.key;
        entry.thumbFailed = false;
        if (info.source?.width) {
          // RAW preview dimensions are more trustworthy than IFD0 thumbnail tags.
          if (raw || !entry.width) entry.width = info.source.width;
          if (raw || !entry.height) entry.height = info.source.height;
        }
      } catch (err) {
        entry.thumbFailed = true;
        console.warn('[library] thumb failed', rel, err.message);
      }
    }

    this.catalog.set(rel, entry);
    if (this._isVisible(rel)) this.emit('photo', { ...entry, path: file });
    return entry;
  }

  /** Add files that were just imported (absolute paths inside the library). */
  async addImported(paths) {
    const added = [];
    for (const file of paths) {
      const rel = path.relative(this.root, file).split(path.sep).join('/');
      if (rel.startsWith('..')) continue;
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        continue;
      }
      added.push({ rel, file, st, entry: this.catalog.get(rel) });
    }
    this.indexing += added.length;
    for (const item of added) {
      this.sem.run(async () => {
        try {
          await this.indexOne(item.rel, item.file, item.st, item.entry);
        } catch (err) {
          console.error('[library] import index failed', item.rel, err.message);
        } finally {
          this.indexing--;
          this.emit('progress', { phase: 'indexing', done: 0, total: this.indexing });
        }
      });
    }
    return added
      .filter((item) => this._isVisible(item.rel))
      .map((item) => ({ ...this.catalog.get(item.rel), path: item.file, rel: item.rel }));
  }

  async update(rel, patch, { persist = true } = {}) {
    const entry = this.catalog.get(rel);
    if (!entry) return null;
    const allowed = {};
    for (const key of [
      'rating', 'flag', 'colorLabel', 'edits', 'rawMode', 'rawNote', 'width', 'height', 'crop',
      'thumbKey', 'thumbFailed', 'metaLoaded', 'capturedAt', 'capturedOffset', 'capturedEpoch',
      'dateSource', 'orientation', 'camera', 'lens', 'iso', 'aperture', 'shutter', 'focalLength',
    ]) {
      if (patch[key] !== undefined) allowed[key] = patch[key];
    }
    const next = this.catalog.patch(rel, { ...allowed, editedAt: Date.now() });
    if (persist) await this.catalog.save();
    if (next && this._isVisible(rel)) this.emit('photo', { ...next, path: safeJoin(this.root, rel) });
    return next;
  }

  async removeMissing() {
    for (const entry of this.catalog.list()) {
      if (entry.missing) this.catalog.delete(entry.rel);
    }
    await this.catalog.save();
    this.emit('snapshot', this.list());
  }

  async close() {
    this.cancelled = true;
    await this.catalog.flush();
  }
}

/** Build a nested folder tree (direct + total photo counts) from visible photos. */
function buildFolderTree(photos, rootName) {
  const root = { name: rootName, path: '', direct: 0, total: 0, children: [] };
  const nodes = new Map([['', root]]);
  const ensure = (dirPath) => {
    const existing = nodes.get(dirPath);
    if (existing) return existing;
    const cut = dirPath.lastIndexOf('/');
    const parentPath = cut >= 0 ? dirPath.slice(0, cut) : '';
    const parent = ensure(parentPath);
    const node = { name: dirPath.slice(cut + 1), path: dirPath, direct: 0, total: 0, children: [] };
    parent.children.push(node);
    nodes.set(dirPath, node);
    return node;
  };
  for (const photo of photos) {
    const rel = String(photo?.rel || '');
    if (!rel) continue;
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    ensure(dir).direct++;
  }
  const compute = (node) => {
    let total = node.direct;
    for (const child of node.children) total += compute(child);
    node.total = total;
    node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return total;
  };
  compute(root);
  return { rootName, all: photos.length, root };
}

module.exports = { Library, THUMB_PX, buildFolderTree };
