'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { Importer } = require('../src/main/importer');

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editawr-import-'));
  const src = path.join(dir, 'card', 'DCIM', '100NIKON');
  const src2 = path.join(dir, 'card', 'DCIM', '101NIKON');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(src2, { recursive: true });
  const png = { create: { width: 16, height: 12, channels: 3, background: '#ff0000' } };
  await sharp(png).jpeg().toFile(path.join(src, 'DSC_0001.JPG'));
  await sharp(png).jpeg().toFile(path.join(src2, 'DSC_0001.JPG'));
  await sharp(png).png().toFile(path.join(src, 'DSC_0002.PNG'));
  const dest = path.join(dir, 'library');
  return { dir, card: path.join(dir, 'card'), dest };
}

test('importer: prepares targets with date folders, extensions and collision flags', async () => {
  const { dir, card, dest } = await fixture();
  const importer = new Importer();
  const plan = await importer.prepare({ source: card, dest, template: '<date>/<filename>' });
  assert.equal(plan.items.length, 3);
  assert.equal(plan.errors.length, 0);
  for (const item of plan.items) {
    assert.match(item.targetRel, /^\d{4}-\d{2}-\d{2}\/DSC_000\d\.(JPG|PNG|jpg|png)$/);
  }
  assert.ok(plan.items.filter((i) => i.duplicateInBatch).length >= 1, 'two DSC_0001.JPG collide');
  assert.ok(plan.stats.freeSpace > 0);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('importer: copies everything, resolves duplicates and never loses a file', async () => {
  const { dir, card, dest } = await fixture();
  const importer = new Importer();
  const plan = await importer.prepare({ source: card, dest, template: '<date>/<filename>', duplicateMode: 'rename' });
  const all = [];
  const job = await importer.run(
    { items: plan.items, dest, duplicateMode: 'rename', verify: false },
    { onProgress: (j) => all.push(j.done) },
  );
  assert.equal(job.copied.length, 3);
  assert.equal(job.failed.length, 0);
  assert.ok(all.length > 0);

  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dest);
  assert.equal(files.length, 3);
  assert.equal(new Set(files.map((f) => path.basename(f))).size, 3);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('importer: skip mode leaves existing files untouched', async () => {
  const { dir, card, dest } = await fixture();
  const importer = new Importer();
  const plan = await importer.prepare({ source: card, dest, template: 'all/<filename>', duplicateMode: 'skip' });
  await importer.run({ items: plan.items, dest, duplicateMode: 'skip' }, {});
  const plan2 = await importer.prepare({ source: card, dest, template: 'all/<filename>', duplicateMode: 'skip' });
  const job2 = await importer.run({ items: plan2.items, dest, duplicateMode: 'skip' }, {});
  assert.equal(job2.copied.length, 0);
  assert.equal(job2.skipped.length, 3);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});

test('importer: rejects templates with unknown tokens', async () => {
  const { dir, card, dest } = await fixture();
  const importer = new Importer();
  const plan = await importer.prepare({ source: card, dest, template: '<date>/<nope>' });
  assert.ok(plan.errors.length > 0);
  assert.equal(plan.items.every((i) => i.error), true);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
});
