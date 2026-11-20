// 引擎单元测试：坐标/镜像/参考中心、DCT 与 Hadamard 原始样例、
// 候选枚举与组选幂次、与独立朴素实现逐值对照、边界与零噪声、取消。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mirrorIndex, patchOffsets, referenceCenters, buildPatchIndexMap } from '../lib/layout.js';
import { dctMatrix, dct2, idct2, hadamardMatrix, groupTransform, inverseGroupTransform } from '../lib/transform.js';
import {
  runDenoise,
  inspectGroup,
  matchGroup,
  validateParams,
  validateImage,
  psnr,
  DEFAULT_PARAMS,
} from '../lib/engine.js';
import { decodePNG } from '../lib/png.js';
import { SAMPLES } from '../app/js/samples.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(HERE, '..', 'samples', 'extracted');

async function loadSample(name) {
  // 优先读取解压目录；缺失时回退到页面内嵌样例，测试不依赖预解压步骤。
  try {
    return decodePNG(await readFile(join(SAMPLE_DIR, name)));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const key = name.replace(/\.png$/, '');
    const sample = SAMPLES[key];
    if (!sample) throw err;
    return decodePNG(Uint8Array.from(Buffer.from(sample.pngBase64, 'base64')));
  }
}

// ---------------------------------------------------------------------------
// 独立朴素实现（不复用 lib 的 layout / transform / engine）
// ---------------------------------------------------------------------------

function naiveMirror(raw, L) {
  if (L <= 1) return 0;
  const period = 2 * (L - 1);
  let t = ((raw % period) + period) % period;
  return t < L ? t : period - t;
}

function naiveCenters(L, s) {
  const set = new Set();
  for (let v = 0; v < L; v += s) set.add(v);
  set.add(L - 1);
  return [...set].sort((a, b) => a - b);
}

function naiveDCTMatrix(p) {
  const C = [];
  for (let k = 0; k < p; k++) {
    C.push([]);
    for (let n = 0; n < p; n++) {
      C[k].push(Math.sqrt((k === 0 ? 1 : 2) / p) * Math.cos((Math.PI * (n + 0.5) * k) / p));
    }
  }
  return C;
}

function naiveDCT(patch, p) {
  const C = naiveDCTMatrix(p);
  const out = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let u = 0; u < p; u++) {
    for (let v = 0; v < p; v++) {
      let s = 0;
      for (let y = 0; y < p; y++) for (let x = 0; x < p; x++) s += C[u][y] * patch[y][x] * C[v][x];
      out[u][v] = s;
    }
  }
  return out;
}

function naiveIDCT(coef, p) {
  const C = naiveDCTMatrix(p);
  const out = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let y = 0; y < p; y++) {
    for (let x = 0; x < p; x++) {
      let s = 0;
      for (let u = 0; u < p; u++) for (let v = 0; v < p; v++) s += C[u][y] * coef[u][v] * C[v][x];
      out[y][x] = s;
    }
  }
  return out;
}

function naiveHadamard(m) {
  if (m === 1) return [[1]];
  const h = naiveHadamard(m / 2);
  const s = Math.SQRT1_2;
  const out = Array.from({ length: m }, () => new Array(m).fill(0));
  const half = m / 2;
  for (let r = 0; r < half; r++) {
    for (let c = 0; c < half; c++) {
      out[r][c] = h[r][c] * s;
      out[r][c + half] = h[r][c] * s;
      out[r + half][c] = h[r][c] * s;
      out[r + half][c + half] = -h[r][c] * s;
    }
  }
  return out;
}

function naiveGroupApply(vectors, m, H) {
  // vectors: m 个 p×p（扁平化前先展开成 [i][k]）
  const n = vectors[0].length;
  const out = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let r = 0; r < m; r++) {
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let j = 0; j < m; j++) s += H[r][j] * vectors[j][k];
      out[r][k] = s;
    }
  }
  return out;
}

