'use strict';
// 多尺度 PatchMatch 供体场修补（自实现，不依赖任何现成修补 / 近邻场库）。
//
// 硬性约束（见样例 README）：
//  1) 供体中心必须在图内，且其整个 (2r+1)^2 源 patch 全部落在【原始已知区】；
//     合成像素永远不能成为供体——每层、每次上采样后都重新检查，不合格即重选。
//  2) 目标 patch 中心为每个待修补像素；目标越界偏移忽略，源端始终取原始图。
//  3) 已知像素逐字节保持，重建只写掩膜内像素。
//  4) 全部随机来自注入的确定性 PRNG，同环境同种子结果逐字节一致。

import { mulberry32, nextInt } from './prng.js';

function buildValidity(width, height, r, known) {
  // 供体中心合法性：整个源 patch 在图内，且覆盖像素全部为原始已知。
  const n = width * height;
  const integral = new Int32Array(n); // “未知像素”二维积分图
  for (let y = 0; y < height; y++) {
    let rowAcc = 0;
    for (let x = 0; x < width; x++) {
      rowAcc += known[y * width + x] ? 0 : 1;
      integral[y * width + x] = rowAcc + (y > 0 ? integral[(y - 1) * width + x] : 0);
    }
  }
  const valid = new Uint8Array(n);
  for (let cy = r; cy < height - r; cy++) {
    for (let cx = r; cx < width - r; cx++) {
      const xa = cx - r;
      const xb = cx + r;
      const ya = cy - r;
      const yb = cy + r;
      let cnt = integral[yb * width + xb];
      if (ya > 0) cnt -= integral[(ya - 1) * width + xb];
      if (xa > 0) cnt -= integral[yb * width + (xa - 1)];
      if (ya > 0 && xa > 0) cnt += integral[(ya - 1) * width + (xa - 1)];
      if (cnt === 0) valid[cy * width + cx] = 1;
    }
  }
  return valid;
}

function listValidCenters(valid, width, height, r) {
  const arr = [];
  for (let y = r; y < height - r; y++) {
    for (let x = r; x < width - r; x++) {
      if (valid[y * width + x]) arr.push(y * width + x);
    }
  }
  return Int32Array.from(arr);
}

// 目标 patch 与供体 patch 的整数 SSD（仅统计目标在界内的偏移；源端保证完整在界）。
// budget 为当前最优 SSD，达到即提前退出（不改变 argmin 结果，仅省算力）。
function patchSSD(image, donorImage, width, height, tx, ty, sx, sy, r, budget) {
  let ssd = 0;
  for (let dy = -r; dy <= r; dy++) {
    const tyy = ty + dy;
    if (tyy < 0 || tyy >= height) continue;
    const syy = sy + dy;
    for (let dx = -r; dx <= r; dx++) {
      const txx = tx + dx;
      if (txx < 0 || txx >= width) continue;
      const sxx = sx + dx;
      const ti = (tyy * width + txx) * 3;
      const si = (syy * width + sxx) * 3;
      let d = image[ti] - donorImage[si];
      ssd += d * d;
      d = image[ti + 1] - donorImage[si + 1];
      ssd += d * d;
      d = image[ti + 2] - donorImage[si + 2];
      ssd += d * d;
      if (ssd >= budget) return ssd;
    }
  }
  return ssd;
}

function downsample2x(src, width, height, channels) {
  const w2 = Math.ceil(width / 2);
  const h2 = Math.ceil(height / 2);
  const out = new Uint8Array(w2 * h2 * channels);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const xs = [x * 2, Math.min(width - 1, x * 2 + 1)];
      const ys = [y * 2, Math.min(height - 1, y * 2 + 1)];
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        let cnt = 0;
        for (const yy of ys) {
          for (const xx of xs) {
            sum += src[(yy * width + xx) * channels + c];
            cnt++;
          }
        }
        out[(y * w2 + x) * channels + c] = Math.round(sum / cnt);
      }
    }
  }
  return { data: out, width: w2, height: h2 };
}

function initialFineImage(image, known, n, meanR, meanG, meanB) {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (known[i]) {
      out[i * 3] = image[i * 3];
      out[i * 3 + 1] = image[i * 3 + 1];
      out[i * 3 + 2] = image[i * 3 + 2];
    } else {
      out[i * 3] = meanR;
      out[i * 3 + 1] = meanG;
      out[i * 3 + 2] = meanB;
    }
  }
  return out;
}

