// 重算 Worker：接收 RAW 字节与参数，返回去马赛克结果与指标，不阻塞 UI。
import { parseRaw, normalizePlanes } from '../lib/raw.js';
import { ALGORITHMS, toUint16, psnr16 } from '../lib/demosaic.js';

self.onmessage = (e) => {
  const { id, rawBytes, wb, algorithm, truth16 } = e.data;
  try {
    const raw = parseRaw(rawBytes);
    const { planes, mask } = normalizePlanes(raw, wb);
    const t0 = performance.now();
    const rgbPlanes = ALGORITHMS[algorithm].run(raw, planes);
    const rgb16 = toUint16(rgbPlanes);
    const elapsedMs = performance.now() - t0;

    // 本地文件没有 truth 时 truth16 为空数组，跳过指标计算
    let metrics = null;
    if (truth16 && truth16.length === rgb16.length) {
      metrics = { overall: psnr16(rgb16, truth16), perChannel: [] };
      const n = rgb16.length / 3;
      for (let c = 0; c < 3; c++) {
        const a = new Uint16Array(n);
        const b = new Uint16Array(n);
        for (let i = 0; i < n; i++) {
          a[i] = rgb16[i * 3 + c];
          b[i] = truth16[i * 3 + c];
        }
        metrics.perChannel.push(psnr16(a, b));
      }
    }

    // 不转移 buffer：这些数组主线程渲染与导出都要持有，
    // transfer 会使主线程侧 TypedArray 被 detach（length 归零）。
    // 样例最大 256×256，结构化克隆的复制成本可接受。
    self.postMessage({
      id,
      ok: true,
      width: raw.width,
      height: raw.height,
      patternName: raw.patternName,
      cfa: raw.cfa,
      mask,
      planes, // float64 三平面，用于 CFA 原始采样视图
      rgb16,
      metrics,
      elapsedMs,
    });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
