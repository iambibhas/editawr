/**
 * RAW decode worker (LibRaw compiled to WebAssembly).
 *
 * Runs in a dedicated module worker: LibRaw itself also spawns an internal
 * worker, so the UI thread never blocks. Returns a linear 16-bit RGB buffer
 * which is uploaded as a WebGL2 integer texture by the editor.
 *
 * Note on Nikon HE/HE*: LibRaw cannot demosaic those files yet. We detect it
 * from the makernote (NEFCompression >= 12) and fail fast so the editor can
 * fall back to the embedded full-size JPEG preview.
 */
import LibRaw from '../vendor/libraw/index.js';

function summarizeMeta(meta) {
  if (!meta) return null;
  return {
    width: meta.width,
    height: meta.height,
    raw_width: meta.raw_width,
    raw_height: meta.raw_height,
    flip: meta.flip,
    camera_make: meta.camera_make,
    camera_model: meta.camera_model,
    iso: meta.iso_speed,
    shutter: meta.shutter,
    aperture: meta.aperture,
    focal: meta.focal_len,
    timestamp: meta.timestamp,
    normalized_model: meta.normalized_model,
    thumb: [meta.thumb_width, meta.thumb_height],
    nefCompression: meta?.nikon?.NEFCompression ?? null,
  };
}

function sampleStats(data, channels) {
  const total = data.length / channels;
  const stepPx = Math.max(1, Math.floor(total / 250000));
  let min = 65535;
  let max = 0;
  let sum = 0;
  let clipped = 0;
  let n = 0;
  for (let p = 0; p < total; p += stepPx) {
    const i = p * channels;
    for (let c = 0; c < Math.min(3, channels); c++) {
      const v = data[i + c];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      if (v >= 65535) clipped++;
    }
    n += Math.min(3, channels);
  }
  return { min, max, mean: Math.round(sum / Math.max(1, n)), clipped: clipped / Math.max(1, n) };
}

self.onmessage = async (event) => {
  const { id, buffer, options = {} } = event.data || {};
  if (!id) return;
  const started = performance.now();
  let raw = null;
  let meta = null;

  try {
    raw = new LibRaw();
    await raw.open(new Uint8Array(buffer), {
      useCameraWb: true,
      useCameraMatrix: 1,
      outputBps: 16,
      outputColor: 1,
      userQual: 3,
      halfSize: !!options.halfSize,
      gamm: [1, 1],
      noAutoBright: false,
      highlight: 0,
      fbddNoiserd: 0,
      medPasses: 0,
      greenMatching: true,
    });

    meta = await raw.metadata(true);
    const compression = Number(meta?.nikon?.NEFCompression);
    if (Number.isFinite(compression) && compression >= 12 && !options.force) {
      self.postMessage({
        id,
        ok: false,
        code: 'HE_COMPRESSION',
        error: 'This NEF uses Nikon HE/HE* compression, which LibRaw cannot demosaic yet.',
        meta: summarizeMeta(meta),
      });
      return;
    }

    const img = await raw.imageData();
    if (!img || !img.width || !img.height || !img.data || !img.data.length) {
      throw Object.assign(new Error('LibRaw returned no image data'), { code: 'DECODE_EMPTY' });
    }

    const stats = sampleStats(img.data, img.colors || 3);
    if (stats.max < 512 || stats.clipped > 0.5) {
      throw Object.assign(
        new Error('RAW decode produced implausible pixel data (the camera model may be unsupported).'),
        { code: 'DECODE_INVALID' },
      );
    }

    self.postMessage(
      {
        id,
        ok: true,
        width: img.width,
        height: img.height,
        channels: img.colors || 3,
        data: img.data,
        meta: summarizeMeta(meta),
        stats,
        ms: Math.round(performance.now() - started),
      },
      [img.data.buffer],
    );
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      code: err?.code || 'DECODE_FAILED',
      error: err?.message || String(err),
      meta: meta ? summarizeMeta(meta) : null,
    });
  } finally {
    try {
      raw?.dispose();
    } catch {
      /* ignore */
    }
  }
};
