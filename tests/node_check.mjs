/*
 * Node 单元 + 交叉核对：
 *   1) 手工构造案例（相交体积、同深度次序、holdout、零 sigma、空像素…）
 *      对照独立手算真值；
 *   2) 随机 fuzz：JS 引擎与 tools/reference.py 逐像素逐分量比对（容差 1e-12）；
 *   3) 校验器错误路径必须带记录位置。
 * 用法：node tests/node_check.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../web/engine.js');
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ok  ${name}`); }
  else { failures++; console.error(`FAIL  ${name} ${extra}`); }
}
function approx(a, b, tol = 1e-12) { return Math.abs(a - b) <= tol; }

/* ---------------- 1. 手工真值 ---------------- */
console.log('== 手工案例 ==');

// 案例 A：两条相交体积 [0,4] sig .5 红、[2,6] sig .25 蓝 + 一个表面 z=4 a=.5 绿 + holdout z=5
{
  const scene = {
    width: 1, height: 1,
    pixels: [{
      x: 0, y: 0,
      layers: [
        { id: 3, type: 'holdout', z: 5 },
        { id: 1, type: 'volume', z0: 0, z1: 4, sigma: 0.5, rgb: [1, 0, 0] },
        { id: 2, type: 'volume', z0: 2, z1: 6, sigma: 0.25, rgb: [0, 0, 1] },
        { id: 4, type: 'surface', z: 4, a: 0.5, rgb: [0, 1, 0] },
      ],
    }],
  };
  const pack = E.parseAndPack(scene);
  const f = E.compositeFrame(pack);
  // 段 0-2：仅体积1，sig=.5，T=e^-1
  const T02 = Math.exp(-1), A02 = 1 - T02;
  // 段 2-4：sig=.75，T*=e^-1.5
  const T24 = T02 * Math.exp(-1.5), A24 = T02 * (1 - Math.exp(-1.5));
  // 段源色 C=(.5*红+.25*蓝)/.75=(2/3,0,1/3)
  // z=4 先结束体积1，再处理表面：share=T24*.5
  const surfShare = T24 * 0.5;
  const TafterSurf = T24 * 0.5;
  // 段 4-5：仅体积2 sig=.25 dt=1
  const A45 = TafterSurf * (1 - Math.exp(-0.25));
  // z=5 holdout → T=0；段 5-6 无贡献
  const A = A02 + A24 + surfShare + A45;
  check('A: 相交段+表面+holdout 后吸收份额', approx(f.rgba[3], A),
    `got ${f.rgba[3]} want ${A}`);
  const rExpect = A02 * 1 + A24 * (2 / 3);
  const gExpect = surfShare * 1;
  const bExpect = A24 * (1 / 3) + A45 * 1;
  check('R', approx(f.rgba[0], rExpect), `${f.rgba[0]} vs ${rExpect}`);
  check('G（仅表面）', approx(f.rgba[1], gExpect), `${f.rgba[1]} vs ${gExpect}`);
  check('B（相交段加权 + 单介质段）', approx(f.rgba[2], bExpect),
    `${f.rgba[2]} vs ${bExpect}`);
  check('holdout 后残余透射为 0', f.T[0] === 0);

  const insp = E.inspectPixel(pack, 0, 0);
  const zs = insp.events.map(e => e.z + ':' + e.type).join(' ');
  check('检查视图事件次序', zs === '0:volume-start 2:volume-start 4:volume-end 4:surface 5:holdout 6:volume-end', zs);
  check('检查视图段数=3（0-2,2-4,4-5；holdout 后无幽灵段）', insp.segments.length === 3,
    String(insp.segments.length));
  check('检查视图结果与帧一致',
    approx(insp.result.A, f.rgba[3]) && approx(insp.result.r, f.rgba[0]));
  // 表面段入射/出射透射率
  const surfEv = insp.events.find(e => e.type === 'surface');
  check('表面入射透射率', approx(surfEv.tIn, T24));
  check('表面出射透射率', approx(surfEv.tOut, TafterSurf));
}

// 案例 B：同深度 结束→holdout→表面(id 序)→开始
{
  const scene = {
    width: 1, height: 1,
    pixels: [{
      x: 0, y: 0,
      layers: [
        { id: 7, type: 'volume', z0: 3, z1: 9, sigma: 0.1, rgb: [1, 1, 1] },
        { id: 2, type: 'surface', z: 3, a: 0.25, rgb: [0.9, 0.8, 0.7] },
        { id: 9, type: 'surface', z: 3, a: 0.5, rgb: [0.1, 0.2, 0.3] },
        { id: 5, type: 'holdout', z: 3 },
        { id: 1, type: 'volume', z0: 0, z1: 3, sigma: 0.4, rgb: [0.5, 0.5, 0.5] },
      ],
    }],
  };
  const pack = E.parseAndPack(scene);
  const insp = E.inspectPixel(pack, 0, 0);
  const at3 = insp.events.filter(e => e.z === 3).map(e => e.type + (e.id !== undefined ? '#' + e.id : ''));
  // holdout 在表面之前 → 表面透射为 0、无贡献；开始在最后
  check('同深度次序', at3.join(',') === 'volume-end#1,holdout#5,surface#2,surface#9,volume-start#7',
    at3.join(','));
  const f = E.compositeFrame(pack);
  // holdout 切断：A 只含 0-3 体积段
  const expectA = 1 - Math.exp(-0.4 * 3);
  check('holdout 先于同深度表面 → 表面零贡献', approx(f.rgba[3], expectA),
    `${f.rgba[3]} vs ${expectA}`);
  check('holdout 后 T=0', f.T[0] === 0);
}

