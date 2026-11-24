/*
 * radiosity-core.js — 互易辐射度校正与三通道稳态求解
 *
 * 与 samples/reciprocal-patches.json 中给出的规则保持一致：
 *   H(i,j) = (Ai*Fij + Aj*Fji) / 2
 *   s(i)   = max(1, sum_j H(i,j)/Ai)
 *   G(i,j) = H(i,j) / max(s(i), s(j))
 *   L(i)   = E(i) + rho(i) * sum_j G(i,j)*L(j)/Ai
 *
 * 浏览器和 Node 均可加载。内部使用对数尺度累计大面积/极小面积，避免
 * 1e308 + 1e308 这类合法输入先溢出为 Infinity 再产生 NaN。
 */
(function (global) {
  'use strict';

  const MAX_PATCHES = 4096;
  const MAX_LINKS = 300000;
  const RHO_LIMIT = 0.98;
  const EXPORT_TOL = 1e-6;
  const SOLVE_TARGET = 4e-7; // 给导出容差和浮点误差留余量
  const SWEEP_CAP = 20000;
  const LN2 = Math.LN2;

  function edgeKey(i, j, n) {
    return i * n + j;
  }

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /* ---------------- 数据校验：边错误使用记录行号 ---------------- */
  function validateData(data) {
    const errors = [];
    let overflow = 0;
    const push = (message) => {
      if (errors.length < 200) errors.push(message);
      else overflow += 1;
    };

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return {
        errors: ['根节点必须是包含 patches 与 links 的对象'],
        overflow: 0,
      };
    }

    const patches = data.patches;
    const links = data.links;
    const patchArrayOk = Array.isArray(patches);
    const n = patchArrayOk ? patches.length : 0;

    if (!patchArrayOk || n === 0) push('patches 必须是非空数组');
    if (n > MAX_PATCHES) push(`补丁数量 ${n} 超过上限 ${MAX_PATCHES}`);

    if (patchArrayOk && n > 0 && n <= MAX_PATCHES) {
      for (let i = 0; i < n; i++) {
        const p = patches[i];
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
          push(`补丁 #${i}: 不是对象`);
          continue;
        }

        if (!isFiniteNumber(p.area) || p.area <= 0) {
          push(`补丁 #${i}: area 须为正有限数`);
        }

        const checkRGB = (value, name, min, max) => {
          if (!Array.isArray(value) || value.length !== 3 ||
              value.some((x) => !isFiniteNumber(x) || x < min || x > max)) {
            push(`补丁 #${i}: ${name} 须为 [${min}, ${max}] 内的 RGB 三元组`);
          }
        };
        checkRGB(p.rho, 'rho', 0, RHO_LIMIT);
        checkRGB(p.E, 'E', 0, 1);

        if (p.rect !== undefined) {
          const rectOk = Array.isArray(p.rect) && p.rect.length === 4 &&
            p.rect.every(isFiniteNumber) && p.rect[2] > 0 && p.rect[3] > 0;
          if (!rectOk) {
            push(`补丁 #${i}: rect 须为 [x, y, w, h]，且宽高为正有限数`);
          }
        }
      }
    }

    if (!Array.isArray(links)) {
      push('links 必须是数组');
    }
    const m = Array.isArray(links) ? links.length : 0;
    if (m > MAX_LINKS) push(`可见记录数量 ${m} 超过上限 ${MAX_LINKS}`);

    // 超过总上限后不再逐行展开，避免 30 万条以上的测试数组造成无意义工作。
    if (Array.isArray(links) && m > 0 && m <= MAX_LINKS &&
        n > 0 && n <= MAX_PATCHES) {
      const seenDirected = new Set();

      for (let index = 0; index < m; index++) {
        const line = index + 1;
        const row = links[index];

        if (!Array.isArray(row) || row.length !== 3) {
          push(`第 ${line} 行: 边须为 [i, j, F] 三元组`);
          continue;
        }

        const i = row[0];
        const j = row[1];
        const f = row[2];
        const endpointsOk = Number.isInteger(i) && Number.isInteger(j) &&
          i >= 0 && j >= 0 && i < n && j < n;

        if (!endpointsOk) {
          push(`第 ${line} 行: 端点编号越界或不是整数（i=${String(i)}, j=${String(j)}）`);
        } else if (i === j) {
          push(`第 ${line} 行: 禁止自连边（${i}→${j}）`);
        }

        if (!isFiniteNumber(f) || f < 0 || f > 1) {
          push(`第 ${line} 行: F=${String(f)} 超出 [0, 1]`);
        }

        if (endpointsOk && i !== j) {
          const key = edgeKey(i, j, n);
          if (seenDirected.has(key)) {
            push(`第 ${line} 行: 重复有向边 ${i}→${j}`);
          } else {
            seenDirected.add(key);
          }
        }
      }
    }

    return { errors, overflow };
  }

  /* ---------------- 规范化：缺 rect 时生成稳定网格 ---------------- */
  function normalizePatches(rawPatches) {
    const n = rawPatches.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));

    return rawPatches.map((p, i) => ({
      area: p.area,
      rho: [Number(p.rho[0]), Number(p.rho[1]), Number(p.rho[2])],
      E: [Number(p.E[0]), Number(p.E[1]), Number(p.E[2])],
      rect: Array.isArray(p.rect)
        ? [p.rect[0], p.rect[1], p.rect[2], p.rect[3]]
        : [(i % cols) * 1.08, Math.floor(i / cols) * 1.08, 1, 1],
    }));
  }

  function logSumExpTwo(a, b) {
    if (a === -Infinity) return b;
    if (b === -Infinity) return a;
    const m = a > b ? a : b;
    return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
  }

  function finiteExp(x) {
    if (x === -Infinity || x < -745.1332191019411) return 0;
    if (x > 709.782712893384) return Number.MAX_VALUE;
    return Math.exp(x);
  }

  /* ---------------- 互易化和两端共同缩放 ---------------- */
  function buildCorrection(patches, links) {
    const n = patches.length;
    const area = new Float64Array(n);
    const logArea = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      area[i] = patches[i].area;
      logArea[i] = Math.log(area[i]);
    }

    // 已校验数据中同一有向边唯一；Map 也让反向缺失自然取 0。
    const directedF = new Map();
    for (let k = 0; k < links.length; k++) {
      const row = links[k];
      directedF.set(edgeKey(row[0], row[1], n), row[2]);
    }

    const uList = [];
    const vList = [];
    const logHList = [];
    const logQUList = [];
    const logQVList = [];

    // 每行 q(i,e)=H(i,e)/Ai 的 log-sum-exp 累加器。
    const rowMax = new Float64Array(n);
    const rowRelativeSum = new Float64Array(n);
    rowMax.fill(-Infinity);

    function addRowContribution(i, logQ) {
      if (logQ === -Infinity) return;
      if (logQ > rowMax[i]) {
        rowRelativeSum[i] = rowMax[i] === -Infinity
          ? 1
          : rowRelativeSum[i] * Math.exp(rowMax[i] - logQ) + 1;
        rowMax[i] = logQ;
      } else {
        rowRelativeSum[i] += Math.exp(logQ - rowMax[i]);
      }
    }

    const seenPair = new Set();

    for (let k = 0; k < links.length; k++) {
      const row = links[k];
      const i = row[0];
      const j = row[1];
      const a = i < j ? i : j;
      const b = i < j ? j : i;
      const pairKey = edgeKey(a, b, n);

      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);

      const fab = directedF.get(edgeKey(a, b, n)) || 0;
      const fba = directedF.get(edgeKey(b, a, n)) || 0;

      const termA = fab > 0 ? logArea[a] + Math.log(fab) : -Infinity;
      const termB = fba > 0 ? logArea[b] + Math.log(fba) : -Infinity;
      const logSumTerms = logSumExpTwo(termA, termB);

      // 两条有向记录都为 F=0 时没有交换量。
      if (logSumTerms === -Infinity) continue;

      // H = 0.5 * (Aa*Fab + Ab*Fba)
      const logH = logSumTerms - LN2;
      const logQA = logH - logArea[a];
      const logQB = logH - logArea[b];

      const edgeIndex = uList.length;
      uList.push(a);
      vList.push(b);
      logHList.push(logH);
      logQUList.push(logQA);
      logQVList.push(logQB);

      addRowContribution(a, logQA);
      addRowContribution(b, logQB);
    }

    const edgeCount = uList.length;
    const eu = new Int32Array(uList);
    const ev = new Int32Array(vList);
    const logH = Float64Array.from(logHList);
    const logQU = Float64Array.from(logQUList);
    const logQV = Float64Array.from(logQVList);

    const s = new Float64Array(n);
    const logS = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      if (rowMax[i] === -Infinity) {
        logS[i] = 0;
        s[i] = 1;
      } else {
        const logRowQ = rowMax[i] + Math.log(rowRelativeSum[i]);
        logS[i] = Math.max(0, logRowQ);
        s[i] = finiteExp(logS[i]);
      }
    }

    const eg = new Float64Array(edgeCount);
    const coeffU = new Float64Array(edgeCount);
    const coeffV = new Float64Array(edgeCount);

    for (let k = 0; k < edgeCount; k++) {
      const u = eu[k];
      const v = ev[k];
      const commonLogScale = Math.max(logS[u], logS[v]);
      const logG = logH[k] - commonLogScale;

      eg[k] = finiteExp(logG);
      coeffU[k] = finiteExp(logQU[k] - commonLogScale);
      coeffV[k] = finiteExp(logQV[k] - commonLogScale);
    }

    // 双向 CSR：adjG 是互易的实际 G；adjCoeff 是各行的 G/Ai。
    const degree = new Int32Array(n);
    for (let k = 0; k < edgeCount; k++) {
      degree[eu[k]] += 1;
      degree[ev[k]] += 1;
    }

    const adjStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + degree[i];

    const directedCount = 2 * edgeCount;
    const adjJ = new Int32Array(directedCount);
    const adjG = new Float64Array(directedCount);
    const adjCoeff = new Float64Array(directedCount);
    const cursor = adjStart.slice(0, n);

    for (let k = 0; k < edgeCount; k++) {
      const a = eu[k];
      const b = ev[k];
      const g = eg[k];

      let p = cursor[a]++;
      adjJ[p] = b;
      adjG[p] = g;
      adjCoeff[p] = coeffU[k];

      p = cursor[b]++;
      adjJ[p] = a;
      adjG[p] = g;
      adjCoeff[p] = coeffV[k];
    }

    // 每块总出射比例 sum_j G(i,j)/Ai，数学上 <= 1。使用 Kahan 求和降低误差。
    const outFrac = new Float64Array(n);
    const compensation = new Float64Array(n);
    for (let k = 0; k < edgeCount; k++) {
      const a = eu[k];
      const b = ev[k];

      let y = coeffU[k] - compensation[a];
      let t = outFrac[a] + y;
      compensation[a] = t - outFrac[a] - y;
      outFrac[a] = t;

      y = coeffV[k] - compensation[b];
      t = outFrac[b] + y;
      compensation[b] = t - outFrac[b] - y;
      outFrac[b] = t;
    }

    return {
      n,
      eu,
      ev,
      eg,
      s,
      logS,
      outFrac,
      adjStart,
      adjJ,
      adjG,
      adjCoeff,
    };
  }

  /* ---------------- 三通道多次反弹稳态 ---------------- */
  function createSolver(patches, correction) {
    const n = correction.n;
    const rho = new Float64Array(3 * n);
    const E = new Float64Array(3 * n);
    const coeff = correction.adjCoeff;
    const hasCoeff = coeff instanceof Float64Array;

    let rhoMax = 0;
    let contraction = 0;

    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const r = patches[i].rho[c];
        rho[3 * i + c] = r;
        E[3 * i + c] = patches[i].E[c];
        if (r > rhoMax) rhoMax = r;
      }

      let rowSum = 0;
      for (let p = correction.adjStart[i]; p < correction.adjStart[i + 1]; p++) {
        if (hasCoeff) {
          rowSum += coeff[p];
        } else {
          rowSum += correction.adjG[p] / patches[i].area;
        }
      }
      // 无穷范数下，通道 c 的放大系数为 rho_ic * rowSum_i。
      for (let c = 0; c < 3; c++) {
        const q = rho[3 * i + c] * rowSum;
        if (q > contraction) contraction = q;
      }
    }

    const contractionCertifiable = Number.isFinite(contraction) && contraction < 1;
    if (!contractionCertifiable) {
      contraction = Number.isFinite(contraction) ? contraction : Infinity;
    }

    const L = new Float64Array(E);
    const adjStart = correction.adjStart;
    const adjJ = correction.adjJ;
    const adjG = correction.adjG;

    let sweeps = 0;
    let lastDelta = Infinity;
    let maxResidual = Infinity;
    let errorBound = Infinity;
    let converged = false;
    let fatal = '';

    function incidenceCoefficient(i, p) {
      if (hasCoeff) return coeff[p];
      return adjG[p] / patches[i].area;
    }

    function sweep() {
      let maxDelta = 0;

      for (let i = 0; i < n; i++) {
        const begin = adjStart[i];
        const end = adjStart[i + 1];
        let sum0 = 0;
        let sum1 = 0;
        let sum2 = 0;

        for (let p = begin; p < end; p++) {
          const j3 = 3 * adjJ[p];
          const k = incidenceCoefficient(i, p);
          sum0 += k * L[j3];
          sum1 += k * L[j3 + 1];
          sum2 += k * L[j3 + 2];
        }

        const i3 = 3 * i;
        const next0 = E[i3] + rho[i3] * sum0;
        const next1 = E[i3 + 1] + rho[i3 + 1] * sum1;
        const next2 = E[i3 + 2] + rho[i3 + 2] * sum2;

        const d0 = Math.abs(next0 - L[i3]);
        const d1 = Math.abs(next1 - L[i3 + 1]);
        const d2 = Math.abs(next2 - L[i3 + 2]);
        if (d0 > maxDelta) maxDelta = d0;
        if (d1 > maxDelta) maxDelta = d1;
        if (d2 > maxDelta) maxDelta = d2;

        L[i3] = next0;
        L[i3 + 1] = next1;
        L[i3 + 2] = next2;
      }

      return maxDelta;
    }

    function residualNorm() {
      let maxRes = 0;

      for (let i = 0; i < n; i++) {
        const begin = adjStart[i];
        const end = adjStart[i + 1];
        let sum0 = 0;
        let sum1 = 0;
        let sum2 = 0;

        for (let p = begin; p < end; p++) {
          const j3 = 3 * adjJ[p];
          const k = incidenceCoefficient(i, p);
          sum0 += k * L[j3];
          sum1 += k * L[j3 + 1];
          sum2 += k * L[j3 + 2];
        }

        const i3 = 3 * i;
        const r0 = L[i3] - (E[i3] + rho[i3] * sum0);
        const r1 = L[i3 + 1] - (E[i3 + 1] + rho[i3 + 1] * sum1);
        const r2 = L[i3 + 2] - (E[i3 + 2] + rho[i3 + 2] * sum2);

        const a0 = Math.abs(r0);
        const a1 = Math.abs(r1);
        const a2 = Math.abs(r2);
        if (a0 > maxRes) maxRes = a0;
        if (a1 > maxRes) maxRes = a1;
        if (a2 > maxRes) maxRes = a2;
      }

      return maxRes;
    }

    function finishCheck() {
      maxResidual = residualNorm();

      if (!Number.isFinite(maxResidual) || !contractionCertifiable) {
        errorBound = Infinity;
        converged = false;
        fatal = contractionCertifiable ? '求解出现非有限值' : '行范数不小于 1，无法认证误差界';
        return;
      }

      // 无穷范数：||L-L*||inf <= ||residual||inf / (1-q)。
      const denominator = 1 - contraction;
      errorBound = maxResidual / denominator;
      converged = Number.isFinite(errorBound) && errorBound <= SOLVE_TARGET;
      if (!converged && sweeps >= SWEEP_CAP) {
        fatal = `达到 ${SWEEP_CAP} 次迭代上限`;
      }
    }

    function step(maxSweeps) {
      const count = Math.max(1, maxSweeps | 0);

      for (let k = 0; k < count; k++) {
        lastDelta = sweep();
        sweeps += 1;

        if (!Number.isFinite(lastDelta)) {
          finishCheck();
          return { done: true, sweeps };
        }
      }

      finishCheck();
      if (converged || sweeps >= SWEEP_CAP) {
        return { done: true, sweeps };
      }
      return { done: false, sweeps };
    }

    return {
      L,
      step,
      stats() {
        return {
          sweeps,
          lastDelta,
          maxResidual,
          errorBound,
          converged,
          fatal,
          rhoMax,
          contraction,
        };
      },
    };
  }

  /* ---------------- 4096 块环形压测样例 ---------------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function generateRingSample(n = 4096, k = 36) {
    n = n || 4096;
    k = k || 36;
    const random = mulberry32(20261125);
    const patches = [];
    const links = [];
    const radius = (n * 1.05) / (2 * Math.PI);
    const round4 = (x) => Math.round(x * 10000) / 10000;
    const round6 = (x) => Math.round(x * 1e6) / 1e6;

    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * i) / n;
      const area = round4(0.5 + 1.5 * random());
      const baseRho = 0.45 + 0.4 * random();
      const emitter = i % 256 === 0;

      patches.push({
        area,
        rect: [
          round4(radius * Math.cos(angle)),
          round4(radius * Math.sin(angle)),
          0.9,
          0.9,
        ],
        rho: [round4(baseRho), round4(baseRho * 0.9), round4(baseRho * 0.8)],
        E: emitter ? [1, 0.85, 0.6] : [0, 0, 0],
      });
    }

    for (let i = 0; i < n; i++) {
      for (let d = 1; d <= k; d++) {
        const fClockwise = round6(0.011 * (0.9 + 0.2 * random()));
        const fCounter = round6(0.011 * (0.9 + 0.2 * random()));
        links.push([i, (i + d) % n, fClockwise]);
        links.push([i, (i - d + n) % n, fCounter]);
      }
    }

    return { patches, links };
  }

  const api = {
    MAX_PATCHES,
    MAX_LINKS,
    RHO_LIMIT,
    EXPORT_TOL,
    SOLVE_TARGET,
    SWEEP_CAP,
    validateData,
    normalizePatches,
    buildCorrection,
    createSolver,
    generateRingSample,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.RadiosityCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