function naiveRun(image, params) {
  const { width: W, height: H } = image;
  const p = params.patch;
  const p2 = p * p;
  const off = [];
  for (let i = 0; i < p; i++) off.push(i - Math.floor(p / 2));
  const yMap = [];
  for (let c = 0; c < H; c++) yMap.push(off.map((o) => naiveMirror(c + o, H)));
  const xMap = [];
  for (let c = 0; c < W; c++) xMap.push(off.map((o) => naiveMirror(c + o, W)));
  // get/extract 统一从浮点像素数组取值（阶段 1 的匹配与取样都用 original）。
  const get = (img, y, x) => img[y * W + x];
  const extract = (img, cy, cx) => {
    const out = Array.from({ length: p }, () => new Array(p));
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) out[i][j] = get(img, yMap[cy][i], xMap[cx][j]);
    return out;
  };
  const dist = (img, ay, ax, by, bx) => {
    let s = 0;
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) {
        const d = get(img, yMap[ay][i], xMap[ax][j]) - get(img, yMap[by][i], xMap[bx][j]);
        s += d * d;
      }
    }
    return s / p2;
  };
  const refYs = naiveCenters(H, params.stride);
  const refXs = naiveCenters(W, params.stride);
  const HmCache = new Map();
  const Hm = (m) => {
    if (!HmCache.has(m)) HmCache.set(m, naiveHadamard(m));
    return HmCache.get(m);
  };

  const original = Array.from({ length: W * H }, (_, i) => image.data[i]);
  const stage = (matchImage, wiener) => {
    const acc = new Array(W * H).fill(0);
    const wsum = new Array(W * H).fill(0);
    for (const ry of refYs) {
      for (const rx of refXs) {
        const candidates = [];
        for (let y = Math.max(0, ry - params.radius); y <= Math.min(H - 1, ry + params.radius); y++) {
          for (let x = Math.max(0, rx - params.radius); x <= Math.min(W - 1, rx + params.radius); x++) {
            candidates.push({ y, x, d: dist(matchImage, ry, rx, y, x) });
          }
        }
        candidates.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
        const cap = Math.min(params.capacity, candidates.length);
        let m = 1;
        while (m * 2 <= cap) m *= 2;
        const members = candidates.slice(0, m);
        const noisyLocal = members.map((mem) => naiveDCT(extract(original, mem.y, mem.x), p).flat());
        const noisyT = naiveGroupApply(noisyLocal, m, Hm(m));
        let outT;
        let weight;
        if (!wiener) {
          let retained = 0;
          outT = noisyT.map((vec, i) =>
            vec.map((v, k) => {
              if (i === 0 && k === 0) {
                retained++;
                return v;
              }
              if (Math.abs(v) < params.threshold * params.sigma) return 0;
              retained++;
              return v;
            }),
          );
          weight = 1 / Math.max(1, retained);
        } else {
          const pilotT = naiveGroupApply(
            members.map((mem) => naiveDCT(extract(resultPilot, mem.y, mem.x), p).flat()),
            m,
            Hm(m),
          );
          let sumGainSq = 0;
          outT = noisyT.map((vec, i) =>
            vec.map((v, k) => {
              const q = pilotT[i][k];
              const gain = (q * q) / (q * q + params.sigma * params.sigma);
              sumGainSq += gain * gain;
              return gain * v;
            }),
          );
          weight = 1 / Math.max(1e-12, sumGainSq);
        }
        const spatialT = naiveGroupApply(outT, m, Hm(m));
        for (let i = 0; i < m; i++) {
          const coef = [];
          for (let u = 0; u < p; u++) coef.push(spatialT[i].slice(u * p, (u + 1) * p));
          const pixel = naiveIDCT(coef, p);
          const mem = members[i];
          const top = mem.y - Math.floor(p / 2);
          const left = mem.x - Math.floor(p / 2);
          for (let dy = 0; dy < p; dy++) {
            const yy = top + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = 0; dx < p; dx++) {
              const xx = left + dx;
              if (xx < 0 || xx >= W) continue;
              acc[yy * W + xx] += pixel[dy][dx] * weight;
              wsum[yy * W + xx] += weight;
            }
          }
        }
      }
    }
    return { acc, wsum };
  };

  const s1 = stage(original, false);
  const resultPilot = s1.acc.map((v, i) => (s1.wsum[i] > 0 ? v / s1.wsum[i] : original[i]));
  const s2 = stage(resultPilot, true);
  const final = s2.acc.map((v, i) => (s2.wsum[i] > 0 ? v / s2.wsum[i] : original[i]));
  return { pilot: resultPilot, final, weight1: s1.wsum, weight2: s2.wsum };
}

