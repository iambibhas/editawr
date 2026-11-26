/** App shell: library, sidebar, shortcuts, settings, menu wiring. */
import {
  state, subscribe, setPhotos, upsertPhoto, setMode, setActive, toggleSelect, selectRange,
  visiblePhotos, notify, patchPhotoLocal, getPhoto, setFilter, setSort, setScan,
  setFolderRecursive,
} from './state.js';
import { PhotoGrid } from './grid.js';
import { Editor } from './editor.js';
import { ImportView } from './import.js';
import { toast, openModal, confirmDialog, showContextMenu } from './ui.js';
import {
  formatCount, formatBytes, basename, debounce, throttle, escapeHtml, formatDate, metaLine,
} from './format.js';
import { PRESETS } from './edits.js';
import { DATE_FORMATS, DEFAULT_DATE_FORMAT, formatDatePattern, normalizeDateFormat, isKnownDateFormat } from './dateformats.js';

const $ = (id) => document.getElementById(id);
let settingsClipboard = null;

class App {
  constructor() {
    this.grid = new PhotoGrid({
      container: $('grid'),
      scrollEl: $('grid-scroll'),
      onOpen: (rel) => this.openEditor(rel),
      onSelection: (rel, modifiers) => this.selectPhoto(rel, modifiers),
      onContext: (rel, x, y) => this.showPhotoMenu(rel, x, y),
      onThumbProgress: (stats) => this.onThumbProgress(stats),
    });
    this.editor = new Editor();
    this.importer = new ImportView();
    this.editor.onEditCommitted = () => {};
    this.pendingGridRefresh = null;
    this.expandedFolders = new Set(['']);
    this._folderTreeTimer = null;
    this._folderTreePromise = null;
    this._folderTreeAgain = false;
    this._folderViewRoot = null;
  }

  async boot() {
    this.bindUI();
    this.bindApiEvents();
    this.bindKeys();

    const info = await window.api.app.info();
    state.appInfo = info;
    state.settings = info.settings || {};
    state.drives = info.drives || [];
    if (info.library) {
      state.libraryRoot = info.library.root;
      state.libraryStats = info.library.stats || {};
      setPhotos(info.library.photos || [], 'boot');
    }

    this.applySettingsToUI();
    this.renderDevices();
    this.renderLibraryInfo();
    this.renderChips();
    this.refreshGrid();
    this.updateTopbar();
    this.updateScanStrip();
    this.refreshFolderTree();

    if (info.library) this.grid.scrollToRel(state.photos[0]?.rel);
    else {
      this.refreshGrid();
      this.renderFolderBar();
    }
  }

  /* ------------------------------- UI bind ------------------------------ */

