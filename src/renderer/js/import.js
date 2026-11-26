/** Import view: card/folder → library with a path template. */
import { state, notify } from './state.js';
import { toast } from './ui.js';
import { formatBytes, formatCount, formatDate, extOf, debounce, basename } from './format.js';
import { DATE_FORMATS, DEFAULT_DATE_FORMAT, formatDatePattern, normalizeDateFormat, isKnownDateFormat } from './dateformats.js';

const MAX_ROWS = 600;

export class ImportView {
  constructor() {
    this.root = document.getElementById('import-view');
    this.el = {
      sources: document.getElementById('import-sources'),
      sourceLabel: document.getElementById('import-source-label'),
      destLabel: document.getElementById('import-dest-label'),
      template: document.getElementById('import-template'),
      samples: document.getElementById('import-samples'),
      dup: document.getElementById('import-dup'),
      verify: document.getElementById('import-verify'),
      subdirs: document.getElementById('import-subdirs'),
      summary: document.getElementById('import-summary'),
      files: document.getElementById('import-files'),
      fill: document.getElementById('import-fill'),
      status: document.getElementById('import-status'),
      start: document.getElementById('import-start'),
      cancel: document.getElementById('import-cancel'),
      close: document.getElementById('import-close'),
      pickFolder: document.getElementById('import-pick-folder'),
      pickDest: document.getElementById('import-pick-dest'),
      dateFormat: document.getElementById('import-date-format'),
      dateCustom: document.getElementById('import-date-custom'),
      dateHint: document.getElementById('import-date-hint'),
    };
    this.source = null;
    this.sourceLabel = '';
    this.volume = null;
    this.inspected = null;
    this.plan = null;
    this.selected = new Set();
    this.busy = false;
    this.running = false;
    this.jobId = null;
    this.prepareSeq = 0;
    this.dateFormat = DEFAULT_DATE_FORMAT;

    this._populateDateFormats();
    this._bind();
    this._subscribe();
  }

