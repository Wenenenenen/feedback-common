// 拼接主管线：输入校验 -> 逐边 RANSAC -> 连通树组合 -> 退化检查 ->
// 画布计算（4096 限制）-> 逆映射重采样 -> 距离权重融合 -> 结果与诊断信息。

import { ransacHomography } from './homography.js';
import { buildSpanningTree, composeToReference, loopClosureResiduals } from './graph.js';
import { checkHorizon, computeCanvas, warpedBounds } from './geometry.js';
import { identity3, matMul, normalizeH } from './linalg.js';
import { blendLayers, warpLayer } from './resample.js';

export const MAX_SIDE = 4096;
export const MAX_IMAGES = 4;
export const MAX_SOURCE_SIDE = 1024;

export class MosaicError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MosaicError';
    this.code = code;
  }
}

// images: [{ name, width, height, data(RGBA) }]
// match: 解析后的 matches.json；threshold: RANSAC 像素阈值；reference: 参考图索引
export function buildMosaic(images, match, threshold, reference) {
  const n = images.length;
  validateInputs(images, match, threshold, reference);

  // ---- 逐边 RANSAC ----
  const edgeResults = match.edges.map((edge) => {
    if (edge.pairs.length < 4) {
      throw new MosaicError(
        'BAD_INPUT',
        `边 ${edge.a}-${edge.b} 只有 ${edge.pairs.length} 对对应点，RANSAC 至少需要 4 对`
      );
    }
    let r;
    try {
      r = ransacHomography(edge.pairs, threshold);
    } catch (err) {
      throw new MosaicError(
        'DEGENERATE',
        `边 ${edge.a}-${edge.b} 单应估计失败：${err.message}（对应点退化或误点过多）`
      );
    }
    return {
      a: edge.a,
      b: edge.b,
      pairs: edge.pairs,
      H: r.H,
      inliers: r.inliers,
      outliers: r.outliers,
      residuals: r.residuals,
      iterations: r.iterations,
      degenerateSamples: r.degenerateSamples,
    };
  });

  // ---- 连通性与最大生成树 ----
  const tree = buildSpanningTree(n, edgeResults);
  const refComponent = tree.components.find((c) => c.includes(reference));
  const disconnected = tree.components.filter((c) => !c.includes(reference)).flat();
  if (disconnected.length > 0) {
    throw new MosaicError(
      'DISCONNECTED',
      `图间没有连通：参考图 ${reference} 无法到达图像 ${disconnected.join(', ')}（内点≥4 的边不足以连成一体）`
    );
  }
  if (!tree.treeEdges.length && n > 1) {
    throw new MosaicError('DISCONNECTED', '图间没有连通：不存在内点数量≥4 的可用边');
  }

  // ---- 组合各图到参考图 ----
  const { toRef, parentEdge } = composeToReference(n, reference, tree.treeEdges);
  for (let i = 0; i < n; i++) {
    if (!toRef[i]) {
      throw new MosaicError('DISCONNECTED', `图间没有连通：图像 ${i} 无法变换到参考图 ${reference}`);
    }
  }

  // ---- 投影地平线检查（每张图 -> 参考） ----
  for (let i = 0; i < n; i++) {
    if (i === reference) continue;
    const horizon = checkHorizon(toRef[i], images[i].width, images[i].height);
    if (!horizon.ok) {
      throw new MosaicError('HORIZON', `图像 ${i} -> 参考图：${horizon.reason}`);
    }
  }

  // ---- 闭环（非树边）残差 ----
  const loops = loopClosureResiduals(tree.nonTreeEdges, toRef);
  const loopWarnings = [];
  for (const rep of loops) {
    if (rep.maxResidual > threshold) {
      loopWarnings.push(
        `闭环边 ${rep.a}-${rep.b} 在参考平面的最大对应残差 ${rep.maxResidual.toFixed(2)}px ` +
          `超过阈值 ${threshold}px（均值 ${rep.meanResidual.toFixed(2)}px），对应关系不一致`
      );
    }
  }

  // ---- 画布包围盒 ----
  const bounds = images.map((img, i) => warpedBounds(toRef[i], img.width, img.height));
  const canvas = computeCanvas(bounds);
  if (canvas.width > MAX_SIDE || canvas.height > MAX_SIDE) {
    throw new MosaicError(
      'CANVAS_TOO_LARGE',
      `输出画布 ${canvas.width}x${canvas.height} 超过 ${MAX_SIDE}x${MAX_SIDE} 上限，拒绝生成`
    );
  }

  // ---- 各图 -> 画布（统一平移 offset=-min） ----
  const T = [1, 0, canvas.offsetX, 0, 1, canvas.offsetY, 0, 0, 1];
  const toCanvas = toRef.map((H) => normalizeH(matMul(T, H)));

  // ---- 逆映射重采样 + 距离权重融合 ----
  const layers = images.map((img, i) =>
    warpLayer(img, canvas.width, canvas.height, toCanvas[i])
  );
  const rgba = blendLayers(layers, canvas.width, canvas.height);

  return {
    canvas,
    rgba,
    layers,
    layerSizes: images.map((img) => [img.width, img.height]),
    bounds,
    toRef,
    toCanvas,
    edgeResults,
    tree,
    loops,
    loopWarnings,
    parentEdge,
    threshold,
    reference,
  };
}

