/**
 * 数值验证（node tools/test.mjs）
 *
 * 1) 连续时间解析积分 vs 密集时间采样（瞬时可见颜色 + 权重）交叉验证；
 * 2) 深度交叉 / 深度相等取小 ID / 切线擦边零曝光 等语义硬答案；
 * 3) 扫描延迟与上下方向、均匀/三角权重的作用；
 * 4) 输入校验的拒绝行为。
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCaseSet,
  buildScene,
  integratePixel,
  renderInstant,
  renderIntegrated,
  exposureWindow,
  compareCardIds,
  ValidationError,
  linearToSrgb,
} from '../js/shutter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let failures = 0;
let passes = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passes++;
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function close(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

const DEFAULT_PARAMS = {
  start: 0,
  duration: 1,
  scanDelay: 0,
  scanDir: 'down',
  weight: 'uniform',
};

/** 密集时间采样参考：对像素在 [a,b] 上按 N 份中点采样瞬时可见颜色，按权重加权平均。 */
function samplePixel(scene, px, py, params, N = 200000) {
  const nominal = exposureWindow(py, scene.H, params);
  const a = Math.max(0, nominal[0]);
  const b = Math.min(1, nominal[1]);
  if (!(b > a)) return { rgb: [0, 0, 0], totalWeight: 0 };
  const ws = nominal[0], we = nominal[1];
  const peak = (we + ws) / 2;
  const wfun = (t) => {
    if (params.weight === 'uniform') return 1;
    const half = (we - ws) / 2;
    if (!(half > 0)) return 0;
    const x = 1 - Math.abs(t - peak) / half;
    return Math.max(0, x);
  };
  const P = px + 0.5, Q = py + 0.5;
  const sum = [0, 0, 0];
  let tw = 0;
  const dt = (b - a) / N;
  for (let n = 0; n < N; n++) {
    const t = a + (n + 0.5) * dt;
    const w = wfun(t);
    tw += w * dt;
    let best = -1, bestD = Infinity;
    for (const tri of scene.triangles) {
      const x0 = tri.p0x[0] + (tri.p1x[0] - tri.p0x[0]) * t;
      const y0 = tri.p0y[0] + (tri.p1y[0] - tri.p0y[0]) * t;
      const x1 = tri.p0x[1] + (tri.p1x[1] - tri.p0x[1]) * t;
      const y1 = tri.p0y[1] + (tri.p1y[1] - tri.p0y[1]) * t;
      const x2 = tri.p0x[2] + (tri.p1x[2] - tri.p0x[2]) * t;
      const y2 = tri.p0y[2] + (tri.p1y[2] - tri.p0y[2]) * t;
      const e0x = x1 - x0, e0y = y1 - y0;
      const e1x = x2 - x1, e1y = y2 - y1;
      const area = e0x * (y2 - y0) - e0y * (x2 - x0);
      if (Math.abs(area) < 1e-14) continue;
      const c0 = e0x * (Q - y0) - e0y * (P - x0);
      const c1 = e1x * (Q - y1) - e1y * (P - x1);
      const c2 = (x0 - x2) * (Q - y2) - (y0 - y2) * (P - x2);
      const inside = area > 0 ? c0 >= 0 && c1 >= 0 && c2 >= 0 : c0 <= 0 && c1 <= 0 && c2 <= 0;
      if (!inside) continue;
      const card = scene.cards[tri.card];
      const d = card.d0 + (card.d1 - card.d0) * t;
      if (best < 0 || d < bestD - 1e-12 || (Math.abs(d - bestD) <= 1e-12 && compareCardIds(card.id, scene.cards[best].id) < 0)) {
        best = tri.card;
        bestD = d;
      }
    }
    const col = best < 0 ? scene.background : scene.cards[best].rgb;
    for (let c = 0; c < 3; c++) sum[c] += col[c] * w * dt;
  }
  return {
    rgb: tw > 0 ? sum.map((s) => s / tw) : [0, 0, 0],
    totalWeight: tw,
  };
}

