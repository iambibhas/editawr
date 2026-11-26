'use strict';

const { app, BrowserWindow, Menu, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const proto = require('./protocol');
const { Settings } = require('./settings');
const { Thumbs } = require('./thumbs');
const { Library } = require('./library');
const { DriveWatcher, eject } = require('./drives');
const { Importer } = require('./importer');
const { registerIpc, decorateEntry } = require('./ipc');
const { isRaw } = require('./metadata');

app.setName('EditAWr');
proto.registerSchemes();

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const isDev = process.argv.includes('--dev');
const isSmoke = process.argv.includes('--smoke');
const dataDirArg = process.argv.find((a) => a.startsWith('--data-dir='));
if (dataDirArg) {
  const dir = path.resolve(dataDirArg.slice('--data-dir='.length));
  fs.mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
}

const ctx = {
  app,
  win: null,
  settings: null,
  thumbs: null,
  library: null,
  drives: null,
  importer: new Importer(),
  devices: [],
  userData: null,
};

ctx.broadcast = (channel, payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
};

ctx.decorate = (entry) => (ctx.library ? decorateEntry(ctx.library, entry) : entry);

ctx.openLibrary = async (root, { scan = true } = {}) => {
  if (!root) throw new Error('No library path');
  const abs = path.resolve(root);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`Not a folder: ${abs}`);

  if (ctx.library) {
    try {
      ctx.library.removeAllListeners();
      await ctx.library.close();
    } catch {
      /* ignore */
    }
    ctx.library = null;
  }

  proto.allowRoot(abs);
  const lib = new Library({
    root: abs,
    userDataDir: ctx.userData,
    thumbs: ctx.thumbs,
    scanSubfolders: ctx.settings.get('scanSubfolders'),
    excludedFolders: ctx.settings.get('excludedFolders'),
    lazyThumbs: ctx.settings.get('lazyThumbs'),
    fastMetadata: ctx.settings.get('fastMetadata'),
    concurrency: ctx.settings.get('indexConcurrency') || 2,
  });
  await lib.open();
  ctx.library = lib;

  const recents = [abs, ...(ctx.settings.get('recentLibraries') || []).filter((p) => p !== abs)].slice(0, 8);
  ctx.settings.set({ libraryPath: abs, recentLibraries: recents });

  lib.on('snapshot', (photos) => ctx.broadcast('library:snapshot', photos.map(ctx.decorate)));
  lib.on('photo', (photo) => ctx.broadcast('library:photo', ctx.decorate(photo)));
  lib.on('progress', (p) => ctx.broadcast('library:progress', p));
  lib.on('scan:done', (s) => ctx.broadcast('library:scan-done', s));
  lib.on('scan:cancelled', (s) => ctx.broadcast('library:scan-cancelled', s));
  lib.on('scan:error', (e) => ctx.broadcast('library:scan-error', e));
  lib.on('scan:tip', (t) => ctx.broadcast('library:scan-tip', t));

  if (scan) {
    lib.scan().catch((err) => {
      console.error('[library] scan failed:', err);
      ctx.broadcast('library:scan-error', { error: err.message });
    });
  }

  return {
    root: lib.root,
    photos: lib.list().map(ctx.decorate),
    stats: lib.stats(),
  };
};

