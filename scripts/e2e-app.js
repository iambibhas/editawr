'use strict';

/**
 * End-to-end test: launches the real app (main + renderer + WebGL + LibRaw
 * worker), drives it through executeJavaScript and asserts on both UI state and
 * files written to disk.
 *
 * Fixtures (optional, skipped when absent):
 *   EDITAWR_TEST_NEF   Nikon HE/HE* NEF (exercise the preview fallback)
 *   EDITAWR_TEST_RAW   any LibRaw-decodable RAW (exercise the 16-bit pipeline)
 *
 *   npm run test:e2e
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const work = path.join(root, 'tmp', 'e2e');
const library = path.join(work, 'library');
const exportsDir = path.join(work, 'exports');
const importLib = path.join(work, 'importlib');
const cardDir = path.join(work, 'card', 'DCIM', '100NIKON');

fs.rmSync(work, { recursive: true, force: true });
for (const dir of [library, exportsDir, importLib, cardDir, path.join(library, 'sub')]) fs.mkdirSync(dir, { recursive: true });

const fixtures = [];
const heNef = process.env.EDITAWR_TEST_NEF;
const rawNef = process.env.EDITAWR_TEST_RAW;
if (heNef && fs.existsSync(heNef)) {
  fs.copyFileSync(heNef, path.join(library, 'he_star.NEF'));
  fs.copyFileSync(heNef, path.join(cardDir, 'CARD_0001.NEF'));
  fixtures.push('he');
}
if (rawNef && fs.existsSync(rawNef)) {
  fs.copyFileSync(rawNef, path.join(library, 'raw_sample.NEF'));
  fs.copyFileSync(rawNef, path.join(cardDir, 'CARD_0002.NEF'));
  fixtures.push('raw');
}

// Generate JPEG fixtures before the app starts scanning (sharp is async-only).
const { execFileSync } = require('node:child_process');
execFileSync(
  process.execPath,
  [
    '-e',
    `const sharp=require('sharp');
     Promise.all([
       sharp({create:{width:1200,height:800,channels:3,background:'#3a6ea5'}}).jpeg({quality:88}).toFile(${JSON.stringify(path.join(library, 'plain.jpg'))}),
       sharp({create:{width:1200,height:800,channels:3,background:'#a53a6e'}}).jpeg({quality:88}).toFile(${JSON.stringify(path.join(cardDir, 'CARD_0003.JPG'))}),
       sharp({create:{width:900,height:700,channels:3,background:'#2d7a4a'}}).jpeg({quality:88}).toFile(${JSON.stringify(path.join(library, 'sub', 'plain2.jpg'))}),
       sharp({create:{width:800,height:500,channels:3,background:'#c22222'}})
         .composite([
           {input:{create:{width:800,height:250,channels:3,background:'#2244cc'}}, top:250, left:0},
           {input:{create:{width:90,height:90,channels:3,background:'#ffee00'}}, top:20, left:20}
         ]).jpeg({quality:92}).toFile(${JSON.stringify(path.join(library, 'orientation.jpg'))})
     ]).catch(e=>{console.error(e);process.exit(1)});`,
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
);

const userData = path.join(work, 'userdata');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ libraryPath: library, autoDetectCards: false, importTemplate: '<date>/<filename>', lazyThumbs: false }),
);

app.setPath('userData', userData);
process.argv.push('--data-dir=' + userData);

const { ctx } = require('../src/main/main.js');

const results = { fixtures, steps: [], errors: [], ok: false };
const consoleErrors = [];

function step(name, data = {}) {
  results.steps.push({ name, ...data });
  console.log('[e2e]', name, JSON.stringify(data));
}

function fail(message) {
  results.errors.push(message);
  console.error('[e2e] FAIL:', message);
}

async function js(code) {
  return ctx.win.webContents.executeJavaScript(code, true);
}

async function waitFor(condition, timeout = 30000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    let value = false;
    try {
      value = await js(`(() => { try { return !!(${condition}); } catch (e) { return false; } })()`);
    } catch {
      value = false;
    }
    if (value) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fileDims(file) {
  const meta = await sharp(file).metadata();
  return { width: meta.width, height: meta.height, format: meta.format };
}

async function main() {
  await waitFor('window.__editawr && window.__editawrState', 20000, 'app boot');
  await waitFor('window.__editawrState.photos.length >= 1', 30000, 'library load');
  await waitFor('!window.__editawrState.scan.active', 60000, 'initial scan');

  const photos = await js('window.__editawrState.photos.map(p => ({ rel: p.rel, name: p.name, w: p.width, h: p.height, thumb: !!p.thumbUrl }))');
  step('library loaded', { count: photos.length, photos });
  assert(photos.length >= 1, 'library should contain photos');
  assert(photos.every((p) => p.thumb), 'all photos should have thumbnails');
  assert(!consoleErrors.length, `renderer console errors: ${consoleErrors.join(' | ')}`);

  // --- folder tree / scoped browsing ------------------------------------
  await js('window.__editawr.refreshFolderTree()');
  const tree = await js('window.api.library.tree()');
  const sub = tree.root.children.find((c) => c.name === 'sub');
  assert(sub && sub.total === 1, 'folder tree should contain the sub folder with 1 photo');
  await js(`window.__editawr.setFolder('sub')`);
  await new Promise((r) => setTimeout(r, 400));
  const scoped = await js(`({ visible: window.__editawr.visibleCount(), folder: window.__editawrState.folder, crumbs: document.getElementById('crumbs').textContent })`);
  step('folder scope', scoped);
  assert(scoped.folder === 'sub', 'folder scope should be "sub"');
  assert(scoped.visible === 1, 'only photos in the selected folder should be visible');
  await js('window.__editawr.setFolder(null)');
  await new Promise((r) => setTimeout(r, 200));

  // --- standard JPEG -----------------------------------------------------
  const jpg = photos.find((p) => p.name === 'plain.jpg');
  if (jpg) {
    await js(`window.__editawr.openEditor(${JSON.stringify(jpg.rel)})`);
    await waitFor('window.__editawr.editor.sourceMode === "image" && !window.__editawr.editor.loading', 20000, 'jpeg load');
    const info = await js('({ mode: window.__editawr.editor.sourceMode, w: window.__editawr.editor.srcW, h: window.__editawr.editor.srcH })');
    step('jpeg opened', info);
    assert(info.w === 1200 && info.h === 800, 'jpeg dimensions');
    const mean = await js(`(() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const x = c.getContext('2d'); x.drawImage(document.getElementById('editor-canvas'), 0, 0, 64, 64);
      const d = x.getImageData(0, 0, 64, 64).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
      return s / (64 * 64 * 3);
    })()`);
    step('jpeg canvas mean', { mean: Math.round(mean) });
    assert(mean > 20 && mean < 235, 'canvas should show the image');
  }

  // --- GPU orientation + rotation direction ------------------------------
  await js(`window.__editawr.openEditor('orientation.jpg')`);
  await waitFor('window.__editawr.editor.sourceMode === "image" && !window.__editawr.editor.loading', 20000, 'orientation image load');
  const sampleCanvas = async (positions) =>
    js(`(() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(document.getElementById('editor-canvas'), 0, 0, 64, 64);
      const d = x.getImageData(0, 0, 64, 64).data;
      const px = (cx, cy) => { const i = (cy * 64 + cx) * 4; return [d[i], d[i + 1], d[i + 2]]; };
      return ${JSON.stringify(positions)}.map(([cx, cy]) => px(cx, cy));
    })()`);
  const vert = await sampleCanvas([[32, 4], [32, 60]]);
  step('orientation upright', { top: vert[0], bottom: vert[1] });
  assert(vert[0][0] > 150 && vert[0][2] < 90, 'top of the preview should be red (upright)');
  assert(vert[1][2] > 150 && vert[1][0] < 90, 'bottom of the preview should be blue (upright)');

  await js('window.__editawr.editor.rotate(1)');
  await new Promise((r) => setTimeout(r, 500));
  const horiz = await sampleCanvas([[60, 32], [4, 32]]);
  step('rotate right', { right: horiz[0], left: horiz[1] });
  assert(horiz[0][0] > 150 && horiz[0][2] < 90, 'rotate right should move the red top to the right');
  assert(horiz[1][2] > 150 && horiz[1][0] < 90, 'rotate right should move the blue bottom to the left');
  await js('window.__editawr.editor.exportPhoto({ format: "jpeg", quality: 92, size: 0, name: "orientation_rot", dir: ' + JSON.stringify(exportsDir) + ' })');
  await waitFor('!window.__editawr.editor.exporting', 60000, 'orientation export');
  const rotatedExport = fs.readdirSync(exportsDir).find((f) => f.startsWith('orientation_rot'));
  assert(rotatedExport, 'rotated orientation export should exist');
  {
    const out = path.join(exportsDir, rotatedExport);
    const meta = await sharp(out).metadata();
    const raw = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const ch = raw.info.channels;
    const at = (x, y) => { const i = (y * raw.info.width + x) * ch; return [raw.data[i], raw.data[i + 1], raw.data[i + 2]]; };
    const right = at(raw.info.width - 20, raw.info.height >> 1);
    const left = at(20, raw.info.height >> 1);
    step('rotated export', { width: meta.width, height: meta.height, left, right });
    assert(right[0] > 150 && right[2] < 90, 'exported rotation should put red on the right');
    assert(left[2] > 150 && left[0] < 90, 'exported rotation should put blue on the left');
  }
  await js(`window.__editawr.setFolder(null)`);

  // --- Nikon HE/HE* preview fallback ------------------------------------
  if (fixtures.includes('he')) {
    const he = photos.find((p) => p.name === 'he_star.NEF');
    await js(`window.__editawr.openEditor(${JSON.stringify(he.rel)})`);
    await waitFor('window.__editawr.editor.sourceMode && !window.__editawr.editor.loading', 40000, 'he preview load');
    const info = await js('({ mode: window.__editawr.editor.sourceMode, w: window.__editawr.editor.srcW, h: window.__editawr.editor.srcH, badge: document.getElementById("mode-badge").textContent })');
    step('HE* NEF opened', info);
    assert(info.mode === 'preview', 'HE* NEF must fall back to the embedded preview');
    assert(info.w >= 5500, 'preview should be full resolution');
    assert(/HE/.test(info.badge), 'badge should explain HE compression');

    // Export the preview at full resolution.
    const outName = 'he_full';
    await js(`window.__editawr.editor.exportPhoto({ format: 'jpeg', quality: 88, size: 0, name: ${JSON.stringify(outName)}, dir: ${JSON.stringify(exportsDir)} })`);
    await waitFor('!window.__editawr.editor.exporting', 90000, 'he export');
    const exported = fs.readdirSync(exportsDir).filter((f) => f.startsWith(outName));
    assert(exported.length === 1, 'HE* export should exist');
    const dims = await fileDims(path.join(exportsDir, exported[0]));
    step('HE* export', dims);
    assert(dims.width >= 5500, 'HE* export should be full resolution');
  }

  // --- decodable RAW (16-bit linear pipeline) ---------------------------
  if (fixtures.includes('raw')) {
    const raw = photos.find((p) => p.name === 'raw_sample.NEF');
    await js(`window.__editawr.openEditor(${JSON.stringify(raw.rel)})`);
    await waitFor('window.__editawr.editor.sourceMode && !window.__editawr.editor.loading', 60000, 'raw load');
    const info = await js('({ mode: window.__editawr.editor.sourceMode, w: window.__editawr.editor.srcW, h: window.__editawr.editor.srcH, half: window.__editawr.editor.decodedHalf })');
    step('RAW opened', info);
    assert(info.mode === 'raw', 'decodable RAW should use LibRaw');
    assert(info.half === true, 'preview should be decoded at half size');

    // Push every slider hard and make sure the pipeline still renders.
    await js(`(() => {
      const e = window.__editawr.editor;
      Object.assign(e.edits, { exposure: 0.9, contrast: 22, highlights: -55, shadows: 40, whites: 12, blacks: -14, temp: 18, tint: -8, vibrance: 30, saturation: 10, clarity: 28, texture: 20, dehaze: 12, denoise: 60, denoiseDetail: 45, colorNR: 55, sharpenAmount: 80, sharpenMasking: 35, vignette: -20, grain: 15 });
      e._syncSliders(); e.requestRender(); return true;
    })()`);
    await new Promise((r) => setTimeout(r, 2500));
    const edited = await js(`(() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const x = c.getContext('2d'); x.drawImage(document.getElementById('editor-canvas'), 0, 0, 64, 64);
      const d = x.getImageData(0, 0, 64, 64).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
      return { mean: s / (64 * 64 * 3), err: null };
    })()`);
    step('RAW edited canvas', { mean: Math.round(edited.mean) });
    assert(edited.mean > 5 && edited.mean < 250, 'edited render should not be black/white');

    // Export at full resolution with a crop + rotation.
    await js(`(() => {
      const e = window.__editawr.editor;
      e.edits.crop = { x: 0.1, y: 0.15, w: 0.6, h: 0.5 };
      e.edits.rotation = 90;
      e._applyCanvasSize(); e.requestRender(); return true;
    })()`);
    await new Promise((r) => setTimeout(r, 800));
    await js(`window.__editawr.editor.exportPhoto({ format: 'jpeg', quality: 90, size: 1600, name: 'raw_crop', dir: ${JSON.stringify(exportsDir)} })`);
    await waitFor('!window.__editawr.editor.exporting', 120000, 'raw export');
    const rawOut = fs.readdirSync(exportsDir).filter((f) => f.startsWith('raw_crop'));
    assert(rawOut.length === 1, 'RAW export should exist');
    const dims = await fileDims(path.join(exportsDir, rawOut[0]));
    step('RAW export', dims);
    assert(Math.max(dims.width, dims.height) === 1600, 'export should honour resize');
  }

  // --- rating persistence ------------------------------------------------
  const anyPhoto = photos[0];
  await js(`window.api.library.update(${JSON.stringify(anyPhoto.rel)}, { rating: 5, flag: 'picked' })`);
  const after = await js(`(() => { const p = window.__editawrState.byRel.get(${JSON.stringify(anyPhoto.rel)}); return { rating: p.rating, flag: p.flag }; })()`);
  step('rating/flag', after);
  assert(after.rating === 5 && after.flag === 'picked', 'rating and flag should persist');

  // --- import from a "card" ---------------------------------------------
  await js(`window.__editawr.importer.close()`);
  const plan = await js(`window.api.importer.prepare({ source: ${JSON.stringify(path.join(work, 'card'))}, dest: ${JSON.stringify(importLib)}, template: '<date>/<camera>/<filename>', duplicateMode: 'rename' })`);
  assert(plan.items.length >= 1, 'import should find files');
  step('import plan', { items: plan.items.length, samples: plan.samples, errors: plan.errors.length });
  assert(plan.errors.length === 0, 'import plan should not have errors');
  assert(plan.items.every((i) => /\.[A-Za-z0-9]+$/.test(i.targetRel)), 'targets must keep file extensions');

  const job = await js(`(async () => {
    const plan = await window.api.importer.prepare({ source: ${JSON.stringify(path.join(work, 'card'))}, dest: ${JSON.stringify(importLib)}, template: '<date>/<camera>/<filename>', duplicateMode: 'rename' });
    const done = new Promise((resolve) => {
      const off = window.api.importer.onDone((d) => { off(); resolve(d); });
      setTimeout(() => resolve({ timeout: true }), 60000);
    });
    await window.api.importer.run(plan);
    return done;
  })()`);
  step('import done', { copied: job.copied, skipped: job.skipped, failed: job.failed });
  assert(!job.timeout, 'import should finish');
  assert(job.copied === plan.items.length, 'all files should be copied');
  const imported = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else imported.push(p);
    }
  };
  walk(importLib);
  step('imported files', { count: imported.length, files: imported.map((f) => path.relative(importLib, f)) });
  assert(imported.length === plan.items.length, 'file count should match the plan');

  // --- final checks ------------------------------------------------------
  const state = await js('({ photos: window.__editawrState.photos.length, root: window.__editawrState.libraryRoot, mode: window.__editawrState.mode })');
  step('final state', state);
  assert(consoleErrors.length === 0, `renderer console errors: ${consoleErrors.join(' | ')}`);
  results.ok = true;
}

app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 200 && !ctx.win; i++) await new Promise((r) => setTimeout(r, 100));
    if (!ctx.win) throw new Error('main window was not created');
    ctx.win.webContents.on('console-message', (event) => {
      if (event.level === 'error') consoleErrors.push(event.message);
    });

    await main();
  } catch (err) {
    fail(err.message);
    results.stack = err.stack;
  } finally {
    try {
      if (ctx.library) await ctx.library.catalog.flush();
    } catch {
      /* ignore */
    }
    fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify(results, null, 2));
    console.log('[e2e] RESULT', JSON.stringify({ ok: results.ok, errors: results.errors, steps: results.steps.length }));
    app.exit(results.ok ? 0 : 1);
  }
});
