'use strict';

const path = require('path');
const Core = require(path.join(__dirname, '..', 'radiosity-core.js'));

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function approx(a, b, tolerance = 1e-6) {
  return Number.isFinite(a) && Math.abs(a - b) <= tolerance;
}

function denseSolve(patches, links) {
  const n = patches.length;
  const F = Array.from({ length: n }, () => new Float64Array(n));
  for (const [i, j, f] of links) F[i][j] = f;

  const H = F.map((row, i) => row.map((fij, j) =>
    (patches[i].area * fij + patches[j].area * F[j][i]) / 2));
  const s = H.map((row, i) =>
    Math.max(1, row.reduce((sum, h) => sum + h, 0) / patches[i].area));

  return [0, 1, 2].map((channel) => {
    const matrix = H.map((row, i) => Array.from(row, (h, j) =>
      Number(i === j) -
      h * patches[i].rho[channel] / Math.max(s[i], s[j]) / patches[i].area
    ).concat(patches[i].E[channel]));

    for (let pivot = 0; pivot < n; pivot++) {
      let pivotRow = pivot;
      for (let r = pivot + 1; r < n; r++) {
        if (Math.abs(matrix[r][pivot]) > Math.abs(matrix[pivotRow][pivot])) pivotRow = r;
      }
      [matrix[pivot], matrix[pivotRow]] = [matrix[pivotRow], matrix[pivot]];

      const pivotValue = matrix[pivot][pivot];
      for (let j = pivot; j <= n; j++) matrix[pivot][j] /= pivotValue;

      for (let i = 0; i < n; i++) {
        if (i === pivot) continue;
        const factor = matrix[i][pivot];
        for (let j = pivot; j <= n; j++) {
          matrix[i][j] -= factor * matrix[pivot][j];
        }
      }
    }

    return matrix.map((row) => row[n]);
  });
}

function runToConverged(patches, corr) {
  const solver = Core.createSolver(patches, corr);
  let result;
  do {
    result = solver.step(50);
  } while (!result.done);
  return solver;
}

/* 1. 预置样例手算值 */
{
  const data = require(path.join(__dirname, '..', 'samples', 'reciprocal-patches.json'));
  const validation = Core.validateData(data);
  check('样例通过校验', validation.errors.length === 0, validation.errors.join('; '));

  const patches = Core.normalizePatches(data.patches);
  const corr = Core.buildCorrection(patches, data.links);

  check('H/G = 0.7', corr.eg.length === 1 && approx(corr.eg[0], 0.7, 1e-12), `G=${corr.eg[0]}`);
  check('s = [1, 1]', approx(corr.s[0], 1, 1e-12) && approx(corr.s[1], 1, 1e-12));
  check('出射比例 [0.7, 0.35]',
    approx(corr.outFrac[0], 0.7, 1e-12) && approx(corr.outFrac[1], 0.35, 1e-12));

  const solver = runToConverged(patches, corr);
  const stats = solver.stats();
  const expectedL0 = 1 / (1 - 0.4 * 0.7 * 0.5 * 0.35);
  const direct = denseSolve(data.patches, data.links);

  let maxError = 0;
  for (let i = 0; i < 2; i++) {
    for (let c = 0; c < 3; c++) {
      maxError = Math.max(maxError, Math.abs(solver.L[3 * i + c] - direct[c][i]));
    }
  }

  check('样例与稠密直接解一致', maxError <= 1e-6, `maxError=${maxError}`);
  check('样例误差上界 <= 1e-6', stats.converged && stats.errorBound <= Core.EXPORT_TOL,
    `bound=${stats.errorBound}`);
  check('样例红通道手算值', approx(solver.L[0], expectedL0, 1e-6),
    `${solver.L[0]} vs ${expectedL0}`);
}

/* 2. 缺失方向按零 */
{
  const patches = [
    { area: 1, rho: [.5, .5, .5], E: [0, 0, 0], rect: [0, 0, 1, 1] },
    { area: 2, rho: [.5, .5, .5], E: [0, 0, 0], rect: [1, 0, 1, 1] },
  ];
  const corr = Core.buildCorrection(patches, [[0, 1, 0.5]]);
  check('缺失方向：G = H = 0.25', corr.eg.length === 1 && approx(corr.eg[0], 0.25, 1e-12),
    `G=${corr.eg[0]}`);
}