// ---------------------------------------------------------------------------

test('镜像：不重复端点，轴长 1 恒为 0', () => {
  assert.deepEqual([-3, -2, -1, 0, 1, 2, 3, 4, 5].map((v) => mirrorIndex(v, 4)), [3, 2, 1, 0, 1, 2, 3, 2, 1]);
  assert.deepEqual([-7, 0, 9].map((v) => mirrorIndex(v, 1)), [0, 0, 0]);
  assert.deepEqual([-2, -1, 0, 1, 2].map((v) => mirrorIndex(v, 2)), [0, 1, 0, 1, 0]);
  assert.deepEqual([-1, 0, 1, 2, 3, 4, 5].map((v) => mirrorIndex(v, 5)), [1, 0, 1, 2, 3, 4, 3]);
});

test('图块偏移：-p/2 .. p/2-1', () => {
  assert.deepEqual([...patchOffsets(4)], [-2, -1, 0, 1]);
  assert.deepEqual([...patchOffsets(8)], [-4, -3, -2, -1, 0, 1, 2, 3]);
});

test('参考中心：补最后一像素并去重升序', () => {
  assert.deepEqual(referenceCenters(9, 2), [0, 2, 4, 6, 8]);
  assert.deepEqual(referenceCenters(10, 2), [0, 2, 4, 6, 8, 9]);
  assert.deepEqual(referenceCenters(10, 4), [0, 4, 8, 9]);
  assert.deepEqual(referenceCenters(1, 2), [0]);
  assert.deepEqual(referenceCenters(256, 8).at(-1), 255);
});

test('DCT-II 与 Hadamard 对齐样例 primitives.json', async () => {
  const prim = await readFile(join(SAMPLE_DIR, 'primitives.json'), 'utf8')
    .then((t) => JSON.parse(t))
    // 与样例包 primitives.json 相同的内容（DCT 与 Hadamard 期望值）
    .catch(() => ({
      dct_input: [[1, 2], [3, 4]],
      dct_expected: [[5, -1], [-2, 0]],
      hadamard_input: [1, 3],
      hadamard_expected: [2.82842712474619, -1.414213562373095],
    }));
  const C = dctMatrix(2);
  assert.ok(Math.abs(C[0] - Math.SQRT1_2) < 1e-15);
  const got = Array.from(dct2(Float64Array.from(prim.dct_input.flat()), 2));
  const want = prim.dct_expected.flat();
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(got[i] - want[i]) < 1e-12, `DCT[${i}]`);

  const round = Array.from(idct2(Float64Array.from(got), 2));
  assert.deepEqual(round.map((v) => Math.round(v * 1e9) / 1e9), [1, 2, 3, 4]);

  const wht = Array.from(groupTransform(Float64Array.from(prim.hadamard_input), 2, 1));
  for (let i = 0; i < 2; i++) assert.ok(Math.abs(wht[i] - prim.hadamard_expected[i]) < 1e-12);

  const H4 = hadamardMatrix(4);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const dot = (() => {
        let s = 0;
        for (let k = 0; k < 4; k++) s += H4[k * 4 + r] * H4[k * 4 + c];
        return s;
      })();
      assert.ok(Math.abs(dot - (r === c ? 1 : 0)) < 1e-12, 'Hadamard 正交');
    }
  }
  const vec = Float64Array.from([3, -1, 4, -1, 5, -9, 2, 6]);
  const fwd = groupTransform(vec, 4, 2);
  const back = inverseGroupTransform(fwd, 4, 2);
  for (let i = 0; i < vec.length; i++) assert.ok(Math.abs(back[i] - vec[i]) < 1e-12);
});

