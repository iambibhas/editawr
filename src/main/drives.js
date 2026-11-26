'use strict';

/**
 * Removable-media detection (SD cards, CFexpress readers, USB drives).
 *
 * Windows: every mounted volume is enumerated through WMI (fast enough on
 * change) and probed for a DCIM folder. Polling itself is extremely cheap:
 * we only test whether drive letters still exist, so an SD card insertion is
 * noticed within ~2 seconds without spawning PowerShell each tick.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { walkFiles } = require('./util');
const { isImage } = require('./metadata');

const IMAGE_PROBE_LIMIT = 4000;

function exec(cmd, args, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve(stdout);
    });
  });
}

async function countImages(dir, limit = 5000) {
  let count = 0;
  try {
    for await (const file of walkFiles(dir, { maxDepth: 6, maxFiles: limit })) {
      if (isImage(file)) count++;
      if (count >= limit) break;
    }
  } catch {
    /* ignore */
  }
  return count;
}

async function dirExists(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/* ------------------------------- Windows -------------------------------- */

function driveLetters() {
  const letters = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    try {
      fs.statSync(`${letter}:\\`);
      letters.push(letter);
    } catch {
      /* not mounted / no media */
    }
  }
  return letters;
}

async function windowsVolumes() {
  const ps = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName,FileSystem,Size,FreeSpace,VolumeSerialNumber | ConvertTo-Json -Compress',
  ];
  let raw;
  try {
    raw = await exec('powershell.exe', ps);
  } catch (err) {
    // Fallback: at least expose the drive letters we can stat.
    return driveLetters().map((l) => ({
      mount: `${l}:\\`,
      label: `${l}:`,
      size: null,
      free: null,
      removable: false,
      driveType: null,
    }));
  }
  raw = String(raw).trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((v) => v && typeof v.DeviceID === 'string' && /^[A-Z]:$/.test(v.DeviceID))
    .map((v) => ({
      mount: `${v.DeviceID}\\`,
      label: v.VolumeName || `${v.DeviceID}\\`,
      size: Number(v.Size) || null,
      free: Number(v.FreeSpace) || null,
      removable: Number(v.DriveType) === 2,
      driveType: Number(v.DriveType),
      fs: v.FileSystem || null,
      serial: v.VolumeSerialNumber || null,
    }));
}

/* -------------------------------- Linux --------------------------------- */

