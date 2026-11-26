/** Tiny observable app state store. */

export const state = {
  revision: 0,
  settings: {},
  libraryRoot: null,
  libraryStats: {},
  photos: [],
  byRel: new Map(),
  selected: new Set(),
  activeRel: null,
  mode: 'library',
  drives: [],
  scan: { active: false, phase: '', done: 0, total: 0 },
  filter: { search: '', rating: 0, flag: 'all', raw: 'all' },
  folder: '', // '' = library root, null = all photos, 'a/b' = folder path
  folderRecursive: false,
  folderTree: null,
  folderInitialized: false,
  sort: 'date-desc',
  thumbSize: 190,
  appInfo: null,
};

const subs = new Set();

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function notify(reason, detail) {
  state.revision++;
  for (const fn of subs) {
    try {
      fn({ reason, detail, revision: state.revision });
    } catch (err) {
      console.error('[state] subscriber failed', err);
    }
  }
}

export function getPhoto(rel) {
  return state.byRel.get(rel) || null;
}

export function setLibrary({ root, photos, stats }) {
  state.libraryRoot = root || null;
  state.libraryStats = stats || {};
  state.selected.clear();
  state.activeRel = null;
  setPhotos(photos || [], 'library');
}

export function setPhotos(list, reason = 'snapshot') {
  const byRel = new Map();
  for (const p of list) byRel.set(p.rel, p);
  state.photos = list;
  state.byRel = byRel;
  for (const rel of [...state.selected]) if (!byRel.has(rel)) state.selected.delete(rel);
  if (state.activeRel && !byRel.has(state.activeRel)) state.activeRel = null;
  notify('photos', { reason });
}

export function upsertPhoto(photo) {
  if (!photo || !photo.rel) return;
  state.byRel.set(photo.rel, photo);
  const idx = state.photos.findIndex((p) => p.rel === photo.rel);
  if (idx >= 0) state.photos[idx] = photo;
  else state.photos.push(photo);
  notify('photo', { rel: photo.rel });
}

export function patchPhotoLocal(rel, patch) {
  const cur = state.byRel.get(rel);
  if (!cur) return;
  const next = { ...cur, ...patch };
  state.byRel.set(rel, next);
  const idx = state.photos.findIndex((p) => p.rel === rel);
  if (idx >= 0) state.photos[idx] = next;
  notify('photo', { rel });
}

export function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  notify('mode', { mode });
}

export function setActive(rel, { select = true } = {}) {
  state.activeRel = rel;
  if (select) {
    state.selected.clear();
    if (rel) state.selected.add(rel);
  }
  notify('selection');
}

export function toggleSelect(rel) {
  if (state.selected.has(rel)) state.selected.delete(rel);
  else state.selected.add(rel);
  state.activeRel = rel;
  notify('selection');
}

export function selectRange(rel) {
  const list = visiblePhotos();
  const anchor = state.activeRel || rel;
  const a = list.findIndex((p) => p.rel === anchor);
  const b = list.findIndex((p) => p.rel === rel);
  if (a < 0 || b < 0) {
    setActive(rel);
    return;
  }
  const [from, to] = a <= b ? [a, b] : [b, a];
  state.selected.clear();
  for (let i = from; i <= to; i++) state.selected.add(list[i].rel);
  state.activeRel = rel;
  notify('selection');
}

export function selectAll() {
  for (const p of visiblePhotos()) state.selected.add(p.rel);
  notify('selection');
}

export function clearSelection() {
  state.selected.clear();
  notify('selection');
}

export function setFilter(patch) {
  Object.assign(state.filter, patch);
  notify('filter');
}

export function setSort(sort) {
  state.sort = sort;
  notify('sort');
}

export function setScan(patch) {
  Object.assign(state.scan, patch);
  notify('scan');
}

/** Is a photo inside the currently selected folder scope? */
export function inFolderScope(rel) {
  const folder = state.folder;
  if (folder === null) return true;
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  if (folder === '') return state.folderRecursive ? true : dir === '';
  if (state.folderRecursive) return rel.startsWith(folder + '/');
  return dir === folder;
}

function matches(p) {
  const f = state.filter;
  if (f.rating && (Number(p.rating) || 0) < f.rating) return false;
  if (f.flag === 'picked' && p.flag !== 'picked') return false;
  if (f.flag === 'rejected' && p.flag !== 'rejected') return false;
  if (f.raw === 'raw' && !p.isRaw) return false;
  if (f.raw === 'edited' && !(p.editSummary > 0)) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = `${p.name} ${p.camera || ''} ${p.lens || ''} ${p.capturedAt || ''} ${p.rel}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function visiblePhotos() {
  const list = state.photos.filter((p) => inFolderScope(p.rel) && matches(p));
  const s = state.sort;
  if (s === 'name-asc') list.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  else if (s === 'date-asc') list.sort((a, b) => (a.capturedEpoch || 0) - (b.capturedEpoch || 0));
  else if (s === 'rating-desc') list.sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.capturedEpoch || 0) - (a.capturedEpoch || 0));
  else list.sort((a, b) => (b.capturedEpoch || 0) - (a.capturedEpoch || 0) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  return list;
}

export function setFolder(folder) {
  const next = folder === undefined ? null : folder;
  if (state.folder === next) return;
  state.folder = next;
  notify('folder');
}

export function setFolderRecursive(value) {
  const next = !!value;
  if (state.folderRecursive === next) return;
  state.folderRecursive = next;
  notify('folder');
}

export function neighbor(rel, dir) {
  const list = visiblePhotos();
  const idx = list.findIndex((p) => p.rel === rel);
  if (idx < 0) return null;
  const next = list[idx + dir];
  return next || null;
}