ctx.eject = async (mount) => {
  const result = await eject(mount);
  if (result.ok) setTimeout(() => ctx.drives.refresh({ force: true }).catch(() => {}), 1200);
  return result;
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1040,
    minHeight: 660,
    show: false,
    backgroundColor: '#0d0f12',
    title: 'EditAWr',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webgl: true,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://renderer/')) event.preventDefault();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] renderer gone:', details);
  });
  win.webContents.on('console-message', (event) => {
    const { level, message } = event;
    if (level === 'error' || level === 'warning' || isDev) console.log(`[renderer:${level}]`, message);
  });
  win.on('closed', () => {
    if (ctx.win === win) ctx.win = null;
  });

  win.loadURL('app://renderer/index.html');
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function buildMenu() {
  const send = (action, payload) => () => ctx.broadcast('menu:action', { action, payload });
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Library…', accelerator: 'CmdOrCtrl+O', click: send('open-library') },
        { label: 'Import from Card…', accelerator: 'CmdOrCtrl+Shift+I', click: send('import') },
        { type: 'separator' },
        { label: 'Export Photo…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { label: 'Rescan Library', accelerator: 'F5', click: send('rescan') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: send('redo') },
        { type: 'separator' },
        { label: 'Copy Settings', accelerator: 'CmdOrCtrl+Shift+C', click: send('copy-settings') },
        { label: 'Paste Settings', accelerator: 'CmdOrCtrl+Shift+V', click: send('paste-settings') },
        { label: 'Reset Photo', accelerator: 'CmdOrCtrl+Shift+R', click: send('reset-settings') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Grid', accelerator: 'G', click: send('view-grid') },
        { label: 'Loupe', accelerator: 'E', click: send('view-loupe') },
        { label: 'Before / After', accelerator: 'Backslash', click: send('toggle-before') },
        { type: 'separator' },
        { label: 'Fit to Screen', accelerator: 'CmdOrCtrl+0', click: send('zoom-fit') },
        { label: '100%', accelerator: 'CmdOrCtrl+1', click: send('zoom-100') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ role: 'toggleDevTools' }, { role: 'reload' }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Supported formats & RAW notes', click: send('help-formats') },
        { label: 'Keyboard shortcuts', click: send('help-shortcuts') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function bootstrap() {
  ctx.userData = app.getPath('userData');
  await fsp.mkdir(ctx.userData, { recursive: true });

  ctx.settings = new Settings(path.join(ctx.userData, 'settings.json'));
  await ctx.settings.load();

  const thumbDir = path.join(ctx.userData, 'thumbs');
  const previewDir = path.join(ctx.userData, 'previews');
  ctx.thumbs = new Thumbs({ thumbDir, previewDir });

  proto.install({ rendererRoot: RENDERER_ROOT, thumbDir, previewDir });
  proto.allowRoot(ctx.userData);

  registerIpc(ctx);
  buildMenu();

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // Images loaded via custom protocols are treated as secure, but keep mixed
  // content disabled explicitly.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^(?!app:|photo:|thumb:|blob:|data:|devtools:)/i.test(details.url)) {
      callback({ cancel: true });
      return;
    }
    callback({ cancel: false });
  });

  ctx.win = createWindow();

  ctx.drives = new DriveWatcher({
    intervalMs: 2500,
    onDevices: (devices) => {
      ctx.devices = devices;
      ctx.broadcast('drives:devices', devices);
    },
  });
  if (ctx.settings.get('autoDetectCards') !== false) {
    ctx.drives.start();
  } else {
    ctx.drives.stop();
    ctx.devices = [];
  }

  const libPath = ctx.settings.get('libraryPath');
  if (libPath && fs.existsSync(libPath)) {
    try {
      await ctx.openLibrary(libPath, { scan: true });
    } catch (err) {
      console.error('[library] could not open saved library:', err.message);
      ctx.settings.set({ libraryPath: null });
    }
  }

  setTimeout(() => ctx.thumbs.prune().catch((e) => console.error('[thumbs] prune failed:', e.message)), 4000);

  if (isSmoke) {
    const openRel = process.env.SMOKE_OPEN;
    if (openRel) {
      setTimeout(() => {
        ctx.win?.webContents
          .executeJavaScript(`window.__editawr && window.__editawr.openEditor(${JSON.stringify(openRel)})`)
          .catch((err) => console.error('[smoke] open failed', err));
      }, 2500);
    }
    const extraJs = process.env.SMOKE_JS;
    if (extraJs) {
      setTimeout(() => {
        ctx.win?.webContents.executeJavaScript(extraJs).catch((err) => console.error('[smoke] js failed', err));
      }, Number(process.env.SMOKE_JS_DELAY || 9000));
    }
    setTimeout(async () => {
      try {
        if (ctx.win) {
          const img = await ctx.win.capturePage();
          const out = path.join(process.cwd(), 'tmp', 'smoke.png');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, img.toPNG());
          console.log('[smoke] screenshot saved to', out);
        }
      } catch (err) {
        console.error('[smoke] screenshot failed', err);
      }
      app.quit();
    }, Number(process.env.SMOKE_MS || 12000));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (ctx.win) {
      if (ctx.win.isMinimized()) ctx.win.restore();
      ctx.win.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.editawr.app');
    await bootstrap();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) ctx.win = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async () => {
    try {
      if (ctx.library) await ctx.library.close();
      if (ctx.settings) await ctx.settings.save();
    } catch {
      /* best effort */
    }
  });
}

module.exports = { ctx };