async function loadSamples() {
  const raw = await readFile(join(ROOT, 'samples', 'shutter-integral-cases.json'), 'utf8');
  return parseCaseSet(raw);
}

// ---------------------------------------------------------------------------
const sampleSet = await loadSamples();

// 1) 交叉验证：每个样例、每个像素、若干参数组合
{
  const paramSets = [
    DEFAULT_PARAMS,
    { ...DEFAULT_PARAMS, weight: 'triangle' },
    { ...DEFAULT_PARAMS, start: 0.2, duration: 0.5 },
    { ...DEFAULT_PARAMS, duration: 0.6, scanDelay: 0.3, scanDir: 'up' },
  ];
  let maxErr = 0;
  let maxWErr = 0;
  let count = 0;
  for (const c of sampleSet.cases) {
    const scene = buildScene(c);
    for (const params of paramSets) {
      for (let py = 0; py < scene.H; py++) {
        for (let px = 0; px < scene.W; px++) {
          const a = integratePixel(scene, px, py, params, false);
          const b = samplePixel(scene, px, py, params, 150000);
          for (let k = 0; k < 3; k++) {
            const e = Math.abs(a.rgb[k] - b.rgb[k]);
            if (e > maxErr) maxErr = e;
          }
          maxWErr = Math.max(maxWErr, Math.abs(a.totalWeight - b.totalWeight));
          count++;
        }
      }
    }
  }
  check(
    `解析积分 vs 密集采样（${count} 像素-参数组）最大色差 ≤ 1e-3`,
    maxErr <= 1e-3,
    `maxErr=${maxErr.toExponential(3)}`,
  );
  check('权重积分 vs 采样最大误差 ≤ 1e-4', maxWErr <= 1e-4, `maxWErr=${maxWErr.toExponential(3)}`);
}

// 2a) cross：红蓝深度在 0.5 交叉，均匀权重 → 各占一半
{
  const c = sampleSet.cases.find((x) => x.id === 'cross');
  const scene = buildScene(c);
  const r = integratePixel(scene, 2, 2, DEFAULT_PARAMS, true);
  check('cross 中心像素 R≈0.5', close(r.rgb[0], 0.5, 1e-6), `r=${r.rgb[0]}`);
  check('cross 中心像素 B≈0.5', close(r.rgb[2], 0.5, 1e-6), `b=${r.rgb[2]}`);
  check('cross 分段数为 2（红→蓝）', r.segments.length === 2, `n=${r.segments.length}`);
  check('cross 第一段红在前', r.segments[0].id === 'red' && close(r.segments[0].t0, 0) && close(r.segments[0].t1, 0.5, 1e-9));
  check('cross 各段权重各 0.5', close(r.segments[0].weight, 0.5, 1e-9) && close(r.segments[1].weight, 0.5, 1e-9));
}

// 2b) 深度相等取较小 ID
{
  const c = sampleSet.cases.find((x) => x.id === 'cross');
  const scene = buildScene(c);
  // 构造两色片同深度常值
  scene.cards[0].d0 = 2; scene.cards[0].d1 = 2;
  scene.cards[1].d0 = 2; scene.cards[1].d1 = 2;
  const r = integratePixel(scene, 2, 2, DEFAULT_PARAMS, true);
  // 'blue'(b) vs 'red'(r)：字符串比较 'blue' < 'red' → blue 在前
  check('同深度取较小 ID（blue < red）→ 全蓝', close(r.rgb[2], 1, 1e-9) && close(r.rgb[0], 0, 1e-9), `rgb=${r.rgb}`);
  check('数值 ID 比较 2 < 10', compareCardIds(2, 10) < 0);
  check('数值 ID 比较 10 > 9', compareCardIds(10, 9) > 0);
  check('字符串 ID 比较 "a" < "b"', compareCardIds('a', 'b') < 0);
}

