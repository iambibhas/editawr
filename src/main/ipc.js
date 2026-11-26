'use strict';

/**
 * IPC surface. Every handler is wrapped so the renderer always receives
 * {ok:true, data} or {ok:false, error} instead of throwing across the bridge.
 */
const { ipcMain, dialog, shell, BrowserWindow } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');

const proto = require('./protocol');
const { isRaw, isImage, extOf, readMetadata } = require('./metadata');
const { buildFolderTree } = require('./library');
const { exportImage } = require('./exporter');
const { normalizeDateFormat } = require('./template');
const { formatBytes, normalizeExclusions } = require('./util');

function registerIpc(ctx) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        const data = await fn(event, ...args);
        return { ok: true, data };
      } catch (err) {
        console.error(`[ipc] ${channel} failed:`, err);
        return { ok: false, error: err?.message || String(err) };
      }
    });
  };

  const decorate = (entry) => decorateEntry(ctx.library, entry);

  const requireLibrary = () => {
    if (!ctx.library) throw new Error('No library is open');
    return ctx.library;
  };

  const findEntry = (rel) => {
    const lib = requireLibrary();
    const entry = lib.catalog.get(rel);
    if (!entry) throw new Error('Photo is not in the catalog');
    return { lib, entry, abs: path.join(lib.root, rel) };
  };

  /* ------------------------------- app -------------------------------- */

  handle('app:info', async () => ({
    version: ctx.app.getVersion(),
    name: 'EditAWr',
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    userData: ctx.userData,
    settings: ctx.settings.get(),
    library: ctx.library
      ? { root: ctx.library.root, photos: ctx.library.list().map(decorate), stats: ctx.library.stats() }
      : null,
    drives: ctx.devices,
  }));

  handle('shell:openPath', async (_e, target) => {
    if (typeof target !== 'string') throw new Error('Invalid path');
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return true;
  });

  handle('shell:showItem', async (_e, target) => {
    if (typeof target !== 'string') throw new Error('Invalid path');
    shell.showItemInFolder(target);
    return true;
  });

  handle('shell:openExternal', async (_e, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Invalid URL');
    await shell.openExternal(url);
    return true;
  });

  /* ----------------------------- settings ------------------------------ */

  handle('settings:get', async () => ctx.settings.get());

  handle('settings:set', async (_e, patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('Invalid settings');
    if (patch.dateFormat !== undefined) patch = { ...patch, dateFormat: normalizeDateFormat(patch.dateFormat) };
    if (patch.excludedFolders !== undefined) patch = { ...patch, excludedFolders: normalizeExclusions(patch.excludedFolders) };
    const next = ctx.settings.set(patch);
    if (patch.autoDetectCards !== undefined) {
      if (patch.autoDetectCards) {
        ctx.drives.start();
      } else {
        ctx.drives.stop();
        ctx.devices = [];
        ctx.broadcast('drives:devices', []);
      }
    }
    const scanKeys = ['scanSubfolders', 'excludedFolders', 'lazyThumbs', 'fastMetadata'];
    if (scanKeys.some((k) => patch[k] !== undefined) && ctx.library) {
      const scopeChanged = patch.scanSubfolders !== undefined || patch.excludedFolders !== undefined;
      ctx.library.setScanOptions({
        scanSubfolders: next.scanSubfolders,
        excludedFolders: next.excludedFolders,
        lazyThumbs: next.lazyThumbs,
        fastMetadata: next.fastMetadata,
      });
      ctx.broadcast('library:snapshot', ctx.library.list().map(decorate));
      ctx.broadcast('library:stats', ctx.library.stats());
      if (scopeChanged) {
        ctx.library.scan().catch((err) => console.error('[library] rescan after scan settings failed:', err.message));
      }
    }
    ctx.broadcast('settings:changed', next);
    if (patch.libraryPath && ctx.library?.root !== path.resolve(patch.libraryPath)) {
      await ctx.openLibrary(patch.libraryPath);
    }
    return next;
  });

  /* ------------------------------ dialog ------------------------------- */

  handle('dialog:pickFolder', async (_e, { title, defaultPath, buttonLabel } = {}) => {
    const win = BrowserWindow.fromWebContents(_e.sender) || ctx.win;
    const res = await dialog.showOpenDialog(win, {
      title: title || 'Choose folder',
      defaultPath: defaultPath || ctx.settings.get('libraryPath') || undefined,
      buttonLabel: buttonLabel || 'Choose',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const dir = res.filePaths[0];
    proto.allowRoot(dir);
    return dir;
  });

  /* ------------------------------ library ------------------------------ */

  handle('library:open', async (_e, { path: root }) => {
    const info = await ctx.openLibrary(root, { scan: true });
    return info;
  });

  handle('library:choose', async (event, opts = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender) || ctx.win;
    const res = await dialog.showOpenDialog(win, {
      title: opts.title || 'Choose your photo library folder',
      defaultPath: ctx.settings.get('libraryPath') || undefined,
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return ctx.openLibrary(res.filePaths[0], { scan: true });
  });

  handle('library:state', async () => {
    if (!ctx.library) return null;
    return {
      root: ctx.library.root,
      photos: ctx.library.list().map(decorate),
      stats: ctx.library.stats(),
    };
  });

  handle('library:scan', async () => {
    const lib = requireLibrary();
    const result = await lib.scan();
    return { ...result, root: lib.root, photos: lib.list().map(decorate), stats: lib.stats() };
  });

  handle('library:cancel-scan', async () => {
    const lib = requireLibrary();
    return { cancelled: lib.cancelScan() };
  });

  handle('library:stats', async () => requireLibrary().stats());

  handle('library:tree', async () => {
    const lib = requireLibrary();
    return buildFolderTree(lib.list(), path.basename(lib.root));
  });

  handle('library:update', async (_e, { rel, patch }) => {
    const lib = requireLibrary();
    const next = await lib.update(rel, patch || {});
    return next ? decorate(next) : null;
  });

  handle('library:removeMissing', async () => {
    const lib = requireLibrary();
    await lib.removeMissing();
    return { photos: lib.list().map(decorate), stats: lib.stats() };
  });

  handle('library:reveal', async (_e, { rel }) => {
    const lib = requireLibrary();
    shell.showItemInFolder(path.join(lib.root, rel));
    return true;
  });

  /* ------------------------------ thumbs ------------------------------- */

  handle('thumbs:ensure', async (_e, { rel, px = 384 }) => {
    const { lib, entry } = findEntry(rel);
    const abs = path.join(lib.root, rel);
    const absStat = await fsp.stat(abs);
    const info = await ctx.thumbs.get(
      { file: abs, mtimeMs: absStat.mtimeMs, size: absStat.size, raw: entry.isRaw },
      px,
    );
    const patch = { thumbKey: info.key, thumbFailed: false };
    const sourceW = info.source?.width || null;
    const sourceH = info.source?.height || null;
    if (sourceW && sourceH) {
      patch.width = entry.isRaw ? sourceW : entry.width || sourceW;
      patch.height = entry.isRaw ? sourceH : entry.height || sourceH;
    }
    if (entry.metaLoaded === false) {
      const meta = await readMetadata(abs, { stat: absStat });
      Object.assign(patch, {
        metaLoaded: true,
        width: meta.width || patch.width || entry.width || null,
        height: meta.height || patch.height || entry.height || null,
        orientation: meta.orientation,
        capturedAt: meta.capturedAt,
        capturedOffset: meta.capturedOffset,
        capturedEpoch: meta.capturedEpoch,
        dateSource: meta.dateSource,
        camera: meta.camera,
        lens: meta.lens,
        iso: meta.iso,
        aperture: meta.aperture,
        shutter: meta.shutter,
        focalLength: meta.focalLength,
      });
    }
    if (entry.thumbKey !== info.key || entry.metaLoaded === false || entry.thumbFailed) {
      await lib.update(rel, patch, { persist: false });
    }
    return { url: info.url, width: info.source?.width || null, height: info.source?.height || null };
  });

  /* ------------------------------ photos ------------------------------- */

  handle('photo:open', async (_e, { rel }) => {
    const found = findEntry(rel);
    let entry = found.entry;
    const { lib, abs } = found;
    const st = await fsp.stat(abs);
    if (entry.metaLoaded === false) {
      const meta = await readMetadata(abs, { stat: st });
      const updated = await lib.update(rel, {
        metaLoaded: true,
        orientation: meta.orientation,
        capturedAt: meta.capturedAt,
        capturedOffset: meta.capturedOffset,
        capturedEpoch: meta.capturedEpoch,
        dateSource: meta.dateSource,
        camera: meta.camera,
        lens: meta.lens,
        iso: meta.iso,
        aperture: meta.aperture,
        shutter: meta.shutter,
        focalLength: meta.focalLength,
        width: meta.width || entry.width || null,
        height: meta.height || entry.height || null,
      });
      if (updated) entry = updated;
    }
    const raw = isRaw(abs);
    const base = {
      rel,
      path: abs,
      entry: decorate(entry),
      name: path.basename(abs),
      size: st.size,
      mtimeMs: st.mtimeMs,
      width: entry.width || null,
      height: entry.height || null,
      isRaw: raw,
      capturedAt: entry.capturedAt,
    };

    if (raw) {
      const preview = await ctx.thumbs.getRawPreview(
        { file: abs, mtimeMs: st.mtimeMs, size: st.size },
        ctx.settings.get('editor')?.previewMaxEdge ?? 0,
      );
      return { ...base, kind: 'raw', previewUrl: proto.thumbUrl(preview.key, 'preview') };
    }

    const ext = extOf(abs);
    if (ext === '.tif' || ext === '.tiff') {
      const preview = await ctx.thumbs.getDisplayPreview({ file: abs, mtimeMs: st.mtimeMs, size: st.size }, 4000);
      return { ...base, kind: 'image', url: proto.thumbUrl(preview.key, 'preview') };
    }

    return { ...base, kind: 'image', url: proto.photoUrl(abs) };
  });

  handle('photo:read', async (_e, { rel }) => {
    const { abs } = findEntry(rel);
    if (!proto.isAllowed(abs)) throw new Error('Access denied');
    const st = await fsp.stat(abs);
    if (st.size > 700 * 1024 * 1024) throw new Error('File is too large to decode');
    const buf = await fsp.readFile(abs);
    // Copy into a standalone ArrayBuffer for zero-surprise structured cloning.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  handle('photo:preview', async (_e, { rel, maxEdge = 3000 }) => {
    const { lib, entry, abs } = findEntry(rel);
    const st = await fsp.stat(abs);
    if (isRaw(abs)) {
      const preview = await ctx.thumbs.getRawPreview({ file: abs, mtimeMs: st.mtimeMs, size: st.size }, maxEdge);
      return { url: proto.thumbUrl(preview.key, 'preview'), width: entry.width, height: entry.height };
    }
    const preview = await ctx.thumbs.getDisplayPreview({ file: abs, mtimeMs: st.mtimeMs, size: st.size }, maxEdge);
    return { url: proto.thumbUrl(preview.key, 'preview'), width: entry.width, height: entry.height };
  });

  handle('photo:metadata', async (_e, { rel }) => {
    const { abs } = findEntry(rel);
    const st = await fsp.stat(abs);
    return readMetadata(abs, { stat: st });
  });

  /* ------------------------------ drives ------------------------------- */

  handle('drives:list', async () => ctx.drives.list());

  handle('drives:inspect', async (_e, { mount }) => {
    proto.allowRoot(mount);
    return ctx.drives.inspect(mount);
  });

  handle('drives:eject', async (_e, { mount }) => ctx.eject(mount));

  handle('drives:refresh', async () => ctx.drives.refresh({ force: true }));

  handle('drives:pickFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || ctx.win;
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a folder or card to import from',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const dir = res.filePaths[0];
    proto.allowRoot(dir);
    return dir;
  });

  /* ------------------------------ import ------------------------------- */

  handle('import:prepare', async (event, opts = {}) => {
    if (opts.source) proto.allowRoot(opts.source);
    if (opts.dest) proto.allowRoot(opts.dest);
    const sender = event.sender;
    let last = 0;
    const plan = await ctx.importer.prepare({
      ...opts,
      dateFormat: opts.dateFormat || ctx.settings.get('dateFormat'),
      onProgress: (p) => {
        const now = Date.now();
        if (now - last > 100) {
          last = now;
          if (!sender.isDestroyed()) sender.send('import:prepare-progress', p);
        }
      },
    });
    return plan;
  });

  handle('import:run', async (event, { plan } = {}) => {
    if (!plan || !Array.isArray(plan.items)) throw new Error('Invalid import plan');
    const dest = plan.dest;
    if (!dest) throw new Error('No destination');
    proto.allowRoot(dest);
    const sender = event.sender;
    const job = await ctx.importer.run(
      { items: plan.items, dest, duplicateMode: plan.duplicateMode || 'rename', verify: !!plan.verify },
      {
        onProgress: (j) => {
          if (sender.isDestroyed()) return;
          sender.send('import:progress', {
            jobId: j.id,
            done: j.done,
            total: j.total,
            bytesDone: j.bytesDone,
            bytesTotal: j.bytesTotal,
            copied: j.copied.length,
            skipped: j.skipped.length,
            failed: j.failed.length,
            current: j.copied[j.copied.length - 1]?.sourcePath || null,
          });
        },
        onDone: async (j) => {
          let added = [];
          try {
            if (ctx.library && j.copied.length) {
              added = await ctx.library.addImported(j.copied.map((c) => c.target));
            }
          } catch (err) {
            console.error('[import] catalog update failed:', err);
          }
          if (!sender.isDestroyed()) {
            sender.send('import:done', {
              jobId: j.id,
              copied: j.copied.length,
              skipped: j.skipped.length,
              failed: j.failed,
              ms: j.ms,
              bytes: j.copied.reduce((n, c) => n + c.size, 0),
              added: added.length,
            });
          }
        },
      },
    );
    return { jobId: job.id, total: job.total };
  });

  handle('import:cancel', async (_e, { jobId }) => ctx.importer.cancel(jobId));

  /* ------------------------------ export ------------------------------- */

  handle('export:save', async (_e, opts = {}) => {
    const { data, format = 'jpeg', quality = 92, dir, filenameTemplate, entry, resizeLongEdge = 0, overwrite = false } = opts;
    if (!data) throw new Error('No rendered image data');
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let targetDir = dir;
    if (!targetDir) {
      const lib = ctx.library;
      if (!lib) throw new Error('Choose an export folder');
      targetDir = path.join(lib.root, 'Exports');
    }
    proto.allowRoot(targetDir);
    const lib = ctx.library;
    const abs = entry && lib ? path.join(lib.root, entry.rel) : null;
    const name = entry?.name || (abs ? path.basename(abs) : 'export');
    const ext = path.extname(name);
    const ctxData = entry
      ? {
          date: parseWallDate(entry.capturedAt),
          dateFormat: normalizeDateFormat(opts.dateFormat || ctx.settings.get('dateFormat')),
          epoch: entry.capturedEpoch,
          filename: path.basename(name, ext),
          name,
          ext,
          camera: entry.camera,
          lens: entry.lens,
          iso: entry.iso,
          aperture: entry.aperture,
          focalLength: entry.focalLength,
          shutter: entry.shutter,
          folder: path.basename(path.dirname(abs)),
          original: entry.rel,
          relPath: entry.rel,
        }
      : { date: new Date(), filename: 'export', name: 'export.jpg', ext: '.jpg' };
    const result = await exportImage({
      buffer,
      format,
      quality,
      targetDir,
      filenameTemplate,
      ctx: ctxData,
      resizeLongEdge,
      overwrite,
    });
    return { ...result, sizeText: formatBytes(result.bytes) };
  });

  handle('export:defaultDir', async () => {
    const lib = ctx.library;
    if (!lib) return null;
    return path.join(lib.root, 'Exports');
  });

  /* ------------------------------- cache ------------------------------- */

  const cacheDirs = () => [ctx.thumbs.thumbDir, ctx.thumbs.previewDir];

  handle('cache:info', async () => {
    let bytes = 0;
    let files = 0;
    for (const dir of cacheDirs()) {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile()) continue;
        try {
          const st = await fsp.stat(path.join(dir, e.name));
          bytes += st.size;
          files++;
        } catch {
          /* ignore */
        }
      }
    }
    return { bytes, files, text: formatBytes(bytes), dirs: cacheDirs() };
  });

  handle('cache:clear', async () => {
    let removed = 0;
    for (const dir of cacheDirs()) {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile()) continue;
        try {
          await fsp.unlink(path.join(dir, e.name));
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
    return { removed };
  });
}

function decorateEntry(lib, entry) {
  if (!entry) return null;
  const abs = path.join(lib.root, entry.rel);
  const raw = entry.isRaw ?? isRaw(abs);
  return {
    ...entry,
    path: abs,
    thumbUrl: entry.thumbKey ? proto.thumbUrl(entry.thumbKey, 'cache') : null,
    photoUrl: raw ? null : proto.photoUrl(abs),
    editSummary: summarizeEdits(entry.edits),
  };
}

function parseWallDate(wall) {
  if (!wall) return new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(wall);
  if (!m) return new Date(wall);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function summarizeEdits(edits) {
  if (!edits) return null;
  const keys = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'vibrance', 'saturation', 'clarity', 'texture', 'denoiseAmount', 'sharpenAmount'];
  let count = 0;
  for (const k of keys) if (Math.abs(Number(edits[k]) || 0) > 0.001) count++;
  if (edits.crop) count++;
  return count;
}

module.exports = { registerIpc, summarizeEdits, decorateEntry };
