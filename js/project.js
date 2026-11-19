// 项目文件（参数 JSON）与输入校验。
//
// 项目 JSON 自包含：按顺序嵌入每张输入的原始 PNG（base64）、实际层数与锁定标签。
// 不含时间戳/随机量，相同输入与参数导出的 JSON 逐字节相同。
import { decodePng } from './png.js';
import { MAX_DIMENSION, MAX_IMAGES, MAX_LEVELS, MIN_IMAGES } from './core.js';

export const PROJECT_FORMAT = 'focus-pyramid-stack-project';
export const PROJECT_VERSION = 1;

export function bytesToBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// 输入校验：2..7 张、全部同尺寸、单边 ≤512、8 位 RGB PNG。
// images 元素需含 { name, width, height, rgb8, colorType }。
export function validateInputs(images) {
  const errors = [];
  if (!Array.isArray(images) || images.length < MIN_IMAGES) {
    errors.push(`至少需要 ${MIN_IMAGES} 张照片（当前 ${images ? images.length : 0} 张）`);
  }
  if (Array.isArray(images) && images.length > MAX_IMAGES) {
    errors.push(`最多 ${MAX_IMAGES} 张照片（当前 ${images.length} 张）`);
  }
  if (!Array.isArray(images) || images.length === 0) return { ok: false, errors };
  const w = images[0].width;
  const h = images[0].height;
  if (w < 1 || h < 1) errors.push('图像尺寸非法');
  if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
    errors.push(`单边最多 ${MAX_DIMENSION} 像素（收到 ${w}×${h}）`);
  }
  for (const im of images) {
    if (im.width !== w || im.height !== h) {
      errors.push(`尺寸不一致：${im.name} 为 ${im.width}×${im.height}，期望 ${w}×${h}`);
    }
    if (im.colorType !== 2) {
      errors.push(`${im.name} 不是 8 位 RGB PNG（color type ${im.colorType}），请先转换为 RGB`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateLevels(levels) {
  const n = Number(levels);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LEVELS) {
    return { ok: false, error: `层数须为 1..${MAX_LEVELS} 的整数` };
  }
  return { ok: true, levels: n };
}

export function validateLabels(labels, n, width, height) {
  if (!labels) return { ok: true };
  if (labels.length !== width * height) {
    return { ok: false, error: `锁定标签尺寸 ${labels.length} 与图像 ${width}×${height} 不符` };
  }
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] > n) return { ok: false, error: `锁定标签 ${labels[i]} 超出帧数 ${n}` };
  }
  return { ok: true };
}

// 序列化项目。labelMap 可为 null（无锁定）。
export function encodeProject({ images, levels, labels, width, height }) {
  const inputs = images.map((im) => ({
    name: im.name,
    width: im.width,
    height: im.height,
    pngBase64: bytesToBase64(im.sourcePng),
  }));
  let lock = null;
  if (labels) {
    let locked = 0;
    for (let i = 0; i < labels.length; i++) if (labels[i] >= 1) locked++;
    if (locked > 0) {
      lock = {
        // 记录导出时配套的锁定标签文件名，同时内嵌标签本身，导入时不依赖外部文件
        fileName: `focus-stack-lock-L${levels}.png`,
        width,
        height,
        encoding: 'base64-u8',
        labels: bytesToBase64(labels),
        lockedPixels: locked,
      };
    }
  }
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    parameters: { levels },
    inputs,
    lock,
  };
}

export async function decodeProject(json) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  if (obj.format !== PROJECT_FORMAT) throw new Error('不是本工具的焦点堆栈项目文件');
  if (!Number.isInteger(obj.version) || obj.version > PROJECT_VERSION) throw new Error('项目文件版本过新');
  const lv = validateLevels(obj.parameters && obj.parameters.levels);
  if (!lv.ok) throw new Error(lv.error);
  const inputs = Array.isArray(obj.inputs) ? obj.inputs : [];
  if (inputs.length < MIN_IMAGES || inputs.length > MAX_IMAGES) {
    throw new Error(`项目含 ${inputs.length} 张输入，需 ${MIN_IMAGES}..${MAX_IMAGES} 张`);
  }
  const images = [];
  for (const item of inputs) {
    const bytes = base64ToBytes(item.pngBase64 || '');
    const dec = await decodePng(bytes);
    images.push({
      name: item.name || 'image.png',
      width: dec.width,
      height: dec.height,
      rgb8: dec.rgb8,
      colorType: dec.colorType,
      sourcePng: bytes,
    });
  }
  const v = validateInputs(images);
  if (!v.ok) throw new Error(v.errors.join('；'));
  let labels = null;
  if (obj.lock) {
    const raw = base64ToBytes(obj.lock.labels || '');
    if (raw.length !== images[0].width * images[0].height) {
      throw new Error('项目锁定标签尺寸与图像不符');
    }
    labels = new Uint8Array(raw);
    const lv2 = validateLabels(labels, images.length, images[0].width, images[0].height);
    if (!lv2.ok) throw new Error(lv2.error);
  }
  return { images, levels: lv.levels, labels, width: images[0].width, height: images[0].height };
}

// 由「图像 + 锁定标签」构造项目文件名（顺序、尺寸均记录在文件内）。
export function projectFileName(levels) {
  return `focus-stack-project-L${levels}.json`;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
