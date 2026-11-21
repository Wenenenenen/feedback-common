/*
 * 线阵扫描相机 暗场/平场校正 计算核心
 * 纯计算、无 DOM 依赖，浏览器 (window.DFC) 与 Node (module.exports) 通用。
 *
 * 约定（与 samples 包内「约定.txt」一致）：
 *  - 栅格为小端 16 位无符号整数，按行存放。
 *  - 忽略达到 clip 的校准样本。
 *  - 暗场斜率 = 不同曝光时长两点斜率的中位数；截距 = (样本 - 斜率*时长) 的中位数；
 *    暗场至少 3 个不同时长。
 *  - 平场增益 = 各帧 (帧值 - 暗场估计) / level 的中位数；至少 3 个有效样本。
 *  - 斜率须在 [0, darkMax]，增益须在 [gainMin, gainMax]，否则判坏。
 *  - 坏点补值：同帧 5×5 窗口中至少 3 个「直接校正且未饱和」点的中位数。
 *  - 质量码：0 无可用值、1 直接校正、2 坏点补值、3 拍摄饱和；质量 0 和 3 对应 NaN。
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.DFC = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** 中位数，与 Python statistics.median 一致（偶数个取中间两值平均）。 */
  function median(vals) {
    if (vals.length === 0) return NaN;
    const a = vals.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /**
   * 由暗场/平场训练帧估计每像素 暗电平(bias)、暗信号斜率(slope)、增益(gain)。
   * @param {object} o
   *   w, h            图像尺寸
   *   darks           [{data:Uint16Array, t:number}] 3~12 张暗场
   *   flats           [{data:Uint16Array, t:number, level:number}] 3~12 张平场
   *   clip            饱和裁剪值（达到即忽略）
   * @return {bias,slope,gain: Float64Array, sampleOk,nDarkT,nFlat: Uint8Array, w,h}
   *   sampleOk=1 表示该像素训练样本数满足约定（不判定阈值，阈值判定见 judgeOk）。
   */
  function computeCalibration(o) {
    const { w, h, darks, flats, clip } = o;
    const N = w * h;
    const bias = new Float64Array(N);
    const slope = new Float64Array(N);
    const gain = new Float64Array(N);
    const sampleOk = new Uint8Array(N);
    const nDarkT = new Uint8Array(N); // 有效（未饱和）暗场不同时长数
    const nFlat = new Uint8Array(N); // 有效（未饱和）平场样本数

    for (let i = 0; i < N; i++) {
      // ---- 暗场：两点斜率中位数 + 截距中位数 ----
      const pts = []; // [t, v]
      const tset = new Set();
      for (const d of darks) {
        const v = d.data[i];
        if (v < clip) {
          pts.push([d.t, v]);
          tset.add(d.t);
        }
      }
      nDarkT[i] = tset.size;
      if (tset.size < 3) continue;

      const slopes = [];
      for (let a = 0; a < pts.length; a++) {
        for (let b = a + 1; b < pts.length; b++) {
          const dt = pts[b][0] - pts[a][0];
          if (dt !== 0) slopes.push((pts[b][1] - pts[a][1]) / dt);
        }
      }
      const s = median(slopes);
      const residuals = new Array(pts.length);
      for (let k = 0; k < pts.length; k++) residuals[k] = pts[k][1] - s * pts[k][0];
      const b = median(residuals);
      bias[i] = b;
      slope[i] = s;

      // ---- 平场：各帧扣暗场信号 / level 的中位数 ----
      const gs = [];
      for (const f of flats) {
        const v = f.data[i];
        if (v < clip) gs.push((v - (b + s * f.t)) / f.level);
      }
      nFlat[i] = gs.length;
      if (gs.length < 3) continue;
      gain[i] = median(gs);
      sampleOk[i] = 1;
    }
    return { w, h, bias, slope, gain, sampleOk, nDarkT, nFlat };
  }

  /**
   * 按阈值判定每像素是否可用（改判坏阈值时重跑此函数即可，无需重估）。
   * @return Uint8Array ok
   */
  function judgeOk(calib, th) {
    const N = calib.w * calib.h;
    const ok = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      ok[i] =
        calib.sampleOk[i] &&
        calib.slope[i] >= 0 &&
        calib.slope[i] <= th.darkMax &&
        calib.gain[i] >= th.gainMin &&
        calib.gain[i] <= th.gainMax
          ? 1
          : 0;
    }
    return ok;
  }

  /**
   * 校正一张拍摄图。
   * @param {object} o
   *   shot  Uint16Array, tShot 曝光时长, clip 饱和值
   *   calib computeCalibration 的结果（或导入的校准）
   *   ok    judgeOk 的结果
   *   repair 是否对坏点做 5×5 邻居补值
   * @return {corr:Float32Array, qual:Uint8Array}
   *   corr 在 qual 为 0 或 3 时为 NaN。
   */
  function correctShot(o) {
    const { shot, tShot, clip, calib, ok, repair } = o;
    const w = calib.w, h = calib.h;
    const N = w * h;
    const corr = new Float32Array(N);
    const qual = new Uint8Array(N);

    for (let i = 0; i < N; i++) {
      if (shot[i] >= clip) {
        qual[i] = 3; // 拍摄饱和，单独标记
        corr[i] = NaN;
      } else if (ok[i]) {
        qual[i] = 1;
        corr[i] = (shot[i] - (calib.bias[i] + calib.slope[i] * tShot)) / calib.gain[i];
      } else {
        qual[i] = 0;
        corr[i] = NaN;
      }
    }

    if (repair) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (qual[i] !== 0) continue;
          const vals = [];
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const j = ny * w + nx;
              if (qual[j] === 1) vals.push(corr[j]); // 直接校正且未饱和
            }
          }
          if (vals.length >= 3) {
            corr[i] = median(vals);
            qual[i] = 2;
          }
          // 邻居不足：保留无效（qual=0, NaN）
        }
      }
    }
    return { corr, qual };
  }

  /**
   * 单像素拟合明细（点击像素查看参与拟合的样本）。
   * 训练帧不在内存时（例如仅导入了校准）可省略 darks/flats。
   */
  function pixelDetail(o) {
    const { i, calib, th, darks, flats, clip } = o;
    const b = calib.bias[i], s = calib.slope[i], g = calib.gain[i];
    const detail = {
      bias: b, slope: s, gain: g,
      sampleOk: calib.sampleOk[i],
      nDarkT: calib.nDarkT ? calib.nDarkT[i] : null,
      nFlat: calib.nFlat ? calib.nFlat[i] : null,
      slopeOk: s >= 0 && s <= th.darkMax,
      gainOk: g >= th.gainMin && g <= th.gainMax,
      darkSamples: null,
      flatSamples: null,
    };
    if (darks) {
      detail.darkSamples = darks.map((d) => {
        const v = d.data[i];
        return { name: d.name, t: d.t, v, used: v < clip, fit: b + s * d.t, resid: v - (b + s * d.t) };
      });
    }
    if (flats) {
      detail.flatSamples = flats.map((f) => {
        const v = f.data[i];
        const sig = v - (b + s * f.t);
        return { name: f.name, t: f.t, level: f.level, v, used: v < clip, signal: sig, gainEst: sig / f.level };
      });
    }
    return detail;
  }

  // ---------- 校准导出 / 导入 ----------

  function f32b64(arr) {
    const f = arr instanceof Float32Array ? arr : Float32Array.from(arr);
    const bytes = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
    return u8b64(bytes);
  }
  function u8b64(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let s = "";
    for (let k = 0; k < bytes.length; k += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
    }
    return btoa(s);
  }
  function b64bytes(b64) {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let k = 0; k < s.length; k++) out[k] = s.charCodeAt(k);
    return out;
  }
  function b64f32(b64) {
    const bytes = b64bytes(b64);
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }

  /** 校准导出为 JSON 字符串（bias/slope/gain 以小端 float32 base64 存放）。 */
  function exportCalibration(calib, th) {
    return JSON.stringify({
      type: "dfc-calibration",
      version: 1,
      w: calib.w,
      h: calib.h,
      clip: th.clip,
      darkMax: th.darkMax,
      gainMin: th.gainMin,
      gainMax: th.gainMax,
      bias: f32b64(calib.bias),
      slope: f32b64(calib.slope),
      gain: f32b64(calib.gain),
      sampleOk: u8b64(calib.sampleOk),
    });
  }

  /** 导入校准 JSON；返回 {calib, th}。尺寸不符等会抛错。 */
  function importCalibration(jsonText) {
    const o = JSON.parse(jsonText);
    if (o.type !== "dfc-calibration" || o.version !== 1) throw new Error("不是本工具导出的校准文件");
    const N = o.w * o.h;
    const bias = b64f32(o.bias), slope = b64f32(o.slope), gain = b64f32(o.gain);
    const sampleOk = b64bytes(o.sampleOk);
    if (bias.length !== N || slope.length !== N || gain.length !== N || sampleOk.length !== N)
      throw new Error("校准文件数据长度与尺寸不符");
    const calib = {
      w: o.w, h: o.h,
      bias: Float64Array.from(bias),
      slope: Float64Array.from(slope),
      gain: Float64Array.from(gain),
      sampleOk,
      nDarkT: null,
      nFlat: null,
    };
    const th = { clip: o.clip, darkMax: o.darkMax, gainMin: o.gainMin, gainMax: o.gainMax };
    return { calib, th };
  }

  // ---------- 结果导出 ----------

  /** 校正结果 -> 小端 float32（质量 0/3 已为 NaN）。返回 ArrayBuffer。 */
  function exportCorrectedF32(result) {
    return result.corr.buffer.slice(0);
  }

  /** 质量码 -> 8 位图。返回 ArrayBuffer。 */
  function exportQualityU8(result) {
    return result.qual.buffer.slice(0);
  }

  /** 解析小端 uint16 原始栅格。 */
  function parseU16(buf, w, h) {
    if (buf.byteLength !== w * h * 2)
      throw new Error("文件大小 " + buf.byteLength + " 字节，与尺寸 " + w + "×" + h + "（应为 " + w * h * 2 + " 字节）不符");
    const dv = new DataView(buf);
    const out = new Uint16Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = dv.getUint16(i * 2, true);
    return out;
  }

  return {
    median,
    computeCalibration,
    judgeOk,
    correctShot,
    pixelDetail,
    exportCalibration,
    importCalibration,
    exportCorrectedF32,
    exportQualityU8,
    parseU16,
  };
});