// 掩膜 255 = 待修补。
// onProgress(info) 返回 false 可取消。
export function runInpaint(options) {
  const {
    image, // Uint8Array RGB 原始图
    mask, // Uint8Array 单通道，255 为洞
    width,
    height,
    patchSize, // 奇数 3..15
    levels, // 1..4
    iterations, // 每层 1..30
    seed,
    onProgress = null,
  } = options;

  if (width > 512 || height > 512) throw new Error('边长不得超过 512');
  if (image.length !== width * height * 3) throw new Error('RGB 图像长度不匹配');
  if (mask.length !== width * height) throw new Error('掩膜尺寸不匹配');
  const r = (patchSize - 1) >> 1;
  if (patchSize < 3 || patchSize > 15 || patchSize % 2 === 0) {
    throw new Error('patch 边长必须是 3..15 的奇数');
  }
  if (levels < 1 || levels > 4) throw new Error('层数须在 1..4');
  if (iterations < 1 || iterations > 30) throw new Error('每层迭代须在 1..30');
  if (width < patchSize || height < patchSize) {
    throw new Error('图像尺寸小于 patch 边长，放不下任何完整 patch');
  }

  const n = width * height;
  const knownFine = new Uint8Array(n);
  const holePixels = [];
  for (let i = 0; i < n; i++) {
    const isHole = mask[i] === 255;
    knownFine[i] = isHole ? 0 : 1;
    if (isHole) holePixels.push(i);
  }
  const params = { patchSize, levels, iterations, seed };

  if (holePixels.length === 0) {
    return {
      status: 'empty',
      message: '掩膜为空：没有待修补像素，输出与原图逐字节相同。',
      image: image.slice(),
      levelReports: [],
      finalNnf: null,
      targetSnapshot: image.slice(),
      params,
    };
  }

  let kr = 0;
  let kg = 0;
  let kb = 0;
  let kcnt = 0;
  for (let i = 0; i < n; i++) {
    if (knownFine[i]) {
      kr += image[i * 3];
      kg += image[i * 3 + 1];
      kb += image[i * 3 + 2];
      kcnt++;
    }
  }
  if (kcnt === 0) {
    return {
      status: 'no-donor',
      message: '整幅图像都在掩膜内，不存在任何原始已知像素，无合法供体，无法修补。',
      image: null,
      levelReports: [],
      finalNnf: null,
      targetSnapshot: null,
      params,
    };
  }
  const meanR = Math.round(kr / kcnt);
  const meanG = Math.round(kg / kcnt);
  const meanB = Math.round(kb / kcnt);

  const rng = mulberry32(seed);

  // ---- 图像金字塔（细 -> 粗）；每层独立按原始已知区判定 ----
  const pyramid = [];
  pyramid.push({
    width,
    height,
    image: initialFineImage(image, knownFine, n, meanR, meanG, meanB),
    known: knownFine,
  });
  for (let lv = 1; lv < levels; lv++) {
    const prev = pyramid[lv - 1];
    const imgDs = downsample2x(prev.image, prev.width, prev.height, 3);
    const knownDs = downsample2x(prev.known, prev.width, prev.height, 1);
    const w = imgDs.width;
    const h = imgDs.height;
    const known = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) known[i] = knownDs.data[i] >= 128 ? 1 : 0;
    pyramid.push({ width: w, height: h, image: imgDs.data, known });
  }

  const levelReports = [];
  let nnfX = null;
  let nnfY = null;
  let dist = null;
  let prevCoarse = null; // 上一（更粗）层的 NNF 与尺寸，供上采样
  let canceled = false;

  for (let lv = levels - 1; lv >= 0; lv--) {
    const L = pyramid[lv];
    const ln = L.width * L.height;
    const valid = buildValidity(L.width, L.height, r, L.known);
    const validCenters = listValidCenters(valid, L.width, L.height, r);
    const holes = [];
    for (let i = 0; i < ln; i++) if (!L.known[i]) holes.push(i);

    const report = {
      level: lv,
      width: L.width,
      height: L.height,
      holeCount: holes.length,
      donorCount: validCenters.length,
      skipped: false,
      initialImage: L.image.slice(),
      snapshots: [], // 每轮重建后的快照
    };

    if (validCenters.length === 0) {
      report.skipped = true;
      levelReports.push(report);
      prevCoarse = null;
      if (lv === 0) {
        return {
          status: 'no-donor',
          message: '原尺寸下不存在完整落在原始已知区的合法供体 patch，无法修补。',
          image: null,
          levelReports,
          finalNnf: null,
          targetSnapshot: null,
          params,
        };
      }
      if (onProgress) {
        if (onProgress({ phase: 'skipped-level', level: lv, levels, width: L.width, height: L.height }) === false) {
          canceled = true;
          break;
        }
      }
      continue;
    }

    // 供体源图：细层严格用原始图；粗层合法供体 patch 全在已知像素上，
    // 取该层降采样图中的已知内容（洞位初值永远不会被合法供体读到）。
    const donorImage = lv === 0 ? image : L.image;

    nnfX = new Int32Array(ln).fill(-1);
    nnfY = new Int32Array(ln).fill(-1);
    dist = new Float64Array(ln).fill(Infinity);

    const initDonor = (idx) => {
      const pick = validCenters[nextInt(rng, validCenters.length)];
      const sx = pick % L.width;
      const sy = (pick / L.width) | 0;
      const tx = idx % L.width;
      const ty = (idx / L.width) | 0;
      nnfX[idx] = sx;
      nnfY[idx] = sy;
      dist[idx] = patchSSD(L.image, donorImage, L.width, L.height, tx, ty, sx, sy, r, Infinity);
    };

    if (prevCoarse === null) {
      // 最粗层或上一层被跳过：纯随机初始化
      for (const idx of holes) initDonor(idx);
    } else {
      // 粗层 NNF 上采样：本层目标对应的 4 个粗位置、每个粗供体的 4 个亚像素，
      // 逐一在本层重新检查原始已知区合法性，取最优；全不合格则随机重选。
      const cw = prevCoarse.width;
      const ch = prevCoarse.height;
      for (const idx of holes) {
        const tx = idx % L.width;
        const ty = (idx / L.width) | 0;
        const cxs = [tx >> 1, Math.min(cw - 1, (tx >> 1) + 1)];
        const cys = [ty >> 1, Math.min(ch - 1, (ty >> 1) + 1)];
        let bestSsd = Infinity;
        let bx = -1;
        let by = -1;
        for (const cy of cys) {
          for (const cx of cxs) {
            const ci = cy * cw + cx;
            const csx = prevCoarse.nnfX[ci];
            if (csx < 0) continue;
            const csy = prevCoarse.nnfY[ci];
            const fxs = [csx * 2, Math.min(L.width - 1, csx * 2 + 1)];
            const fys = [csy * 2, Math.min(L.height - 1, csy * 2 + 1)];
            for (const fy of fys) {
              for (const fx of fxs) {
                if (!valid[fy * L.width + fx]) continue;
                const ssd = patchSSD(L.image, donorImage, L.width, L.height, tx, ty, fx, fy, r, bestSsd);
                if (ssd < bestSsd) {
                  bestSsd = ssd;
                  bx = fx;
                  by = fy;
                }
              }
            }
          }
        }
        if (bx >= 0) {
          nnfX[idx] = bx;
          nnfY[idx] = by;
          dist[idx] = bestSsd;
        } else {
          initDonor(idx);
        }
      }
    }

    const consider = (idx, sx, sy, budget) => {
      if (sx < r || sy < r || sx >= L.width - r || sy >= L.height - r) return budget;
      if (!valid[sy * L.width + sx]) return budget;
      const tx = idx % L.width;
      const ty = (idx / L.width) | 0;
      const ssd = patchSSD(L.image, donorImage, L.width, L.height, tx, ty, sx, sy, r, budget);
      if (ssd < budget) {
        nnfX[idx] = sx;
        nnfY[idx] = sy;
        dist[idx] = ssd;
        return ssd;
      }
      return budget;
    };

    const maxDim = Math.max(L.width, L.height);

    for (let it = 0; it < iterations; it++) {
      const forward = it % 2 === 0;

      // --- 传播：从扫描方向上的相邻目标借用供体（保持相对偏移） ---
      for (let h = 0; h < holes.length; h++) {
        const idx = forward ? holes[h] : holes[holes.length - 1 - h];
        const tx = idx % L.width;
        const ty = (idx / L.width) | 0;
        let budget = dist[idx];
        const nX = forward ? tx - 1 : tx + 1;
        const nY = forward ? ty - 1 : ty + 1;
        if (nX >= 0 && nX < L.width) {
          const ni = ty * L.width + nX;
          if (nnfX[ni] >= 0) budget = consider(idx, nnfX[ni] - (nX - tx), nnfY[ni], budget);
        }
        if (nY >= 0 && nY < L.height) {
          const ni = nY * L.width + tx;
          if (nnfX[ni] >= 0) budget = consider(idx, nnfX[ni], nnfY[ni] - (nY - ty), budget);
        }
      }

      // --- 随机搜索：窗口半径按 1/2 递减，抖动均匀随机 ---
      let searchRadius = maxDim;
      while (searchRadius >= 1) {
        for (const idx of holes) {
          const ox = nextInt(rng, 2 * searchRadius + 1) - searchRadius;
          const oy = nextInt(rng, 2 * searchRadius + 1) - searchRadius;
          consider(idx, nnfX[idx] + ox, nnfY[idx] + oy, dist[idx]);
        }
        searchRadius >>= 1;
      }

      // --- 固定 I 上的匹配误差：RGB 归一化 [0,1] 平方差，按目标 patch 求均值 ---
      let sumMse = 0;
      let maxMse = 0;
      for (const idx of holes) {
        const tx = idx % L.width;
        const ty = (idx / L.width) | 0;
        const sx = nnfX[idx];
        const sy = nnfY[idx];
        let ssd = 0;
        let cnt = 0;
        for (let dy = -r; dy <= r; dy++) {
          const tyy = ty + dy;
          if (tyy < 0 || tyy >= L.height) continue;
          for (let dx = -r; dx <= r; dx++) {
            const txx = tx + dx;
            if (txx < 0 || txx >= L.width) continue;
            const ti = (tyy * L.width + txx) * 3;
            const si = ((sy + dy) * L.width + (sx + dx)) * 3;
            for (let c = 0; c < 3; c++) {
              const d = L.image[ti + c] - donorImage[si + c];
              ssd += d * d;
              cnt++;
            }
          }
        }
        const mse = ssd / cnt / (255 * 255);
        sumMse += mse;
        if (mse > maxMse) maxMse = mse;
      }
      const meanMse = sumMse / holes.length;

      // 最后一轮重建前的细层快照（NNF 即对应该快照）
      const preReconstruct = lv === 0 && it === iterations - 1 ? L.image.slice() : null;

      // --- 重叠 patch 加权投票重建（只写洞像素）---
      const next = L.image.slice();
      const accR = new Float64Array(ln);
      const accG = new Float64Array(ln);
      const accB = new Float64Array(ln);
      const accW = new Float64Array(ln);
      for (const idx of holes) {
        const tx = idx % L.width;
        const ty = (idx / L.width) | 0;
        const sx = nnfX[idx];
        const sy = nnfY[idx];
        // 权重 = 1 / (归一化平均平方差 + 1e-4)，再 ×1024 四舍五入为整数权重。
        // 归一化按完整 patch 通道数 3*(2r+1)^2 计算，界面与导出参数均说明此公式。
        const norm = dist[idx] / (3 * patchSize * patchSize * 255 * 255);
        const w = Math.max(1, Math.min(1048576, Math.round((1 / (norm + 1e-4)) * 1024)));
        for (let dy = -r; dy <= r; dy++) {
          const tyy = ty + dy;
          if (tyy < 0 || tyy >= L.height) continue;
          for (let dx = -r; dx <= r; dx++) {
            const txx = tx + dx;
            if (txx < 0 || txx >= L.width) continue;
            const ti = tyy * L.width + txx;
            if (L.known[ti]) continue;
            const si = ((sy + dy) * L.width + (sx + dx)) * 3;
            accR[ti] += donorImage[si] * w;
            accG[ti] += donorImage[si + 1] * w;
            accB[ti] += donorImage[si + 2] * w;
            accW[ti] += w;
          }
        }
      }
      for (const idx of holes) {
        if (accW[idx] <= 0) continue;
        next[idx * 3] = Math.round(accR[idx] / accW[idx]);
        next[idx * 3 + 1] = Math.round(accG[idx] / accW[idx]);
        next[idx * 3 + 2] = Math.round(accB[idx] / accW[idx]);
      }
      L.image = next;

      // 细层保留每轮快照供逐轮浏览；粗层只保留最后一轮，控制内存。
      const snap = {
        iteration: it + 1,
        meanMse,
        maxMse,
        preReconstruct,
        image: lv === 0 ? next.slice() : null,
      };
      if (lv !== 0 && it === iterations - 1) snap.image = next.slice();
      report.snapshots.push(snap);

      if (onProgress) {
        const keep = onProgress({
          phase: 'iterating',
          level: lv,
          levels,
          iteration: it + 1,
          iterations,
          meanMse,
          maxMse,
          width: L.width,
          height: L.height,
          image: snap.image,
        });
        if (keep === false) {
          canceled = true;
          break;
        }
      }
    }

    if (canceled) break;
    levelReports.push(report);
    prevCoarse = { width: L.width, height: L.height, nnfX: nnfX.slice(), nnfY: nnfY.slice() };
  }

  if (canceled) {
    return {
      status: 'canceled',
      message: '任务已取消。',
      image: null,
      levelReports,
      finalNnf: null,
      targetSnapshot: null,
      params,
    };
  }

  const fine = pyramid[0];
  // 已知像素逐字节核对（双保险）
  for (let i = 0; i < n; i++) {
    if (knownFine[i]) {
      fine.image[i * 3] = image[i * 3];
      fine.image[i * 3 + 1] = image[i * 3 + 1];
      fine.image[i * 3 + 2] = image[i * 3 + 2];
    }
  }

  const fineReport = levelReports.find((rp) => rp.level === 0 && !rp.skipped);
  let targetSnapshot = null;
  let finalNnf = null;
  if (fineReport) {
    const snaps = fineReport.snapshots;
    const last = snaps[snaps.length - 1];
    targetSnapshot = last.preReconstruct;
    finalNnf = { width, height, nnfX, nnfY, dist: Float64Array.from(dist) };
  }

  return {
    status: 'ok',
    message: '',
    image: fine.image.slice(),
    levelReports,
    finalNnf,
    targetSnapshot,
    params,
  };
}