// 2b2) 深度交叉点落在扫描延迟窗口内（非 0.5）：分段边界应精确落在交点
{
  const caseObj = {
    id: 'late-cross',
    W: 4, H: 3,
    background: [0, 0, 0],
    cards: [
      { id: 'a', rgb: [1, 0, 0], xy0: [[0, 0], [4, 0], [0, 3]], xy1: [[0, 0], [4, 0], [0, 3]], depth: [0, 1], f: [[0, 1, 2]] },
      { id: 'b', rgb: [0, 1, 0], xy0: [[0, 0], [4, 0], [0, 3]], xy1: [[0, 0], [4, 0], [0, 3]], depth: [1, 0], f: [[0, 1, 2]] },
    ],
  };
  const scene = buildScene(caseObj);
  // 顶行窗口 [0.4, 0.9]：交点 t=0.5 在窗口内 → 分段应为 a:0.4→0.5，b:0.5→0.9
  const params = { start: 0.4, duration: 0.5, scanDelay: 0, scanDir: 'down', weight: 'uniform' };
  const r = integratePixel(scene, 0, 0, params, true);
  check('窗口内深度交点：两段且边界为 0.5', r.segments.length === 2 && close(r.segments[0].t1, 0.5, 1e-9) && close(r.segments[1].t0, 0.5, 1e-9), JSON.stringify(r.segments.map((s) => [s.id, s.t0, s.t1])));
  check('窗口内深度交点：占比 0.1/0.4 与 0.4/0.4', close(r.segments[0].share, 0.2, 1e-9) && close(r.segments[1].share, 0.8, 1e-9));
  check('窗口内深度交点：颜色混合', close(r.rgb[0], 0.2, 1e-9) && close(r.rgb[1], 0.8, 1e-9), `rgb=${r.rgb}`);

  // 扫描延迟使顶行窗口落在交点前、底行落在交点后 → 两行分属不同色片
  const p2 = { start: 0.2, duration: 0.3, scanDelay: 0.6, scanDir: 'down', weight: 'uniform' };
  const top = integratePixel(scene, 0, 0, p2, false);   // [0.4,0.6] → 跨交点
  const bot = integratePixel(scene, 0, 2, p2, false);   // [0.9,1.1] → 裁剪后全 b
  check('扫描延迟下底行窗口被裁剪到 ≤1', bot.clipped[1] <= 1 + 1e-12 && bot.clipped[0] > 0.5, `top=${top.clipped} bot=${bot.clipped}`);
  check('扫描延迟使上下行分属不同遮挡', close(bot.rgb[0], 0, 1e-9) && close(bot.rgb[1], 1, 1e-9), `top=${top.rgb} bot=${bot.rgb}`);
}

// 2c) 掠边/瞬间接触：解析积分与密集采样一致（瞬间接触为零测集）
{
  // 一个窄三角形在 t≈0.5 掠过像素中心 (2.5,2.5)：cover 区间为正值。
  const caseObj = {
    id: 'sweep',
    W: 5, H: 4,
    background: [0, 0, 0],
    cards: [{
      id: 'g', rgb: [0, 1, 0],
      d0: 1, d1: 1,
      xy0: [[1.0, 3.0], [4.0, 3.0], [2.5, 3.0]],
      xy1: [[1.0, 3.0], [4.0, 3.0], [2.5, 2.0]],
      f: [[0, 1, 2]],
    }],
  };
  const scene = buildScene(caseObj);
  const r = integratePixel(scene, 2, 2, DEFAULT_PARAMS, true);
  const ref = samplePixel(scene, 2, 2, DEFAULT_PARAMS, 400000);
  check('掠边三角形：解析积分与采样一致', Math.abs(r.rgb[1] - ref.rgb[1]) <= 1e-3, `ana=${r.rgb[1]} ref=${ref.rgb[1]}`);
  // 顶点在 t=0.5 恰好经过 Q=2.5，覆盖区间为 (0.5,1] → 绿 ≈ 0.5
  check('掠边三角形覆盖上半程', close(r.rgb[1], 0.5, 1e-6), `g=${r.rgb[1]}`);

  // 真正只在单一瞬间贴边：一个顶点在 t=0.5 恰好经过像素中心，其余时刻三角形都在该点之外。
  const tangent = {
    id: 'tangent',
    W: 5, H: 4,
    background: [0, 0, 0],
    cards: [{
      id: 'g', rgb: [0, 1, 0], d0: 1, d1: 1,
      xy0: [[2.0, 2.5], [1.8, 2.9], [2.2, 2.9]],
      xy1: [[3.0, 2.5], [2.8, 2.9], [3.2, 2.9]],
      f: [[0, 1, 2]],
    }],
  };
  const tscene = buildScene(tangent);
  const tr = integratePixel(tscene, 2, 2, DEFAULT_PARAMS, true);
  check('单瞬间顶点相切：零曝光、仅背景分段', tr.rgb[1] === 0 && tr.segments.every((s) => s.card === -1), `g=${tr.rgb[1]} segs=${JSON.stringify(tr.segments.map((s) => s.card))}`);
}

