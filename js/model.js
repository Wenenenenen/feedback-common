/**
 * 观测模型与矩阵无关算子（灰度单通道；RGB 在 worker 中逐通道调用）。
 *
 * 观测（低分辨率 W×H，高分辨率 2W×2H，均为整数节点坐标）：
 *   1. 真卷积  B[y,x] = Σ_{j,i} k[j,i] · X[y-(j-c), x-(i-c)]，图外 X 视为 0；
 *   2. 观测 (u,v) 在 B 坐标 (2u+dx, 2v+dy) 做双线性取样，
 *      越界的四邻项一律视为 0，不做任何重归一化；
 *   3. 掩膜权重 weight = mask/255（无掩膜为 1）。
 *
 * A_f = S_f ∘ B，其严格转置 A_fᵀ = Bᵀ ∘ S_fᵀ（同一组系数反向累加）。
 * 全部系数在构建时一次性确定，前向与伴随复用同一份数据，从构造上保证配对严格。
 */

export const ETA = 1e-6;

/**
 * @typedef {Object} FrameConfig
 * @property {number[]} shift  [dx, dy]，高分辨率像素单位
 * @property {Float64Array|null} weights  W*H，每观测像素的置信权重（mask/255）
 */

/**
 * 构建模型。观测值 Y 不放进模型——算子对任意输入都成立（探测/伴随测试需要）。
 *
 * @param {number} W 低分辨率宽
 * @param {number} H 低分辨率高
 * @param {number[][]} kernel 边长 1/3/5 的方阵
 * @param {FrameConfig[]} frames
 */