/* 3. 过量行共同缩放、互易、出射上限 */
{
  const patches = [{ area: 0.5, rho: [.5, .5, .5], E: [0, 0, 0], rect: [0, 0, 1, 1] }];
  const links = [];
  for (let j = 1; j <= 4; j++) {
    patches.push({ area: 2, rho: [.5, .5, .5], E: [0, 0, 0], rect: [j, 0, 1, 1] });
    links.push([0, j, 0.9]);
  }

  const corr = Core.buildCorrection(patches, links);
  check('s(0) = 1.8', approx(corr.s[0], 1.8, 1e-12), `s0=${corr.s[0]}`);
  check('G = 0.125', corr.eg.every((g) => approx(g, 0.125, 1e-12)));
  check('总出射比例 <= 1', corr.outFrac.every((f) => f <= 1 + 1e-10),
    `max=${Math.max(...corr.outFrac)}`);

  let reciprocal = true;
  for (let k = 0; k < corr.eu.length; k++) {
    const a = corr.eu[k];
    const b = corr.ev[k];
    for (let p = corr.adjStart[a]; p < corr.adjStart[a + 1]; p++) {
      if (corr.adjJ[p] === b && !approx(corr.adjG[p], corr.eg[k], 1e-15)) reciprocal = false;
    }
    for (let p = corr.adjStart[b]; p < corr.adjStart[b + 1]; p++) {
      if (corr.adjJ[p] === a && !approx(corr.adjG[p], corr.eg[k], 1e-15)) reciprocal = false;
    }
  }
  check('CSR 两方向 G 相等', reciprocal);
}

/* 4. 随机小场景对照稠密解 */
{
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const n = 10;
  const raw = [];
  for (let i = 0; i < n; i++) {
    raw.push({
      area: 0.25 + 3 * rnd(),
      rho: [.9 * rnd(), .9 * rnd(), .9 * rnd()],
      E: [rnd(), rnd(), rnd()],
      rect: [i, 0, 1, 1],
    });
  }

  const links = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && rnd() < .32) links.push([i, j, rnd()]);
    }
  }

  const patches = Core.normalizePatches(raw);
  const corr = Core.buildCorrection(patches, links);
  check('随机场景出射 <= 1', corr.outFrac.every((x) => x <= 1 + 1e-10));

  const solver = runToConverged(patches, corr);
  const stats = solver.stats();
  const direct = denseSolve(raw, links);
  let maxError = 0;

  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      maxError = Math.max(maxError, Math.abs(solver.L[3 * i + c] - direct[c][i]));
    }
  }

  check('随机场景收敛', stats.converged && stats.errorBound <= Core.EXPORT_TOL,
    `bound=${stats.errorBound}`);
  check('随机场景每通道误差 <= 1e-6', maxError <= 1e-6, `maxError=${maxError}`);
}

/* 5. 非法边记录行号 */
{
  const data = {
    patches: [
      { area: 1, rho: [.5, .5, .5], E: [0, 0, 0] },
      { area: 1, rho: [.5, .5, .5], E: [0, 0, 0] },
    ],
    links: [
      [0, 1, .5],
      [0, 0, .1],
      [0, 1, .2],
      [1, 9, .3],
      [1, 0, 1.5],
    ],
  };
  const text = Core.validateData(data).errors.join('\n');
  check('自连报第 2 行', /第 2 行/.test(text), text);
  check('重复报第 3 行', /第 3 行/.test(text), text);
  check('越界报第 4 行', /第 4 行/.test(text), text);
  check('F 超界报第 5 行', /第 5 行/.test(text), text);
  check('合法第 1 行不误报', !/第 1 行/.test(text), text);
}

/* 6. 数量上限 */
{
  const tooManyPatches = Core.validateData({
    patches: new Array(4097).fill({ area: 1, rho: [0, 0, 0], E: [0, 0, 0] }),
    links: [],
  });
  check('补丁 > 4096 报错', tooManyPatches.errors.some((e) => e.includes('4096')));

  const tooManyLinks = Core.validateData({
    patches: [{ area: 1, rho: [0, 0, 0], E: [0, 0, 0] }],
    links: new Array(300001).fill([0, 0, 0]),
  });
  check('边 > 300000 报错', tooManyLinks.errors.some((e) => e.includes('300000')));
}