// NNF 导出：逐像素交错 int32 小端 (sx, sy)；非掩膜位置 (-1, -1)。
export function encodeNNF(nnf, mask, width, height) {
  const buf = new ArrayBuffer(width * height * 8);
  const dv = new DataView(buf);
  let p = 0;
  for (let i = 0; i < width * height; i++) {
    if (mask[i] === 255) {
      dv.setInt32(p, nnf.nnfX[i], true);
      dv.setInt32(p + 4, nnf.nnfY[i], true);
    } else {
      dv.setInt32(p, -1, true);
      dv.setInt32(p + 4, -1, true);
    }
    p += 8;
  }
  return new Uint8Array(buf);
}

// 独立复核：给定目标快照、原始图、掩膜与 NNF，按 README 定义重算每个目标
// patch 的归一化 MSE（RGB/255 平方差在目标有效偏移上的均值），并校验供体
// 合法性。用于页面“核对误差”与导出数据的独立验算。
export function verifyNNFErrors(options) {
  const { targetSnapshot, originalImage, mask, nnfX, nnfY, width, height, patchSize } = options;
  const r = (patchSize - 1) >> 1;
  const errors = new Float64Array(width * height).fill(NaN);
  let illegal = 0;
  let sumMse = 0;
  let count = 0;
  let maxMse = 0;
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const idx = ty * width + tx;
      if (mask[idx] !== 255) continue;
      const sx = nnfX[idx];
      const sy = nnfY[idx];
      let legal = sx >= r && sy >= r && sx < width - r && sy < height - r;
      if (legal) {
        for (let dy = -r; dy <= r && legal; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (mask[(sy + dy) * width + (sx + dx)] === 255) {
              legal = false;
              break;
            }
          }
        }
      }
      if (!legal) {
        illegal++;
        continue;
      }
      let ssd = 0;
      let cnt = 0;
      for (let dy = -r; dy <= r; dy++) {
        const tyy = ty + dy;
        if (tyy < 0 || tyy >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const txx = tx + dx;
          if (txx < 0 || txx >= width) continue;
          const ti = (tyy * width + txx) * 3;
          const si = ((sy + dy) * width + (sx + dx)) * 3;
          for (let c = 0; c < 3; c++) {
            const d = targetSnapshot[ti + c] - originalImage[si + c];
            ssd += d * d;
            cnt++;
          }
        }
      }
      const mse = ssd / cnt / (255 * 255);
      errors[idx] = mse;
      sumMse += mse;
      count++;
      if (mse > maxMse) maxMse = mse;
    }
  }
  return { perPixelMse: errors, meanMse: count ? sumMse / count : NaN, maxMse, illegal, count };
}