export function buildModel(W, H, kernel, frames) {
  const GW = 2 * W;
  const GH = 2 * H;
  const N = GW * GH;
  const M = W * H;
  const ksize = kernel.length;
  if (!Number.isInteger(ksize) || ksize % 2 === 0) {
    throw new Error('卷积核边长必须为 1、3 或 5 的奇数方阵');
  }
  const c = (ksize - 1) / 2;

  // 展平卷积核并记录 (j, i, k)，跳过零权系数（核允许稀疏，如探测核）。
  const taps = [];
  let ksum = 0;
  for (let j = 0; j < ksize; j++) {
    if (!Array.isArray(kernel[j]) || kernel[j].length !== ksize) {
      throw new Error('卷积核必须为方阵');
    }
    for (let i = 0; i < ksize; i++) {
      const kv = kernel[j][i];
      if (typeof kv !== 'number' || !Number.isFinite(kv) || kv < 0) {
        throw new Error('卷积核系数必须为非负有限数');
      }
      ksum += kv;
      if (kv !== 0) taps.push({ j, i, kv });
    }
  }
  if (Math.abs(ksum - 1) > 1e-8) {
    throw new Error(`卷积核权重之和必须为 1（当前 ${ksum}），缺失采样不得重归一化`);
  }

  const frameData = frames.map((fr, f) => {
    if (!Array.isArray(fr.shift) || fr.shift.length !== 2) {
      throw new Error(`第 ${f + 1} 帧的 shift 必须是 [dx, dy]`);
    }
    const [dx, dy] = fr.shift;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      throw new Error(`第 ${f + 1} 帧位移分量必须在 [-4, 4] 内`);
    }
    let weights = fr.weights;
    if (weights === null || weights === undefined) {
      weights = new Float64Array(M).fill(1);
    } else {
      if (weights.length !== M) throw new Error(`第 ${f + 1} 帧掩膜尺寸与观测图不一致`);
      for (let q = 0; q < M; q++) {
        if (weights[q] < 0 || weights[q] > 1 || !Number.isFinite(weights[q])) {
          throw new Error(`第 ${f + 1} 帧掩膜权重必须在 [0,1] 内`);
        }
      }
    }

    // 每个观测像素的双线性四邻项（越界邻项不记录——它们恒贡献 0，而非按比例重归一化）。
    // 与前向/伴随共用，保证 S 与 Sᵀ 严格配对。
    const nbIndex = new Int32Array(M * 4);
    const nbWeight = new Float64Array(M * 4);
    const nbCount = new Uint8Array(M);
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        const px = 2 * u + dx;
        const py = 2 * v + dy;
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const ax = px - x0;
        const ay = py - y0;
        const q = v * W + u;
        let cnt = 0;
        // 四邻顺序：(y0,x0) (y0,x0+1) (y0+1,x0) (y0+1,x0+1)
        const cand = [
          [y0, x0, (1 - ay) * (1 - ax)],
          [y0, x0 + 1, (1 - ay) * ax],
          [y0 + 1, x0, ay * (1 - ax)],
          [y0 + 1, x0 + 1, ay * ax],
        ];
        for (const [yy, xx, ww] of cand) {
          if (yy >= 0 && yy < GH && xx >= 0 && xx < GW && ww !== 0) {
            nbIndex[q * 4 + cnt] = yy * GW + xx;
            nbWeight[q * 4 + cnt] = ww;
            cnt++;
          }
        }
        nbCount[q] = cnt;
      }
    }
    return { shift: [dx, dy], weights, nbIndex, nbWeight, nbCount };
  });

  /** 真卷积 B：X(高分辨率) -> B(同尺寸)，图外 X=0 */
  function convForward(X, B) {
    B.fill(0);
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        let acc = 0;
        for (let t = 0; t < taps.length; t++) {
          const { j, i, kv } = taps[t];
          const yy = y - (j - c);
          const xx = x - (i - c);
          if (yy >= 0 && yy < GH && xx >= 0 && xx < GW) {
            acc += kv * X[yy * GW + xx];
          }
        }
        B[y * GW + x] = acc;
      }
    }
  }

  /** 卷积的严格转置 Bᵀ：Z(高分辨率) -> 同尺寸，系数与边界处理与 B 完全配对 */
  function convAdjoint(Z, Out) {
    Out.fill(0);
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        const zv = Z[y * GW + x];
        if (zv === 0) continue;
        for (let t = 0; t < taps.length; t++) {
          const { j, i, kv } = taps[t];
          const yy = y - (j - c);
          const xx = x - (i - c);
          if (yy >= 0 && yy < GH && xx >= 0 && xx < GW) {
            Out[yy * GW + xx] += kv * zv;
          }
        }
      }
    }
  }

  /** 单帧前向 A_f X：高分辨率 -> 该帧 W×H 观测向量 */
  function forward(X, f, B, out) {
    convForward(X, B);
    const fd = frameData[f];
    for (let q = 0; q < M; q++) {
      let acc = 0;
      const base = q * 4;
      const cnt = fd.nbCount[q];
      for (let t = 0; t < cnt; t++) {
        acc += fd.nbWeight[base + t] * B[fd.nbIndex[base + t]];
      }
      out[q] = acc;
    }
  }

  /** 单帧严格转置 A_fᵀ Z：观测向量 -> 高分辨率网格 */
  function adjoint(z, f, B, out) {
    const fd = frameData[f];
    B.fill(0);
    for (let q = 0; q < M; q++) {
      const zv = z[q];
      if (zv === 0) continue;
      const base = q * 4;
      const cnt = fd.nbCount[q];
      for (let t = 0; t < cnt; t++) {
        B[fd.nbIndex[base + t]] += fd.nbWeight[base + t] * zv;
      }
    }
    convAdjoint(B, out);
  }

  /**
   * 正规方程右端 b = Σ_f A_fᵀ (w_f ⊙ y_f)。
   * @param {Float64Array[]} ys 每帧观测向量
   */
  function makeRhs(ys) {
    const b = new Float64Array(N);
    const B = new Float64Array(N);
    const tmp = new Float64Array(N);
    const z = new Float64Array(M);
    frameData.forEach((fd, f) => {
      const y = ys[f];
      for (let q = 0; q < M; q++) z[q] = fd.weights[q] * y[q];
      adjoint(z, f, B, tmp);
      for (let n = 0; n < N; n++) b[n] += tmp[n];
    });
    return b;
  }

  /** 平滑算子 L X：图内水平/垂直边，每条向右或向下的边只计一次的 4-邻域拉普拉斯 */
  function laplacian(X, out) {
    out.fill(0);
    for (let y = 0; y < GH; y++) {
      const row = y * GW;
      for (let x = 0; x < GW; x++) {
        const idx = row + x;
        const v = X[idx];
        let acc = 0;
        if (x + 1 < GW) {
          const d = v - X[idx + 1];
          acc += d;
          out[idx + 1] -= d;
        }
        if (y + 1 < GH) {
          const d = v - X[idx + GW];
          acc += d;
          out[idx + GW] -= d;
        }
        out[idx] += acc;
      }
    }
  }

  /**
   * 正规方程算子 H = Σ_f A_fᵀ W_f A_f + λL + ηI。
   * 利用 B 在帧间相同：每帧只做取样/散射，卷积全帧仅各一次。
   * 临时缓冲在模型上复用，CG 每次 matvec 不产生大数组分配。
   */
  const hBufB = new Float64Array(N);
  const hBufScatter = new Float64Array(N);
  const hBufZ = new Float64Array(M);
  function hMatvec(X, lambda, out) {
    const B = hBufB;
    const scatter = hBufScatter;
    const z = hBufZ;
    out.fill(0);

    convForward(X, B);
    for (let f = 0; f < frameData.length; f++) {
      const fd = frameData[f];
      for (let q = 0; q < M; q++) {
        let acc = 0;
        const base = q * 4;
        const cnt = fd.nbCount[q];
        for (let t = 0; t < cnt; t++) {
          acc += fd.nbWeight[base + t] * B[fd.nbIndex[base + t]];
        }
        z[q] = fd.weights[q] * acc;
      }
      scatter.fill(0);
      for (let q = 0; q < M; q++) {
        const zv = z[q];
        if (zv === 0) continue;
        const base = q * 4;
        const cnt = fd.nbCount[q];
        for (let t = 0; t < cnt; t++) {
          scatter[fd.nbIndex[base + t]] += fd.nbWeight[base + t] * zv;
        }
      }
      for (let n = 0; n < N; n++) out[n] += scatter[n];
    }
    convAdjoint(out, scatter); // scatter 复用为临时缓冲
    out.set(scatter);

    if (lambda > 0) {
      laplacian(X, B); // B 复用为临时缓冲
      for (let n = 0; n < N; n++) out[n] += lambda * B[n];
    }
    if (ETA !== 0) {
      for (let n = 0; n < N; n++) out[n] += ETA * X[n];
    }
  }

  /**
   * 单帧回投影残差 r_f = A_f X − y_f（不乘权重；掩膜为 0 的像素仍如实给出数值）。
   */
  function residual(X, f, y, B) {
    const r = new Float64Array(M);
    forward(X, f, B, r);
    for (let q = 0; q < M; q++) r[q] -= y[q];
    return r;
  }

  /**
   * 单个观测像素对高分辨率网格的贡献系数（A_f 的对应行，未乘掩膜）。
   * 用于“点一个观测像素查看贡献”：B = Σ k[j,i] X[y-(j-c),x-(i-c)]，
   * 观测 = Σ_nb w_nb · B[nb]，故对 X[p] 的系数 = Σ_nb w_nb · k[映射到 p 的 tap]。
   * 返回 Map<高分辨率线性索引, 系数>。
   */
  function pixelContribution(f, u, v) {
    const fd = frameData[f];
    const q = v * W + u;
    const base = q * 4;
    const cnt = fd.nbCount[q];
    const map = new Map();
    for (let t = 0; t < cnt; t++) {
      const nbIdx = fd.nbIndex[base + t];
      const w = fd.nbWeight[base + t];
      const by = Math.floor(nbIdx / GW);
      const bx = nbIdx - by * GW;
      for (const tap of taps) {
        const yy = by - (tap.j - c);
        const xx = bx - (tap.i - c);
        if (yy >= 0 && yy < GH && xx >= 0 && xx < GW) {
          const p = yy * GW + xx;
          map.set(p, (map.get(p) || 0) + w * tap.kv);
        }
      }
    }
    return map;
  }

  /** 该观测像素双线性四邻的总权重（<1 即存在越界/缺测，未做重归一化的直接证据） */
  function bilinearCoverage(f, u, v) {
    const fd = frameData[f];
    const q = v * W + u;
    const base = q * 4;
    const cnt = fd.nbCount[q];
    let s = 0;
    for (let t = 0; t < cnt; t++) s += fd.nbWeight[base + t];
    return s;
  }

  return {
    W, H, GW, GH, N, M, ksize, c, taps,
    frames: frameData,
    convForward, convAdjoint, forward, adjoint,
    makeRhs, laplacian, hMatvec, residual,
    pixelContribution, bilinearCoverage,
  };
}