  bindUI() {
    $('btn-import').addEventListener('click', () => this.importer.open());
    $('btn-rescan').addEventListener('click', () => this.rescan());
    $('btn-settings').addEventListener('click', () => this.openSettings());
    $('btn-drives-refresh').addEventListener('click', async () => {
      await window.api.drives.refresh().catch(() => {});
      toast('Devices refreshed');
    });
    $('scan-stop')?.addEventListener('click', async () => {
      const btn = $('scan-stop');
      btn.disabled = true;
      btn.textContent = 'Stopping…';
      try {
        await window.api.library.cancelScan();
      } catch (err) {
        toast('Could not stop the scan', err.message, 'error');
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = 'Stop';
      }, 4000);
    });
    $('scan-fast')?.addEventListener('click', () => this.speedUpScan());
    $('folder-up')?.addEventListener('click', () => this.goUpFolder());
    $('folder-recursive')?.addEventListener('change', (e) => this.setFolderRecursive(e.target.checked));
    $('btn-folders-refresh')?.addEventListener('click', () => this.refreshFolderTree(true));
    $('folder-tree')?.addEventListener('click', (e) => this.onFolderTreeClick(e));
    $('crumbs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-folder]');
      if (!btn) return;
      this.setFolder(btn.dataset.folder === '__all__' ? null : btn.dataset.folder);
    });

    $('search').addEventListener(
      'input',
      debounce((e) => setFilter({ search: e.target.value }), 140),
    );
    $('sort').addEventListener('change', (e) => setSort(e.target.value));
    const thumb = $('thumb-size');
    thumb.addEventListener('input', () => {
      state.thumbSize = Number(thumb.value);
      this.grid.setThumbSize(state.thumbSize);
    });

    for (const chip of document.querySelectorAll('#flag-filters .chip')) {
      chip.addEventListener('click', () => {
        setFilter({ flag: chip.dataset.flag });
        this.renderChips();
      });
    }
    for (const chip of document.querySelectorAll('#rating-filters .chip')) {
      chip.addEventListener('click', () => {
        setFilter({ rating: Number(chip.dataset.rating) });
        this.renderChips();
      });
    }
    for (const chip of document.querySelectorAll('#raw-filters .chip')) {
      chip.addEventListener('click', () => {
        setFilter({ raw: chip.dataset.raw });
        this.renderChips();
      });
    }

    $('library-info').addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'change') this.openLibraryChooser();
      if (action === 'scan-settings') this.openSettings();
      if (action === 'reveal' && state.libraryRoot) window.api.app.showItem(state.libraryRoot);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.importer.isOpen) {
          this.importer.close();
          e.preventDefault();
        } else if (this.editor.isOpen) {
          this.editor.close();
          setMode('library');
          e.preventDefault();
        } else if (document.activeElement?.closest('#editor-view, #import-view')) {
          document.activeElement.blur();
        }
      }
    });
  }

  bindApiEvents() {
    window.api.settings.onChanged((settings) => {
      state.settings = settings;
      this.applySettingsToUI();
    });

    window.api.library.onSnapshot((photos) => {
      setPhotos(photos, 'snapshot');
      if (state.libraryStats) state.libraryStats = { ...state.libraryStats, total: photos.length };
      this.renderLibraryInfo();
    });

    window.api.library.onPhoto((photo) => {
      upsertPhoto(photo);
      if (this.editor.isOpen && this.editor.rel === photo.rel) {
        this.editor.entry = photo;
        this.editor.renderFilmstrip();
      }
    });

    window.api.library.onProgress((p) => {
      setScan({ active: true, phase: p.phase, done: p.done, total: p.total });
    });

    window.api.library.onScanDone((s) => {
      setScan({ active: false, phase: 'done', done: 1, total: 1 });
      state.libraryStats = { ...(state.libraryStats || {}), ...s, root: state.libraryRoot };
      this.renderLibraryInfo();
      if (s.indexed) toast('Library updated', `${formatCount(s.indexed)} new or changed photo(s) indexed in ${(s.ms / 1000).toFixed(1)}s.`, 'success');
      this.scheduleFolderTreeRefresh();
      this.updateScanStrip(true);
    });

    window.api.library.onScanError((e) => {
      setScan({ active: false });
      toast('Scan failed', e.error, 'error', 8000);
    });

    window.api.library.onScanCancelled((s) => {
      setScan({ active: false });
      if (s) state.libraryStats = { ...(state.libraryStats || {}), ...s };
      this.renderLibraryInfo();
      this.updateTopbar();
      this.updateScanStrip(true, 'Scan stopped');
      this.scheduleFolderTreeRefresh();
      toast('Scan stopped', `${formatCount(s?.indexed || 0)} photos indexed before stopping. The rest stay unindexed until the next scan.`, 'info', 7000);
    });

    window.api.library.onStats((s) => {
      state.libraryStats = { ...(state.libraryStats || {}), ...s };
      this.renderLibraryInfo();
      this.updateTopbar();
      this.scheduleFolderTreeRefresh();
    });

    window.api.library.onScanTip(({ count }) => {
      toast(
        'Large scan',
        `${formatCount(count)} photos to index. On a slow disk, stop the scan and enable “Skip EXIF during scan” in Scan settings — metadata then loads as you browse.`,
        'info',
        14000,
      );
    });

    window.api.drives.onDevices((devices) => {
      const before = new Set((state.drives || []).map((d) => d.mount));
      state.drives = devices || [];
      this.renderDevices();
      this.importer.renderSources();
      const cards = state.drives.filter((d) => d.hasDcim && !before.has(d.mount));
      if (cards.length && this._booted) {
        toast('Memory card detected', `${cards[0].label} — click Import to copy photos.`, 'success', 6000);
      }
      this._booted = true;
    });

    window.api.app.onMenu(({ action }) => this.handleMenu(action));

    subscribe(({ reason }) => this.onState(reason));
  }

  /* ------------------------------- state -------------------------------- */

  onState(reason) {
    if (reason === 'photos' || reason === 'photo') this.scheduleFolderTreeRefresh();
    if (reason === 'folder') {
      this.hideThumbStatus();
      this.renderFolderTree();
      this.renderFolderBar();
      this.refreshGrid();
      this.updateTopbar();
      if (this.editor.isOpen) this.editor.renderFilmstrip();
    }
    if (reason === 'photos' || reason === 'photo' || reason === 'filter' || reason === 'sort') {
      this.scheduleGridRefresh();
      this.updateTopbar();
      if (this.editor.isOpen) this.editor.renderFilmstrip();
    }
    if (reason === 'selection') {
      this.grid.updateSelection();
    }
    if (reason === 'scan') this.updateScanStrip();
    if (reason === 'library') {
      this.renderLibraryInfo();
      this.updateTopbar();
      this.refreshGrid();
    }
  }

  scheduleGridRefresh() {
    if (this.pendingGridRefresh) return;
    this.pendingGridRefresh = requestAnimationFrame(() => {
      this.pendingGridRefresh = null;
      this.refreshGrid();
    });
  }

  refreshGrid() {
    const list = visiblePhotos();
    this.grid.setPhotos(list);
    $('photo-count').textContent = `${formatCount(list.length)} ${list.length === 1 ? 'photo' : 'photos'}`;
    this.grid.updateSelection();
    const es = $('empty-state');
    if (!state.libraryRoot) {
      es.hidden = false;
      const recents = (state.settings?.recentLibraries || []).filter(Boolean).slice(0, 4);
      es.innerHTML = '<div class="card"><h2>Welcome to EditAWr</h2>' +
        '<p>Choose a folder to use as your photo library. Photos already in it are catalogued in place — nothing is moved or modified. Then import from an SD card or another folder using a path template.</p>' +
        '<div class="actions"><button class="btn primary" id="es-choose">Choose library folder</button>' +
        '<button class="btn ghost" id="es-import">Import from card…</button></div>' +
        (recents.length
          ? '<div style="margin-top:16px;font-size:11px;color:var(--text-3)">Recent</div>' +
            recents.map((r, i) => '<button class="side-link" data-recent="' + i + '" style="display:block;margin-top:4px">' + escapeHtml(r) + '</button>').join('')
          : '') +
        '</div>';
      $('es-choose')?.addEventListener('click', () => this.openLibraryChooser({ empty: true }));
      $('es-import')?.addEventListener('click', () => this.importer.open());
      for (const btn of es.querySelectorAll('[data-recent]')) {
        btn.addEventListener('click', async () => {
          try {
            const res = await window.api.library.open(recents[Number(btn.dataset.recent)]);
            if (res) this.applyLibrary(res);
          } catch (err) {
            toast('Could not open recent library', err.message, 'error');
          }
        });
      }
      return;
    }

    if (!list.length) {
      es.hidden = false;
      es.innerHTML = this._emptyStateHtml();
      this._bindEmptyStateActions();
    } else {
      es.hidden = true;
    }
  }

  _emptyStateHtml() {
    const scoped = state.folder !== null;
    const node = this.findFolderNode(state.folder);
    const hasSubPhotos = !!(node && node.total > node.direct);
    const f = state.filter;
    const filtering = !!(f.search.trim() || f.rating || f.flag !== 'all' || f.raw !== 'all');
    const scopeName = this.folderLabel(state.folder);
    const buttons = [];
    let title = 'No photos match';
    let body = 'Adjust the filters or search above.';

    if (!state.photos.length) {
      title = 'This library is empty';
      body = 'Import photos from a card or folder to get started.';
      return `<div class="card">
        <h2>${title}</h2><p>${body}</p>
        <div class="actions"><button class="btn primary" id="es-import">Import photos</button>
        <button class="btn ghost" id="es-rescan">Rescan folder</button></div>
      </div>`;
    }

    if (filtering) {
      title = 'No photos match';
      body = `No photos match the current search/filters in ${escapeHtml(scopeName)}.`;
      buttons.push({ id: 'es-clear', label: 'Clear search & filters', kind: 'primary' });
      if (scoped) buttons.push({ id: 'es-all', label: 'Search all photos' });
    } else if (scoped && !state.folderRecursive && hasSubPhotos) {
      title = 'No photos directly in this folder';
      body = `${formatCount(node.total)} photo${node.total === 1 ? '' : 's'} live in its subfolders.`;
      buttons.push({ id: 'es-sub', label: 'Include subfolders', kind: 'primary' });
      buttons.push({ id: 'es-all', label: 'Show all photos' });
    } else if (scoped) {
      title = 'This folder is empty';
      body = state.libraryStats?.hidden
        ? `No visible photos here. ${formatCount(state.libraryStats.hidden)} photos are hidden by the current scan rules.`
        : 'There are no photos in this folder for the current rules.';
      buttons.push({ id: 'es-all', label: 'Show all photos', kind: 'primary' });
    } else {
      buttons.push({ id: 'es-clear', label: 'Clear search & filters', kind: 'primary' });
    }

    return `<div class="card">
      <h2>${title}</h2>
      <p>${body}</p>
      <div class="actions">${buttons
        .map((b) => `<button class="btn ${b.kind || 'ghost'}" id="${b.id}">${b.label}</button>`)
        .join('')}</div>
    </div>`;
  }

  _bindEmptyStateActions() {
    $('es-import')?.addEventListener('click', () => this.importer.open());
    $('es-rescan')?.addEventListener('click', () => this.rescan());
    $('es-sub')?.addEventListener('click', () => this.setFolderRecursive(true));
    $('es-all')?.addEventListener('click', () => this.setFolder(null));
    $('es-clear')?.addEventListener('click', () => this.resetFilters());
  }

  resetFilters() {
    setFilter({ search: '', rating: 0, flag: 'all', raw: 'all' });
    $('search').value = '';
    this.renderChips();
  }

  folderLabel(folder) {
    if (folder === null) return 'All photos';
    if (folder === '') return basename(state.libraryRoot) || 'the library root';
    const parts = folder.split('/');
    return parts[parts.length - 1] || folder;
  }

  findFolderNode(folder) {
    const tree = state.folderTree;
    if (!tree || folder === null) return null;
    if (folder === '') return tree.root;
    let node = tree.root;
    for (const seg of folder.split('/')) {
      node = (node.children || []).find((c) => c.name === seg);
      if (!node) return null;
    }
    return node;
  }

  /* ------------------------------ folder tree --------------------------- */

  folderStorageKey() {
    return `editawr.folderView.${encodeURIComponent(state.libraryRoot || '')}`;
  }

  loadFolderView() {
    try {
      const raw = localStorage.getItem(this.folderStorageKey());
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  saveFolderView() {
    try {
      localStorage.setItem(this.folderStorageKey(), JSON.stringify({ folder: state.folder, recursive: state.folderRecursive }));
    } catch {
      /* ignore quota/privacy errors */
    }
  }

  initFolderView() {
    if (state.libraryRoot !== this._folderViewRoot) {
      this._folderViewRoot = state.libraryRoot;
      state.folderInitialized = false;
    }
    if (state.folderInitialized) {
      this.validateFolder();
      return;
    }
    state.folderInitialized = true;
    const saved = this.loadFolderView();
    if (saved && (typeof saved.folder === 'string' || saved.folder === null)) {
      state.folder = saved.folder;
      state.folderRecursive = !!saved.recursive;
    } else {
      const root = state.folderTree?.root;
      // Smart default: if the root has no photos but subfolders do, show everything.
      state.folder = root && root.total > 0 && root.direct === 0 ? null : '';
      state.folderRecursive = false;
    }
    this.validateFolder();
    this.expandToFolder(state.folder);
  }

  validateFolder() {
    const tree = state.folderTree;
    if (!tree || state.folder === null) return;
    const paths = new Set();
    const walk = (node) => {
      paths.add(node.path);
      (node.children || []).forEach(walk);
    };
    walk(tree.root);
    if (!paths.has(state.folder)) state.folder = '';
  }

  expandToFolder(folder) {
    this.expandedFolders.add('');
    if (!folder) return;
    let acc = '';
    for (const seg of folder.split('/')) {
      acc = acc ? `${acc}/${seg}` : seg;
      this.expandedFolders.add(acc);
    }
  }

  setFolder(folder) {
    if (state.folder === folder) return;
    state.folder = folder;
    state.selected.clear();
    state.activeRel = null;
    this.expandToFolder(folder);
    this.saveFolderView();
    if (state.folderTree) this.renderFolderTree();
    notify('folder');
    $('grid-scroll').scrollTop = 0;
  }

  setFolderRecursive(value) {
    const changed = state.folderRecursive !== !!value;
    setFolderRecursive(value);
    if (changed) {
      state.selected.clear();
      state.activeRel = null;
      this.saveFolderView();
    }
  }

  goUpFolder() {
    if (state.folder === null) return;
    if (state.folder === '') {
      this.setFolder(null);
      return;
    }
    const cut = state.folder.lastIndexOf('/');
    this.setFolder(cut >= 0 ? state.folder.slice(0, cut) : '');
  }

  async refreshFolderTree() {
    if (!state.libraryRoot) {
      state.folderTree = null;
      state.folderInitialized = false;
      this.renderFolderTree();
      this.renderFolderBar();
      return;
    }
    if (this._folderTreePromise) {
      this._folderTreeAgain = true;
      return this._folderTreePromise;
    }
    this._folderTreePromise = window.api.library
      .tree()
      .then((tree) => {
        state.folderTree = tree;
        this.initFolderView();
        this.renderFolderTree();
        this.renderFolderBar();
        this.refreshGrid();
      })
      .catch((err) => {
        console.warn('[app] folder tree failed', err.message);
      })
      .finally(() => {
        this._folderTreePromise = null;
        if (this._folderTreeAgain) {
          this._folderTreeAgain = false;
          this.refreshFolderTree();
        }
      });
    return this._folderTreePromise;
  }

  scheduleFolderTreeRefresh() {
    clearTimeout(this._folderTreeTimer);
    this._folderTreeTimer = setTimeout(() => this.refreshFolderTree(), 1200);
  }

  onFolderTreeClick(e) {
    const scanSettings = e.target.closest('[data-action="scan-settings"]');
    if (scanSettings) {
      this.openSettings();
      return;
    }
    const twisty = e.target.closest('[data-twisty]');
    if (twisty) {
      const id = twisty.dataset.twisty;
      if (id && id !== '__all__') {
        if (this.expandedFolders.has(id)) this.expandedFolders.delete(id);
        else this.expandedFolders.add(id);
        this.renderFolderTree();
      }
      e.stopPropagation();
      return;
    }
    const row = e.target.closest('.folder-row');
    if (!row) return;
    const path = row.dataset.path;
    this.setFolder(path === '__all__' ? null : path);
    if (state.folder && this.findFolderNode(state.folder)?.children.length) {
      this.expandedFolders.add(state.folder);
      this.renderFolderTree();
    }
  }

  _folderRow({ label, path, depth, count, direct, total, hasChildren, all = false }) {
    const active = all ? state.folder === null : state.folder === path;
    const row = document.createElement('div');
    row.className = `folder-row${all ? ' all' : ''}${active ? ' active' : ''}`;
    row.dataset.path = all ? '__all__' : path;
    row.style.paddingLeft = `${4 + depth * 12}px`;
    row.title = all ? `${count} photos in the library` : `${direct ?? count} directly in this folder · ${total ?? count} including subfolders`;
    const twisty = document.createElement('button');
    twisty.className = `twisty${hasChildren ? '' : ' leaf'}`;
    twisty.dataset.twisty = all ? '__all__' : path;
    twisty.textContent = hasChildren ? (this.expandedFolders.has(path) ? '▾' : '▸') : '▸';
    const ico = document.createElement('span');
    ico.className = 'folder-ico';
    ico.textContent = all ? '◎' : '▤';
    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = label;
    const c = document.createElement('span');
    const subOnly = !all && !state.folderRecursive && direct === 0 && total > 0;
    c.className = `folder-count${subOnly ? ' sub-count' : ''}`;
    c.textContent = subOnly ? `(${formatCount(total)})` : formatCount(count);
    row.append(twisty, ico, name, c);
    return row;
  }

  renderFolderTree() {
    const holder = $('folder-tree');
    if (!holder) return;
    holder.replaceChildren();
    if (!state.libraryRoot) {
      holder.innerHTML = '<div class="side-empty">No library open.</div>';
      return;
    }
    const tree = state.folderTree;
    if (!tree) {
      holder.innerHTML = '<div class="side-empty">Loading folders…</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    frag.appendChild(this._folderRow({ label: 'All photos', depth: 0, count: tree.all, hasChildren: false, all: true }));
    this.expandedFolders.add('');
    const render = (node, depth) => {
      frag.appendChild(
        this._folderRow({
          label: node.name,
          path: node.path,
          depth,
          count: state.folderRecursive ? node.total : node.direct,
          direct: node.direct,
          total: node.total,
          hasChildren: node.children.length > 0,
        }),
      );
      if (node.children.length && this.expandedFolders.has(node.path)) {
        for (const child of node.children) render(child, depth + 1);
      }
    };
    render(tree.root, 0);
    holder.appendChild(frag);
    if (state.libraryStats?.scanSubfolders === false) {
      const hint = document.createElement('div');
      hint.className = 'folder-hint';
      hint.innerHTML = 'Subfolders are not indexed. <button data-action="scan-settings">Enable in Scan settings</button>';
      holder.appendChild(hint);
    }
  }

  renderFolderBar() {
    const bar = $('folder-bar');
    if (!bar) return;
    if (!state.libraryRoot) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const crumbs = $('crumbs');
    crumbs.replaceChildren();
    const add = (label, folder, current) => {
      if (crumbs.childElementCount) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        crumbs.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.className = `crumb${current ? ' current' : ''}`;
      btn.textContent = label;
      btn.title = label;
      btn.dataset.folder = folder === null ? '__all__' : folder;
      crumbs.appendChild(btn);
    };
    add('All photos', null, state.folder === null);
    if (state.folder !== null) {
      add(basename(state.libraryRoot) || 'root', '', state.folder === '');
      if (state.folder !== '') {
        let acc = '';
        for (const seg of state.folder.split('/')) {
          acc = acc ? `${acc}/${seg}` : seg;
          add(seg, acc, acc === state.folder);
        }
      }
    }
    const recursive = $('folder-recursive');
    recursive.checked = state.folderRecursive;
    recursive.disabled = state.folder === null;
    $('folder-up').disabled = state.folder === null;
  }

  visibleCount() {
    return visiblePhotos().length;
  }

  onThumbProgress(stats) {
    const el = $('thumb-status');
    const text = $('thumb-status-text');
    if (!el || !text) return;
    clearTimeout(this._thumbStatusTimer);
    if (stats.pending > 0) {
      const total = Math.max(stats.total, stats.done + stats.pending);
      el.hidden = false;
      el.classList.add('busy');
      text.textContent = `Generating thumbnails… ${Math.min(stats.done, total)}/${total}`;
      return;
    }
    if (stats.total > 0) {
      el.hidden = false;
      el.classList.remove('busy');
      text.textContent = stats.errors
        ? `Thumbnails ready · ${stats.errors} failed`
        : `Thumbnails ready (${formatCount(stats.total)})`;
      this._thumbStatusTimer = setTimeout(() => {
        el.hidden = true;
      }, 2400);
      return;
    }
    el.hidden = true;
  }

  hideThumbStatus() {
    clearTimeout(this._thumbStatusTimer);
    const el = $('thumb-status');
    if (el) el.hidden = true;
  }

  renderChips() {
    const f = state.filter;
    for (const chip of document.querySelectorAll('#flag-filters .chip')) chip.classList.toggle('active', chip.dataset.flag === f.flag);
    for (const chip of document.querySelectorAll('#rating-filters .chip')) chip.classList.toggle('active', Number(chip.dataset.rating) === f.rating);
    for (const chip of document.querySelectorAll('#raw-filters .chip')) chip.classList.toggle('active', chip.dataset.raw === f.raw);
  }

  applySettingsToUI() {
    const s = state.settings || {};
    $('sort').value = state.sort;
    $('thumb-size').value = String(state.thumbSize || 190);
    this.grid.setThumbSize(state.thumbSize || 190);
  }

  updateTopbar() {
    $('lib-name').textContent = state.libraryRoot ? basename(state.libraryRoot) : 'No library open';
    document.querySelector('.lib-dot')?.classList.toggle('on', !!state.libraryRoot);
    $('lib-count').textContent = state.libraryRoot ? `${formatCount(state.photos.length)} photos` : '';
    document.title = state.libraryRoot ? `EditAWr — ${basename(state.libraryRoot)}` : 'EditAWr';
    const catalogCount = state.libraryStats?.all ?? state.libraryStats?.total ?? state.photos.length;
    $('cache-line').textContent = state.libraryRoot ? `catalog: ${formatCount(catalogCount)} entries` : '';
  }

  renderLibraryInfo() {
    const box = $('library-info');
    if (!state.libraryRoot) {
      box.innerHTML = `<div class="side-empty">No library yet.</div><button class="btn ghost" style="width:100%" data-action="change">Choose folder…</button>`;
      return;
    }
    const stats = state.libraryStats || {};
    const missing = stats.missing || 0;
    const hidden = stats.hidden || 0;
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
        <b class="truncate" title="${escapeHtml(state.libraryRoot)}">${escapeHtml(basename(state.libraryRoot))}</b>
        <span class="muted" style="font-size:10.5px">${formatCount(state.photos.length)}</span>
      </div>
      <div class="path">${escapeHtml(state.libraryRoot)}</div>
      <div class="stat-row"><span>RAW files</span><b>${formatCount(state.photos.filter((p) => p.isRaw).length)}</b></div>
      <div class="stat-row"><span>Edited</span><b>${formatCount(state.photos.filter((p) => p.editSummary > 0).length)}</b></div>
      ${hidden ? `<div class="stat-row" title="Excluded by scan settings; ratings and edits are preserved"><span>Hidden by scan rules</span><b>${formatCount(hidden)}</b></div>` : ''}
      ${missing ? `<div class="stat-row" style="color:var(--red)"><span>Missing</span><b>${formatCount(missing)}</b></div>` : ''}
      <div class="stat-row"><span>Scan scope</span><b style="font-weight:450;color:var(--text-2)">${escapeHtml(this.scanScopeLabel(stats))}</b></div>
      <div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap">
        <button class="side-link" data-action="reveal">Reveal folder</button>
        <button class="side-link" data-action="change">Change…</button>
        <button class="side-link" data-action="scan-settings">Scan settings…</button>
      </div>
    `;
  }

  renderDevices() {
    const box = $('devices');
    const list = (state.drives || []).filter((d) => d.removable || d.hasDcim);
    box.replaceChildren();
    if (!list.length) {
      box.innerHTML = '<div class="side-empty">No card detected.<br />Insert an SD card or import from a folder.</div>';
      return;
    }
    for (const drive of list) {
      const row = document.createElement('div');
      row.className = 'device';
      row.innerHTML = `
        <span class="dev-ico">▤</span>
        <span style="flex:1;min-width:0">
          <span class="dev-name">${escapeHtml(drive.label || drive.mount)}</span>
          <span class="dev-sub">${escapeHtml(drive.mount)}${drive.mediaHint ? ` · ${formatCount(drive.mediaHint)} photos` : drive.size ? ` · ${formatBytes(drive.size)}` : ''}</span>
        </span>
        <button class="eject" title="Eject">⏏</button>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.eject')) {
          e.stopPropagation();
          this.eject(drive);
          return;
        }
        this.importer.open({ source: drive.mount });
      });
      box.appendChild(row);
    }
  }

  async eject(drive) {
    const ok = await confirmDialog({
      title: 'Eject card?',
      message: `Safely eject ${drive.label || drive.mount}? Make sure no import is running.`,
      confirmText: 'Eject',
    });
    if (!ok) return;
    const res = await window.api.drives.eject(drive.mount).catch((e) => ({ ok: false, error: e.message }));
    if (res?.ok) toast('Ejected', drive.label || drive.mount, 'success');
    else toast('Could not eject', res?.error || 'The drive may be in use.', 'error');
  }

  async speedUpScan() {
    const ok = await confirmDialog({
      title: 'Speed up this scan?',
      message:
        'Stops the current scan, enables “Skip EXIF during scan”, and rescans. This makes large libraries much faster on slow disks; camera/date metadata then loads as you browse. You can turn it off again in Scan settings.',
      confirmText: 'Speed up',
    });
    if (!ok) return;
    try {
      await window.api.library.cancelScan();
      await window.api.settings.set({ fastMetadata: true });
      const started = Date.now();
      while (Date.now() - started < 10000) {
        const stats = await window.api.library.stats();
        if (!stats?.scanning) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await this.rescan();
      toast('Fast scan enabled', 'Metadata and thumbnails now load on demand.', 'success');
    } catch (err) {
      toast('Could not switch scan mode', err.message, 'error');
    }
  }

  scanScopeLabel(stats = {}) {
    if (!stats || typeof stats !== 'object') return '';
    if (stats.scanSubfolders === false) return 'top level only';
    const ex = stats.excludedFolders || [];
    if (ex.length) return `skipping ${ex.length} folder${ex.length === 1 ? '' : 's'}`;
    return 'all subfolders';
  }

  updateScanStrip(done = false, doneMessage = 'Library up to date') {
    const strip = $('scan-strip');
    const stop = $('scan-stop');
    const scan = state.scan;
    if (stop) stop.hidden = !scan.active;
    const fast = $('scan-fast');
    if (fast) fast.hidden = !scan.active;
    if (!scan.active) {
      if (done) {
        strip.hidden = false;
        $('scan-fill').style.width = '100%';
        $('scan-text').textContent = doneMessage;
        setTimeout(() => {
          if (!state.scan.active) strip.hidden = true;
        }, 2200);
      } else {
        strip.hidden = true;
      }
      return;
    }
    strip.hidden = false;
    const pct = scan.total ? Math.round((scan.done / scan.total) * 100) : 3;
    $('scan-fill').style.width = `${Math.max(3, pct)}%`;
    $('scan-text').textContent =
      scan.phase === 'walking'
        ? `Scanning folders… ${formatCount(scan.done)} files`
        : `Indexing photos… ${formatCount(scan.done)} / ${formatCount(scan.total)}`;
  }

  /* ------------------------------ selection ----------------------------- */

  selectPhoto(rel, { toggle = false, range = false } = {}) {
    if (range) selectRange(rel);
    else if (toggle) toggleSelect(rel);
    else setActive(rel);
    this.grid.updateSelection();
  }

  openEditor(rel) {
    setActive(rel);
    setMode('editor');
    this.editor.open(rel);
  }

  /* ------------------------------ actions ------------------------------- */

  async openLibraryChooser({ empty = false } = {}) {
    try {
      const res = await window.api.library.choose({ title: empty ? 'Choose a folder for your photo library' : 'Switch library folder' });
      if (!res) return;
      this.applyLibrary(res);
    } catch (err) {
      toast('Could not open library', err.message, 'error', 8000);
    }
  }

  openLibraryFromDialog() {
    this.openLibraryChooser();
  }

  applyLibrary(res) {
    state.libraryRoot = res.root;
    state.libraryStats = res.stats || {};
    state.selected.clear();
    state.activeRel = null;
    state.folder = '';
    state.folderRecursive = false;
    state.folderInitialized = false;
    state.folderTree = null;
    this._folderViewRoot = null;
    this.expandedFolders = new Set(['']);
    this.hideThumbStatus();
    setPhotos(res.photos || [], 'library');
    setMode('library');
    this.editor.close();
    this.renderLibraryInfo();
    this.updateTopbar();
    this.refreshGrid();
    this.renderFolderTree();
    this.renderFolderBar();
    this.refreshFolderTree();
    this.grid.scrollToRel(res.photos?.[0]?.rel);
    toast('Library opened', `${formatCount(res.photos?.length || 0)} photos · ${res.root}`, 'success');
  }

  async rescan() {
    if (!state.libraryRoot) return this.openLibraryChooser();
    try {
      setScan({ active: true, phase: 'walking', done: 0, total: 0 });
      const res = await window.api.library.scan();
      if (res?.photos) {
        state.libraryStats = res.stats || {};
        setPhotos(res.photos, 'snapshot');
        this.renderLibraryInfo();
        this.refreshGrid();
        this.updateTopbar();
        if (res.cancelled) toast('Scan stopped', 'You can rescan at any time — already-indexed photos are kept.', 'info');
      }
    } catch (err) {
      setScan({ active: false });
      toast('Rescan failed', err.message, 'error');
    }
  }

  async rateActive(n) {
    const rel = this.editor.isOpen ? this.editor.rel : state.activeRel;
    if (!rel) return;
    if (this.editor.isOpen) return this.editor.setRating(n);
    return this.setPhotoRating(rel, n);
  }

  async setPhotoRating(rel, n) {
    patchPhotoLocal(rel, { rating: n });
    try {
      const updated = await window.api.library.update(rel, { rating: n });
      if (updated) patchPhotoLocal(rel, updated);
    } catch (err) {
      toast('Could not save rating', err.message, 'error');
    }
  }

  async flagActive(kind) {
    const rel = this.editor.isOpen ? this.editor.rel : state.activeRel;
    if (!rel) return;
    if (this.editor.isOpen) return this.editor.setFlag(kind);
    return this.setPhotoFlag(rel, kind);
  }

  async setPhotoFlag(rel, kind) {
    const value = kind === 'none' ? null : kind;
    patchPhotoLocal(rel, { flag: value });
    try {
      const updated = await window.api.library.update(rel, { flag: value });
      if (updated) patchPhotoLocal(rel, updated);
    } catch (err) {
      toast('Could not save flag', err.message, 'error');
    }
  }

  showPhotoMenu(rel, x, y) {
    const photo = getPhoto(rel);
    if (!photo) return;
    if (!state.selected.has(rel)) setActive(rel);
    const rating = photo.rating || 0;
    showContextMenu(
      [
        { label: 'Open in editor', hint: 'Enter', action: () => this.openEditor(rel) },
        { label: 'Reveal in file manager', action: () => window.api.library.reveal(rel) },
        'sep',
        { label: '★ 1 star', action: () => this.setPhotoRating(rel, 1) },
        { label: '★★★ 3 stars', action: () => this.setPhotoRating(rel, 3) },
        { label: '★★★★★ 5 stars', hint: rating ? `${rating} now` : '', action: () => this.setPhotoRating(rel, 5) },
        { label: 'Clear rating', disabled: !rating, action: () => this.setPhotoRating(rel, 0) },
        'sep',
        { label: 'Flag as pick', hint: 'P', action: () => this.setPhotoFlag(rel, 'picked') },
        { label: 'Reject', hint: 'X', action: () => this.setPhotoFlag(rel, 'rejected') },
        { label: 'Clear flag', disabled: !photo.flag, action: () => this.setPhotoFlag(rel, 'none') },
        'sep',
        { label: 'Export…', hint: 'Ctrl+E', action: () => this.openEditorForExport(rel) },
      ],
      { x, y },
    );
  }

  async openEditorForExport(rel) {
    setActive(rel);
    setMode('editor');
    await this.editor.open(rel);
    this.editor.openExport();
  }

  moveActive(dir) {
    const list = visiblePhotos();
    if (!list.length) return;
    const idx = list.findIndex((p) => p.rel === state.activeRel);
    const next = list[Math.max(0, Math.min(list.length - 1, (idx < 0 ? 0 : idx) + dir))];
    if (next) {
      setActive(next.rel);
      this.grid.scrollToRel(next.rel);
    }
  }

  /* ------------------------------- settings ----------------------------- */

  async openSettings() {
    const s = state.settings || {};
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="field">
        <label>Photo library</label>
        <div class="row">
          <div class="pathval grow">${escapeHtml(state.libraryRoot || 'No library open')}</div>
          <button class="btn ghost" id="st-change-lib">Change…</button>
        </div>
        <div class="hint">The catalog is stored in the app data folder; photos are never moved.</div>
      </div>
      <div class="field">
        <label>Date folder format</label>
        <div class="row">
          <select id="st-date-format"></select>
          <input type="text" id="st-date-custom" class="mono grow" placeholder="YYYY-MM-DD" spellcheck="false" hidden />
        </div>
        <div class="hint" id="st-date-hint"></div>
        <div class="hint">Controls what &lt;date&gt; expands to in import/export templates. Tokens: <span class="mono">YYYY YY MM DD HH mm ss</span>; “/” creates subfolders. Inline override: <span class="mono">&lt;date:YYYY/MM/DD&gt;</span>.</div>
      </div>
      <div class="field">
        <label>Library scanning</label>
        <label class="check"><input type="checkbox" id="st-scan-sub" ${s.scanSubfolders !== false ? 'checked' : ''} /> Index photos in subfolders</label>
        <label class="check"><input type="checkbox" id="st-lazy-thumbs" ${s.lazyThumbs !== false ? 'checked' : ''} /> Load thumbnails on demand (recommended for large libraries)</label>
        <label class="check"><input type="checkbox" id="st-fast-meta" ${s.fastMetadata ? 'checked' : ''} /> Skip EXIF during scan; load metadata while browsing</label>
        <label style="margin-top:8px;display:block">Skip folders</label>
        <input type="text" id="st-exclude" class="mono" spellcheck="false"
          placeholder="backup, 2023/Originals" value="${escapeHtml((s.excludedFolders || []).join(', '))}" />
        <div class="hint">
          Comma-separated folder names or relative paths (case-insensitive). Hidden photos stay in the catalog with their ratings and edits, and reappear when the rules change.
          Date-folder imports (e.g. <span class="mono">&lt;date&gt;/&lt;filename&gt;</span>) need “Index photos in subfolders”.
          “Skip EXIF” makes first scans of 10k+ files on a slow disk much faster; camera/date info fills in as you browse.
        </div>
      </div>
      <div class="field">
        <label>Devices</label>
        <label class="check"><input type="checkbox" id="st-cards" ${s.autoDetectCards !== false ? 'checked' : ''} /> Detect SD cards automatically</label>
      </div>
      <div class="field">
        <label>RAW preview decoding</label>
        <select id="st-preview">
          <option value="0">Full embedded preview (best export quality)</option>
          <option value="3000">Cap at 3000 px (less memory)</option>
          <option value="2000">Cap at 2000 px (low memory)</option>
        </select>
        <div class="hint">Used only when LibRaw cannot demosaic a RAW (e.g. Nikon HE/HE*). Editing always falls back to the embedded JPEG preview.</div>
        <label class="check" style="margin-top:6px"><input type="checkbox" id="st-force" ${s.rawForceDecode ? 'checked' : ''} /> Try LibRaw anyway for HE/HE* files</label>
        <div class="hint">Enable this after upgrading <span class="mono">libraw-wasm</span>: newer builds may demosaic files the current one cannot.</div>
      </div>
      <div class="field">
        <label>Cache</label>
        <div class="row">
          <div class="pathval grow" id="st-cache">calculating…</div>
          <button class="btn ghost" id="st-clear">Clear</button>
        </div>
      </div>
      <div class="field">
        <label>About</label>
        <div class="hint">
          EditAWr ${escapeHtml(state.appInfo?.version || '')} · Electron ${escapeHtml(state.appInfo?.electron || '')} · Chromium ${escapeHtml(state.appInfo?.chrome || '')}<br />
          RAW: LibRaw (WebAssembly) · decode: ${escapeHtml(this.editor.sourceMode || '—')} · denoise/sharpening: GPU shaders<br />
          Data folder: <span class="mono">${escapeHtml(state.appInfo?.userData || '')}</span>
        </div>
      </div>
    `;
    const modal = openModal({
      title: 'Settings',
      body,
      actions: [
        { label: 'Close' },
        {
          label: 'Save',
          kind: 'primary',
          onClick: async ({ close }) => {
            const dateSelect = body.querySelector('#st-date-format');
            const dateCustom = body.querySelector('#st-date-custom');
            const rawDate = dateSelect.value === 'custom' ? dateCustom.value : dateSelect.value;
            const patch = {
              autoDetectCards: body.querySelector('#st-cards').checked,
              rawForceDecode: body.querySelector('#st-force').checked,
              dateFormat: normalizeDateFormat(rawDate),
              scanSubfolders: body.querySelector('#st-scan-sub').checked,
              lazyThumbs: body.querySelector('#st-lazy-thumbs').checked,
              fastMetadata: body.querySelector('#st-fast-meta').checked,
              excludedFolders: body.querySelector('#st-exclude').value,
              editor: { previewMaxEdge: Number(body.querySelector('#st-preview').value) || 0 },
            };
            try {
              state.settings = await window.api.settings.set(patch);
              this.applySettingsToUI();
              toast('Settings saved');
            } catch (err) {
              toast('Could not save settings', err.message, 'error');
            }
            close();
          },
        },
      ],
    });
    const dateSelect = body.querySelector('#st-date-format');
    const dateCustom = body.querySelector('#st-date-custom');
    const dateHint = body.querySelector('#st-date-hint');
    for (const f of DATE_FORMATS) {
      const opt = document.createElement('option');
      opt.value = f.value;
      opt.textContent = f.label;
      dateSelect.appendChild(opt);
    }
    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = 'Custom pattern…';
    dateSelect.appendChild(customOpt);

    const currentFormat = s.dateFormat || DEFAULT_DATE_FORMAT;
    if (isKnownDateFormat(currentFormat)) dateSelect.value = currentFormat;
    else {
      dateSelect.value = 'custom';
      dateCustom.value = currentFormat;
      dateCustom.hidden = false;
    }
    const updateDateHint = () => {
      const raw = dateSelect.value === 'custom' ? dateCustom.value.trim() : dateSelect.value;
      const valid = /(YYYY|YY|MM|DD)/.test(raw) && !/[<>:"|?*]/.test(raw);
      dateHint.textContent = valid ? `Example: ${formatDatePattern(new Date(), raw)}` : 'Needs YYYY / MM / DD tokens — Save will fall back to YYYY-MM-DD.';
      dateHint.style.color = valid ? '' : 'var(--red)';
    };
    dateSelect.addEventListener('change', () => {
      const custom = dateSelect.value === 'custom';
      dateCustom.hidden = !custom;
      if (custom) dateCustom.focus();
      updateDateHint();
    });
    dateCustom.addEventListener('input', updateDateHint);
    updateDateHint();

    body.querySelector('#st-preview').value = String(s.editor?.previewMaxEdge || 0);
    body.querySelector('#st-change-lib').addEventListener('click', async () => {
      modal.close();
      await this.openLibraryChooser();
    });
    try {
      const info = await window.api.cache.info();
      const el = body.querySelector('#st-cache');
      if (el) el.textContent = `${info.text} · ${formatCount(info.files)} files`;
    } catch {
      /* ignore */
    }
    body.querySelector('#st-clear').addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Clear cache?', message: 'Thumbnails and previews will be regenerated when needed.', confirmText: 'Clear', danger: true });
      if (!ok) return;
      const res = await window.api.cache.clear().catch((e) => ({ removed: 0, error: e.message }));
      body.querySelector('#st-cache').textContent = `cleared ${formatCount(res.removed || 0)} files`;
      toast('Cache cleared', `${formatCount(res.removed || 0)} files removed`, 'success');
    });
  }

  showShortcuts() {
    openModal({
      title: 'Keyboard shortcuts',
      body: `<div class="kbd-list">
        <kbd>Ctrl O</kbd><span>Open library folder</span>
        <kbd>Ctrl Shift I</kbd><span>Import from card</span>
        <kbd>Ctrl E</kbd><span>Export current photo</span>
        <kbd>F5</kbd><span>Rescan library</span>
        <kbd>Enter</kbd><span>Open photo in editor</span>
        <kbd>← ↑ → ↓</kbd><span>Move selection / previous & next photo</span>
        <kbd>0 – 5</kbd><span>Set star rating</span>
        <kbd>P / X / U</kbd><span>Pick / reject / clear flag</span>
        <kbd>[ / ]</kbd><span>Rotate 90°</span>
        <kbd>\\</kbd><span>Before / after</span>
        <kbd>C</kbd><span>Crop tool</span>
        <kbd>F</kbd><span>Fit to screen</span>
        <kbd>+ / −</kbd><span>Zoom in / out</span>
        <kbd>Ctrl 0 / Ctrl 1</kbd><span>Fit / 100%</span>
        <kbd>Esc</kbd><span>Back to library</span>
      </div>`,
      actions: [{ label: 'Close' }],
    });
  }

  showFormats() {
    openModal({
      title: 'Supported files & RAW notes',
      wide: true,
      body: `<div class="hint" style="font-size:12px;line-height:1.7;color:var(--text-2)">
        <p><b>RAW:</b> NEF/NRW, CR2/CR3, ARW/SR2, DNG, RAF, ORF, RW2, PEF, SRW, X3F and other LibRaw formats.
        Sensor data is demosaiced in a worker by LibRaw (WebAssembly) at 16-bit precision and edited in a linear GPU pipeline.</p>
        <p><b>Nikon HE / HE* compression:</b> LibRaw cannot demosaic these files yet. EditAWr detects the compression from the Nikon makernote and automatically edits the embedded <i>full-size</i> JPEG preview instead. The preview badge in the editor tells you which path was used.</p>
        <p><b>Standard images:</b> JPEG, PNG, WebP, AVIF, BMP, GIF and TIFF. TIFF is converted to an sRGB preview by sharp; HEIC is attempted through sharp/libheif (system codec support varies — HEVC-compressed iPhone HEICs usually fail).</p>
        <p><b>Packages:</b> sharp (thumbnails, TIFF/JPEG encoding) · exifr (metadata) · LibRaw-Wasm (RAW demosaic) · WebGL2 shaders (tone, colour, denoise, sharpening).</p>
        <p><b>Denoise:</b> a GPU edge-aware non-local-means filter, not a neural network — no model download, fully offline. It is tuned to behave like a detail-preserving denoiser; the amount/detail sliders trade noise against texture.</p>
      </div>`,
      actions: [{ label: 'Close' }],
    });
  }

  /* -------------------------------- menu -------------------------------- */

  handleMenu(action) {
    switch (action) {
      case 'open-library':
        return this.openLibraryChooser();
      case 'import':
        return this.importer.open();
      case 'export':
        if (this.editor.isOpen) return this.editor.openExport();
        return toast('Open a photo first', 'Export renders the photo in the editor.', 'error', 3000);
      case 'rescan':
        return this.rescan();
      case 'copy-settings':
        if (!this.editor.isOpen) return;
        settingsClipboard = { ...this.editor.edits };
        return toast('Settings copied', undefined, 'info', 1800);
      case 'paste-settings':
        if (!this.editor.isOpen) return;
        if (!settingsClipboard) return toast('Nothing to paste', 'Copy settings from another photo first.', 'error', 3000);
        this.editor.applyPreset(settingsClipboard);
        return;
      case 'reset-settings':
        if (this.editor.isOpen) this.editor.resetEdits();
        return;
      case 'undo':
        if (this.editor.isOpen) this.editor.undo();
        return;
      case 'redo':
        if (this.editor.isOpen) this.editor.redo();
        return;
      case 'view-grid':
      case 'view-loupe':
        if (this.editor.isOpen) {
          this.editor.close();
          setMode('library');
        } else if (action === 'view-loupe' && (state.activeRel || state.photos[0])) {
          this.openEditor(state.activeRel || state.photos[0].rel);
        }
        return;
      case 'toggle-before':
        if (this.editor.isOpen) this.editor.toggleBefore();
        return;
      case 'zoom-fit':
        this.editor.zoomToFit();
        return;
      case 'zoom-100':
        this.editor.zoomToActual();
        return;
      case 'help-formats':
        return this.showFormats();
      case 'help-shortcuts':
        return this.showShortcuts();
      default:
        return undefined;
    }
  }

  /* ------------------------------- keyboard ----------------------------- */

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (document.querySelector('.modal-backdrop')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;

      if (mod && key.toLowerCase() === 'o') {
        e.preventDefault();
        this.openLibraryChooser();
        return;
      }
      if (mod && e.shiftKey && key.toLowerCase() === 'i') {
        e.preventDefault();
        this.importer.open();
        return;
      }
      if (mod && key.toLowerCase() === 'e') {
        e.preventDefault();
        if (this.editor.isOpen) this.editor.openExport();
        return;
      }
      if (key === 'F5') {
        e.preventDefault();
        this.rescan();
        return;
      }
      if (mod && key === '0') {
        e.preventDefault();
        this.editor.zoomToFit();
        return;
      }
      if (mod && key === '1') {
        e.preventDefault();
        this.editor.zoomToActual();
        return;
      }
      if (mod && key.toLowerCase() === 'a' && !this.editor.isOpen) {
        e.preventDefault();
        for (const p of visiblePhotos()) state.selected.add(p.rel);
        notify('selection');
        return;
      }

      if (!this.editor.isOpen && e.altKey && key === 'ArrowUp') {
        e.preventDefault();
        this.goUpFolder();
        return;
      }

      if (this.editor.isOpen && !mod) {
        if (key === 'ArrowLeft') return void this.editor.step(-1);
        if (key === 'ArrowRight') return void this.editor.step(1);
        if (key === '[') return void this.editor.rotate(-1);
        if (key === ']') return void this.editor.rotate(1);
        if (key === '\\') {
          e.preventDefault();
          return void this.editor.toggleBefore();
        }
        if (key.toLowerCase() === 'c') return void (this.editor.cropMode ? this.editor.applyCrop() : this.editor.enterCrop());
        if (key.toLowerCase() === 'f') return void this.editor.zoomToFit();
        if (key === '+' || key === '=') return void this.editor.zoomBy(1.4);
        if (key === '-') return void this.editor.zoomBy(1 / 1.4);
      }

      if (!this.editor.isOpen && !mod) {
        if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
          e.preventDefault();
          if (key === 'ArrowLeft' || key === 'ArrowRight') this.moveActive(key === 'ArrowLeft' ? -1 : 1);
          else {
            const cols = this.grid.cols;
            this.moveActive(key === 'ArrowUp' ? -cols : cols);
          }
          return;
        }
        if (key === 'Enter' && state.activeRel) {
          e.preventDefault();
          this.openEditor(state.activeRel);
          return;
        }
      }

      if (/^[0-5]$/.test(key)) {
        this.rateActive(Number(key));
        return;
      }
      if (key.toLowerCase() === 'p') {
        this.flagActive('picked');
        return;
      }
      if (key.toLowerCase() === 'x') {
        this.flagActive('rejected');
        return;
      }
      if (key.toLowerCase() === 'u') {
        this.flagActive('none');
      }
    });
  }
}

const app = new App();
app.boot().catch((err) => {
  console.error('[app] boot failed', err);
  document.body.innerHTML = `<div style="padding:40px;font:14px sans-serif;color:#eee;background:#111;height:100vh">
    <h2>EditAWr could not start</h2><pre style="white-space:pre-wrap;color:#f88">${escapeHtml(err.stack || err.message)}</pre></div>`;
});

window.__editawr = app;
window.__editawrState = state;
