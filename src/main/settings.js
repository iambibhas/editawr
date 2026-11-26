'use strict';

/**
 * JSON settings store with atomic writes + debounce.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULTS = {
  libraryPath: null,
  recentLibraries: [],
  importTemplate: '<date>/<filename>',
  dateFormat: 'YYYY-MM-DD',
  duplicateMode: 'rename', // rename | skip | overwrite
  autoDetectCards: true,
  rawForceDecode: false,
  scanSubfolders: true,
  excludedFolders: [],
  lazyThumbs: true,
  fastMetadata: false,
  indexConcurrency: 2,
  generateFullPreview: false,
  editor: {
    previewMaxEdge: 0, // 0 = full embedded preview; otherwise cap long edge
  },
  thumbnailSize: 384,
  theme: 'dark',
};

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

class Settings {
  constructor(file) {
    this.file = file;
    this.data = clone(DEFAULTS);
    this._saveTimer = null;
    this._writing = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = deepMerge(clone(DEFAULTS), parsed);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[settings] load failed, using defaults:', err.message);
    }
    return this.data;
  }

  get(key) {
    return key ? this.data[key] : this.data;
  }

  set(patch) {
    this.data = deepMerge(this.data, patch);
    this.scheduleSave();
    return this.data;
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.save().catch((e) => console.error('[settings] save failed:', e.message));
    }, 250);
  }

  save() {
    clearTimeout(this._saveTimer);
    const payload = JSON.stringify(this.data, null, 2);
    this._writing = this._writing.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, payload, 'utf8');
      await fsp.rename(tmp, this.file);
    });
    return this._writing;
  }
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { Settings, DEFAULTS, deepMerge };