/* 7. 极端面积：评审发现的 NaN/导出错误回归 */
for (const area of [1e308, 1e-310, Number.MAX_VALUE, Number.MIN_VALUE]) {
  const scene = {
    patches: [
      { area, rho: [.5, .5, .5], E: [1, 1, 1] },
      { area, rho: [.5, .5, .5], E: [1, 1, 1] },
    ],
    links: [[0, 1, 1], [1, 0, 1]],
  };

  const validation = Core.validateData(scene);
  const patches = Core.normalizePatches(scene.patches);
  const corr = Core.buildCorrection(patches, scene.links);
  const solver = runToConverged(patches, corr);
  const stats = solver.stats();

  let maxError = 0;
  let allFinite = true;
  for (let i = 0; i < 2; i++) {
    for (let c = 0; c < 3; c++) {
      const value = solver.L[3 * i + c];
      allFinite = allFinite && Number.isFinite(value);
      maxError = Math.max(maxError, Math.abs(value - 2));
    }
  }

  check(`极端面积 ${area} 校验合法`, validation.errors.length === 0, validation.errors.join(';'));
  check(`极端面积 ${area} 结果有限且为 2±1e-6`, allFinite && maxError <= 1e-6,
    `maxError=${maxError}, L0=${Array.from(solver.L.slice(0, 3))}`);
  check(`极端面积 ${area} 误差上界达标`, stats.converged && stats.errorBound <= Core.EXPORT_TOL,
    `bound=${stats.errorBound}`);
}

/* 8. 4096 / 294912 环形性能 */
{
  const started = process.hrtime.bigint();
  const ring = Core.generateRingSample(4096, 36);

  check('环形边数 = 294912', ring.links.length === 4096 * 72, `links=${ring.links.length}`);
  const validation = Core.validateData(ring);
  check('环形数据合法', validation.errors.length === 0, validation.errors.slice(0, 3).join('; '));

  const patches = Core.normalizePatches(ring.patches);
  const corr = Core.buildCorrection(patches, ring.links);
  check('环形出射 <= 1', corr.outFrac.every((x) => x <= 1 + 1e-9),
    `max=${Math.max(...corr.outFrac)}`);

  const solver = runToConverged(patches, corr);
  const stats = solver.stats();
  const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;

  check('环形收敛到导出精度', stats.converged && stats.errorBound <= Core.EXPORT_TOL,
    `bound=${stats.errorBound}, sweeps=${stats.sweeps}`);
  check('环形核心流程 <= 12 秒', milliseconds <= 12000, `${milliseconds.toFixed(0)} ms`);
  console.log(`  info  ring: ${ring.links.length} links, ${stats.sweeps} sweeps, ` +
    `bound=${stats.errorBound.toExponential(2)}, ${milliseconds.toFixed(0)} ms`);
}

/* 9. 最恶劣均匀高反射率端到端数值 */
{
  const n = 4096;
  const patches = [];
  const links = [];
  for (let i = 0; i < n; i++) {
    patches.push({ area: 1, rho: [.98, .98, .98], E: [1, 1, 1] });
    for (let d = 1; d <= 36; d++) {
      links.push([i, (i + d) % n, 1 / 72]);
      links.push([i, (i - d + n) % n, 1 / 72]);
    }
  }

  const started = process.hrtime.bigint();
  const normalized = Core.normalizePatches(patches);
  const corr = Core.buildCorrection(normalized, links);
  const solver = runToConverged(normalized, corr);
  const stats = solver.stats();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  let maxError = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) maxError = Math.max(maxError, Math.abs(solver.L[3 * i + c] - 50));
  }

  check('均匀高反射率稳态为 50±1e-6', maxError <= 1e-6, `maxError=${maxError}`);
  check('均匀高反射率误差上界达标', stats.converged && stats.errorBound <= Core.EXPORT_TOL,
    `bound=${stats.errorBound}, sweeps=${stats.sweeps}`);
  check('均匀高反射率核心流程 <= 12 秒', ms <= 12000, `${ms.toFixed(0)} ms`);
  console.log(`  info  uniform ring: ${stats.sweeps} sweeps, maxError=${maxError.toExponential(2)}, ${ms.toFixed(0)} ms`);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