test('候选枚举：方框与图像范围交集，取最大 2 次幂且按 (距离,y,x) 排序', async () => {
  const noisy = await loadSample('noisy.png');
  const params = validateParams({ patch: 4, radius: 4, stride: 2, capacity: 8, sigma: 18, threshold: 2.7 });
  const maps = buildPatchIndexMap(noisy.height, patchOffsets(4));
  const xmaps = buildPatchIndexMap(noisy.width, patchOffsets(4));
  const all = { y: maps, x: xmaps };
  // 角落：候选数 5×5=25 → 容量 8，2 的幂取 8
  const corner = matchGroup(noisy.data, noisy.width, noisy.height, 0, 0, params, all);
  assert.equal(corner.candidateCount, 25);
  assert.equal(corner.m, 8);
  for (let i = 1; i < corner.members.length; i++) {
    const a = corner.members[i - 1];
    const b = corner.members[i];
    assert.ok(a.d < b.d || (a.d === b.d && (a.y < b.y || (a.y === b.y && a.x <= b.x))), '排序');
  }
  // 候选数 3 → 容量 min(8,3)=3，2 的幂取 2
  const single = matchGroup(noisy.data, 1, 1, 0, 0, params, { y: [[0, 0, 0, 0]], x: [[0, 0, 0, 0]] });
  assert.equal(single.candidateCount, 1);
  assert.equal(single.m, 1);
});

test('与独立朴素实现逐值一致（含边界镜像、两阶段与权重）', async () => {
  const W = 13;
  const H = 11;
  const data = new Uint8Array(W * H);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < data.length; i++) data[i] = Math.round(30 + 150 * rand());
  const image = { width: W, height: H, data };
  for (const params of [
    { patch: 4, radius: 4, stride: 2, capacity: 4, sigma: 18, threshold: 2.7 },
    { patch: 4, radius: 5, stride: 3, capacity: 8, sigma: 9.5, threshold: 1.6 },
  ]) {
    const got = await runDenoise(image, params);
    const want = naiveRun(image, params);
    for (let i = 0; i < W * H; i++) {
      assert.ok(Math.abs(got.pilot[i] - want.pilot[i]) < 1e-9, `pilot[${i}]`);
      assert.ok(Math.abs(got.final[i] - want.final[i]) < 1e-9, `final[${i}]`);
      assert.ok(Math.abs(got.weight1[i] - want.weight1[i]) < 1e-9, `w1[${i}]`);
      assert.ok(Math.abs(got.weight2[i] - want.weight2[i]) < 1e-9, `w2[${i}]`);
    }
  }
});

test('样例去噪：PSNR 提升、无零权重空洞、两阶段有限', async () => {
  const noisy = await loadSample('noisy.png');
  const clean = await loadSample('clean.png');
  const res = await runDenoise(noisy, {});
  assert.equal(res.canceled, false);
  const pIn = psnr(clean.data, res.original, 48, 40);
  const p1 = psnr(clean.data, res.pilot, 48, 40);
  const p2 = psnr(clean.data, res.final, 48, 40);
  assert.ok(p1 > pIn + 3, `初估应显著优于输入：${pIn} -> ${p1}`);
  assert.ok(p2 > p1, `最终应优于初估：${p1} -> ${p2}`);
  for (let i = 0; i < res.weight2.length; i++) {
    assert.ok(res.weight2[i] > 0, `像素 ${i} 权重为 0`);
    assert.ok(Number.isFinite(res.final[i]));
  }
  assert.equal(res.groups.stage1.groups, 525);
  assert.equal(res.groups.stage2.groups, 525);
  // 组容量 4，参考中心 21×25
  assert.equal(res.groups.stage1.meanGroupSize, 4);
});