// 案例 C：零 sigma 体积不改变透射、不产生吸收
{
  const scene = {
    width: 2, height: 1,
    pixels: [{
      x: 0, y: 0,
      layers: [
        { id: 1, type: 'volume', z0: 1, z1: 4, sigma: 0, rgb: [3, 4, 5] },
        { id: 2, type: 'surface', z: 2, a: 1, rgb: [0.2, 0.3, 0.4] },
      ],
    }],
  };
  const f = E.compositeFrame(E.parseAndPack(scene));
  check('零 sigma 表面 a=1 全吸收', approx(f.rgba[3], 1) &&
    approx(f.rgba[0], 0.2) && approx(f.rgba[1], 0.3) && approx(f.rgba[2], 0.4));
  check('空像素全零', f.rgba[4] === 0 && f.rgba[7] === 0 && f.T[1] === 1);
}

// 案例 D：a=0 表面不挡光；a=1 表面全挡
{
  const scene = {
    width: 1, height: 1,
    pixels: [{
      x: 0, y: 0,
      layers: [
        { id: 1, type: 'surface', z: 1, a: 0, rgb: [9, 9, 9] },
        { id: 2, type: 'volume', z0: 2, z1: 3, sigma: 1, rgb: [1, 0, 0] },
        { id: 3, type: 'surface', z: 4, a: 1, rgb: [0, 1, 0] },
        { id: 4, type: 'volume', z0: 5, z1: 6, sigma: 1, rgb: [0, 0, 1] },
      ],
    }],
  };
  const f = E.compositeFrame(E.parseAndPack(scene));
  // 体积段吸收 (1-e^-1)，a=1 表面份额 = 残余透射 e^-1，A 收敛到 1
  check('a=0 不挡光、a=1 全挡后方',
    approx(f.rgba[3], 1) && approx(f.T[0], 0),
    `A=${f.rgba[3]} T=${f.T[0]}`);
  check('后方蓝色体积被 a=1 挡住', approx(f.rgba[2], 0));
  // 绿色表面贡献 = e^-1 * 1
  check('a=1 表面预乘贡献', approx(f.rgba[1], Math.exp(-1)));
}

/* ---------------- 2. 校验错误带位置 ---------------- */
console.log('== 校验路径 ==');
const badCases = [
  [{ width: -1, height: 1, pixels: [] }, '$.width'],
  [{ width: 1, height: 1, pixels: [{ x: 2, y: 0, layers: [] }] }, '$.pixels[0].x'],
  [{ width: 1, height: 1, pixels: [{ x: 0, y: 0, layers: [{ id: 1, type: 'volume', z0: 5, z1: 5, sigma: 1, rgb: [0, 0, 0] }] }] }, 'z0 < z1'],
  [{ width: 1, height: 1, pixels: [{ x: 0, y: 0, layers: [
    { id: 1, type: 'surface', z: 0, a: 0.5, rgb: [0, 0, 0] },
    { id: 1, type: 'holdout', z: 1 },
  ] }] }, 'id 重复'],
  [{ width: 1, height: 1, pixels: [{ x: 0, y: 0, layers: [{ id: 0, type: 'mystery', z: 0 }] }] }, '未知层类型'],
  [{ width: 1, height: 1, pixels: [{ x: 0, y: 0, layers: [{ id: 0, type: 'surface', z: 0, a: 1.2, rgb: [0, 0, 0] }] }] }, 'a 必须'],
  [{ width: 1, height: 1, pixels: [{ x: 0, y: 0, layers: [{ id: 0, type: 'volume', z0: 0, z1: 2, sigma: -1, rgb: [0, 0, 0] }] }] }, 'sigma'],
  [{ width: 1, height: 1, pixels: [{ x: 0, y: 0, layers: [{ id: 0, type: 'surface', z: 0, a: 0.5, rgb: [0, NaN, 0] }] }] }, 'rgb'],
  [{ width: 2, height: 1, pixels: [
    { x: 0, y: 0, layers: [] }, { x: 0, y: 0, layers: [] },
  ] }, '像素坐标重复'],
];
for (const [scene, hint] of badCases) {
  let err = null;
  try { E.parseAndPack(scene); } catch (e) { err = e; }
  check(`校验拒绝：${hint}`, err instanceof E.ValidationError && err.path !== null,
    err ? err.message : '未抛错');
}

// JSON 语法错误必须带行列位置
{
  let err = null;
  try { E.parseJson('{\n "width": 2,\n}\n'); } catch (e) { err = e; }
  check('JSON 语法错误带行列位置',
    err instanceof E.ValidationError && /第 \d+ 行第 \d+ 列/.test(err.message),
    err ? err.message : '未抛错');
}

