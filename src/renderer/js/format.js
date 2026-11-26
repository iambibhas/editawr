/** Formatting helpers shared by the UI. */

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function parseWall(wall) {
  if (!wall) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(wall);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(wall, { withTime = true } = {}) {
  const p = parseWall(wall);
  if (!p) return '';
  const date = `${String(p.d).padStart(2, '0')} ${MONTHS[p.mo - 1]} ${p.y}`;
  return withTime ? `${date}, ${pad2(p.h)}:${pad2(p.mi)}` : date;
}

export function formatAperture(a) {
  return a ? `f/${Number(a).toFixed(1).replace(/\.0$/, '')}` : '';
}

export function formatShutter(s) {
  if (!s || !Number.isFinite(Number(s))) return '';
  const v = Number(s);
  if (v >= 0.5) return `${Number(v.toFixed(1))}s`;
  return `1/${Math.round(1 / v)}`;
}

export function formatFocal(f) {
  return f ? `${Math.round(f)}mm` : '';
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatCount(n) {
  return Number(n || 0).toLocaleString();
}

export function basename(p, stripExt = false) {
  if (!p) return '';
  const clean = String(p).replace(/[\\/]+$/, '');
  const base = clean.split(/[\\/]/).pop();
  return stripExt ? base.replace(/\.[^.]+$/, '') : base;
}

export function extOf(p) {
  const m = /\.([^.\\/]+)$/.exec(String(p || ''));
  return m ? m[1].toUpperCase() : '';
}

export function metaLine(entry) {
  if (!entry) return '';
  const bits = [];
  if (entry.capturedAt) bits.push(formatDate(entry.capturedAt));
  if (entry.camera) bits.push(entry.camera);
  if (entry.lens) bits.push(entry.lens);
  if (entry.iso) bits.push(`ISO ${entry.iso}`);
  if (entry.aperture) bits.push(formatAperture(entry.aperture));
  if (entry.shutter) bits.push(formatShutter(entry.shutter));
  if (entry.focalLength) bits.push(formatFocal(entry.focalLength));
  return bits.filter(Boolean).join('  ·  ');
}

export function stars(n) {
  const v = Math.max(0, Math.min(5, Number(n) || 0));
  return '★'.repeat(v) + '☆'.repeat(5 - v);
}

export function debounce(fn, ms = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    return fn(...args);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function throttle(fn, ms = 100) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  const run = (args) => {
    last = Date.now();
    fn(...args);
  };
  return (...args) => {
    pendingArgs = args;
    const now = Date.now();
    if (now - last >= ms) run(args);
    else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pendingArgs) run(pendingArgs);
      }, ms - (now - last));
    }
  };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
