'use strict';

/**
 * The only bridge between the renderer and Node. No `require`, no `fs`, no
 * arbitrary IPC: each method maps to a validated main-process handler.
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res) return null;
  if (res.ok === false) throw new Error(res.error || 'Operation failed');
  return res.data;
};

const subscribe = (channel, cb) => {
  const listener = (_event, payload) => {
    try {
      cb(payload);
    } catch (err) {
      console.error(`[api:${channel}] listener failed`, err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  app: {
    info: () => invoke('app:info'),
    version: () => invoke('app:info').then((i) => i.version),
    openPath: (p) => invoke('shell:openPath', p),
    showItem: (p) => invoke('shell:showItem', p),
    openExternal: (url) => invoke('shell:openExternal', url),
    onMenu: (cb) => subscribe('menu:action', cb),
    onWindowState: (cb) => subscribe('window:state', cb),
  },

  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    onChanged: (cb) => subscribe('settings:changed', cb),
  },

  dialog: {
    pickFolder: (opts) => invoke('dialog:pickFolder', opts),
  },

  library: {
    open: (p) => invoke('library:open', { path: p }),
    choose: (opts) => invoke('library:choose', opts),
    state: () => invoke('library:state'),
    scan: () => invoke('library:scan'),
    cancelScan: () => invoke('library:cancel-scan'),
    stats: () => invoke('library:stats'),
    tree: () => invoke('library:tree'),
    update: (rel, patch) => invoke('library:update', { rel, patch }),
    removeMissing: () => invoke('library:removeMissing'),
    reveal: (rel) => invoke('library:reveal', { rel }),
    onSnapshot: (cb) => subscribe('library:snapshot', cb),
    onPhoto: (cb) => subscribe('library:photo', cb),
    onProgress: (cb) => subscribe('library:progress', cb),
    onScanDone: (cb) => subscribe('library:scan-done', cb),
    onScanCancelled: (cb) => subscribe('library:scan-cancelled', cb),
    onScanTip: (cb) => subscribe('library:scan-tip', cb),
    onScanError: (cb) => subscribe('library:scan-error', cb),
    onStats: (cb) => subscribe('library:stats', cb),
  },

  thumbs: {
    ensure: (rel, px) => invoke('thumbs:ensure', { rel, px }),
  },

  photo: {
    open: (rel) => invoke('photo:open', { rel }),
    read: (rel) => invoke('photo:read', { rel }),
    preview: (rel, maxEdge) => invoke('photo:preview', { rel, maxEdge }),
    metadata: (rel) => invoke('photo:metadata', { rel }),
  },

  drives: {
    list: () => invoke('drives:list'),
    inspect: (mount) => invoke('drives:inspect', { mount }),
    eject: (mount) => invoke('drives:eject', { mount }),
    refresh: () => invoke('drives:refresh'),
    pickFolder: () => invoke('drives:pickFolder'),
    onDevices: (cb) => subscribe('drives:devices', cb),
  },

  importer: {
    prepare: (opts) => invoke('import:prepare', opts),
    run: (plan) => invoke('import:run', { plan }),
    cancel: (jobId) => invoke('import:cancel', { jobId }),
    onPrepareProgress: (cb) => subscribe('import:prepare-progress', cb),
    onProgress: (cb) => subscribe('import:progress', cb),
    onDone: (cb) => subscribe('import:done', cb),
  },

  exporter: {
    save: (opts) => invoke('export:save', opts),
    defaultDir: () => invoke('export:defaultDir'),
  },

  cache: {
    info: () => invoke('cache:info'),
    clear: () => invoke('cache:clear'),
  },
});
