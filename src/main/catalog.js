'use strict';

/**
 * Catalog: the library database (one JSON file per library root, stored in
 * userData so the photo folders are never polluted).
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite, sha1 } = require('./util');

const VERSION = 1;

class Catalog {
  constructor({ userDataDir, root }) {
    this.root = path.resolve(root);
    this.dir = path.join(userDataDir, 'catalogs');
    this.file = path.join(this.dir, `${sha1(this.root.toLowerCase(), 16)}.json`);
    this.data = { version: VERSION, root: this.root, createdAt: Date.now(), updatedAt: Date.now(), entries: {} };
    this.dirty = false;
    this.saveTimer = null;
    this.saving = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entries) {
        this.data = {
          version: parsed.version || VERSION,
          root: this.root,
          createdAt: parsed.createdAt || Date.now(),
          updatedAt: parsed.updatedAt || Date.now(),
          entries: parsed.entries || {},
        };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[catalog] load failed:', err.message);
    }
    return this.data;
  }

  get(rel) {
    return this.data.entries[rel] || null;
  }

  set(rel, entry) {
    this.data.entries[rel] = entry;
    this.markDirty();
  }

  patch(rel, patch) {
    const cur = this.data.entries[rel];
    if (!cur) return null;
    this.data.entries[rel] = { ...cur, ...patch, rel };
    this.markDirty();
    return this.data.entries[rel];
  }

  delete(rel) {
    if (this.data.entries[rel]) {
      delete this.data.entries[rel];
      this.markDirty();
    }
  }

  list() {
    return Object.values(this.data.entries);
  }

  markDirty() {
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.save().catch((e) => console.error('[catalog] save failed:', e.message));
    }, 400);
  }

  async save() {
    clearTimeout(this.saveTimer);
    if (!this.dirty) return;
    this.dirty = false;
    this.data.updatedAt = Date.now();
    const payload = JSON.stringify(this.data);
    const file = this.file;
    this.saving = this.saving.then(() => atomicWrite(file, payload)).catch((err) => {
      this.dirty = true;
      throw err;
    });
    return this.saving;
  }

  async flush() {
    if (this.dirty) await this.save();
    else await this.saving;
  }
}

module.exports = { Catalog, VERSION };
