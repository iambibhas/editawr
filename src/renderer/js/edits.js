/** Non-destructive edit parameters + presets. Values are Lightroom-like. */

export const DEFAULT_EDITS = Object.freeze({
  // Light
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  // Color
  temp: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  // Presence
  clarity: 0,
  texture: 0,
  dehaze: 0,
  // Detail
  sharpenAmount: 40,
  sharpenRadius: 1.0,
  sharpenDetail: 25,
  sharpenMasking: 0,
  denoise: 0,
  denoiseDetail: 50,
  colorNR: 25,
  // Effects
  vignette: 0,
  grain: 0,
  // Geometry (90° steps + normalized crop in rotated space)
  rotation: 0,
  crop: null,
});

export const SLIDER_DEFS = {
  light: [
    { key: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.01, def: 0, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}` },
    { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, def: 0 },
    { key: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1, def: 0 },
    { key: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1, def: 0 },
    { key: 'whites', label: 'Whites', min: -100, max: 100, step: 1, def: 0 },
    { key: 'blacks', label: 'Blacks', min: -100, max: 100, step: 1, def: 0 },
  ],
  color: [
    { key: 'temp', label: 'Temperature', min: -100, max: 100, step: 1, def: 0 },
    { key: 'tint', label: 'Tint', min: -100, max: 100, step: 1, def: 0 },
    { key: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1, def: 0 },
    { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, def: 0 },
  ],
  detail: [
    { key: 'sharpenAmount', label: 'Sharpening', min: 0, max: 150, step: 1, def: 40 },
    { key: 'sharpenRadius', label: 'Radius', min: 0.3, max: 4, step: 0.1, def: 1.0, fmt: (v) => v.toFixed(1), sub: true },
    { key: 'sharpenDetail', label: 'Detail', min: 0, max: 100, step: 1, def: 25, sub: true },
    { key: 'sharpenMasking', label: 'Masking', min: 0, max: 100, step: 1, def: 0, sub: true },
    { key: 'denoise', label: 'Denoise', min: 0, max: 100, step: 1, def: 0, tag: 'AI' },
    { key: 'denoiseDetail', label: 'Denoise Detail', min: 0, max: 100, step: 1, def: 50, sub: true },
    { key: 'colorNR', label: 'Color Noise', min: 0, max: 100, step: 1, def: 25, sub: true },
  ],
  effects: [
    { key: 'clarity', label: 'Clarity', min: -100, max: 100, step: 1, def: 0 },
    { key: 'texture', label: 'Texture', min: -100, max: 100, step: 1, def: 0 },
    { key: 'dehaze', label: 'Dehaze', min: -100, max: 100, step: 1, def: 0 },
    { key: 'vignette', label: 'Vignette', min: -100, max: 100, step: 1, def: 0 },
    { key: 'grain', label: 'Grain', min: 0, max: 100, step: 1, def: 0 },
  ],
};

export const PRESETS = [
  { name: 'Natural', note: 'gentle baseline', patch: { contrast: 6, vibrance: 10, clarity: 4 } },
  { name: 'Punch', note: 'contrast + vibrance', patch: { contrast: 24, vibrance: 28, saturation: 6, clarity: 14, whites: 12, blacks: -10, sharpenAmount: 62 } },
  { name: 'Landscape', note: 'sky & foliage', patch: { highlights: -18, shadows: 14, vibrance: 26, clarity: 12, dehaze: 12, sharpenAmount: 55, sharpenMasking: 30 } },
  { name: 'Soft portrait', note: 'skin-friendly', patch: { contrast: -4, highlights: -12, shadows: 16, clarity: -12, texture: -12, vibrance: 8, sharpenAmount: 34, denoise: 22, denoiseDetail: 42, colorNR: 35 } },
  { name: 'High ISO', note: 'noise cleanup', patch: { denoise: 62, denoiseDetail: 48, colorNR: 62, sharpenAmount: 28, sharpenMasking: 55, contrast: 6, blacks: -6 } },
  { name: 'Monochrome', note: 'neutral B&W', patch: { saturation: -100, contrast: 18, clarity: 14, whites: 8, blacks: -10 } },
  { name: 'Warm film', note: 'temperature + grain', patch: { temp: 14, tint: 4, contrast: 10, highlights: -12, shadows: 10, saturation: -6, grain: 14, vignette: -10 } },
  { name: 'Cool matte', note: 'lifted blacks', patch: { temp: -12, contrast: -8, blacks: 18, whites: -8, vibrance: 6, saturation: -4 } },
];

export function normalizeEdits(raw) {
  const out = { ...DEFAULT_EDITS };
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'crop') {
        if (v && typeof v === 'object' && [v.x, v.y, v.w, v.h].every((n) => Number.isFinite(n))) {
          out.crop = { x: v.x, y: v.y, w: v.w, h: v.h };
        }
      } else if (k === 'rotation') {
        out.rotation = ((Math.round(Number(v) / 90) * 90) % 360 + 360) % 360;
      } else if (k in out && Number.isFinite(Number(v))) {
        out[k] = Number(v);
      }
    }
  }
  return out;
}

export function isEdited(edits) {
  if (!edits) return false;
  const e = normalizeEdits(edits);
  if (e.crop) return true;
  if (e.rotation % 360 !== 0) return true;
  for (const [k, v] of Object.entries(DEFAULT_EDITS)) {
    if (k === 'crop') continue;
    if (Math.abs(Number(e[k]) - Number(v)) > 0.0001) return true;
  }
  return false;
}

export function editedKeys(edits) {
  const e = normalizeEdits(edits);
  const dirty = {};
  for (const [k, v] of Object.entries(DEFAULT_EDITS)) {
    if (k === 'crop') {
      if (e.crop) dirty.crop = true;
      continue;
    }
    if (Math.abs(Number(e[k]) - Number(v)) > 0.0001) dirty[k] = true;
  }
  return dirty;
}

export function clampEdit(key, value) {
  const def = [...SLIDER_DEFS.light, ...SLIDER_DEFS.color, ...SLIDER_DEFS.detail, ...SLIDER_DEFS.effects].find((d) => d.key === key);
  if (!def) return value;
  return Math.max(def.min, Math.min(def.max, Number(value)));
}