async function linuxVolumes() {
  let raw;
  try {
    raw = await exec('lsblk', ['-J', '-b', '-o', 'NAME,LABEL,MOUNTPOINT,RM,TYPE,SIZE,FSTYPE,TRAN']);
  } catch {
    raw = null;
  }
  const out = [];
  const add = (dev, parentRemovable = false) => {
    if (!dev || !dev.mountpoint) return;
    if (!['part', 'disk', 'crypt'].includes(dev.type || '')) return;
    const removable = dev.rm === true || dev.rm === 1 || parentRemovable || dev.tran === 'usb';
    out.push({
      mount: dev.mountpoint,
      label: dev.label || path.basename(dev.mountpoint),
      size: Number(dev.size) || null,
      free: null,
      removable,
      driveType: removable ? 2 : 3,
    });
  };
  if (raw) {
    try {
      const json = JSON.parse(raw);
      for (const dev of json.blockdevices || []) {
        add(dev, dev.rm === true || dev.rm === 1 || dev.tran === 'usb');
        for (const child of dev.children || []) {
          add(child, dev.rm === true || dev.rm === 1 || dev.tran === 'usb');
          for (const grand of child.children || []) add(grand, dev.rm === true || dev.rm === 1);
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (!out.length) {
    for (const base of ['/media', `/run/media/${process.env.USER || ''}`, '/mnt']) {
      try {
        for (const entry of await fsp.readdir(base, { withFileTypes: true })) {
          if (entry.isDirectory()) out.push({ mount: path.join(base, entry.name), label: entry.name, size: null, free: null, removable: true, driveType: 2 });
        }
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/* -------------------------------- macOS --------------------------------- */

async function macVolumes() {
  const out = [];
  try {
    for (const entry of await fsp.readdir('/Volumes', { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mount = path.join('/Volumes', entry.name);
      let info = null;
      try {
        const plist = await exec('diskutil', ['info', '-plist', mount], { timeout: 8000 });
        const internal = /<key>Internal<\/key>\s*<true\/>/.test(plist);
        const removable = /<key>RemovableMedia<\/key>\s*<true\/>/.test(plist);
        const ejectable = /<key>Ejectable<\/key>\s*<true\/>/.test(plist);
        const mountPoint = /<key>MountPoint<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
        const totalSize = /<key>TotalSize<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist);
        info = {
          internal,
          removable: removable || ejectable || !internal,
          size: totalSize ? Number(totalSize[1]) : null,
          mount: mountPoint ? mountPoint[1] : mount,
        };
      } catch {
        /* ignore */
      }
      // Skip the boot volume.
      if (mount === '/Volumes/' || entry.name === 'Macintosh HD') continue;
      out.push({
        mount: info?.mount || mount,
        label: entry.name,
        size: info?.size ?? null,
        free: null,
        removable: info ? info.removable : true,
        driveType: info?.removable === false ? 3 : 2,
      });
    }
  } catch {
    /* ignore */
  }
  return out;
}

/* ---------------------------------------------------------------- */

class DriveWatcher {
  constructor({ intervalMs = 2500, onDevices } = {}) {
    this.intervalMs = intervalMs;
    this.onDevices = onDevices || (() => {});
    this.timer = null;
    this.lastSignature = null;
    this.lastDevices = [];
    this.refreshing = null;
    this.stopped = true;
  }

  signatureNow() {
    if (process.platform === 'win32') return driveLetters().join('');
    if (process.platform === 'darwin') {
      try {
        return fs.readdirSync('/Volumes').sort().join('|');
      } catch {
        return '';
      }
    }
    try {
      return fs.readFileSync('/proc/mounts', 'utf8').split('\n').length + ':' + fs.statSync('/media').mtimeMs;
    } catch {
      return '';
    }
  }

  async list() {
    let volumes;
    if (process.platform === 'win32') volumes = await windowsVolumes();
    else if (process.platform === 'darwin') volumes = await macVolumes();
    else volumes = await linuxVolumes();

    const devices = [];
    for (const v of volumes) {
      if (!v.mount) continue;
      const dcim = await dirExists(path.join(v.mount, 'DCIM'));
      let mediaHint = 0;
      if (dcim) {
        try {
          mediaHint = await countImages(path.join(v.mount, 'DCIM'), IMAGE_PROBE_LIMIT);
        } catch {
          mediaHint = 0;
        }
      }
      devices.push({
        id: v.mount,
        mount: v.mount,
        label: v.label,
        size: v.size,
        free: v.free,
        removable: !!v.removable,
        driveType: v.driveType ?? null,
        hasDcim: dcim,
        mediaHint,
        kind: dcim || v.removable ? 'card' : 'volume',
      });
    }
    // Cards first, then other removable, then fixed volumes.
    devices.sort((a, b) => {
      const score = (d) => (d.hasDcim ? 0 : d.removable ? 1 : 2);
      return score(a) - score(b) || String(a.mount).localeCompare(String(b.mount));
    });
    return devices;
  }

  async refresh({ force = false } = {}) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const devices = await this.list();
      const sig = devices.map((d) => `${d.mount}:${d.mediaHint}:${d.removable}`).join('|');
      if (force || sig !== this.lastSignature) {
        this.lastSignature = sig;
        this.lastDevices = devices;
        this.onDevices(devices);
      }
      return devices;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.mountSignature = this.signatureNow();
    this.refresh({ force: true }).catch(() => {});
    this.timer = setInterval(() => {
      if (this.stopped) return;
      const sig = this.signatureNow();
      if (sig !== this.mountSignature) {
        this.mountSignature = sig;
        this.refresh().catch(() => {});
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }

  async inspect(mount) {
    const folders = [];
    const root = await dirExists(path.join(mount, 'DCIM')) ? path.join(mount, 'DCIM') : mount;
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return { mount, root, folders: [] };
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);
      const count = await countImages(dir, IMAGE_PROBE_LIMIT);
      if (count > 0) folders.push({ path: dir, name: entry.name, count });
    }
    // Cards may keep photos at the root too.
    if (!folders.length) {
      const count = await countImages(root, IMAGE_PROBE_LIMIT);
      if (count > 0) folders.push({ path: root, name: path.basename(root), count });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { mount, root, folders, total: folders.reduce((n, f) => n + f.count, 0) };
  }
}

async function eject(mount) {
  try {
    if (process.platform === 'win32') {
      const letter = mount.replace(/[\\/]+$/, '');
      const ps = [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$sh = New-Object -ComObject Shell.Application; $item = $sh.Namespace(17).ParseName('${letter}\'); if ($item) { $item.InvokeVerb('Eject'); 'ok' } else { 'not-found' }`,
      ];
      const out = await exec('powershell.exe', ps, { timeout: 15000 });
      return { ok: String(out).includes('ok') };
    }
    if (process.platform === 'darwin') {
      await exec('diskutil', ['eject', mount], { timeout: 20000 });
      return { ok: true };
    }
    await exec('udisksctl', ['unmount', '-b', mount], { timeout: 20000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { DriveWatcher, driveLetters, eject };
