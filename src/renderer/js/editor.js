/** The loupe/editor view: GPU preview, adjustments, crop, export. */
import { GLPipeline } from './gl.js';
import { RawDecoder } from './raw.js';
import { DEFAULT_EDITS, SLIDER_DEFS, PRESETS, normalizeEdits, clampEdit, editedKeys } from './edits.js';
import { state, getPhoto, patchPhotoLocal, visiblePhotos, notify } from './state.js';
import { toast, openModal, confirmDialog } from './ui.js';
import {
  formatAperture, formatDate, formatShutter, formatFocal, formatBytes, metaLine, debounce, throttle, basename, extOf,
} from './format.js';

const MAX_PREVIEW_PIXELS = 2_600_000; // render ceiling for interactive preview
const FINAL_DELAY = 190;

const ASPECTS = [
  { label: 'Free', value: 0 },
  { label: '5:4', value: 5 / 4 },
  { label: '1:1', value: 1 },
  { label: '4:5', value: 4 / 5 },
  { label: '3:2', value: 3 / 2 },
  { label: '16:9', value: 16 / 9 },
];

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export class Editor {
  constructor() {
    this.el = {
      view: document.getElementById('editor-view'),
      canvas: document.getElementById('editor-canvas'),
      wrap: document.getElementById('canvas-wrap'),
      loading: document.getElementById('loading-overlay'),
      loadingText: document.getElementById('loading-text'),
      badge: document.getElementById('mode-badge'),
      zoomLabel: document.getElementById('zoom-label'),
      filename: document.getElementById('ed-filename'),
      meta: document.getElementById('ed-meta'),
      rating: document.getElementById('ed-rating'),
      flag: document.getElementById('ed-flag'),
      before: document.getElementById('ed-before'),
      reset: document.getElementById('ed-reset'),
      exportBtn: document.getElementById('ed-export'),
      back: document.getElementById('btn-back'),
      filmstrip: document.getElementById('filmstrip'),
      histogram: document.getElementById('histogram'),
      histReadout: document.getElementById('hist-readout'),
      cropOverlay: document.getElementById('crop-overlay'),
      panel: document.getElementById('panel'),
    };

    this.rel = null;
    this.entry = null;
    this.info = null;
    this.edits = normalizeEdits(null);
    this.sourceMode = null; // raw | preview | image
    this.decodedHalf = false;
    this.previewPixels = null;
    this.bitmap = null;
    this.srcW = 0;
    this.srcH = 0;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.before = false;
    this.cropMode = false;
    this.cropRect = null;
    this.cropAspect = 0;
    this.loadingCount = 0;
    this.exporting = false;
    this.upgrading = false;
    this.fastFinalTimer = null;
    this.raf = null;
    this.wantFast = false;
    this.openSeq = 0;
    this.loading = false;

    this.pipeline = null;
    this.pipelineError = null;
    try {
      this.pipeline = new GLPipeline(this.el.canvas);
    } catch (err) {
      this.pipelineError = err;
      console.error('[editor] WebGL init failed:', err);
    }
    this.rawDecoder = new RawDecoder();
    this.history = [];
    this.historyIndex = -1;

    this.histSample = document.createElement('canvas');
    this.histCtx = this.histSample.getContext('2d', { willReadFrequently: true });
    this.histDirty = false;
    this._updateHistogramSoon = throttle(() => this._drawHistogram(), 180);

    this._persist = debounce(() => this._saveEdits(), 550);
    this._upgradeSoon = debounce(() => this._maybeUpgradeResolution(), 450);
    this._buildPanel();
    this._bind();
    this._layoutCropOverlay = throttle(() => this._positionCropOverlay(), 60);

    new ResizeObserver(() => {
      if (!this.rel) return;
      this._applyCanvasSize();
      this.requestRender();
      this._positionCropOverlay();
    }).observe(this.el.wrap);
  }

  /* ------------------------------ setup ------------------------------- */

  _buildPanel() {
    this.sliders = new Map();
    const groups = {
      light: document.getElementById('group-light'),
      color: document.getElementById('group-color'),
      detail: document.getElementById('group-detail'),
      effects: document.getElementById('group-effects'),
    };
    for (const [group, defs] of Object.entries(SLIDER_DEFS)) {
      const holder = groups[group];
      if (!holder) continue;
      for (const def of defs) holder.appendChild(this._makeSlider(def));
    }
    if (groups.detail) {
      const hint = document.createElement('div');
      hint.className = 'crop-hint';
      hint.textContent = 'Denoise: GPU edge-aware non-local means. Sharpening: unsharp mask with radius, detail and masking.';
      groups.detail.appendChild(hint);
    }

    this._buildCropGroup();
    this._buildPresets();
  }

  _makeSlider(def) {
    const row = document.createElement('div');
    row.className = `slider-row${def.sub ? ' sub' : ''}`;
    row.dataset.key = def.key;
    const top = document.createElement('div');
    top.className = 'slider-top';
    const label = document.createElement('span');
    label.className = 'slider-label';
    label.textContent = def.label;
    if (def.tag) {
      const tag = document.createElement('em');
      tag.style.cssText = 'font-style:normal;font-size:8.5px;letter-spacing:.06em;color:var(--accent);border:1px solid rgba(255,179,71,.45);border-radius:3px;padding:0 3px;';
      tag.textContent = def.tag;
      label.appendChild(tag);
    }
    const val = document.createElement('input');
    val.className = 'slider-val';
    val.type = 'text';
    val.spellcheck = false;
    val.value = String(def.def);
    top.append(label, val);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(def.min);
    range.max = String(def.max);
    range.step = String(def.step);
    range.value = String(def.def);

    row.append(top, range);
    const fmt = def.fmt || ((v) => (def.step >= 1 ? String(Math.round(v)) : Number(v).toFixed(2)));

    const setValue = (v, { fromSlider = false } = {}) => {
      const clamped = Math.max(def.min, Math.min(def.max, Number(v)));
      this.edits[def.key] = clamped;
      range.value = String(clamped);
      val.value = fmt(clamped);
      label.classList.toggle('dirty', Math.abs(clamped - def.def) > 0.0001);
      if (!fromSlider) range.classList.remove('active');
      this._onEditChanged({ fast: true });
    };

    range.addEventListener('pointerdown', () => range.classList.add('active'));
    range.addEventListener('pointerup', () => range.classList.remove('active'));
    range.addEventListener('input', () => setValue(range.value, { fromSlider: true }));
    range.addEventListener('change', () => {
      range.classList.remove('active');
      this.requestRender({ fast: false });
      this._persist();
    });
    val.addEventListener('change', () => {
      const n = Number(val.value.replace(/[^\d.+-]/g, ''));
      if (Number.isFinite(n)) setValue(n);
      else val.value = fmt(this.edits[def.key]);
      this.requestRender({ fast: false });
      this._persist();
    });
    val.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') val.blur();
      if (e.key === 'Escape') {
        val.value = fmt(this.edits[def.key]);
        val.blur();
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = e.shiftKey ? def.step * 10 : def.step;
        setValue(this.edits[def.key] + (e.key === 'ArrowUp' ? step : -step));
      }
    });
    for (const el of [label, val]) {
      el.addEventListener('dblclick', (e) => {
        e.preventDefault();
        setValue(def.def);
        this.requestRender({ fast: false });
        this._persist();
      });
    }

    this.sliders.set(def.key, { row, range, val, def, setValue });
    return row;
  }

  _buildCropGroup() {
    const holder = document.getElementById('group-crop');
    if (!holder) return;
    const rot = document.createElement('div');
    rot.className = 'crop-actions';
    rot.style.gridTemplateColumns = '1fr 1fr';
    const rotL = document.createElement('button');
    rotL.className = 'btn ghost';
    rotL.textContent = '⟲  90° left';
    rotL.addEventListener('click', () => this.rotate(-1));
    const rotR = document.createElement('button');
    rotR.className = 'btn ghost';
    rotR.textContent = '⟳  90° right';
    rotR.addEventListener('click', () => this.rotate(1));
    rot.append(rotL, rotR);

    const aspects = document.createElement('div');
    aspects.className = 'crop-actions';
    this._aspectButtons = [];
    for (const a of ASPECTS) {
      const btn = document.createElement('button');
      btn.className = 'btn ghost';
      btn.textContent = a.label;
      btn.dataset.aspect = String(a.value);
      btn.addEventListener('click', () => {
        this.cropAspect = a.value;
        for (const b of this._aspectButtons) b.classList.toggle('active', b === btn);
        if (this.cropMode) {
          this.cropRect = this._constrainCrop(this.cropRect, a.value);
          this._positionCropOverlay();
        }
        if (!this.cropMode) this.enterCrop();
      });
      this._aspectButtons.push(btn);
      aspects.appendChild(btn);
    }

    const actions = document.createElement('div');
    actions.className = 'crop-actions';
    actions.style.gridTemplateColumns = '1fr 1fr 1fr';
    this._cropBtn = document.createElement('button');
    this._cropBtn.className = 'btn ghost';
    this._cropBtn.textContent = 'Crop';
    this._cropBtn.addEventListener('click', () => (this.cropMode ? this.applyCrop() : this.enterCrop()));
    this._cropApplyBtn = document.createElement('button');
    this._cropApplyBtn.className = 'btn primary';
    this._cropApplyBtn.textContent = 'Apply';
    this._cropApplyBtn.hidden = true;
    this._cropApplyBtn.addEventListener('click', () => this.applyCrop());
    this._cropCancelBtn = document.createElement('button');
    this._cropCancelBtn.className = 'btn ghost';
    this._cropCancelBtn.textContent = 'Cancel';
    this._cropCancelBtn.hidden = true;
    this._cropCancelBtn.addEventListener('click', () => this.cancelCrop());
    document.getElementById('crop-apply-top')?.addEventListener('click', () => this.applyCrop());
    document.getElementById('crop-cancel-top')?.addEventListener('click', () => this.cancelCrop());
    document.getElementById('crop-reset')?.addEventListener('click', () => {
      this.cropRect = { x: 0, y: 0, w: 1, h: 1 };
      if (this.cropAspect > 0) this.cropRect = this._constrainCrop(this.cropRect, this.cropAspect);
      this._positionCropOverlay();
    });
    actions.append(this._cropBtn, this._cropCancelBtn, this._cropApplyBtn);

    const reset = document.createElement('button');
    reset.className = 'btn ghost';
    reset.textContent = 'Reset crop & rotation';
    reset.style.width = '100%';
    reset.addEventListener('click', () => {
      this.edits.rotation = 0;
      this.edits.crop = null;
      this.cropMode = false;
      this.cropRect = null;
      this.el.cropOverlay.hidden = true;
      this._syncCropButtons();
      this._applyCanvasSize();
      this.requestRender();
      this._persist();
    });

    const hint = document.createElement('div');
    hint.className = 'crop-hint';
    hint.textContent = 'Crop works in the rotated frame. Drag the frame to move, drag handles to resize.';

    holder.append(rot, aspects, actions, reset, hint);
  }

  _buildPresets() {
    const holder = document.getElementById('group-presets');
    if (!holder) return;
    const grid = document.createElement('div');
    grid.className = 'preset-grid';
    for (const p of PRESETS) {
      const btn = document.createElement('button');
      btn.className = 'preset';
      btn.innerHTML = `${p.name}<small>${p.note}</small>`;
      btn.addEventListener('click', () => this.applyPreset(p.patch));
      grid.appendChild(btn);
    }
    holder.appendChild(grid);
  }

  _bind() {
    this.el.back.addEventListener('click', () => this.close());
    this.el.before.addEventListener('click', () => this.toggleBefore());
    this.el.reset.addEventListener('click', () => this.resetEdits());
    this.el.exportBtn.addEventListener('click', () => this.openExport());
    this.el.flag.addEventListener('click', () => this.cycleFlag());
    for (const btn of this.el.rating.querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        const n = Number(btn.dataset.star);
        this.setRating(this.edits && this.entry && Number(this.entry.rating) === n ? 0 : n);
      });
    }

    document.getElementById('ed-rot-left').addEventListener('click', () => this.rotate(-1));
    document.getElementById('ed-rot-right').addEventListener('click', () => this.rotate(1));

    for (const btn of document.querySelectorAll('.section-head')) {
      btn.addEventListener('click', () => btn.closest('.panel-section').classList.toggle('collapsed'));
    }

    document.getElementById('zoom-in').addEventListener('click', () => this.zoomBy(1.4));
    document.getElementById('zoom-out').addEventListener('click', () => this.zoomBy(1 / 1.4));
    document.getElementById('zoom-fit').addEventListener('click', () => this.zoomToFit());
    document.getElementById('zoom-100').addEventListener('click', () => this.zoomToActual());

    // Pan + wheel zoom.
    const canvas = this.el.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      if (this.cropMode || e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
      this._drag = { x: e.clientX, y: e.clientY, pan: { ...this.pan } };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const fit = this._fitSize();
      const viewW = 1 / this.zoom;
      const viewH = 1 / this.zoom;
      const dx = (e.clientX - this._drag.x) / Math.max(1, fit.w);
      const dy = (e.clientY - this._drag.y) / Math.max(1, fit.h);
      this.pan.x = this._drag.pan.x - dx * viewW;
      this.pan.y = this._drag.pan.y - dy * viewH;
      this.requestRender({ fast: true });
    });
    const endDrag = () => {
      if (!this._drag) return;
      this._drag = null;
      canvas.classList.remove('dragging');
      this.requestRender({ fast: false });
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('dblclick', () => {
      if (this.cropMode) return;
      if (this.zoom > 1.05) this.zoomToFit();
      else this.zoomToActual();
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.cropMode) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const fx = (e.clientX - rect.left) / Math.max(1, rect.width);
        const fy = (e.clientY - rect.top) / Math.max(1, rect.height);
        const fit = this._fitSize();
        const out = this._outputDims();
        const viewW0 = 1 / this.zoom;
        const uvx = this._clamp01(0.5 - viewW0 / 2 + this.pan.x + fx * viewW0);
        const uvy = this._clamp01(0.5 - viewW0 / 2 + this.pan.y + fy * viewW0);
        const factor = Math.exp(-e.deltaY * 0.0016);
        const maxZoom = Math.max(1, (out.w / Math.max(1, fit.w)) * 8);
        this.zoom = this._clamp(this.zoom * factor, 1, maxZoom);
        const viewW1 = 1 / this.zoom;
        this.pan.x = uvx - fx * viewW1 - (0.5 - viewW1 / 2);
        this.pan.y = uvy - fy * viewW1 - (0.5 - viewW1 / 2);
        this.requestRender({ fast: true });
        this._finalizeSoon();
        this._upgradeSoon();
      },
      { passive: false },
    );

    this._initCropOverlay();
  }

  /* ------------------------------ open/close --------------------------- */

  async open(rel) {
    const entry = getPhoto(rel);
    if (!entry) return;
    this.entry = entry;
    this.rel = rel;
    this.edits = normalizeEdits(entry.edits);
    this.before = false;
    this.cropMode = false;
    this.cropRect = null;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.previewPixels = null;
    this._closeBitmap();
    this.el.cropOverlay.hidden = true;
    this._syncCropButtons();
    this.el.view.hidden = false;
    this.el.before.classList.remove('primary');
    this.el.before.textContent = 'Before';
    this._resetHistory();
    this._syncHeader();
    this._syncSliders();
    this._syncCropButtons();
    this.renderFilmstrip();
    this.setLoading(true, 'Loading photo…');
    const seq = ++this.openSeq;

    if (!this.pipeline) {
      this.setLoading(false);
      this._showBadge('WebGL 2 unavailable', true);
      toast('Cannot start the editor', this.pipelineError?.message || 'WebGL 2 is not available', 'error', 9000);
      return;
    }

    try {
      const info = await window.api.photo.open(rel);
      if (seq !== this.openSeq) return;
      this.info = info;
      this.srcW = info.width || 0;
      this.srcH = info.height || 0;

      if (info.kind === 'raw') {
        await this._loadRaw(info, entry, seq);
      } else {
        await this._loadBitmapFromUrl(info.url, seq);
        this.sourceMode = 'image';
        this._showBadge(extOf(entry.name) ? `${extOf(entry.name)}` : 'Image');
      }
      if (seq !== this.openSeq) return;
      if (!this.srcW || !this.srcH) throw new Error('Image has no dimensions');

      this.el.filename.textContent = entry.name;
      this.el.meta.textContent = metaLine(entry);
      this.el.rating.dataset.value = String(entry.rating || 0);
      this._syncRating(entry.rating || 0);
      this._syncFlag(entry.flag);
      this.el.filmstrip.querySelector(`[data-rel="${cssEscape(rel)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });

      this._applyCanvasSize();
      this.requestRender();
      this.setLoading(false);
    } catch (err) {
      if (seq !== this.openSeq) return;
      console.error('[editor] open failed', err);
      this.setLoading(false);
      this._showBadge('Failed to load', true);
      toast('Could not load photo', err.message, 'error', 8000);
    }
  }

  close() {
    this.openSeq++;
    this._persist.flush();
    this.el.view.hidden = true;
    this.rel = null;
    this._closeBitmap();
    this.previewPixels = null;
    this.pipeline?.clearSource();
    notify('editor-closed');
  }

  get isOpen() {
    return !this.el.view.hidden && !!this.rel;
  }

  async _loadRaw(info, entry, seq) {
    const el = this.el;
    this._showBadge('RAW · decoding…');
    let decoded = null;
    try {
      this.setLoading(true, 'Decoding RAW…');
      const buffer = await window.api.photo.read(this.rel);
      if (seq !== this.openSeq) return;
      decoded = await this.rawDecoder.decode(buffer, { halfSize: true, force: !!state.settings.rawForceDecode });
      if (seq !== this.openSeq) return;
      this.pipeline.setLinear16(decoded.data, decoded.width, decoded.height);
      this.previewPixels = { data: decoded.data, width: decoded.width, height: decoded.height };
      this.srcW = decoded.width;
      this.srcH = decoded.height;
      this.decodedHalf = true;
      this.sourceMode = 'raw';
      const note = decoded.meta?.normalized_model
        ? `${decoded.meta.camera_make || ''} ${decoded.meta.normalized_model} · demosaiced by LibRaw`.trim()
        : 'Demosaiced by LibRaw';
      this._showBadge(`RAW ${decoded.width}×${decoded.height}`);
      el.meta.title = note;
      this._persistRawMode('raw', note);
    } catch (err) {
      if (seq !== this.openSeq) return;
      const reason =
        err.code === 'HE_COMPRESSION'
          ? 'Nikon HE/HE* compression is not supported by the bundled LibRaw — editing the embedded full-size JPEG preview instead.'
          : `RAW decode failed (${err.message}). Using the embedded JPEG preview.`;
      console.warn('[editor] raw decode fallback:', err.code, err.message);
      try {
        await this._loadBitmapFromUrl(info.previewUrl, seq);
        if (seq !== this.openSeq) return;
        this.sourceMode = 'preview';
        this._showBadge(err.code === 'HE_COMPRESSION' ? 'HE/HE* preview' : 'Preview (RAW fallback)', true);
        el.meta.title = reason;
        this.el.meta.textContent = `${metaLine(entry)}`;
        this._persistRawMode('preview', this._shortReason(err));
      } catch (err2) {
        throw new Error(`RAW and preview decode both failed: ${err2.message}`);
      }
    }
  }

  _shortReason(err) {
    if (err.code === 'HE_COMPRESSION') return 'Nikon HE/HE* compression: LibRaw cannot demosaic this file, using embedded JPEG preview.';
    if (err.code === 'DECODE_INVALID') return 'LibRaw produced invalid pixels (camera model may be unsupported), using embedded JPEG preview.';
    return `RAW decode failed: ${err.message}. Using embedded JPEG preview.`;
  }

  _persistRawMode(mode, note) {
    this.rawMode = mode;
    this.rawNote = note;
    const prev = state.byRel.get(this.rel);
    if (prev?.rawMode === mode && prev?.rawNote === note) return;
    window.api.library
      .update(this.rel, { rawMode: mode, rawNote: note })
      .then((updated) => {
        if (updated) patchPhotoLocal(this.rel, { rawMode: mode, rawNote: note });
      })
      .catch((err) => console.warn('[editor] could not persist raw mode', err.message));
  }

  async _loadBitmapFromUrl(url, seq) {
    this.setLoading(true, 'Loading preview…');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load image (HTTP ${res.status})`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    if (seq !== this.openSeq || !this.pipeline) {
      bitmap.close?.();
      return;
    }
    this._closeBitmap();
    this.bitmap = bitmap;
    this.pipeline.setBitmap(bitmap);
    this.srcW = bitmap.width;
    this.srcH = bitmap.height;
    this.decodedHalf = false;
  }

  _closeBitmap() {
    if (this.bitmap) {
      try {
        this.bitmap.close?.();
      } catch {
        /* ignore */
      }
      this.bitmap = null;
    }
  }

  /* ------------------------------ view/render -------------------------- */

  _rotatedDims() {
    const r = ((Math.round(this.edits.rotation / 90) * 90) % 360 + 360) % 360;
    return r % 180 === 0 ? { w: this.srcW, h: this.srcH } : { w: this.srcH, h: this.srcW };
  }

  _effectiveCrop() {
    if (this.cropMode) return { x: 0, y: 0, w: 1, h: 1 };
    const c = this.edits.crop;
    if (!c) return { x: 0, y: 0, w: 1, h: 1 };
    return c;
  }

  _outputDims() {
    const rot = this._rotatedDims();
    const crop = this._effectiveCrop();
    return { w: Math.max(1, rot.w * crop.w), h: Math.max(1, rot.h * crop.h), rotW: rot.w, rotH: rot.h };
  }

  _fitSize() {
    const rect = this.el.wrap.getBoundingClientRect();
    const out = this._outputDims();
    const padX = 26;
    const padY = 26;
    const availW = Math.max(80, rect.width - padX * 2);
    const availH = Math.max(80, rect.height - padY * 2);
    const scale = Math.min(availW / out.w, availH / out.h);
    return { w: Math.max(80, out.w * scale), h: Math.max(80, out.h * scale), scale };
  }

  _applyCanvasSize() {
    const fit = this._fitSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const renderScale = Math.min(dpr, Math.sqrt(MAX_PREVIEW_PIXELS / Math.max(1, fit.w * fit.h)), 2);
    const cssW = Math.round(fit.w);
    const cssH = Math.round(fit.h);
    this.el.canvas.style.width = `${cssW}px`;
    this.el.canvas.style.height = `${cssH}px`;
    this.el.canvas.width = Math.max(2, Math.round(cssW * renderScale));
    this.el.canvas.height = Math.max(2, Math.round(cssH * renderScale));
    this.renderScale = Math.max(0.2, this.el.canvas.width / cssW);
    this._positionCropOverlay();
  }

  requestRender({ fast = false } = {}) {
    this.wantFast = this.wantFast || fast;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      const useFast = this.wantFast;
      this.wantFast = false;
      this._renderNow(useFast);
      if (useFast) this._finalizeSoon();
    });
  }

  _finalizeSoon() {
    clearTimeout(this.fastFinalTimer);
    this.fastFinalTimer = setTimeout(() => this.requestRender({ fast: false }), FINAL_DELAY);
  }

  _renderNow(fast) {
    if (!this.pipeline || !this.pipeline.source) return;
    if (!this.el.canvas.width || !this.el.canvas.height) return;
    const crop = this._effectiveCrop();
    const z = this.cropMode ? 1 : this.zoom;
    const viewW = 1 / z;
    const viewH = 1 / z;
    let vx = 0.5 - viewW / 2 + this.pan.x;
    let vy = 0.5 - viewH / 2 + this.pan.y;
    vx = this._clamp(vx, 0, Math.max(0, 1 - viewW));
    vy = this._clamp(vy, 0, Math.max(0, 1 - viewH));
    this.pan.x = vx - (0.5 - viewW / 2);
    this.pan.y = vy - (0.5 - viewH / 2);

    const map = {
      x: crop.x + vx * crop.w,
      y: crop.y + vy * crop.h,
      w: viewW * crop.w,
      h: viewH * crop.h,
    };
    const edits = this.before ? { ...DEFAULT_EDITS } : this.edits;
    try {
      this.pipeline.render({
        edits,
        map,
        rotation: this.edits.rotation,
        dpr: this.renderScale || 1,
        fast,
      });
    } catch (err) {
      console.error('[editor] render failed', err);
      this._showBadge('Render error', true);
      return;
    }
    this._updateZoomLabel();
    if (!fast) this._updateHistogramSoon();
  }

  _updateZoomLabel() {
    const out = this._outputDims();
    const fit = this._fitSize();
    const pct = Math.round((this.zoom * fit.w * 100) / Math.max(1, out.w));
    this.el.zoomLabel.textContent = this.cropMode ? 'Crop' : this.zoom <= 1.001 ? 'Fit' : `${pct}%`;
    document.getElementById('zoom-fit').classList.toggle('active', !this.cropMode && this.zoom <= 1.001);
    document.getElementById('zoom-100').classList.toggle('active', Math.abs(this.zoom - out.w / fit.w) < 0.05);
  }

  zoomBy(factor) {
    const fit = this._fitSize();
    const out = this._outputDims();
    const maxZoom = Math.max(1, (out.w / Math.max(1, fit.w)) * 8);
    this.zoom = this._clamp(this.zoom * factor, 1, maxZoom);
    this.requestRender();
    this._upgradeSoon();
  }

  zoomToFit() {
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.requestRender();
  }

  zoomToActual() {
    const fit = this._fitSize();
    const out = this._outputDims();
    this.zoom = this._clamp(out.w / Math.max(1, fit.w), 1, 40);
    this.requestRender();
    this._upgradeSoon();
  }

  /** At high zoom, re-decode RAW at full resolution for crisp 1:1 detail. */
  async _maybeUpgradeResolution() {
    if (this.sourceMode !== 'raw' || !this.decodedHalf || this.upgrading || this.exporting || !this.rel) return;
    const fit = this._fitSize();
    const out = this._outputDims();
    const pct = (this.zoom * fit.w) / Math.max(1, out.w);
    if (pct < 0.85) return;
    this.upgrading = true;
    const seq = this.openSeq;
    const rel = this.rel;
    try {
      this.setLoading(true, 'Loading full-resolution RAW…');
      const buf = await window.api.photo.read(rel);
      if (seq !== this.openSeq) return;
      const dec = await this.rawDecoder.decode(buf, { halfSize: false, force: !!state.settings.rawForceDecode });
      if (seq !== this.openSeq) return;
      this.pipeline.setLinear16(dec.data, dec.width, dec.height);
      this.srcW = dec.width;
      this.srcH = dec.height;
      this.decodedHalf = false;
      this.previewPixels = { data: dec.data, width: dec.width, height: dec.height };
      this._showBadge(`RAW ${dec.width}×${dec.height}`);
      this.requestRender({ fast: false });
    } catch (err) {
      console.warn('[editor] full-resolution upgrade failed:', err.message);
    } finally {
      if (seq === this.openSeq) this.setLoading(false);
      this.upgrading = false;
    }
  }

  _clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  _clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  _showBadge(text, warn = false) {
    this.el.badge.hidden = false;
    this.el.badge.textContent = text;
    this.el.badge.classList.toggle('warn', !!warn);
  }

  setLoading(on, text) {
    this.loading = !!on;
    this.el.loading.hidden = !on;
    if (text) this.el.loadingText.textContent = text;
  }

  /* ------------------------------ header/rating ------------------------ */

  _syncHeader() {
    const e = state.byRel.get(this.rel) || this.entry;
    if (!e) return;
    this.el.filename.textContent = e.name;
    this.el.meta.textContent = metaLine(e);
    this._syncRating(e.rating || 0);
    this._syncFlag(e.flag);
  }

  _syncRating(value) {
    const n = Number(value) || 0;
    for (const btn of this.el.rating.querySelectorAll('button')) {
      btn.classList.toggle('on', Number(btn.dataset.star) <= n);
    }
  }

  _syncFlag(flag) {
    const btn = this.el.flag;
    btn.classList.toggle('on', flag === 'picked');
    btn.classList.toggle('rejected', flag === 'rejected');
    btn.title = flag === 'picked' ? 'Picked (P)' : flag === 'rejected' ? 'Rejected (X)' : 'Neither';
  }

  async setRating(n) {
    if (!this.rel) return;
    this._syncRating(n);
    this.entry = { ...(this.entry || {}), rating: n };
    patchPhotoLocal(this.rel, { rating: n });
    try {
      const updated = await window.api.library.update(this.rel, { rating: n });
      if (updated) patchPhotoLocal(this.rel, updated);
    } catch (err) {
      toast('Could not save rating', err.message, 'error');
    }
    this.renderFilmstrip();
  }

  async cycleFlag() {
    if (!this.rel) return;
    const cur = state.byRel.get(this.rel)?.flag ?? this.entry?.flag;
    const next = cur === 'picked' ? 'rejected' : cur === 'rejected' ? 'none' : 'picked';
    await this.setFlag(next);
  }

  async setFlag(flag) {
    if (!this.rel) return;
    const value = flag === 'none' ? null : flag;
    this._syncFlag(value);
    this.entry = { ...(this.entry || {}), flag: value };
    patchPhotoLocal(this.rel, { flag: value });
    try {
      const updated = await window.api.library.update(this.rel, { flag: value });
      if (updated) patchPhotoLocal(this.rel, updated);
    } catch (err) {
      toast('Could not save flag', err.message, 'error');
    }
    this.renderFilmstrip();
  }

  /* ------------------------------ sliders/presets ---------------------- */

  _onEditChanged({ fast = true } = {}) {
    this.requestRender({ fast });
    this._persist();
    const dirty = editedKeys(this.edits);
    patchPhotoLocal(this.rel, { edits: { ...this.edits }, editSummary: Object.keys(dirty).length });
  }

  _syncSliders() {
    for (const [key, s] of this.sliders) {
      const v = Number(this.edits[key]);
      const def = s.def;
      s.range.value = String(v);
      s.val.value = (def.fmt || ((x) => (def.step >= 1 ? String(Math.round(x)) : Number(x).toFixed(2))))(v);
      s.row.querySelector('.slider-label').classList.toggle('dirty', Math.abs(v - def.def) > 0.0001);
    }
    this._syncCropButtons();
  }

  applyPreset(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (k in this.edits) this.edits[k] = clampEdit(k, v);
    }
    this._commitHistory();
    this._syncSliders();
    this.requestRender();
    this._persist();
    patchPhotoLocal(this.rel, { edits: { ...this.edits }, editSummary: Object.keys(editedKeys(this.edits)).length });
    toast('Preset applied', Object.keys(patch).slice(0, 4).join(', ') + (Object.keys(patch).length > 4 ? '…' : ''), 'info', 2200);
  }

  resetEdits() {
    this.edits = normalizeEdits(null);
    this.before = false;
    this.el.before.textContent = 'Before';
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.cropMode = false;
    this.el.cropOverlay.hidden = true;
    this._syncSliders();
    this._applyCanvasSize();
    this.requestRender();
    this._commitHistory();
    this._persist.flush();
    patchPhotoLocal(this.rel, { edits: { ...this.edits }, editSummary: 0 });
  }

  toggleBefore() {
    this.before = !this.before;
    this.el.before.textContent = this.before ? 'After' : 'Before';
    this.el.before.classList.toggle('primary', this.before);
    this.requestRender();
  }

  rotate(dir) {
    this.edits.rotation = (((this.edits.rotation + dir * 90) % 360) + 360) % 360;
    this.edits.crop = null;
    this.cropRect = null;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this._applyCanvasSize();
    this.requestRender();
    this._persist();
    patchPhotoLocal(this.rel, { edits: { ...this.edits } });
    this._commitHistory();
    this._syncCropButtons();
  }

  /* ------------------------------ history ------------------------------ */

  _resetHistory() {
    this.history = [JSON.stringify(this.edits)];
    this.historyIndex = 0;
  }

  _commitHistory() {
    const snap = JSON.stringify(this.edits);
    if (this.history[this.historyIndex] === snap) return;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(snap);
    if (this.history.length > 60) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  _applySnapshot(snap) {
    this.edits = normalizeEdits(JSON.parse(snap));
    this.cropMode = false;
    this.el.cropOverlay.hidden = true;
    this._syncCropButtons();
    this._syncSliders();
    this._applyCanvasSize();
    this.requestRender();
    this._persist();
    patchPhotoLocal(this.rel, { edits: { ...this.edits }, editSummary: Object.keys(editedKeys(this.edits)).length });
  }

  undo() {
    if (!this.rel || this.historyIndex <= 0) return toast('Nothing to undo', undefined, 'info', 1600);
    this.historyIndex--;
    this._applySnapshot(this.history[this.historyIndex]);
  }

  redo() {
    if (!this.rel || this.historyIndex >= this.history.length - 1) return toast('Nothing to redo', undefined, 'info', 1600);
    this.historyIndex++;
    this._applySnapshot(this.history[this.historyIndex]);
  }

  /* ------------------------------ persistence -------------------------- */

  async _saveEdits() {
    if (!this.rel) return;
    try {
      const updated = await window.api.library.update(this.rel, { edits: { ...this.edits } });
      if (updated) {
        patchPhotoLocal(this.rel, updated);
        this.entry = updated;
      }
      this._commitHistory();
    } catch (err) {
      console.warn('[editor] save failed', err.message);
      toast('Could not save edits', err.message, 'error');
    }
  }

  /* ------------------------------ histogram ---------------------------- */

  _drawHistogram() {
    const src = this.el.canvas;
    if (!src.width || !src.height) return;
    const w = 256;
    const h = Math.max(1, Math.round((w * src.height) / src.width));
    this.histSample.width = w;
    this.histSample.height = h;
    try {
      this.histCtx.drawImage(src, 0, 0, w, h);
    } catch {
      return;
    }
    let data;
    try {
      data = this.histCtx.getImageData(0, 0, w, h).data;
    } catch {
      return;
    }
    const bins = 64;
    const r = new Array(bins).fill(0);
    const g = new Array(bins).fill(0);
    const b = new Array(bins).fill(0);
    const l = new Array(bins).fill(0);
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let clipped = 0;
    const px = w * h;
    for (let i = 0; i < data.length; i += 4) {
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      r[(R * bins) >> 8]++;
      g[(G * bins) >> 8]++;
      b[(B * bins) >> 8]++;
      const L = (0.2126 * R + 0.7152 * G + 0.0722 * B) | 0;
      l[(L * bins) >> 8]++;
      sumR += R;
      sumG += G;
      sumB += B;
      if (R > 250 || G > 250 || B > 250) clipped++;
      else if (R < 4 && G < 4 && B < 4) clipped++;
    }
    const canvas = this.el.histogram;
    const ctx = canvas.getContext('2d');
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = 'lighter';
    const draw = (arr, color, alpha) => {
      const max = Math.max(1, ...arr.slice(1, bins - 1));
      ctx.beginPath();
      ctx.moveTo(0, ch);
      for (let i = 0; i < bins; i++) {
        const x = (i / (bins - 1)) * cw;
        const y = ch - Math.min(ch, (arr[i] / max) * (ch * 0.94));
        ctx.lineTo(x, y);
      }
      ctx.lineTo(cw, ch);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.fill();
    };
    draw(r, '#ff5a5a', 0.5);
    draw(g, '#4ad07a', 0.45);
    draw(b, '#5a8aff', 0.5);
    draw(l, '#ffffff', 0.22);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // thirds grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      const x = (cw * i) / 3;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ch);
    }
    ctx.stroke();

    this.el.histReadout.textContent = `R ${Math.round(sumR / px)}  G ${Math.round(sumG / px)}  B ${Math.round(sumB / px)}  ·  clipped ${((clipped / px) * 100).toFixed(1)}%`;
  }

  /* ------------------------------ filmstrip ---------------------------- */

  renderFilmstrip() {
    const strip = this.el.filmstrip;
    const list = visiblePhotos();
    const idx = list.findIndex((p) => p.rel === this.rel);
    if (!list.length) {
      strip.replaceChildren();
      return;
    }
    const start = Math.max(0, idx < 0 ? 0 : idx - 30);
    const end = Math.min(list.length, (idx < 0 ? 0 : idx) + 90);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const p = list[i];
      const item = document.createElement('div');
      item.className = 'film-item';
      item.dataset.rel = p.rel;
      item.title = p.name;
      if (p.rel === this.rel) item.classList.add('active');
      if (p.thumbUrl) {
        const img = document.createElement('img');
        img.src = p.thumbUrl;
        img.loading = 'lazy';
        img.draggable = false;
        item.appendChild(img);
      } else {
        item.innerHTML = '<div class="ph" style="display:grid;place-items:center;height:100%;color:#39404a">◻</div>';
      }
      if (p.editSummary > 0) {
        const b = document.createElement('span');
        b.className = 'fi-badge';
        b.textContent = 'Edited';
        item.appendChild(b);
      }
      item.addEventListener('click', () => this.open(p.rel));
      frag.appendChild(item);
    }
    strip.replaceChildren(frag);
    const active = strip.querySelector('.film-item.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  /* ------------------------------ crop --------------------------------- */

  _syncCropButtons() {
    if (!this._cropBtn) return;
    this._cropBtn.textContent = this.cropMode ? 'Cropping…' : 'Crop';
    this._cropBtn.classList.toggle('active', this.cropMode);
    this._cropApplyBtn.hidden = !this.cropMode;
    this._cropCancelBtn.hidden = !this.cropMode;
    this._cropBtn.hidden = this.cropMode;
    const hud = document.getElementById('crop-hud');
    if (hud) hud.hidden = !this.cropMode;
    const zoomHud = document.querySelector('#canvas-hud .hud-zoom');
    if (zoomHud) zoomHud.style.visibility = this.cropMode ? 'hidden' : '';
    for (const b of this._aspectButtons || []) {
      b.classList.toggle('active', Number(b.dataset.aspect) === this.cropAspect && this.cropMode);
    }
  }

  _initCropOverlay() {
    const overlay = this.el.cropOverlay;
    overlay.innerHTML = '';
    const shades = ['top', 'bottom', 'left', 'right'].map(() => {
      const d = document.createElement('div');
      d.className = 'shade';
      return d;
    });
    const rect = document.createElement('div');
    rect.className = 'crop-rect';
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const handle = document.createElement('div');
      handle.className = 'handle';
      handle.dataset.h = h;
      handle.addEventListener('pointerdown', (e) => this._startCropDrag(e, h));
      rect.appendChild(handle);
    }
    rect.addEventListener('pointerdown', (e) => {
      if (e.target !== rect) return;
      this._startCropDrag(e, 'move');
    });
    overlay.append(...shades, rect);
    this._cropEl = rect;
    this._cropShades = shades;
  }

  enterCrop() {
    if (!this.rel || this.cropMode) return;
    this._cropBackup = this.edits.crop ? { ...this.edits.crop } : null;
    this.cropRect = this.edits.crop ? { ...this.edits.crop } : { x: 0, y: 0, w: 1, h: 1 };
    if (this.cropAspect > 0) this.cropRect = this._constrainCrop(this.cropRect, this.cropAspect);
    this.cropMode = true;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.el.cropOverlay.hidden = false;
    this._syncCropButtons();
    this._applyCanvasSize();
    this.requestRender();
    this._positionCropOverlay();
    document.querySelector('.panel-section[data-section="crop"]')?.scrollIntoView({ block: 'nearest' });
  }

  applyCrop() {
    if (!this.cropMode) return;
    const r = this.cropRect || { x: 0, y: 0, w: 1, h: 1 };
    const full = r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999;
    this.edits.crop = full ? null : { ...r };
    this.cropMode = false;
    this.el.cropOverlay.hidden = true;
    this._syncCropButtons();
    this._applyCanvasSize();
    this.requestRender();
    this._commitHistory();
    this._persist();
    patchPhotoLocal(this.rel, { edits: { ...this.edits }, editSummary: Object.keys(editedKeys(this.edits)).length });
  }

  cancelCrop() {
    if (!this.cropMode) return;
    this.cropMode = false;
    this.cropRect = null;
    this.el.cropOverlay.hidden = true;
    this._syncCropButtons();
    this._applyCanvasSize();
    this.requestRender();
  }

  _startCropDrag(e, mode) {
    e.preventDefault();
    e.stopPropagation();
    if (!this.cropMode) return;
    const canvasRect = this.el.canvas.getBoundingClientRect();
    this._cropDrag = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      rect: { ...(this.cropRect || { x: 0, y: 0, w: 1, h: 1 }) },
      canvasRect,
    };
    const move = (ev) => this._moveCropDrag(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this._cropDrag = null;
      this._positionCropOverlay();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  _moveCropDrag(e) {
    const d = this._cropDrag;
    if (!d) return;
    const dx = (e.clientX - d.startX) / Math.max(1, d.canvasRect.width);
    const dy = (e.clientY - d.startY) / Math.max(1, d.canvasRect.height);
    let { x, y, w, h } = d.rect;
    const minSize = 0.04;
    const rot = this._rotatedDims();
    if (d.mode === 'move') {
      x = this._clamp(x + dx, 0, 1 - w);
      y = this._clamp(y + dy, 0, 1 - h);
    } else {
      let nx = x;
      let ny = y;
      let nw = w;
      let nh = h;
      if (d.mode.includes('w')) {
        nx = this._clamp(x + dx, 0, x + w - minSize);
        nw = x + w - nx;
      }
      if (d.mode.includes('e')) {
        nw = this._clamp(w + dx, minSize, 1 - x);
      }
      if (d.mode.includes('n')) {
        ny = this._clamp(y + dy, 0, y + h - minSize);
        nh = y + h - ny;
      }
      if (d.mode.includes('s')) {
        nh = this._clamp(h + dy, minSize, 1 - y);
      }
      if (this.cropAspect > 0) {
        // Keep pixel aspect: h_norm = w_norm * rotW / (aspect * rotH)
        const targetH = (nw * rot.w) / (this.cropAspect * rot.h);
        if (d.mode.includes('n')) {
          ny = y + h - targetH;
          nh = targetH;
        } else {
          nh = targetH;
        }
        if (ny < 0) {
          nh += ny;
          ny = 0;
        }
        if (ny + nh > 1) nh = 1 - ny;
        nw = (nh * this.cropAspect * rot.h) / rot.w;
        if (d.mode.includes('w')) nx = x + w - nw;
        if (nx < 0) {
          nw += nx;
          nx = 0;
        }
        if (nx + nw > 1) nw = 1 - nx;
      }
      x = nx;
      y = ny;
      w = nw;
      h = nh;
    }
    this.cropRect = {
      x: this._clamp(x, 0, 1),
      y: this._clamp(y, 0, 1),
      w: this._clamp(w, minSize, 1),
      h: this._clamp(h, minSize, 1),
    };
    this._positionCropOverlay();
  }

  _constrainCrop(rect, aspect) {
    const rot = this._rotatedDims();
    if (!aspect || aspect <= 0) return rect;
    let { x, y, w, h } = rect;
    // Fit the largest rect with the requested pixel aspect inside current rect.
    const cx = x + w / 2;
    const cy = y + h / 2;
    let nw = w;
    let nh = (nw * rot.w) / (aspect * rot.h);
    if (nh > 1) {
      nh = 1;
      nw = (nh * aspect * rot.h) / rot.w;
    }
    x = this._clamp(cx - nw / 2, 0, 1 - nw);
    y = this._clamp(cy - nh / 2, 0, 1 - nh);
    return { x, y, w: nw, h: nh };
  }

  _positionCropOverlay() {
    if (!this.cropMode || !this._cropEl) return;
    const canvasRect = this.el.canvas.getBoundingClientRect();
    const wrapRect = this.el.wrap.getBoundingClientRect();
    const left = canvasRect.left - wrapRect.left;
    const top = canvasRect.top - wrapRect.top;
    const W = canvasRect.width;
    const H = canvasRect.height;
    const c = this.cropRect || { x: 0, y: 0, w: 1, h: 1 };
    const rl = left + c.x * W;
    const rt = top + c.y * H;
    const rw = Math.max(8, c.w * W);
    const rh = Math.max(8, c.h * H);
    this._cropEl.style.left = `${rl}px`;
    this._cropEl.style.top = `${rt}px`;
    this._cropEl.style.width = `${rw}px`;
    this._cropEl.style.height = `${rh}px`;

    const [shadeTop, shadeBottom, shadeLeft, shadeRight] = this._cropShades;
    const fullW = Math.max(1, wrapRect.width);
    const fullH = Math.max(1, wrapRect.height);
    Object.assign(shadeTop.style, { left: '0px', top: '0px', width: `${fullW}px`, height: `${Math.max(0, rt)}px` });
    Object.assign(shadeBottom.style, { left: '0px', top: `${rt + rh}px`, width: `${fullW}px`, height: `${Math.max(0, fullH - (rt + rh))}px` });
    Object.assign(shadeLeft.style, { left: '0px', top: `${rt}px`, width: `${Math.max(0, rl)}px`, height: `${rh}px` });
    Object.assign(shadeRight.style, { left: `${rl + rw}px`, top: `${rt}px`, width: `${Math.max(0, fullW - (rl + rw))}px`, height: `${rh}px` });
  }

  /* ------------------------------ export ------------------------------- */

  async openExport() {
    if (!this.rel || this.exporting) return;
    const out = this._outputDims();
    const fullW = this.sourceMode === 'raw' && this.decodedHalf ? out.w * 2 : out.w;
    const fullH = this.sourceMode === 'raw' && this.decodedHalf ? out.h * 2 : out.h;
    let defaultDir = null;
    try {
      defaultDir = await window.api.exporter.defaultDir();
    } catch {
      defaultDir = null;
    }

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="field">
        <label>Format</label>
        <select id="ex-format">
          <option value="jpeg">JPEG (8-bit, best for sharing)</option>
          <option value="png">PNG (lossless)</option>
          <option value="tiff">TIFF (lossless, 8-bit)</option>
          <option value="webp">WebP</option>
        </select>
      </div>
      <div class="field" id="ex-quality-row">
        <label>Quality <span id="ex-quality-val" class="mono">92</span></label>
        <input type="range" id="ex-quality" min="40" max="100" step="1" value="92" />
      </div>
      <div class="field">
        <label>Resize (long edge, px — leave 0 for full resolution)</label>
        <input type="number" id="ex-size" min="0" max="30000" step="100" value="0" />
        <div class="hint">Full resolution for this photo: <b>${Math.round(fullW)} × ${Math.round(fullH)}</b> px (before any resize).</div>
      </div>
      <div class="field">
        <label>Filename template</label>
        <input type="text" id="ex-name" class="mono" value="&lt;filename&gt;" spellcheck="false" />
        <div class="hint">Tokens: &lt;filename&gt;, &lt;date&gt;, &lt;camera&gt;, &lt;seq:3&gt;, &lt;ext&gt; …</div>
      </div>
      <div class="field">
        <label>Folder</label>
        <div class="row">
          <input type="text" id="ex-dir" class="grow mono" value="${escapeAttr(defaultDir || '')}" />
          <button class="btn ghost" id="ex-browse">Browse…</button>
        </div>
      </div>
      <div class="hint" id="ex-mode">${this.sourceMode === 'preview' ? 'This RAW uses HE/HE* compression; export uses the embedded full-size JPEG preview (8-bit).' : this.sourceMode === 'raw' ? 'RAW will be re-decoded at full resolution for export.' : 'Editing and export use the original JPEG/PNG pixels.'}</div>
    `;

    const modal = openModal({
      title: `Export — ${this.entry?.name || ''}`,
      body,
      wide: true,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Export',
          kind: 'primary',
          onClick: async ({ close }) => {
            const format = body.querySelector('#ex-format').value;
            const quality = Number(body.querySelector('#ex-quality').value);
            const size = Number(body.querySelector('#ex-size').value) || 0;
            const name = body.querySelector('#ex-name').value.trim() || '<filename>';
            const dir = body.querySelector('#ex-dir').value.trim();
            close();
            await this.exportPhoto({ format, quality, size, name, dir });
          },
        },
      ],
    });

    const qualityRow = modal.body.querySelector('#ex-quality-row');
    const qualityVal = modal.body.querySelector('#ex-quality-val');
    const quality = modal.body.querySelector('#ex-quality');
    const syncQuality = () => {
      qualityVal.textContent = quality.value;
      const fmt = modal.body.querySelector('#ex-format').value;
      qualityRow.style.display = fmt === 'jpeg' || fmt === 'webp' ? '' : 'none';
    };
    modal.body.querySelector('#ex-format').addEventListener('change', syncQuality);
    quality.addEventListener('input', syncQuality);
    modal.body.querySelector('#ex-browse').addEventListener('click', async () => {
      const picked = await window.api.dialog.pickFolder({ title: 'Choose export folder', defaultPath: modal.body.querySelector('#ex-dir').value });
      if (picked) modal.body.querySelector('#ex-dir').value = picked;
    });
    syncQuality();
  }

  async exportPhoto({ format, quality, size, name, dir }) {
    if (!this.pipeline || !this.pipeline.source) return;
    this.exporting = true;
    this.setLoading(true, 'Preparing full resolution…');
    const seq = this.openSeq;
    let restored = false;
    try {
      let fullSource = null;
      if (this.sourceMode === 'raw' && this.decodedHalf) {
        this.setLoading(true, 'Re-decoding RAW at full resolution…');
        const buf = await window.api.photo.read(this.rel);
        fullSource = await this.rawDecoder.decode(buf, { halfSize: false, force: !!state.settings.rawForceDecode });
        if (seq !== this.openSeq) return;
        this.pipeline.setLinear16(fullSource.data, fullSource.width, fullSource.height);
        this.srcW = fullSource.width;
        this.srcH = fullSource.height;
        this.decodedHalf = false;
      }

      const canvas = this.el.canvas;
      const prevW = canvas.width;
      const prevH = canvas.height;
      const out = this._outputDims();
      const maxDim = this.pipeline.maxSize || 8192;
      let w = Math.round(out.w);
      let h = Math.round(out.h);
      if (size > 0) {
        const scale = Math.min((size / w), (size / h), 1);
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
      }
      if (w * h > 90_000_000) throw new Error(`Export is too large (${w}×${h}). Reduce the size or crop.`);
      if (w > maxDim || h > maxDim) throw new Error(`Image is larger than the GPU limit (${maxDim}px)`);

      this.setLoading(true, `Rendering ${w} × ${h}…`);
      canvas.width = w;
      canvas.height = h;
      this.pipeline.setSize(w, h);
      const crop = this._effectiveCrop();
      this.pipeline.render({
        edits: this.before ? { ...DEFAULT_EDITS } : this.edits,
        map: { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
        rotation: this.edits.rotation,
        dpr: 1,
        fast: false,
      });

      const mime = MIME[format] || 'image/jpeg';
      const blob = await this.pipeline.toBlob(mime, Math.max(1, Math.min(100, quality)) / 100);
      const data = await blob.arrayBuffer();
      this.setLoading(true, 'Writing file…');
      const result = await window.api.exporter.save({
        data,
        format,
        quality,
        dir: dir || null,
        filenameTemplate: name,
        resizeLongEdge: size > 0 ? size : 0,
        entry: this.entry,
      });

      // Restore interactive preview.
      canvas.width = prevW;
      canvas.height = prevH;
      this.pipeline.setSize(prevW, prevH);
      restored = true;
      await this._restorePreviewSource(fullSource);
      this.requestRender();
      toast('Exported', `${formatBytes(result.bytes)} → ${result.path}`, 'success', 9000);
    } catch (err) {
      console.error('[editor] export failed', err);
      toast('Export failed', err.message, 'error', 9000);
      if (!restored) {
        this._applyCanvasSize();
        await this._restorePreviewSource(null);
        this.requestRender();
      }
    } finally {
      this.exporting = false;
    this.upgrading = false;
      this.setLoading(false);
    }
  }

  async _restorePreviewSource(fullSource) {
    try {
      if (this.sourceMode === 'raw') {
        if (this.previewPixels) {
          this.pipeline.setLinear16(this.previewPixels.data, this.previewPixels.width, this.previewPixels.height);
          this.srcW = this.previewPixels.width;
          this.srcH = this.previewPixels.height;
          this.decodedHalf = this.previewPixels.width < (fullSource?.width ?? Infinity);
        } else {
          const buf = await window.api.photo.read(this.rel);
          const dec = await this.rawDecoder.decode(buf, { halfSize: true, force: !!state.settings.rawForceDecode });
          this.previewPixels = { data: dec.data, width: dec.width, height: dec.height };
          this.pipeline.setLinear16(dec.data, dec.width, dec.height);
          this.srcW = dec.width;
          this.srcH = dec.height;
          this.decodedHalf = true;
        }
      } else if (this.sourceMode === 'preview') {
        // Re-decode the preview to restore GPU texture (bitmap was kept).
        if (this.bitmap) this.pipeline.setBitmap(this.bitmap);
      } else if (this.bitmap) {
        this.pipeline.setBitmap(this.bitmap);
      }
    } catch (err) {
      console.warn('[editor] preview restore failed', err.message);
      this._applyCanvasSize();
    }
  }

  /* ------------------------------ keyboard helpers --------------------- */

  async step(dir) {
    const list = visiblePhotos();
    const idx = list.findIndex((p) => p.rel === this.rel);
    const next = list[idx + dir];
    if (next) await this.open(next.rel);
  }
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeHtml(s) {
  return escapeAttr(s);
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