/* ---------------- 3. 随机 fuzz × Python 参考实现 ---------------- */
console.log('== fuzz：JS vs Python ==');

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomScene(rng, W, H, maxLayers) {
  const pixels = [];
  const npx = 1 + Math.floor(rng() * W * H);
  const used = new Set();
  for (let i = 0; i < npx; i++) {
    let x, y, key;
    do {
      x = Math.floor(rng() * W); y = Math.floor(rng() * H); key = y * W + x;
    } while (used.has(key));
    used.add(key);
    const nl = 1 + Math.floor(rng() * maxLayers);
    const layers = [];
    const ids = [];
    let id = 0;
    for (let l = 0; l < nl; l++) {
      const typ = rng();
      id += 1 + Math.floor(rng() * 3);
      ids.push(id);
      if (typ < 0.5) {
        const z0 = Math.floor(rng() * 10);
        const z1 = z0 + 1 + Math.floor(rng() * 8);
        layers.push({
          id, type: 'volume', z0, z1,
          sigma: rng() < 0.1 ? 0 : rng() * 2,
          rgb: [rng() * 1.5, rng() * 1.5, rng() * 1.5],
        });
      } else if (typ < 0.85) {
        const a = rng() < 0.2 ? 0 : rng();
        layers.push({
          id, type: 'surface', z: Math.floor(rng() * 12),
          a,
          rgb: [rng() * 1.5, rng() * 1.5, rng() * 1.5],
        });
      } else {
        layers.push({ id, type: 'holdout', z: Math.floor(rng() * 12) });
      }
    }
    // 打乱记录顺序，确保引擎不依赖输入顺序
    for (let k = layers.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [layers[k], layers[j]] = [layers[j], layers[k]];
    }
    pixels.push({ x, y, layers });
  }
  return { width: W, height: H, pixels };
}

const tmp = mkdtempSync(join(tmpdir(), 'dic-fuzz-'));
const scenePath = join(tmp, 'scene.json');
const outPath = join(tmp, 'out.json');
let fuzzPixels = 0;

for (let seed = 1; seed <= 40; seed++) {
  const rng = mulberry32(seed * 7919 + 13);
  const W = 1 + Math.floor(rng() * 6);
  const H = 1 + Math.floor(rng() * 6);
  const scene = randomScene(rng, W, H, 9);
  writeFileSync(scenePath, JSON.stringify(scene));
  execFileSync('python3', ['-I', join(root, 'tools/reference.py'),
    'render', scenePath, '-o', outPath]);
  const py = JSON.parse(readText(outPath));
  const pack = E.parseAndPack(scene);
  const js = E.compositeFrame(pack);

  let worst = 0;
  for (let p = 0; p < W * H; p++) {
    const o = p * 4;
    for (let c = 0; c < 4; c++) {
      worst = Math.max(worst, Math.abs(js.rgba[o + c] - py.rgba64[o + c]));
    }
    worst = Math.max(worst, Math.abs(js.T[p] - pyT(py, p)));
  }
  fuzzPixels += W * H;
  check(`fuzz#${seed} ${W}x${H} 最大偏差 ≤ 1e-12`, worst <= 1e-12, `worst=${worst}`);

  // 检查视图与帧结果一致 + Python inspect 交叉
  for (const px of scene.pixels.slice(0, 3)) {
    const insp = E.inspectPixel(pack, px.x, px.y);
    const p = px.y * W + px.x;
    check(`fuzz#${seed} inspect 与帧一致 (${px.x},${px.y})`,
      approx(insp.result.A, js.rgba[p * 4 + 3]) &&
      approx(insp.result.r, js.rgba[p * 4]));
    const pyInspect = JSON.parse(execFileSync('python3', ['-I',
      join(root, 'tools/reference.py'), 'inspect', scenePath,
      String(px.x), String(px.y)], { encoding: 'utf8' }));
    let d = 0;
    d = Math.max(d, Math.abs(insp.result.A - pyInspect.result.A));
    d = Math.max(d, Math.abs(insp.result.T - pyInspect.result.T));
    d = Math.max(d, Math.abs(insp.segments.length - pyInspect.segments.length));
    for (let s2 = 0; s2 < Math.min(insp.segments.length, pyInspect.segments.length); s2++) {
      const a = insp.segments[s2], b = pyInspect.segments[s2];
      d = Math.max(d, Math.abs(a.tIn - b.tIn), Math.abs(a.tOut - b.tOut),
        Math.abs(a.absorbShare - b.absorbShare), Math.abs(a.sigma - b.sigma));
    }
    check(`fuzz#${seed} inspect 段明细 vs Python (${px.x},${px.y})`, d <= 1e-12, `d=${d}`);
  }
}
console.log(`fuzz 覆盖 ${fuzzPixels} 像素位`);

function pyT(py, p) {
  const cell = py.pixels.find(c => c.y * py.width + c.x === p);
  return cell ? cell.T : 1;
}
function readText(p) {
  return readFileSync(p, 'utf8');
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
