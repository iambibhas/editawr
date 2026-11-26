'use strict';

/**
 * Custom protocols:
 *   app://renderer/<path>  -> static renderer assets (ES modules, workers, wasm)
 *   photo://local/<b64>    -> user photos, restricted to allowed roots
 *   thumb://<key>.jpg      -> generated thumbnails from the cache dir
 *
 * Using a real scheme (instead of file://) is what makes ES modules, module
 * workers and fetch() of the LibRaw .wasm work in the renderer.
 */
const { protocol, net } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.nef': 'image/x-nikon-nef',
  '.dng': 'image/x-adobe-dng',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

const state = {
  rendererRoot: null,
  thumbDir: null,
  previewDir: null,
  allowedRoots: new Set(),
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function normalizeForCompare(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function allowRoot(dir) {
  if (!dir) return;
  try {
    state.allowedRoots.add(normalizeForCompare(dir));
  } catch {
    /* ignore malformed paths */
  }
}

function isAllowed(file) {
  const target = normalizeForCompare(file);
  for (const root of state.allowedRoots) {
    if (target === root) return true;
    if (target.startsWith(root + path.sep)) return true;
  }
  return false;
}

function notFound(msg = 'Not found') {
  return new Response(msg, { status: 404, headers: { 'content-type': 'text/plain' } });
}

function forbidden() {
  return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain' } });
}

async function serveFile(file, { cache = false, download = false } = {}) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) return notFound();
  const body = await fsp.readFile(file);
  const headers = {
    'content-type': mimeFor(file),
    'content-length': String(stat.size),
    'cache-control': cache ? 'public, max-age=31536000, immutable' : 'no-store',
  };
  if (download) headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
  return new Response(body, { status: 200, headers });
}

function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
    {
      scheme: 'photo',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
    {
      scheme: 'thumb',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

function install({ rendererRoot, thumbDir, previewDir }) {
  state.rendererRoot = path.resolve(rendererRoot);
  state.thumbDir = thumbDir;
  state.previewDir = previewDir || null;

  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'renderer') return notFound();
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(state.rendererRoot, rel);
      const rootRel = path.relative(state.rendererRoot, file);
      if (rootRel.startsWith('..') || path.isAbsolute(rootRel)) return forbidden();
      return await serveFile(file, { cache: !rel.endsWith('.html') });
    } catch (err) {
      console.error('[protocol app]', err);
      return notFound();
    }
  });

  protocol.handle('photo', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'local') return notFound();
      const encoded = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = Buffer.from(encoded, 'base64url').toString('utf8');
      if (!isAllowed(file)) return forbidden();
      return await serveFile(file, { cache: true });
    } catch (err) {
      console.error('[protocol photo]', err);
      return notFound();
    }
  });

  protocol.handle('thumb', async (request) => {
    try {
      const url = new URL(request.url);
      const key = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!/^[a-f0-9]{20,64}(@2x)?\.(jpg|webp|png)$/i.test(key)) return notFound();
      const dir = url.hostname === 'preview' ? state.previewDir : state.thumbDir;
      if (!dir) return notFound();
      return await serveFile(path.join(dir, key), { cache: true });
    } catch (err) {
      console.error('[protocol thumb]', err);
      return notFound();
    }
  });
}

function photoUrl(file) {
  const b64 = Buffer.from(path.resolve(file), 'utf8').toString('base64url');
  return `photo://local/${b64}`;
}

function thumbUrl(key, kind = 'cache') {
  return `thumb://${kind}/${encodeURIComponent(key)}`;
}

module.exports = { registerSchemes, install, allowRoot, isAllowed, photoUrl, thumbUrl, state };
