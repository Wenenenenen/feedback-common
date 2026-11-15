// Sequence import: frame discovery, numeric frame-number ordering and the
// validation contract (8-bit sRGB RGB PNG, <=120 frames, <=1280x720, one size).

import { readZip } from './zip.js';
import { decodePNG } from './png.js';

export const MAX_FRAMES = 120;
export const MAX_WIDTH = 1280;
export const MAX_HEIGHT = 720;

// Extract the frame number from a file name. Uses the LAST run of digits
// before the extension ("frame_10.png" -> 10, "shot.0042.png" -> 42).
export function frameNumberFromName(name) {
  const base = name.split('/').pop().replace(/\.[^.]+$/, '');
  const matches = base.match(/\d+/g);
  if (!matches) return null;
  return Number(matches[matches.length - 1]);
}

// Decode every RGB PNG entry in a ZIP and validate the whole batch.
// Returns { frames: [{ name, number, width, height, rgb }], width, height }.
// Throws an Error with a Chinese, user-facing message on any violation.
export async function importSequenceZip(buf) {
  const entries = await readZip(buf);
  const pngEntries = entries
    .filter(e => e.name.toLowerCase().endsWith('.png'))
    .map(e => ({ ...e, number: frameNumberFromName(e.name) }))
    .filter(e => e.number !== null);

  if (pngEntries.length === 0) throw new Error('ZIP 内没有找到带数字帧号的 PNG 文件');
  if (pngEntries.length > MAX_FRAMES) {
    throw new Error(`帧数 ${pngEntries.length} 超过上限 ${MAX_FRAMES} 帧`);
  }

  const numbers = new Set();
  for (const e of pngEntries) {
    if (numbers.has(e.number)) throw new Error(`帧号 ${e.number} 重复（文件 ${e.name}）`);
    numbers.add(e.number);
  }

  pngEntries.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));

  const frames = [];
  let width = 0, height = 0;
  for (const e of pngEntries) {
    let img;
    try {
      img = await decodePNG(e.bytes);
    } catch (err) {
      throw new Error(`文件 ${e.name} 无法解码：${err.message}`);
    }
    if (img.channels !== 3) {
      throw new Error(`文件 ${e.name} 不是 8 位 sRGB RGB PNG（检测到 ${img.channels} 通道）`);
    }
    if (img.width > MAX_WIDTH || img.height > MAX_HEIGHT) {
      throw new Error(`文件 ${e.name} 尺寸 ${img.width}×${img.height} 超过 ${MAX_WIDTH}×${MAX_HEIGHT}`);
    }
    if (width === 0) { width = img.width; height = img.height; }
    else if (img.width !== width || img.height !== height) {
      throw new Error(`文件 ${e.name} 尺寸 ${img.width}×${img.height} 与首帧 ${width}×${height} 不一致，已拒绝导入`);
    }
    frames.push({ name: e.name.split('/').pop(), number: e.number, width: img.width, height: img.height, rgb: img.data });
  }
  return { frames, width, height };
}

// Validate a standalone background PNG against the sequence size.
export async function importBackgroundPng(bytes, width, height) {
  const img = await decodePNG(bytes);
  if (img.channels === 2) throw new Error('不支持带 alpha 的灰度背景 PNG');
  if (img.channels === 4) {
    // Flatten RGBA over black; the requirement is an RGB backdrop anyway.
    const rgb = new Uint8Array(img.width * img.height * 3);
    for (let p = 0, i = 0, o = 0; p < img.width * img.height; p++, i += 4, o += 3) {
      const a = img.data[i + 3] / 255;
      rgb[o] = Math.round(img.data[i] * a);
      rgb[o + 1] = Math.round(img.data[i + 1] * a);
      rgb[o + 2] = Math.round(img.data[i + 2] * a);
    }
    if (img.width !== width || img.height !== height) {
      throw new Error(`背景尺寸 ${img.width}×${img.height} 与序列 ${width}×${height} 不一致`);
    }
    return { width: img.width, height: img.height, rgb };
  }
  if (img.width !== width || img.height !== height) {
    throw new Error(`背景尺寸 ${img.width}×${img.height} 与序列 ${width}×${height} 不一致`);
  }
  return { width: img.width, height: img.height, rgb: img.data.slice() };
}