  _bind() {
    this.el.close.addEventListener('click', () => (this.running ? this._confirmClose() : this.close()));
    this.el.pickFolder.addEventListener('click', () => this._pickFolder());
    this.el.pickDest.addEventListener('click', async () => {
      const res = await window.api.library.choose({ title: 'Choose your photo library folder' }).catch((e) => {
        toast('Could not open folder', e.message, 'error');
        return null;
      });
      if (res) {
        this._applyLibrary(res.root);
        this.el.destLabel.textContent = res.root;
        notify('library');
        this._prepare();
      }
    });
    this.el.template.addEventListener(
      'input',
      debounce(() => this._prepare(), 350),
    );
    this.el.template.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._prepare();
    });
    for (const el of [this.el.dup, this.el.verify, this.el.subdirs]) {
      el.addEventListener('change', () => this._prepare());
    }
    this.el.dateFormat.addEventListener('change', () => {
      const custom = this.el.dateFormat.value === 'custom';
      this.el.dateCustom.hidden = !custom;
      if (custom) this.el.dateCustom.focus();
      this._onDateFormatChanged();
    });
    this.el.dateCustom.addEventListener('input', debounce(() => this._onDateFormatChanged(), 350));
    this.el.start.addEventListener('click', () => this._run());
    this.el.cancel.addEventListener('click', () => this._cancel());

    window.api.importer.onProgress((p) => this._onProgress(p));
    window.api.importer.onDone((d) => this._onDone(d));
    window.api.importer.onPrepareProgress((p) => {
      if (!this.busy) return;
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      this.el.fill.style.width = `${pct}%`;
      this.el.status.textContent = `Reading metadata… ${p.done}/${p.total} (${pct}%)`;
    });
  }

  _subscribe() {
    notify('import:init');
  }

  get isOpen() {
    return !this.root.hidden;
  }

  async open(initial = {}) {
    this.root.hidden = false;
    this.running = false;
    this.jobId = null;
    this.el.start.disabled = true;
    this.el.cancel.hidden = true;
    this.el.fill.style.width = '0%';
    this.el.status.textContent = '';

    const settings = state.settings || (await window.api.settings.get());
    if (settings.importTemplate) this.el.template.value = settings.importTemplate;
    this.setDateFormat(settings.dateFormat || DEFAULT_DATE_FORMAT);
    this.el.dup.value = settings.duplicateMode || 'rename';
    this._applyLibrary(state.libraryRoot);
    this.renderSources();
    if (initial.source) await this.selectSource(initial.source);
    else if (this.volume) await this.selectVolume(this.volume);
    else this.el.sources.querySelector('.source-item')?.click();
  }

  _populateDateFormats() {
    const select = this.el.dateFormat;
    select.replaceChildren();
    for (const f of DATE_FORMATS) {
      const opt = document.createElement('option');
      opt.value = f.value;
      opt.textContent = f.label;
      select.appendChild(opt);
    }
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'Custom pattern…';
    select.appendChild(custom);
  }

  setDateFormat(fmt) {
    const norm = normalizeDateFormat(fmt);
    if (isKnownDateFormat(norm)) {
      this.el.dateFormat.value = norm;
      this.el.dateCustom.hidden = true;
    } else {
      this.el.dateFormat.value = 'custom';
      this.el.dateCustom.value = norm;
      this.el.dateCustom.hidden = false;
    }
    this.dateFormat = norm;
    this._updateDateHint();
  }

  dateFormatValue() {
    if (this.el.dateFormat.value === 'custom') {
      return normalizeDateFormat(this.el.dateCustom.value || DEFAULT_DATE_FORMAT);
    }
    return normalizeDateFormat(this.el.dateFormat.value);
  }

  _customDateFormatValid() {
    if (this.el.dateFormat.value !== 'custom') return true;
    const raw = String(this.el.dateCustom.value || '').trim();
    return /(YYYY|YY|MM|DD)/.test(raw) && !/[<>:"|?*]/.test(raw);
  }

  _updateDateHint() {
    const raw = this.el.dateFormat.value === 'custom' ? this.el.dateCustom.value.trim() : this.el.dateFormat.value;
    const valid = /(YYYY|YY|MM|DD)/.test(raw) && !/[<>:"|?*]/.test(raw);
    this.el.dateHint.textContent = valid
      ? `→ ${formatDatePattern(new Date(), raw)}`
      : 'Needs YYYY / MM / DD tokens';
    this.el.dateHint.style.color = valid ? '' : 'var(--red)';
  }

  _onDateFormatChanged() {
    this.dateFormat = this.dateFormatValue();
    this._updateDateHint();
    this._prepare();
  }

  _applyLibrary(root) {
    this.dest = root || state.libraryRoot || null;
    this.el.destLabel.textContent = this.dest || 'No library yet — choose a folder';
    this.el.start.disabled = !this.dest;
  }

  close() {
    this.root.hidden = true;
    document.getElementById('btn-import')?.blur();
  }

  async _confirmClose() {
    const ok = window.confirm('An import is running. Close the import view anyway?');
    if (ok) this.close();
  }

  renderSources() {
    const list = (state.drives || []).filter((d) => d.removable || d.hasDcim);
    const container = this.el.sources;
    container.replaceChildren();
    if (!list.length) {
      container.innerHTML = '<div class="side-empty">No card detected. Insert an SD card or choose a folder below.</div>';
    }
    for (const drive of list) {
      const el = document.createElement('div');
      el.className = 'source-item';
      el.dataset.mount = drive.mount;
      el.innerHTML = `
        <span class="dev-ico">▤</span>
        <span class="si-name">${drive.label || drive.mount}</span>
        <span class="si-sub">${drive.mount}${drive.mediaHint ? ` · ${formatCount(drive.mediaHint)} photos` : ''}</span>
      `;
      el.addEventListener('click', () => this.selectVolume(drive));
      container.appendChild(el);
    }
    if (this.source) {
      for (const el of container.children) el.classList.toggle('active', el.dataset.mount === this.volume?.mount);
    }
  }

  async selectVolume(drive) {
    this.volume = drive;
    this.renderSources();
    this.el.sourceLabel.textContent = `Inspecting ${drive.mount}…`;
    try {
      const info = await window.api.drives.inspect(drive.mount);
      this.inspected = info;
      const folders = info.folders || [];
      if (!folders.length) {
        this.el.sourceLabel.textContent = 'No photos found on this card';
        this.source = null;
        this.plan = null;
        this._renderEmpty('No photos found on this card.');
        return;
      }
      this.el.sourceLabel.textContent = '';
      this._renderFolderChoices(folders);
      await this.selectSource(folders[0].path);
    } catch (err) {
      toast('Could not read card', err.message, 'error');
      this.el.sourceLabel.textContent = '';
    }
  }

  _renderFolderChoices(folders) {
    const holder = document.createElement('div');
    holder.className = 'import-row';
    for (const f of folders) {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.textContent = `${f.name} (${f.count})`;
      btn.dataset.path = f.path;
      btn.addEventListener('click', () => this.selectSource(f.path));
      holder.appendChild(btn);
    }
    this.el.sources.appendChild(holder);
    this._folderButtons = [...holder.querySelectorAll('button')];
  }

  async selectSource(sourcePath) {
    this.source = sourcePath;
    this.el.sourceLabel.textContent = sourcePath;
    for (const btn of this._folderButtons || []) {
      btn.classList.toggle('active', btn.dataset.path === sourcePath);
    }
    await this._prepare();
  }

  async _pickFolder() {
    const dir = await window.api.drives.pickFolder().catch((e) => {
      toast('Could not choose folder', e.message, 'error');
      return null;
    });
    if (!dir) return;
    this.volume = null;
    this.renderSources();
    this.el.sourceLabel.textContent = dir;
    this._folderButtons = [];
    await this.selectSource(dir);
  }

  async _prepare() {
    if (!this.source || !this.dest) return;
    const seq = ++this.prepareSeq;
    this.busy = true;
    this.el.start.disabled = true;
    this.el.fill.style.width = '2%';
    this.el.status.textContent = 'Scanning files…';
    const template = this.el.template.value.trim();
    const dateFormatValid = this._customDateFormatValid();
    const dateFormat = this.dateFormatValue();
    try {
      const plan = await window.api.importer.prepare({
        source: this.source,
        dest: this.dest,
        template,
        dateFormat,
        duplicateMode: this.el.dup.value,
        includeSubdirs: this.el.subdirs.checked,
        verify: this.el.verify.checked,
      });
      if (seq !== this.prepareSeq) return;
      this.plan = plan;
      this._updateDateHint();
      if (!dateFormatValid) {
        this.el.dateHint.textContent = `Invalid pattern — using ${plan.dateFormat}`;
        this.el.dateHint.style.color = 'var(--red)';
      }
      if (dateFormatValid && (plan.template !== state.settings.importTemplate || plan.duplicateMode !== state.settings.duplicateMode || plan.dateFormat !== state.settings.dateFormat)) {
        window.api.settings.set({ importTemplate: plan.template, duplicateMode: plan.duplicateMode, dateFormat: plan.dateFormat }).catch(() => {});
        if (state.settings) {
          state.settings.importTemplate = plan.template;
          state.settings.duplicateMode = plan.duplicateMode;
          state.settings.dateFormat = plan.dateFormat;
        }
      }
      const keep = this.selected;
      this.selected = new Set(plan.items.filter((it) => it.selected && !it.error).map((it) => it.sourcePath));
      for (const path of keep) if (this.selected.has(path)) this.selected.add(path);
      this._renderPlan();
    } catch (err) {
      if (seq !== this.prepareSeq) return;
      this.plan = null;
      this.el.start.disabled = true;
      this.el.status.textContent = '';
      this.el.summary.innerHTML = `<span class="bad">${escapeHtml(err.message)}</span>`;
      this._renderEmpty('Fix the template or destination to continue.');
      toast('Could not prepare import', err.message, 'error');
    } finally {
      if (seq === this.prepareSeq) {
        this.busy = false;
        this.el.fill.style.width = '0%';
        this.el.status.textContent = '';
      }
    }
  }

  _renderEmpty(msg) {
    this.el.files.replaceChildren();
    const div = document.createElement('div');
    div.className = 'side-empty';
    div.style.padding = '18px';
    div.textContent = msg;
    this.el.files.appendChild(div);
    this.el.summary.textContent = msg;
  }

  _renderPlan() {
    const plan = this.plan;
    if (!plan) return;
    this.el.samples.replaceChildren();
    if (plan.errors.length) {
      const e = document.createElement('div');
      e.className = 'err';
      e.textContent = `${plan.errors.length} file(s) cannot be imported: ${plan.errors[0].error}`;
      this.el.samples.appendChild(e);
    }
    for (const sample of plan.samples) {
      const d = document.createElement('div');
      d.className = 's';
      d.innerHTML = `<span>→</span>${escapeHtml(sample)}`;
      this.el.samples.appendChild(d);
    }
    if (!plan.items.length) {
      this._renderEmpty('No supported images found in this folder.');
      return;
    }
    this._updateSummary();

    const frag = document.createDocumentFragment();
    for (const item of plan.items.slice(0, MAX_ROWS)) {
      const row = document.createElement('label');
      row.className = 'import-file';
      const checked = this.selected.has(item.sourcePath);
      if (!checked) row.classList.add('disabled');
      row.innerHTML = `
        <input type="checkbox" ${checked ? 'checked' : ''} ${item.error ? 'disabled' : ''} />
        <span class="fi-thumb">${extOf(item.sourcePath)}</span>
        <span class="fi-main">
          <span class="fi-name">${escapeHtml(basename(item.sourcePath))}</span>
          <span class="fi-target">${escapeHtml(item.error ? `⚠ ${item.error}` : item.targetRel || '—')}${item.exists ? ' <span class="fi-warn">· exists</span>' : ''}</span>
        </span>
        <span class="fi-date">${item.meta?.capturedAt ? escapeHtml(formatDate(item.meta.capturedAt, { withTime: false })) : ''}</span>
      `;
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) this.selected.add(item.sourcePath);
        else this.selected.delete(item.sourcePath);
        row.classList.toggle('disabled', !cb.checked);
        this._updateSummary();
      });
      frag.appendChild(row);
    }
    if (plan.items.length > MAX_ROWS) {
      const more = document.createElement('div');
      more.className = 'import-file';
      more.innerHTML = `<span class="muted">Showing first ${MAX_ROWS} of ${formatCount(plan.items.length)} files — all selected files will be imported.</span>`;
      frag.appendChild(more);
    }
    this.el.files.replaceChildren(frag);
  }

  _updateSummary() {
    const plan = this.plan;
    if (!plan) return;
    const selectedItems = plan.items.filter((it) => this.selected.has(it.sourcePath));
    const bytes = selectedItems.reduce((n, it) => n + (it.size || 0), 0);
    const existing = selectedItems.filter((it) => it.exists).length;
    const inBatch = selectedItems.filter((it) => it.duplicateInBatch).length;
    const space = plan.stats;
    const parts = [
      `<b>${formatCount(selectedItems.length)}</b> of ${formatCount(plan.items.length)} photos selected`,
      `<b>${formatBytes(bytes)}</b> to copy`,
    ];
    if (existing) parts.push(`<span class="warn">${existing} already exist</span>`);
    if (inBatch) parts.push(`<span class="warn">${inBatch} target collision(s) in this batch</span>`);
    if (space.enoughSpace === false) parts.push(`<span class="bad">Not enough free space (${space.freeSpaceText} free)</span>`);
    else if (space.freeSpaceText) parts.push(`${space.freeSpaceText} free at destination`);
    if (plan.errors.length) parts.push(`<span class="bad">${plan.errors.length} error(s)</span>`);
    this.el.summary.innerHTML = parts.join(' · ');
    this.el.start.disabled = !selectedItems.length || this.running;
  }

  async _run() {
    if (!this.plan || this.running) return;
    const items = this.plan.items.map((it) => ({ ...it, selected: this.selected.has(it.sourcePath) }));
    const plan = { ...this.plan, items };
    this.running = true;
    this.el.start.disabled = true;
    this.el.cancel.hidden = false;
    this.el.fill.style.width = '0%';
    this.el.status.textContent = 'Starting…';
    try {
      const res = await window.api.importer.run(plan);
      this.jobId = res.jobId;
      this.el.status.textContent = `Copying ${formatCount(res.total)} files…`;
    } catch (err) {
      this.running = false;
      this.el.cancel.hidden = true;
      this.el.start.disabled = false;
      toast('Import failed', err.message, 'error');
    }
  }

  _cancel() {
    if (this.jobId) window.api.importer.cancel(this.jobId).catch(() => {});
    this.el.status.textContent = 'Cancelling…';
  }

  _onProgress(p) {
    if (!this.running) return;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    this.el.fill.style.width = `${pct}%`;
    this.el.status.textContent = `${p.done}/${p.total} · ${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}${p.failed ? ` · ${p.failed} failed` : ''}`;
  }

  _onDone(result) {
    this.running = false;
    this.jobId = null;
    this.el.cancel.hidden = true;
    this.el.start.disabled = false;
    const failed = result.failed?.length || 0;
    this.el.status.textContent = `Done — ${result.copied} copied in ${(result.ms / 1000).toFixed(1)}s`;
    this.el.fill.style.width = '100%';
    if (failed) {
      toast('Import finished with errors', `${result.copied} copied, ${failed} failed: ${result.failed[0].error}`, 'error', 9000);
    } else {
      toast('Import complete', `${result.copied} photos copied${result.skipped ? `, ${result.skipped} skipped` : ''}.`, 'success');
    }
    this.plan = null;
    this._prepare();
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
