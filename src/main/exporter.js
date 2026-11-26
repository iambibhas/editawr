'use strict';

/**
 * Export pipeline: the renderer renders the edited image with WebGL and hands
 * us an encoded PNG; sharp does format conversion, optional resizing and
 * writes the final file atomically.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { ensureDir, uniquePath, pathExists } = require('./util');
const { expand } = require('./template');

const FORMATS = new Set(['jpeg', 'png', 'tiff', 'webp']);

function buildFilename({ filenameTemplate, ctx, ext }) {
  if (filenameTemplate) {
    const { relPath, error } = expand(filenameTemplate, ctx);
    if (!error && relPath) {
      const withExt = /\.(jpe?g|png|tiff?|webp)$/i.test(relPath) ? relPath : `${relPath}.${ext}`;
      return withExt;
    }
  }
  return `${ctx.filename}.${ext}`;
}

async function exportImage({
  buffer,
  format = 'jpeg',
  quality = 92,
  targetDir,
  filenameTemplate,
  ctx = {},
  resizeLongEdge = 0,
  overwrite = false,
}) {
  if (!buffer || !buffer.length) throw new Error('No image data to export');
  if (!FORMATS.has(format)) throw new Error(`Unsupported format: ${format}`);
  if (!targetDir) throw new Error('No export folder');

  const ext = format === 'jpeg' ? 'jpg' : format;
  const relName = buildFilename({ filenameTemplate, ctx, ext });
  const baseDir = path.join(targetDir, path.dirname(relName));
  const baseName = path.basename(relName);
  await ensureDir(baseDir);

  let target = path.join(baseDir, baseName);
  if (!overwrite) target = await uniquePath(target);

  let pipeline = sharp(buffer, { failOn: 'none' });
  if (resizeLongEdge && Number(resizeLongEdge) > 0) {
    pipeline = pipeline.resize({ width: Number(resizeLongEdge), height: Number(resizeLongEdge), fit: 'inside', withoutEnlargement: true });
  }
  switch (format) {
    case 'jpeg':
      pipeline = pipeline.jpeg({
        quality: Math.max(1, Math.min(100, Number(quality) || 92)),
        mozjpeg: true,
        chromaSubsampling: Number(quality) >= 90 ? '4:4:4' : '4:2:0',
      });
      break;
    case 'png':
      pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality: Math.max(1, Math.min(100, Number(quality) || 92)), effort: 5 });
      break;
    case 'tiff':
      pipeline = pipeline.tiff({ compression: 'deflate', predictor: 'horizontal' });
      break;
    default:
      throw new Error(`Unsupported format: ${format}`);
  }

  const tmp = `${target}.${process.pid}.tmp`;
  await pipeline.toFile(tmp);
  await fsp.rename(tmp, target);
  const st = await fsp.stat(target);
  return { path: target, bytes: st.size, format, width: null, height: null };
}

async function exportFolder(targetDir) {
  await ensureDir(targetDir);
  const st = await fsp.stat(targetDir);
  return { exists: true, isDirectory: st.isDirectory() };
}

module.exports = { exportImage, exportFolder, FORMATS };
