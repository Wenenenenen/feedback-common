/*
 * Instance mask agreement core.
 * Framework-free UMD module so the same exact arithmetic and matcher runs in
 * the page and in Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgreementCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const IGNORE_ID = 65535;
  const MAX_ID = 65534;
  const MAX_SIDE = 1024;
  const MAX_INSTANCES_PER_SIDE = 256;
  const MILLION = 1_000_000;

  class AgreementError extends Error {
    constructor(message, details) {
      super(message);
      this.name = 'AgreementError';
      if (details) this.details = details;
    }
  }

  function isWhitespace(byte) {
    return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
  }

  // Parses a binary P5 portable graymap. For maxval > 255, samples are
  // big-endian unsigned 16-bit integers as required by the PGM specification.
  function parsePgm(input, label = 'PGM') {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 8) throw new AgreementError(`${label} 文件太短，不是完整的 P5 PGM。`);
    if (bytes[0] !== 0x50 || bytes[1] !== 0x35) {
      throw new AgreementError(`${label} 不是 P5 二进制 PGM（缺少 P5 标记）。`);
    }

    let pos = 2;

    function skipWhitespaceAndComments() {
      while (pos < bytes.length) {
        const b = bytes[pos];
        if (isWhitespace(b)) {
          pos += 1;
        } else if (b === 0x23 /* # */) {
          while (pos < bytes.length && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos += 1;
        } else {
          break;
        }
      }
    }

    function readToken(name) {
      skipWhitespaceAndComments();
      if (pos >= bytes.length) throw new AgreementError(`${label} 头部缺少 ${name}。`);
      const start = pos;
      while (pos < bytes.length && !isWhitespace(bytes[pos])) pos += 1;
      const token = String.fromCharCode(...bytes.subarray(start, pos));
      if (!/^\d+$/.test(token)) {
        throw new AgreementError(`${label} 头部的 ${name} 不是非负整数：${token || '(空)'}。`);
      }
      return Number.parseInt(token, 10);
    }

    const width = readToken('width');
    const height = readToken('height');
    const maxval = readToken('maxval');

    if (pos >= bytes.length || !isWhitespace(bytes[pos])) {
      throw new AgreementError(`${label} P5 头部与二进制栅格之间缺少分隔空白。`);
    }
    // PNM permits exactly one header delimiter here. Do not skip further
    // bytes: a following 0x0a may itself be the high/low byte of pixel data.
    pos += 1;
    // Accept the common CRLF line ending as one logical header newline.
    if (bytes[pos - 1] === 0x0d && bytes[pos] === 0x0a) pos += 1;

    if (!Number.isSafeInteger(width) || width <= 0 || height <= 0) {
      throw new AgreementError(`${label} 尺寸无效：${width}×${height}。`);
    }
    if (width > MAX_SIDE || height > MAX_SIDE) {
      throw new AgreementError(`${label} 尺寸为 ${width}×${height}，每边最多 ${MAX_SIDE} 像素。`);
    }
    if (maxval <= 0 || maxval > 65535) {
      throw new AgreementError(`${label} maxval 无效：${maxval}，应为 1..65535。`);
    }

    const bytesPerSample = maxval > 255 ? 2 : 1;
    const pixelCount = width * height;
    const expectedBytes = pixelCount * bytesPerSample;
    if (bytes.length - pos < expectedBytes) {
      throw new AgreementError(
        `${label} 像素数据不足：需要至少 ${expectedBytes} 字节，头部后仅有 ${bytes.length - pos} 字节。`,
      );
    }

    const data = new Uint16Array(pixelCount);
    if (bytesPerSample === 2) {
      for (let i = 0; i < pixelCount; i += 1) {
        const j = pos + i * 2;
        data[i] = (bytes[j] << 8) | bytes[j + 1];
      }
    } else {
      for (let i = 0; i < pixelCount; i += 1) data[i] = bytes[pos + i];
    }

    return {
      format: 'P5',
      width,
      height,
      maxval,
      bytesPerSample,
      bitDepth: bytesPerSample === 2 ? 16 : 8,
      data,
    };
  }

  function normalizeThresholdToken(raw) {
    let s = String(raw).trim();
    if (!s) return null;
    // Tolerate a trailing permyriad sign if pasted by users.
    s = s.replace(/‱$/, '');
    if (!/^\d+(?:\.\d+)?$/.test(s)) {
      throw new AgreementError(`阈值“${raw}”不是非负数字；请用万分数输入，例如 5000 表示 0.50。`);
    }

    let [intPart, fracPart = ''] = s.split('.');
    let digits = fracPart;
    while (digits.endsWith('0')) digits = digits.slice(0, -1);
    const decimals = digits.length;
    const numerator = BigInt(intPart + digits || '0');
    const scale = 10n ** BigInt(decimals);
    if (numerator > 10000n * scale) {
      throw new AgreementError(`阈值“${raw}”超出范围：万分数应在 0..10000 之间。`);
    }

    const canonical = decimals ? `${intPart}.${digits}` : intPart;
    return {
      canonical,
      key: canonical,
      numerator,
      scale,
      permyriad: Number(numerator) / Number(scale),
      ratio: Number(numerator) / (Number(scale) * 10000),
    };
  }

  function parseThresholds(input) {
    const rawTokens = Array.isArray(input)
      ? input
      : String(input ?? '').split(/[\s,，;；、|]+/u);
    const thresholds = [];
    const seen = new Set();

    for (const raw of rawTokens) {
      if (!String(raw).trim()) continue;
      const th = normalizeThresholdToken(raw);
      if (!th || seen.has(th.key)) continue;
      seen.add(th.key);
      thresholds.push(th);
    }

    if (thresholds.length === 0) throw new AgreementError('请至少输入一个重叠阈值。');
    if (thresholds.length > 32) throw new AgreementError(`最多同时比较 32 个阈值，当前有 ${thresholds.length} 个。`);
    return thresholds;
  }

  function buildDataset(truthImage, predictionImage, options = {}) {
    if (!truthImage || !predictionImage) throw new AgreementError('需要同时提供真值图和预测图。');
    if (truthImage.width !== predictionImage.width || truthImage.height !== predictionImage.height) {
      throw new AgreementError(
        `两图尺寸必须相同：真值 ${truthImage.width}×${truthImage.height}，预测 ${predictionImage.width}×${predictionImage.height}。`,
      );
    }

    const width = truthImage.width;
    const height = truthImage.height;
    const pixelCount = width * height;
    if (width > MAX_SIDE || height > MAX_SIDE || pixelCount > MAX_SIDE * MAX_SIDE) {
      throw new AgreementError(`图像超过 ${MAX_SIDE}×${MAX_SIDE} 限制。`);
    }

    const truth = truthImage.data;
    const prediction = predictionImage.data;
    if (!(truth instanceof Uint16Array) || !(prediction instanceof Uint16Array)) {
      throw new AgreementError('解析后的栅格必须是 Uint16Array。');
    }
    if (truth.length !== pixelCount || prediction.length !== pixelCount) {
      throw new AgreementError('栅格长度与头部声明的尺寸不一致。');
    }

    const truthRawCounts = new Map();
    const predictionRawCounts = new Map();
    const truthAreasMap = new Map();
    const predictionAreasMap = new Map();
    const intersectionMap = new Map();

    let ignoredPixels = 0;
    let predictionIgnoreValuePixels = 0;

    for (let i = 0; i < pixelCount; i += 1) {
      const t = truth[i];
      const p = prediction[i];

      if (t !== 0) truthRawCounts.set(t, (truthRawCounts.get(t) ?? 0) + 1);
      if (p !== 0) predictionRawCounts.set(p, (predictionRawCounts.get(p) ?? 0) + 1);

      // The supplied P5 convention reserves 65535 in predictions as well.
      // Count it explicitly even if it lies under a truth ignore pixel.
      if (p === IGNORE_ID) predictionIgnoreValuePixels += 1;

      // Truth 65535 is the ignore mask. Pixels there are absent from both
      // area calculations and from every intersection/union.
      if (t === IGNORE_ID) {
        ignoredPixels += 1;
        continue;
      }

      if (t > 0) truthAreasMap.set(t, (truthAreasMap.get(t) ?? 0) + 1);
      if (p > 0 && p !== IGNORE_ID) {
        predictionAreasMap.set(p, (predictionAreasMap.get(p) ?? 0) + 1);
      }
      if (t > 0 && p > 0 && p !== IGNORE_ID) {
        const key = t * 65536 + p;
        intersectionMap.set(key, (intersectionMap.get(key) ?? 0) + 1);
      }
    }

    if (predictionIgnoreValuePixels > 0 && options.allowPredictionIgnore !== true) {
      throw new AgreementError(
        `预测图含有保留值 65535（${predictionIgnoreValuePixels} 像素）；按样例格式，预测编号只能是 0..65534。`,
      );
    }

    const truthIds = [...truthAreasMap.keys()].sort((a, b) => a - b);
    const predictionIds = [...predictionAreasMap.keys()].sort((a, b) => a - b);

    if (truthIds.length > MAX_INSTANCES_PER_SIDE) {
      throw new AgreementError(`真值参与匹配的实例有 ${truthIds.length} 个，每边最多 ${MAX_INSTANCES_PER_SIDE} 个。`);
    }
    if (predictionIds.length > MAX_INSTANCES_PER_SIDE) {
      throw new AgreementError(`预测参与匹配的实例有 ${predictionIds.length} 个，每边最多 ${MAX_INSTANCES_PER_SIDE} 个。`);
    }

    const truthIndex = new Map(truthIds.map((id, i) => [id, i]));
    const predictionIndex = new Map(predictionIds.map((id, i) => [id, i]));
    const nT = truthIds.length;
    const nP = predictionIds.length;

    const truthAreas = truthIds.map((id) => truthAreasMap.get(id));
    const predictionAreas = predictionIds.map((id) => predictionAreasMap.get(id));
    const intersections = new Int32Array(Math.max(1, nT * nP));

    for (const [key, count] of intersectionMap) {
      const tId = Math.floor(key / 65536);
      const pId = key % 65536;
      const ti = truthIndex.get(tId);
      const pj = predictionIndex.get(pId);
      if (ti === undefined || pj === undefined) continue;
      intersections[ti * nP + pj] = count;
    }

    const truthCentroidX = new Float64Array(nT);
    const truthCentroidY = new Float64Array(nT);
    const predictionCentroidX = new Float64Array(nP);
    const predictionCentroidY = new Float64Array(nP);

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const i = row + x;
        if (truth[i] === IGNORE_ID) continue;
        const t = truth[i];
        const p = prediction[i];
        if (t > 0) {
          const ti = truthIndex.get(t);
          truthCentroidX[ti] += x;
          truthCentroidY[ti] += y;
        }
        if (p > 0 && p !== IGNORE_ID) {
          const pj = predictionIndex.get(p);
          predictionCentroidX[pj] += x;
          predictionCentroidY[pj] += y;
        }
      }
    }

    const truthObjects = truthIds.map((id, i) => ({
      side: 'truth',
      id,
      index: i,
      area: truthAreas[i],
      centroid: { x: truthCentroidX[i] / truthAreas[i], y: truthCentroidY[i] / truthAreas[i] },
    }));
    const predictionObjects = predictionIds.map((id, i) => ({
      side: 'prediction',
      id,
      index: i,
      area: predictionAreas[i],
      centroid: { x: predictionCentroidX[i] / predictionAreas[i], y: predictionCentroidY[i] / predictionAreas[i] },
    }));

    const excludedTruth = [];
    for (const [id, rawArea] of [...truthRawCounts.entries()].sort((a, b) => a[0] - b[0])) {
      if (id === IGNORE_ID) continue;
      if (!truthAreasMap.has(id)) excludedTruth.push({ id, rawArea, reason: '有效区域面积为 0' });
    }
    const excludedPrediction = [];
    for (const [id, rawArea] of [...predictionRawCounts.entries()].sort((a, b) => a[0] - b[0])) {
      if (id === IGNORE_ID) continue;
      if (!predictionAreasMap.has(id)) {
        excludedPrediction.push({ id, rawArea, reason: '全部像素位于真值 65535 忽略区' });
      }
    }

    return {
      width,
      height,
      pixelCount,
      truth,
      prediction,
      ignoreId: IGNORE_ID,
      ignoredPixels,
      validPixels: pixelCount - ignoredPixels,
      truthIds,
      predictionIds,
      truthIndex,
      predictionIndex,
      truthAreas,
      predictionAreas,
      intersections,
      truthObjects,
      predictionObjects,
      excludedTruth,
      excludedPrediction,
      truthImageMeta: { maxval: truthImage.maxval, bitDepth: truthImage.bitDepth },
      predictionImageMeta: { maxval: predictionImage.maxval, bitDepth: predictionImage.bitDepth },
    };
  }

  function getOverlap(dataset, truthIndexValue, predictionIndexValue) {
    const nP = dataset.predictionIds.length;
    const intersection = dataset.intersections[truthIndexValue * nP + predictionIndexValue] ?? 0;
    const union = dataset.truthAreas[truthIndexValue] + dataset.predictionAreas[predictionIndexValue] - intersection;
    const iouMillionFloor = union > 0 ? Math.floor((intersection * MILLION) / union) : 0;
    return { intersection, union, iouMillionFloor };
  }

  function isEligible(dataset, ti, pj, threshold) {
    const { intersection, union } = getOverlap(dataset, ti, pj);
    if (intersection === 0 || union <= 0) return false;
    // Exact comparison, no floating-point threshold test:
    // inter / union >= numerator / (scale * 10000).
    return (
      BigInt(intersection) * 10000n * threshold.scale >=
      threshold.numerator * BigInt(union)
    );
  }

  /*
   * Rectangular Hungarian primal-dual assignment with BigInt costs. The page
   * does not call a third-party matcher: this optimizes the exact composite
   * objective described in the task. Rows <= columns; a taller matrix is
   * transposed and its assignment is mapped back to the original rows.
   */
  function hungarianMaxWeight(weights) {
    const originalRows = weights.length;
    if (originalRows === 0) return [];
    const originalCols = weights[0].length;
    if (originalCols === 0) return new Array(originalRows).fill(-1);

    let matrix = weights;
    let transposed = false;
    if (originalRows > originalCols) {
      transposed = true;
      matrix = Array.from({ length: originalCols }, (_, col) =>
        Array.from({ length: originalRows }, (_, row) => weights[row][col]));
    }

    const n = matrix.length;
    const m = matrix[0].length; // n <= m
    let maxWeight = 0n;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < m; j += 1) if (matrix[i][j] > maxWeight) maxWeight = matrix[i][j];
    }
    // Constant shift per edge turns maximization into minimization without
    // changing which assignment is optimal.
    const costs = matrix.map((row) => row.map((w) => maxWeight - w));
    const INF = 1n << 8192n;

    const u = new Array(n + 1).fill(0n);
    const v = new Array(m + 1).fill(0n);
    const p = new Array(m + 1).fill(0); // p[j] = row assigned to column j
    const way = new Array(m + 1).fill(0);

    for (let i = 1; i <= n; i += 1) {
      p[0] = i;
      let j0 = 0;
      const minv = new Array(m + 1).fill(INF);
      const used = new Array(m + 1).fill(false);

      do {
        used[j0] = true;
        const i0 = p[j0];
        let delta = INF;
        let j1 = 0;

        for (let j = 1; j <= m; j += 1) {
          if (used[j]) continue;
          const cur = costs[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }

        for (let j = 0; j <= m; j += 1) {
          if (used[j]) {
            u[p[j]] += delta;
            v[j] -= delta;
          } else {
            minv[j] -= delta;
          }
        }
        j0 = j1;
      } while (p[j0] !== 0);

      do {
        const j1 = way[j0];
        p[j0] = p[j1];
        j0 = j1;
      } while (j0 !== 0);
    }

    const rowToColumn = new Array(n).fill(-1);
    for (let j = 1; j <= m; j += 1) {
      if (p[j] !== 0) rowToColumn[p[j] - 1] = j - 1;
    }

    if (!transposed) return rowToColumn;

    // Transposed rows were original columns and transposed columns were
    // original rows. Convert back to original-row -> original-column.
    const originalAssignment = new Array(originalRows).fill(-1);
    for (let transposedRow = 0; transposedRow < n; transposedRow += 1) {
      const originalColumn = transposedRow;
      const originalRow = rowToColumn[transposedRow];
      if (originalRow >= 0) originalAssignment[originalRow] = originalColumn;
    }
    return originalAssignment;
  }

  function matchThreshold(dataset, thresholdInput) {
    const threshold = thresholdInput?.numerator !== undefined
      ? thresholdInput
      : parseThresholds([thresholdInput])[0];

    const nT = dataset.truthIds.length;
    const nP = dataset.predictionIds.length;
    const base = BigInt(nP + 1);
    const lexSpace = base ** BigInt(nT);
    const maxPairs = Math.min(nT, nP);
    // One additional pair must outweigh every possible IoU/lex contribution.
    const cardinalityUnit = (BigInt(Math.max(1, maxPairs) * MILLION) + 1n) * lexSpace;

    const powers = new Array(Math.max(nT, 1)).fill(0n);
    if (nT > 0) {
      powers[nT - 1] = 1n;
      for (let i = nT - 2; i >= 0; i -= 1) powers[i] = powers[i + 1] * base;
    }

    const weights = Array.from({ length: nT }, () => new Array(nP).fill(0n));
    const eligibleEdges = [];

    for (let ti = 0; ti < nT; ti += 1) {
      for (let pj = 0; pj < nP; pj += 1) {
        const overlap = getOverlap(dataset, ti, pj);
        if (!isEligible(dataset, ti, pj, threshold)) continue;

        const lexReward = nT > 0 ? BigInt(nP - pj) * powers[ti] : 0n;
        weights[ti][pj] =
          cardinalityUnit + BigInt(overlap.iouMillionFloor) * lexSpace + lexReward;

        eligibleEdges.push({
          truthIndex: ti,
          predictionIndex: pj,
          truthId: dataset.truthIds[ti],
          predictionId: dataset.predictionIds[pj],
          ...overlap,
        });
      }
    }

    const assignment = hungarianMaxWeight(weights);
    const pairs = [];
    const matchedTruth = new Set();
    const matchedPrediction = new Set();
    let scoreMillionTotal = 0;

    for (let ti = 0; ti < nT; ti += 1) {
      const pj = assignment[ti];
      if (pj < 0 || pj >= nP || weights[ti][pj] === 0n) continue;
      const overlap = getOverlap(dataset, ti, pj);
      if (overlap.intersection === 0) continue;

      const pair = {
        truthIndex: ti,
        predictionIndex: pj,
        truthId: dataset.truthIds[ti],
        predictionId: dataset.predictionIds[pj],
        intersectionArea: overlap.intersection,
        unionArea: overlap.union,
        iouMillionFloor: overlap.iouMillionFloor,
        iouExact: `${overlap.intersection}/${overlap.union}`,
        iou: overlap.intersection / overlap.union,
      };
      pairs.push(pair);
      matchedTruth.add(ti);
      matchedPrediction.add(pj);
      scoreMillionTotal += overlap.iouMillionFloor;
    }

    const unmatchedTruth = dataset.truthIds.filter((_, i) => !matchedTruth.has(i));
    const unmatchedPrediction = dataset.predictionIds.filter((_, i) => !matchedPrediction.has(i));

    return {
      thresholdPermyriad: threshold.canonical,
      thresholdRatio: threshold.ratio,
      threshold,
      eligibleEdgeCount: eligibleEdges.length,
      eligibleEdges: eligibleEdges.map((e) => ({
        truthId: e.truthId,
        predictionId: e.predictionId,
        intersectionArea: e.intersection,
        unionArea: e.union,
        iouMillionFloor: e.iouMillionFloor,
        iouExact: `${e.intersection}/${e.union}`,
        iou: e.intersection / e.union,
      })),
      pairs,
      unmatchedTruthIds: unmatchedTruth,
      unmatchedPredictionIds: unmatchedPrediction,
      scoreMillionTotal,
      counts: {
        truthInstances: nT,
        predictionInstances: nP,
        eligibleEdges: eligibleEdges.length,
        matchedPairs: pairs.length,
        matchedTruth: pairs.length,
        matchedPrediction: pairs.length,
        unmatchedTruth: unmatchedTruth.length,
        unmatchedPrediction: unmatchedPrediction.length,
        excludedTruth: dataset.excludedTruth.length,
        excludedPrediction: dataset.excludedPrediction.length,
      },
    };
  }

  function analyze(dataset, thresholdsInput) {
    const thresholds = parseThresholds(thresholdsInput);
    return thresholds.map((th) => matchThreshold(dataset, th));
  }

  function buildReport(dataset, results, meta = {}) {
    return {
      schema: 'instance-mask-agreement/v1',
      ...meta,
      image: {
        width: dataset.width,
        height: dataset.height,
        pixels: dataset.pixelCount,
        validPixels: dataset.validPixels,
        ignoredPixels: dataset.ignoredPixels,
        ignoreRule: 'truth value 65535 excludes that pixel from area and IoU for both images',
      },
      instances: {
        truth: dataset.truthObjects.map((o) => ({ id: o.id, area: o.area })),
        prediction: dataset.predictionObjects.map((o) => ({ id: o.id, area: o.area })),
        excludedTruth: dataset.excludedTruth,
        excludedPrediction: dataset.excludedPrediction,
      },
      tieBreaking: {
        objectiveOrder: [
          'maximize matched pair count',
          'maximize sum of floor(IoU * 1e6) per pair',
          'lexicographically minimize prediction IDs in ascending truth ID order; unmatched follows all numeric IDs',
        ],
        eligibility: 'intersection > 0 and exact intersection/union >= threshold/10000',
      },
      summary: results.map((r) => ({
        thresholdPermyriad: r.thresholdPermyriad,
        thresholdRatio: r.thresholdRatio,
        eligibleEdges: r.eligibleEdgeCount,
        matchedPairs: r.counts.matchedPairs,
        truthInstances: r.counts.truthInstances,
        predictionInstances: r.counts.predictionInstances,
        unmatchedTruth: r.counts.unmatchedTruth,
        unmatchedPrediction: r.counts.unmatchedPrediction,
        truthMatchRate: r.counts.truthInstances ? r.counts.matchedPairs / r.counts.truthInstances : null,
        predictionMatchRate: r.counts.predictionInstances
          ? r.counts.matchedPairs / r.counts.predictionInstances
          : null,
        scoreMillionTotal: r.scoreMillionTotal,
      })),
      thresholds: results.map((r) => ({
        thresholdPermyriad: r.thresholdPermyriad,
        thresholdRatio: r.thresholdRatio,
        counts: r.counts,
        scoreMillionTotal: r.scoreMillionTotal,
        pairs: r.pairs.map((p) => ({
          truthId: p.truthId,
          predictionId: p.predictionId,
          intersectionArea: p.intersectionArea,
          unionArea: p.unionArea,
          iou: p.iou,
          iouExact: p.iouExact,
          iouMillionFloor: p.iouMillionFloor,
        })),
        unmatchedTruthIds: r.unmatchedTruthIds,
        unmatchedPredictionIds: r.unmatchedPredictionIds,
      })),
    };
  }

  return {
    AgreementError,
    IGNORE_ID,
    MAX_SIDE,
    MAX_INSTANCES_PER_SIDE,
    parsePgm,
    parseThresholds,
    buildDataset,
    getOverlap,
    isEligible,
    hungarianMaxWeight,
    matchThreshold,
    analyze,
    buildReport,
  };
});
