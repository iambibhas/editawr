'use strict';

/**
 * Copies third-party browser assets from node_modules into src/renderer/vendor
 * so they can be served by the app:// protocol (and shipped in a packaged app).
 * Run automatically on npm install and before `npm start`.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const copies = [
  ['node_modules/libraw-wasm/dist', 'src/renderer/vendor/libraw'],
];

let changed = 0;
for (const [from, to] of copies) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  if (!fs.existsSync(src)) {
    console.warn(`[vendor] missing ${from} — run npm install`);
    continue;
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (!fs.statSync(s).isFile()) continue;
    const a = fs.statSync(s);
    const b = fs.existsSync(d) ? fs.statSync(d) : null;
    if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue;
    fs.copyFileSync(s, d);
    changed++;
  }
}
console.log(`[vendor] synced ${copies.length} package(s), ${changed} file(s) updated`);