// 2d) flash：宽 0.2 的竖条从左扫到右，均匀权重 → 覆盖率等于各像素被覆盖的时间比例
{
  const c = sampleSet.cases.find((x) => x.id === 'flash');
  const scene = buildScene(c);
  const mid = integratePixel(scene, 2, 2, DEFAULT_PARAMS, true);
  // 竖条宽度 0.2，速度 5/1（x0 从 0→5），像素中心 2.5 被覆盖时长 = 0.2/5 = 0.04
  check('flash 中心像素覆盖时长 ≈ 0.04', close(mid.totalWeight, 1, 1e-12) && close(mid.rgb[0], 0.04, 1e-6), `r=${mid.rgb[0]}`);
  // 第一列像素中心 0.5：竖条从 0 到 5 扫过，x∈[0.5,0.7] 时 t∈[0.1,0.14]
  const p0 = integratePixel(scene, 0, 2, DEFAULT_PARAMS, false);
  check('flash 第 0 列覆盖 ≈ 0.04', close(p0.rgb[0], 0.04, 1e-6), `r=${p0.rgb[0]}`);
  check('flash 背景色为黑时无红色以外分量', close(mid.rgb[1], 0) && close(mid.rgb[2], 0));
}

// 3a) 三角权重：恒覆盖全屏的色片 → 归一化颜色等于色片颜色；总权重 = 时长/2
{
  const caseObj = {
    id: 'full',
    W: 3, H: 2,
    background: [0, 0, 0],
    cards: [{ id: 'k', rgb: [0.2, 0.4, 0.6], d0: 1, d1: 1, xy0: [[-5, -5], [10, -5], [-5, 10]], xy1: [[-5, -5], [10, -5], [-5, 10]], f: [[0, 1, 2]] }],
  };
  const scene = buildScene(caseObj);
  const u = integratePixel(scene, 1, 1, DEFAULT_PARAMS, false);
  const tri = integratePixel(scene, 1, 1, { ...DEFAULT_PARAMS, weight: 'triangle' }, false);
  check('均匀权重全屏覆盖 → 原色', close(u.rgb[0], 0.2, 1e-12) && close(u.rgb[2], 0.6, 1e-12));
  check('三角权重全屏覆盖 → 原色（归一化）', close(tri.rgb[0], 0.2, 1e-12) && close(tri.rgb[2], 0.6, 1e-12));
  check('均匀权重总量 = 1', close(u.totalWeight, 1, 1e-12));
  check('三角权重总量 = 0.5', close(tri.totalWeight, 0.5, 1e-12));
}

// 3b) 扫描延迟与方向：窗口随行移动
{
  const wTopDown = exposureWindow(0, 4, { ...DEFAULT_PARAMS, scanDelay: 0.5, scanDir: 'down' });
  const wBotDown = exposureWindow(3, 4, { ...DEFAULT_PARAMS, scanDelay: 0.5, scanDir: 'down' });
  const wTopUp = exposureWindow(0, 4, { ...DEFAULT_PARAMS, scanDelay: 0.5, scanDir: 'up' });
  const wBotUp = exposureWindow(3, 4, { ...DEFAULT_PARAMS, scanDelay: 0.5, scanDir: 'up' });
  check('向下扫描：顶行窗口最早', wTopDown[0] < wBotDown[0], `${wTopDown} vs ${wBotDown}`);
  check('向上扫描：底行窗口最早', wBotUp[0] < wTopUp[0], `${wBotUp} vs ${wTopUp}`);
  check('窗口长度等于时长', close(wTopDown[1] - wTopDown[0], 1, 1e-12));
}