function validateInputs(images, match, threshold, reference) {
  const n = images.length;
  if (n < 2 || n > MAX_IMAGES) {
    throw new MosaicError('BAD_INPUT', `图片数量必须为 2..4 张，当前 ${n} 张`);
  }
  if (!match || !Array.isArray(match.edges)) {
    throw new MosaicError('BAD_INPUT', 'matches JSON 缺少 edges 数组');
  }
  if (!Number.isInteger(reference) || reference < 0 || reference >= n) {
    throw new MosaicError('BAD_INPUT', `参考图索引必须在 0..${n - 1} 之间`);
  }
  if (!(threshold > 0) || !Number.isFinite(threshold)) {
    throw new MosaicError('BAD_INPUT', '误差阈值必须为正数（像素）');
  }
  for (const img of images) {
    if (img.width > MAX_SOURCE_SIDE || img.height > MAX_SOURCE_SIDE) {
      throw new MosaicError(
        'BAD_INPUT',
        `${img.name} 尺寸 ${img.width}x${img.height} 超出单边 ${MAX_SOURCE_SIDE} 限制`
      );
    }
  }
  const seen = new Set();
  match.edges.forEach((edge, ei) => {
    if (!Number.isInteger(edge.a) || !Number.isInteger(edge.b) || edge.a === edge.b) {
      throw new MosaicError('BAD_INPUT', `第 ${ei} 条边的 a/b 索引无效`);
    }
    if (edge.a < 0 || edge.a >= n || edge.b < 0 || edge.b >= n) {
      throw new MosaicError('BAD_INPUT', `第 ${ei} 条边引用了不存在的图片索引`);
    }
    if (!Array.isArray(edge.pairs) || edge.pairs.length < 4) {
      throw new MosaicError('BAD_INPUT', `边 ${edge.a}-${edge.b} 至少需要 4 对对应点`);
    }
    edge.pairs.forEach((p, pi) => {
      const ok =
        Array.isArray(p) && p.length === 2 &&
        Array.isArray(p[0]) && p[0].length === 2 &&
        Array.isArray(p[1]) && p[1].length === 2 &&
        p[0].every(Number.isFinite) && p[1].every(Number.isFinite);
      if (!ok) throw new MosaicError('BAD_INPUT', `边 ${edge.a}-${edge.b} 第 ${pi} 对坐标格式无效`);
    });
    const key = edge.a < edge.b ? `${edge.a}-${edge.b}` : `${edge.b}-${edge.a}`;
    if (seen.has(key)) {
      throw new MosaicError('BAD_INPUT', `图片对 ${key} 存在重复边，请合并对应点`);
    }
    seen.add(key);
  });
}

// 导出 JSON：平移后的画布坐标、各图矩阵、内点索引
export function buildExportJson(result, imageNames) {
  const { canvas, toCanvas, toRef, edgeResults } = result;
  return {
    canvas: {
      width: canvas.width,
      height: canvas.height,
      origin: [canvas.originX, canvas.originY],
      offset: [canvas.offsetX, canvas.offsetY],
    },
    reference: result.reference,
    images: imageNames,
    image_to_reference: toRef.map((H) => matrixRows(H)),
    image_to_canvas: toCanvas.map((H) => matrixRows(H)),
    edges: edgeResults.map((e) => ({
      a: e.a,
      b: e.b,
      inliers: e.inliers,
      outliers: e.outliers,
      ransac_iterations: e.iterations,
    })),
    tree_edges: result.tree.treeEdges.map((e) => [e.a, e.b]),
    loop_closures: result.loops.map((r) => ({
      a: r.a,
      b: r.b,
      max_residual: r.maxResidual,
      mean_residual: r.meanResidual,
      rms_residual: r.rmsResidual,
    })),
  };
}

function matrixRows(H) {
  return [
    [H[0], H[1], H[2]],
    [H[3], H[4], H[5]],
    [H[6], H[7], H[8]],
  ];
}

export { identity3 };
