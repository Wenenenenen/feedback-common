// 导出：两阶段 8 位 PNG、浮点结果（.npy，numpy 可直接读取）、参数报告 JSON，
// 以及把四者打成一个 ZIP（存储模式，无第三方依赖）。

import { encodeGrayPNG } from '../../lib/png.js';
import { crc32 } from '../../lib/crc32.js';

export function clampToGray(values) {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(values[i]);
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
  }
  return out;
}

export async function buildPilotPNG(result) {
  return encodeGrayPNG(result.width, result.height, result.pilot, { round: true });
}

export async function buildFinalPNG(result) {
  return encodeGrayPNG(result.width, result.height, result.final, { round: true });
}

// .npy v1.0，shape (4, H, W)，dtype '<f8'：
//   [0] 初估图 pilot、[1] 最终图 final、[2] 初估聚合权重、[3] 最终聚合权重。
export function buildFloatNpy(result) {
  const { width, height, pilot, final, weight1, weight2 } = result;
  const count = 4;
  const bytesPerSample = 8;
  const dataBytes = count * height * width * bytesPerSample;
  const base = `{'descr': '<f8', 'fortran_order': False, 'shape': (${count}, ${height}, ${width}), }`;
  let pad = (16 - ((10 + base.length + 1) % 16)) % 16;
  const header = base + ' '.repeat(pad) + '\n';
  const headerBytes = new TextEncoder().encode(header);
  const out = new Uint8Array(10 + headerBytes.length + dataBytes);
  const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
  out.set(magic, 0);
  out[6] = 1;
  out[7] = 0;
  out[8] = headerBytes.length & 0xff;
  out[9] = (headerBytes.length >>> 8) & 0xff;
  out.set(headerBytes, 10);

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let off = 10 + headerBytes.length;
  for (const arr of [pilot, final, weight1, weight2]) {
    for (let i = 0; i < arr.length; i++) {
      view.setFloat64(off, arr[i], true);
      off += 8;
    }
  }
  return out;
}

export function buildReport(result, extra = {}) {
  const s1 = result.groups?.stage1 || {};
  const s2 = result.groups?.stage2 || {};
  const strip = (s) => {
    const out = { ...s };
    delete out.groupSizes;
    return out;
  };
  return {
    tool: 'group-transform-denoiser',
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    source: extra.sourceName || null,
    image: { width: result.width, height: result.height, bitDepth: 8, channels: 1 },
    params: result.params,
    derived: {
      referenceCentersY: extra.referenceCentersY || null,
      referenceCentersX: extra.referenceCentersX || null,
      referenceGroupCount: extra.referenceGroupCount || null,
      hardThreshold: result.params.threshold * result.params.sigma,
      sigmaSquared: result.params.sigma * result.params.sigma,
    },
    zeroNoise: result.zeroNoise,
    timingMs: result.timing,
    stages: {
      stage1: { ...strip(s1), groupSizeHistogram: s1.groupSizes || {} },
      stage2: { ...strip(s2), groupSizeHistogram: s2.groupSizes || {} },
    },
    weights: {
      stage1: s1.weightStats || null,
      stage2: s2.weightStats || null,
      aggregation: '每个图块按组权重累加，镜像取样的越界像素不写回图像；逐像素除以权重和归一化。',
    },
    exports: {
      pilotPng: 'pilot.png（初估，四舍五入到 0–255）',
      finalPng: 'final.png（最终，四舍五入到 0–255）',
      floatNpy:
        'float-result.npy（numpy 可直接读取；shape=(4,H,W)，dtype=<f8；通道依次为 pilot、final、weight1、weight2）',
    },
    metrics: extra.metrics || null,
    notes: [
      '图块中心为整数像素；偏移 -p/2 .. p/2-1。',
      '越界取样使用不重复端点的镜像；轴长 1 时恒取 0。',
      '参考中心为 0,s,2s,... 中小于边长的位置并补最后一像素，去重升序。',
      '候选中心为搜索方框与图像范围的交集，按均方距离、y、x 升序取 2 的幂个成员。',
      '硬阈值初估保留组索引 0 且空间频率为 (0,0) 的全局 DC。',
      'sigma=0 时两阶段均原样返回输入图。',
    ],
  };
}

function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

// ZIP（stored）：UTF-8 文件名，无压缩，便于在浏览器内零依赖生成。
export function buildZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const { time, day } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    locals.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralStart = offset;
  const centralBytes = concatBytes(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralBytes.length, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);
  return concatBytes([...locals, centralBytes, eocd]);
}

export function downloadBytes(filename, bytes, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(filename, text, mime = 'application/json') {
  downloadBytes(filename, new TextEncoder().encode(text), mime);
}

export function timestampSlug(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