// 3c) 扫描延迟让上下两行积分不同（对移动物体）
{
  const c = sampleSet.cases.find((x) => x.id === 'flash');
  const scene = buildScene(c);
  const params = { ...DEFAULT_PARAMS, duration: 0.3, scanDelay: 0.4, scanDir: 'down' };
  const row0 = integratePixel(scene, 2, 0, params, false);
  const row3 = integratePixel(scene, 2, 3, params, false);
  check('扫描延迟导致不同行曝光不同', Math.abs(row0.rgb[0] - row3.rgb[0]) > 1e-6, `r0=${row0.rgb[0]} r3=${row3.rgb[0]}`);
}

// 4) 输入校验
{
  const expectReject = (name, raw, needle) => {
    try {
      parseCaseSet(raw);
      check(name, false, '未抛出错误');
    } catch (e) {
      check(name, e instanceof ValidationError && (!needle || e.message.includes(needle)), e.message.split('\n').slice(0, 3).join(' / '));
    }
  };
  expectReject('拒绝超过 160×96 的尺寸', { cases: [{ size: [161, 10], cards: [{ id: 'a', rgb: [1, 0, 0], xy0: [[0, 0], [1, 0], [0, 1]], xy1: [[0, 0], [1, 0], [0, 1]], depth: [1, 1], f: [[0, 1, 2]] }] }] }, '超出范围');
  expectReject('拒绝超过 64 个三角形', { cases: [{ size: [4, 4], cards: [{ id: 'a', rgb: [1, 0, 0], xy0: [[0, 0], [1, 0], [0, 1]], xy1: [[0, 0], [1, 0], [0, 1]], depth: [1, 1], f: Array.from({ length: 65 }, () => [0, 1, 2]) }] }] }, '超过上限');
  expectReject('拒绝 NaN 顶点', { cases: [{ size: [4, 4], cards: [{ id: 'a', rgb: [1, 0, 0], xy0: [[0, 0], [NaN, 0], [0, 1]], xy1: [[0, 0], [1, 0], [0, 1]], depth: [1, 1], f: [[0, 1, 2]] }] }] }, '有限数');
  expectReject('拒绝空 cards', { cases: [{ size: [4, 4], cards: [] }] }, '非空数组');
  expectReject('拒绝顶点数不一致', { cases: [{ size: [4, 4], cards: [{ id: 'a', rgb: [1, 0, 0], xy0: [[0, 0], [1, 0], [0, 1]], xy1: [[0, 0], [1, 0]], depth: [1, 1], f: [[0, 1, 2]] }] }] }, '一致');
  expectReject('拒绝越界三角形索引', { cases: [{ size: [4, 4], cards: [{ id: 'a', rgb: [1, 0, 0], xy0: [[0, 0], [1, 0], [0, 1]], xy1: [[0, 0], [1, 0], [0, 1]], depth: [1, 1], f: [[0, 1, 5]] }] }] }, '索引');
  // 合法输入应通过
  try {
    const ok = parseCaseSet({
      background: [0.1, 0.2, 0.3],
      cases: [{ size: [8, 4], cards: [{ id: 1, rgb: [1, 0, 0], xy0: [[0, 0], [1, 0], [0, 1]], xy1: [[0, 0], [1, 0], [0, 1]], depth: [1, 1], f: [[0, 1, 2]] }] }],
    });
    check('合法输入通过并规范化', ok.cases.length === 1 && ok.cases[0].cards[0].id === 1);
  } catch (e) {
    check('合法输入通过并规范化', false, e.message);
  }
}

