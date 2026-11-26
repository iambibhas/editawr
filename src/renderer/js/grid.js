/** Virtualised photo grid: only the visible rows exist in the DOM. */
import { state, getPhoto, patchPhotoLocal } from './state.js';
import { formatDate, extOf, stars } from './format.js';
import { toast } from './ui.js';

const GAP = 12;
const CAPTION = 30;

export class PhotoGrid {
  constructor({ container, scrollEl, onOpen, onSelection, onContext, onThumbProgress }) {
    this.container = container;
    this.scrollEl = scrollEl;
    this.onOpen = onOpen || (() => {});
    this.onSelection = onSelection || (() => {});
    this.onContext = onContext || (() => {});
    this.onThumbProgress = onThumbProgress || (() => {});
    this.items = [];
    this.cols = 1;
    this.tileW = 190;
    this.rowH = 220;
    this.raf = null;
    this.retrying = new Set();
    this.thumbQueue = [];
    this.thumbActive = 0;
    this.thumbMax = 4;
    this.thumbRequested = new Set();
    this.thumbPending = new Set();
    this.thumbStats = { pending: 0, done: 0, total: 0, errors: 0 };
    this._thumbNotifyTimer = null;
    this.renderedFirst = -1;
    this.renderedLast = -1;

    container.addEventListener('click', (e) => this._onClick(e));
    container.addEventListener('dblclick', (e) => this._onDblClick(e));
    container.addEventListener('contextmenu', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile) return;
      e.preventDefault();
      this.onContext(tile.dataset.rel, e.clientX, e.clientY);
    });
    container.addEventListener('error', (e) => this._onImgError(e), true);
    scrollEl.addEventListener('scroll', () => this._schedule(), { passive: true });
    new ResizeObserver(() => this.layout()).observe(scrollEl);
  }

  setPhotos(list) {
    // Drop queued thumbnails for photos that are no longer in view (e.g. the
    // user switched folders). In-flight requests are allowed to finish.
    const rels = new Set(list.map((p) => p.rel));
    let removed = 0;
    this.thumbQueue = this.thumbQueue.filter((rel) => {
      if (rels.has(rel)) return true;
      this.thumbPending.delete(rel);
      removed++;
      return false;
    });
    if (removed) {
      this.thumbStats.pending = Math.max(0, this.thumbStats.pending - removed);
      this.thumbStats.total = Math.max(0, this.thumbStats.total - removed);
      this._notifyThumbProgress();
    }
    this.items = list;
    this.renderedFirst = -1;
    this.renderedLast = -1;
    this.layout();
  }

  setThumbSize(px) {
    this.tileW = px;
    this.container.style.setProperty('--tile', `${px}px`);
    this.renderedFirst = -1;
    this.renderedLast = -1;
    this.layout();
  }

  layout() {
    if (!this.items) return;
    const width = this.scrollEl.clientWidth - 28; // padding
    const minTile = this.tileW;
    this.cols = Math.max(1, Math.floor((width + GAP) / (minTile + GAP)));
    const actual = Math.max(70, (width - GAP * (this.cols - 1)) / this.cols);
    this.tileWActual = actual;
    this.rowH = actual + CAPTION + GAP;
    const rows = Math.ceil(this.items.length / this.cols);
    this.container.style.height = `${Math.max(0, rows * this.rowH - GAP)}px`;
    this.container.style.setProperty('--tile', `${actual}px`);
    this.renderedFirst = -1;
    this.renderedLast = -1;
    this.render();
  }

  _schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.render();
    });
  }

  render(force = false) {
    const scrollTop = this.scrollEl.scrollTop;
    const height = this.scrollEl.clientHeight;
    const startRow = Math.max(0, Math.floor(scrollTop / this.rowH) - 1);
    const endRow = Math.min(Math.ceil(this.items.length / this.cols), Math.ceil((scrollTop + height) / this.rowH) + 1);
    const first = startRow * this.cols;
    const last = Math.min(this.items.length, endRow * this.cols);
    if (!force && first === this.renderedFirst && last === this.renderedLast && this.container.childElementCount) {
      return;
    }
    this.renderedFirst = first;
    this.renderedLast = last;

    // Keep the thumbnail queue scoped to what is on/near the screen. Without
    // this, fast scrolling on a slow disk would queue hundreds of previews.
    const wanted = new Set();
    const buffer = this.cols * 2;
    for (let i = Math.max(0, first - buffer); i < Math.min(this.items.length, last + buffer); i++) {
      if (this.items[i]) wanted.add(this.items[i].rel);
    }
    let dropped = 0;
    this.thumbQueue = this.thumbQueue.filter((rel) => {
      if (wanted.has(rel)) return true;
      this.thumbPending.delete(rel);
      this.thumbRequested.delete(rel);
      dropped++;
      return false;
    });
    if (dropped) {
      this.thumbStats.pending = Math.max(0, this.thumbStats.pending - dropped);
      this.thumbStats.total = Math.max(this.thumbStats.done, this.thumbStats.total - dropped);
      this._notifyThumbProgress();
    }

    // Enqueue thumbnails for the newly visible tiles first, so the markup
    // below can show per-tile loading spinners immediately.
    for (let i = first; i < last; i++) {
      const p = this.items[i];
      if (p && !p.thumbUrl && !p.thumbFailed && !this.thumbRequested.has(p.rel)) this._enqueueThumb(p.rel);
    }

    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const photo = this.items[i];
      if (!photo) continue;
      const row = Math.floor(i / this.cols);
      const col = i % this.cols;
      const el = document.createElement('div');
      el.className = 'tile';
      el.dataset.rel = photo.rel;
      el.style.transform = `translate(${col * (this.tileWActual + GAP)}px, ${row * this.rowH}px)`;
      el.style.width = `${this.tileWActual}px`;
      el.setAttribute('role', 'option');
      el.title = [
        photo.name,
        formatDate(photo.capturedAt),
        photo.camera,
        photo.lens,
        photo.iso ? `ISO ${photo.iso}` : '',
        photo.missing ? 'FILE MISSING' : '',
      ]
        .filter(Boolean)
        .join('\n');

      if (state.selected.has(photo.rel)) el.classList.add('selected');
      if (state.activeRel === photo.rel) el.classList.add('active');

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (photo.thumbUrl) {
        const img = document.createElement('img');
        img.src = photo.thumbUrl;
        img.alt = photo.name;
        img.decoding = 'async';
        img.draggable = false;
        img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
        thumb.appendChild(img);
      } else if (this.thumbPending.has(photo.rel)) {
        thumb.innerHTML = '<div class="thumb-loading"><span class="thumb-spinner"></span></div>';
      } else {
        thumb.innerHTML = '<div class="ph">◻</div>';
      }
      if (photo.editSummary > 0) {
        const b = document.createElement('span');
        b.className = 'edit-badge';
        b.textContent = 'Edited';
        thumb.appendChild(b);
      }
      if (photo.isRaw) {
        const b = document.createElement('span');
        b.className = 'raw-badge';
        b.textContent = extOf(photo.name) || 'RAW';
        thumb.appendChild(b);
      }
      if (photo.missing) {
        const b = document.createElement('span');
        b.className = 'missing';
        b.textContent = 'File missing';
        thumb.appendChild(b);
      }
      el.appendChild(thumb);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = photo.name;
      meta.appendChild(name);
      if (photo.rating) {
        const s = document.createElement('span');
        s.className = 'stars';
        s.textContent = '★'.repeat(Math.min(5, photo.rating));
        meta.appendChild(s);
      }
      if (photo.flag === 'picked') {
        const f = document.createElement('span');
        f.className = 'flag';
        f.textContent = '⚑';
        meta.appendChild(f);
      } else if (photo.flag === 'rejected') {
        const f = document.createElement('span');
        f.className = 'reject';
        f.textContent = '✕';
        meta.appendChild(f);
      }
      el.appendChild(meta);
      frag.appendChild(el);
    }
    this.container.replaceChildren(frag);
  }

  _enqueueThumb(rel) {
    if (this.thumbRequested.has(rel) || this.thumbPending.has(rel)) return;
    // Start a fresh progress batch once the previous one has fully drained.
    if (this.thumbStats.pending === 0 && this.thumbStats.done > 0) {
      this.thumbStats = { pending: 0, done: 0, total: 0, errors: 0 };
    }
    this.thumbRequested.add(rel);
    this.thumbPending.add(rel);
    this.thumbQueue.push(rel);
    this.thumbStats.pending++;
    this.thumbStats.total++;
    this._notifyThumbProgress();
    this._pumpThumbs();
  }

  _notifyThumbProgress() {
    if (this._thumbNotifyTimer) return;
    this._thumbNotifyTimer = setTimeout(() => {
      this._thumbNotifyTimer = null;
      try {
        this.onThumbProgress({ ...this.thumbStats });
      } catch (err) {
        console.warn('[grid] thumb progress listener failed', err.message);
      }
    }, 80);
  }

  _pumpThumbs() {
    while (this.thumbActive < this.thumbMax && this.thumbQueue.length) {
      const rel = this.thumbQueue.shift();
      this.thumbActive++;
      window.api.thumbs
        .ensure(rel, 384)
        .then((res) => {
          if (res?.url) {
            const photo = getPhoto(rel);
            patchPhotoLocal(rel, {
              thumbUrl: res.url,
              width: res.width || photo?.width || null,
              height: res.height || photo?.height || null,
            });
          }
        })
        .catch((err) => {
          console.warn('[grid] thumbnail failed', rel, err.message);
          this.thumbStats.errors++;
          patchPhotoLocal(rel, { thumbFailed: true });
        })
        .finally(() => {
          this.thumbActive--;
          this.thumbPending.delete(rel);
          this.thumbStats.pending = Math.max(0, this.thumbStats.pending - 1);
          this.thumbStats.done++;
          this._notifyThumbProgress();
          this._pumpThumbs();
        });
    }
  }

  updateSelection() {
    for (const el of this.container.children) {
      const rel = el.dataset.rel;
      el.classList.toggle('selected', state.selected.has(rel));
      el.classList.toggle('active', state.activeRel === rel);
    }
  }

  _onClick(e) {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const rel = tile.dataset.rel;
    this.onSelection(rel, {
      toggle: e.ctrlKey || e.metaKey,
      range: e.shiftKey,
    });
  }

  _onDblClick(e) {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    this.onOpen(tile.dataset.rel);
  }

  _onImgError(e) {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const tile = img.closest('.tile');
    if (!tile) return;
    const rel = tile.dataset.rel;
    if (this.retrying.has(rel)) return;
    this.retrying.add(rel);
    const photo = getPhoto(rel);
    if (!photo) return;
    window.api.thumbs
      .ensure(rel, 384)
      .then((res) => {
        if (res?.url) patchPhotoLocal(rel, { thumbUrl: res.url, width: res.width || photo.width, height: res.height || photo.height });
        img.src = res.url;
      })
      .catch((err) => {
        console.warn('[grid] thumbnail regeneration failed', rel, err.message);
        img.remove();
        tile.querySelector('.thumb')?.insertAdjacentHTML('afterbegin', '<div class="ph">⚠</div>');
      })
      .finally(() => this.retrying.delete(rel));
  }

  scrollToRel(rel) {
    const idx = this.items.findIndex((p) => p.rel === rel);
    if (idx < 0) return;
    const row = Math.floor(idx / this.cols);
    const top = row * this.rowH;
    const viewTop = this.scrollEl.scrollTop;
    const viewBottom = viewTop + this.scrollEl.clientHeight;
    if (top < viewTop + 4 || top + this.rowH > viewBottom - 4) {
      this.scrollEl.scrollTop = Math.max(0, top - this.rowH * 0.5);
    }
  }
}