test('权重图等于覆盖该像素的组权重之和（镜像越界像素不写回）', async () => {
  const noisy = await loadSample('noisy.png');
  const res = await runDenoise(noisy, {});
  const p = res.params.patch;
  // 用检查器逐个参考中心取组权重与组员，重建阶段 1 的权重和
  const expected = new Float64Array(res.width * res.height);
  const refYs = referenceCenters(res.height, res.params.stride);
  const refXs = referenceCenters(res.width, res.params.stride);
  const half = p >> 1;
  for (const y of refYs) {
    for (const x of refXs) {
      const group = inspectGroup(res, y, x);
      const w = group.stage1.groupWeight;
      for (const mem of group.stage1.members) {
        for (let dy = 0; dy < p; dy++) {
          const yy = mem.y - half + dy;
          if (yy < 0 || yy >= res.height) continue;
          for (let dx = 0; dx < p; dx++) {
            const xx = mem.x - half + dx;
            if (xx < 0 || xx >= res.width) continue;
            expected[yy * res.width + xx] += w;
          }
        }
      }
    }
  }
  let maxDiff = 0;
  for (let i = 0; i < expected.length; i++) maxDiff = Math.max(maxDiff, Math.abs(expected[i] - res.weight1[i]));
  assert.ok(maxDiff < 1e-9, `权重和偏差 ${maxDiff}`);
});

test('零噪声：两阶段逐像素等于输入，不做组变换', async () => {
  for (const id of ['noisy.png', 'thin.png', 'single.png']) {
    const img = await loadSample(id);
    const res = await runDenoise(img, { sigma: 0 });
    assert.equal(res.zeroNoise, true);
    for (let i = 0; i < img.data.length; i++) {
      assert.equal(res.pilot[i], img.data[i]);
      assert.equal(res.final[i], img.data[i]);
      assert.equal(res.weight1[i], 1);
      assert.equal(res.weight2[i], 1);
    }
  }
});

test('1 像素与 1 像素窄图也能算，σ=0 原样返回', async () => {
  for (const id of ['thin.png', 'single.png']) {
    const img = await loadSample(id);
    const zero = await runDenoise(img, { sigma: 0 });
    assert.deepEqual(Array.from(zero.final), Array.from(img.data));
    const res = await runDenoise(img, { patch: 8, radius: 12, stride: 8, capacity: 8, sigma: 18, threshold: 2.7 });
    assert.equal(res.canceled, false);
    for (const v of res.final) assert.ok(Number.isFinite(v));
    for (const v of res.weight2) assert.ok(v > 0);
  }
  // 1×1 上 p=4 时组只有 1 个成员，DCT DC 保留、维纳增益仍可定义
  const one = await loadSample('single.png');
  const res = await runDenoise(one, { sigma: 18 });
  assert.equal(res.groups.stage1.meanGroupSize, 1);
  assert.ok(Number.isFinite(res.final[0]));
});

test('参数与尺寸校验', () => {
  assert.throws(() => validateParams({ patch: 6 }), /图块大小/);
  assert.throws(() => validateParams({ radius: 3 }), /搜索半径/);
  assert.throws(() => validateParams({ stride: 1 }), /步长/);
  assert.throws(() => validateParams({ patch: 4, stride: 8 }), /步长/);
  assert.throws(() => validateParams({ capacity: 16 }), /组容量/);
  assert.throws(() => validateParams({ sigma: -1 }), /噪声标准差/);
  assert.throws(() => validateImage({ width: 257, height: 1, data: new Uint8Array(257) }), /256/);
  assert.throws(() => validateImage({ width: 0, height: 1, data: new Uint8Array(0) }), /尺寸/);
  assert.deepEqual(validateParams(DEFAULT_PARAMS), { ...DEFAULT_PARAMS });
});

test('取消：在协作点返回 canceled 结果，不产出半成品', async () => {
  const img = await loadSample('noisy.png');
  let calls = 0;
  const res = await runDenoise(img, { patch: 8, radius: 12, stride: 2, capacity: 8, sigma: 18 }, {
    shouldCancel: () => ++calls > 3,
  });
  assert.equal(res.canceled, true);
  assert.equal(res.pilot, null);
  assert.equal(res.final, null);
});