// 4b) 随机几何交叉验证：随机色片/运动/深度/权重/扫描，与密集采样比色差
{
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const ri = (n) => Math.floor(rnd() * n);
  let worst = 0;
  let worstCase = null;
  let samples = 0;
  for (let roll = 0; roll < 60; roll++) {
    const W = 2 + ri(6);
    const H = 2 + ri(5);
    const cardCount = 1 + ri(3);
    const cards = [];
    for (let k = 0; k < cardCount; k++) {
      const nv = 3 + ri(2);
      const xy0 = [];
      const xy1 = [];
      for (let i = 0; i < nv; i++) {
        const bx = rnd() * W;
        const by = rnd() * H;
        const dx = (rnd() - 0.5) * W;
        const dy = (rnd() - 0.5) * H;
        xy0.push([bx, by]);
        xy1.push([bx + dx, by + dy]);
      }
      const f = [];
      // 扇形三角化
      for (let i = 1; i + 1 < nv; i++) f.push([0, i, i + 1]);
      const d0 = rnd() * 2;
      const d1 = rnd() * 2;
      cards.push({
        id: `c${k}`,
        rgb: [rnd(), rnd(), rnd()],
        xy0, xy1,
        depth: [d0, d1],
        f,
      });
    }
    const caseObj = { size: [W, H], cards };
    const scene = buildScene(caseObj);
    const params = {
      start: rnd() * 0.3,
      duration: 0.4 + rnd() * 0.5,
      scanDelay: rnd() * 0.3,
      scanDir: rnd() < 0.5 ? 'down' : 'up',
      weight: rnd() < 0.5 ? 'uniform' : 'triangle',
    };
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const a = integratePixel(scene, px, py, params, false);
        const b = samplePixel(scene, px, py, params, 120000);
        const err = Math.max(
          Math.abs(a.rgb[0] - b.rgb[0]),
          Math.abs(a.rgb[1] - b.rgb[1]),
          Math.abs(a.rgb[2] - b.rgb[2]),
        );
        samples++;
        if (err > worst) {
          worst = err;
          worstCase = { roll, px, py, params };
        }
      }
    }
  }
  check(
    `随机几何 ${samples} 像素 vs 密集采样：最大色差 ≤ 3e-3`,
    worst <= 3e-3,
    `worst=${worst.toExponential(3)} @ ${JSON.stringify(worstCase)}`,
  );
}

// 5) 整帧渲染一致性：分块积分的每个像素与积分结果一致
{
  const c = sampleSet.cases.find((x) => x.id === 'flash');
  const scene = buildScene(c);
  const { data, weights } = renderIntegrated(scene, DEFAULT_PARAMS);
  let ok = true;
  for (let py = 0; py < scene.H; py++) {
    for (let px = 0; px < scene.W; px++) {
      const r = integratePixel(scene, px, py, DEFAULT_PARAMS, false);
      const o = (py * scene.W + px) * 3;
      for (let k = 0; k < 3; k++) if (Math.abs(data[o + k] - r.rgb[k]) > 1e-12) ok = false;
      if (Math.abs(weights[py * scene.W + px] - r.totalWeight) > 1e-12) ok = false;
    }
  }
  check('renderIntegrated 与逐像素积分一致', ok);
}

// 6) 瞬时渲染：cross 在 t=0.25 应为红，t=0.75 应为蓝
{
  const c = sampleSet.cases.find((x) => x.id === 'cross');
  const scene = buildScene(c);
  const d1 = renderInstant(scene, 0.25);
  const d2 = renderInstant(scene, 0.75);
  const o = (2 * scene.W + 2) * 3;
  check('t=0.25 红在前', close(d1[o], 1) && close(d1[o + 2], 0));
  check('t=0.75 蓝在前', close(d2[o], 0) && close(d2[o + 2], 1));
}

// 7) sRGB 传输函数边界
{
  check('linearToSrgb(0)=0', linearToSrgb(0) === 0);
  check('linearToSrgb(1)=1', linearToSrgb(1) === 1);
  check('linearToSrgb 单调', linearToSrgb(0.2) < linearToSrgb(0.5));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
