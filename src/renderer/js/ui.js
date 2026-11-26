/** Toasts + modal dialogs. */

import { escapeHtml } from './format.js';

let toastRoot;
let modalRoot;

function ensureRoots() {
  toastRoot = toastRoot || document.getElementById('toasts');
  modalRoot = modalRoot || document.getElementById('modal-root');
}

export function toast(title, body = '', kind = 'info', ms = 4200) {
  ensureRoots();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t-title">${escapeHtml(title)}</div>${body ? `<div class="t-body">${escapeHtml(body)}</div>` : ''}`;
  toastRoot.appendChild(el);
  const timer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s ease';
    setTimeout(() => el.remove(), 220);
  }, ms);
  el.addEventListener('click', () => {
    clearTimeout(timer);
    el.remove();
  });
  return el;
}

/**
 * Open a modal.
 * @param {{title:string, body:Node|string, actions?:Array<{label:string, kind?:string, value?:any, onClick?:Function}>, wide?:boolean}} opts
 * @returns {{close:Function, el:HTMLElement, value:Promise<any>}}
 */
export function openModal({ title, body, actions = [], wide = false, onClose } = {}) {
  ensureRoots();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  if (wide) modal.style.width = 'min(760px, 94vw)';

  const head = document.createElement('div');
  head.className = 'modal-head';
  head.innerHTML = `<h3>${escapeHtml(title || '')}</h3>`;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'icon-btn';
  closeBtn.textContent = '✕';
  head.appendChild(closeBtn);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'modal-body';
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);

  modal.append(head, bodyEl);

  let resolveValue;
  const value = new Promise((res) => (resolveValue = res));
  const close = (val) => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose(val);
    resolveValue(val);
  };

  if (actions.length) {
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.className = `btn ${action.kind || 'ghost'}`;
      btn.textContent = action.label;
      btn.addEventListener('click', async () => {
        if (action.onClick) {
          const keepOpen = await action.onClick({ close, body: bodyEl, value });
          if (keepOpen) return;
        }
        close(action.value);
      });
      foot.appendChild(btn);
    }
    modal.appendChild(foot);
  }

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(null);
    }
  };
  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', () => close(null));
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close(null);
  });

  backdrop.appendChild(modal);
  modalRoot.appendChild(backdrop);
  const focusable = modal.querySelector('input, select, button.primary');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { close, el: modal, value, body: bodyEl };
}

let activeMenu = null;

/** Lightweight right-click menu. items: [{label, hint, action} | 'sep'] */
export function showContextMenu(items, { x, y } = {}) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'ctx-item';
    if (item.disabled) row.style.opacity = '0.4';
    row.innerHTML = `<span>${escapeHtml(item.label)}</span>${item.hint ? `<span class="k">${escapeHtml(item.hint)}</span>` : ''}`;
    if (!item.disabled) {
      row.addEventListener('click', () => {
        closeContextMenu();
        item.action?.();
      });
    }
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.min(Math.max(6, x), window.innerWidth - rect.width - 8);
  const top = Math.min(Math.max(6, y), window.innerHeight - rect.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  activeMenu = menu;
  setTimeout(() => {
    const off = (e) => {
      if (!menu.contains(e.target)) {
        closeContextMenu();
        document.removeEventListener('mousedown', off, true);
      }
    };
    document.addEventListener('mousedown', off, true);
  }, 0);
  return menu;
}

export function closeContextMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

export function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title,
      body: `<div class="hint" style="font-size:12.5px;line-height:1.6;color:var(--text-2)">${escapeHtml(message)}</div>`,
      actions: [
        { label: cancelText, onClick: () => { resolve(false); close(false); } },
        { label: confirmText, kind: danger ? 'primary' : 'primary', onClick: () => { resolve(true); close(true); } },
      ],
      onClose: () => resolve(false),
    });
  });
}