test('确定性：同参数两次运行结果逐位相同', async () => {
  const img = await loadSample('noisy.png');
  const a = await runDenoise(img, { patch: 8, radius: 6, stride: 4, capacity: 8, sigma: 22, threshold: 3 });
  const b = await runDenoise(img, { patch: 8, radius: 6, stride: 4, capacity: 8, sigma: 22, threshold: 3 });
  assert.deepEqual(Array.from(a.final), Array.from(b.final));
  assert.deepEqual(Array.from(a.weight2), Array.from(b.weight2));
});

test('检查器：组员、距离、DCT、组域系数、增益与引擎口径一致', async () => {
  const noisy = await loadSample('noisy.png');
  const res = await runDenoise(noisy, {});
  const ins = inspectGroup(res, 8, 8);
  assert.equal(ins.stage1.m, 4);
  assert.equal(ins.stage1.members[0].y, 8);
  assert.equal(ins.stage1.members[0].x, 8);
  assert.equal(ins.stage1.members[0].distance, 0);
  assert.equal(ins.stage1.groupWeight, 1 / Math.max(1, ins.stage1.retainedCount));
  let sumGainSq = 0;
  for (const row of ins.stage2.matrices) for (const g of row.gain) sumGainSq += g * g;
  assert.ok(Math.abs(sumGainSq - ins.stage2.sumGainSq) < 1e-9);
  assert.ok(Math.abs(ins.stage2.groupWeight - 1 / sumGainSq) < 1e-12);
  // 增益应在 0..1，DC 增益接近 1
  for (const row of ins.stage2.matrices) for (const g of row.gain) assert.ok(g >= 0 && g <= 1);
  assert.ok(ins.stage2.matrices[0].gain[0] > 0.9);
  assert.throws(() => inspectGroup(res, -1, 0), /超出/);
});

test('极端长宽比：1×256、256×1、2×3、3×2 均可计算且无空洞', async () => {
  const dims = [
    [1, 256],
    [256, 1],
    [2, 3],
    [3, 2],
    [2, 256],
    [256, 2],
    [1, 2],
  ];
  for (const [W, H] of dims) {
    const data = new Uint8Array(W * H);
    for (let i = 0; i < data.length; i++) data[i] = (i * 53 + 17) % 256;
    for (const params of [
      { patch: 4, radius: 4, stride: 2, capacity: 4, sigma: 18, threshold: 2.7 },
      { patch: 8, radius: 12, stride: 8, capacity: 8, sigma: 30, threshold: 1 },
    ]) {
      const res = await runDenoise({ width: W, height: H, data }, params);
      assert.equal(res.canceled, false, `${W}×${H}`);
      for (let i = 0; i < W * H; i++) {
        assert.ok(Number.isFinite(res.pilot[i]), `${W}×${H} pilot[${i}]`);
        assert.ok(Number.isFinite(res.final[i]), `${W}×${H} final[${i}]`);
        assert.ok(res.weight1[i] > 0, `${W}×${H} w1[${i}]`);
        assert.ok(res.weight2[i] > 0, `${W}×${H} w2[${i}]`);
      }
      // 参考中心数 = |Y 中心| × |X 中心|
      assert.equal(res.groups.stage1.groups, referenceCenters(H, params.stride).length * referenceCenters(W, params.stride).length);
    }
    const zero = await runDenoise({ width: W, height: H, data }, { sigma: 0 });
    assert.deepEqual(Array.from(zero.final), Array.from(data), `${W}×${H} σ=0`);
  }
});

test('sigma=0 的统计如实报告单位权重', async () => {
  const img = await loadSample('noisy.png');
  const res = await runDenoise(img, { sigma: 0 });
  assert.equal(res.groups.stage1.weightStats.min, 1);
  assert.equal(res.groups.stage1.weightStats.max, 1);
  assert.equal(res.groups.stage1.zeroWeightPixels, 0);
  assert.equal(res.groups.stage2.weightStats.mean, 1);
});
