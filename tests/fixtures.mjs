/*
 * 生成 E2E / 性能测试夹具（写到 os.tmpdir()，不污染仓库）。
 *   stress-1m.json   512x512、100 万条交错层记录（同深度多类型混排，输入顺序打乱）
 *   invalid-*.json   各类带位置的错误样例
 *   tie-order.json   同深度 结束/holdout/表面(id)/开始 混排
 */
import { writeFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeDir() {
  return mkdtempSync(join(tmpdir(), 'dic-e2e-'));
}

// 确定性 PRNG
function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function writeStress1M(dir, { width = 512, height = 512, targetLayers = 1_000_000 } = {}) {
  const rng = mulberry32(20261124);
  const N = width * height;
  // 每像素固定预算（含末尾追加的同深度表面）。向上取整保证总层数 ≥ 目标值，
  // 实际约 105 万，比 100 万要求更保守。
  const base = Math.ceil(targetLayers / N);
  const pixels = [];
  let total = 0;
  for (let p = 0; p < N; p++) {
    const x = p % width, y = Math.floor(p / width);
    const budget = base;
    const layers = [];
    let id = 0;
    // 预留一个槽位给同深度交错表面（预算为 1 时就不追加）
    const coreCount = budget > 1 ? budget - 1 : budget;
    let firstVol = null;
    for (let l = 0; l < coreCount; l++) {
      id++;
      const r = rng();
      if (r < 0.55) {
        const z0 = Math.floor(rng() * 40);
        const rec = {
          id, type: 'volume',
          z0, z1: z0 + 1 + Math.floor(rng() * 20),
          sigma: rng() * 1.5,
          rgb: [rng(), rng(), rng()],
        };
        if (!firstVol) firstVol = rec;
        layers.push(rec);
      } else if (r < 0.9) {
        layers.push({
          id, type: 'surface',
          z: Math.floor(rng() * 60),
          a: rng() * 0.8,
          rgb: [rng(), rng(), rng()],
        });
      } else {
        layers.push({ id, type: 'holdout', z: Math.floor(rng() * 60) });
      }
    }
    // 刻意打乱输入顺序，暴露“按起点排序”类错误
    for (let k = layers.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      [layers[k], layers[j]] = [layers[j], layers[k]];
    }
    // 同深度冲突：在首个体积起点放一个表面，制造交错事件
    if (budget > 1 && firstVol) {
      id++;
      layers.push({ id, type: 'surface', z: firstVol.z0, a: 0.3, rgb: [0.5, 0.5, 0.5] });
    }
    total += layers.length;
    pixels.push({ x, y, layers });
  }
  const scene = { width, height, pixels };
  const path = join(dir, 'stress-1m.json');
  writeFileSync(path, JSON.stringify(scene));
  return { path, layerCount: total, pixels: pixels.length, bytes: statSync(path).size };
}

export function writeInvalid(dir) {
  const cases = {
    'invalid-type.json': {
      width: 2, height: 2,
      pixels: [{ x: 0, y: 0, layers: [{ id: 0, type: 'bogus', z: 1 }] }],
    },
    'invalid-zorder.json': {
      width: 2, height: 2,
      pixels: [{ x: 0, y: 0, layers: [
        { id: 0, type: 'volume', z0: 5, z1: 5, sigma: 1, rgb: [0, 0, 0] },
      ] }],
    },
    'invalid-dup-id.json': {
      width: 2, height: 2,
      pixels: [{ x: 1, y: 1, layers: [
        { id: 3, type: 'holdout', z: 2 },
        { id: 3, type: 'surface', z: 3, a: 0.5, rgb: [0, 0, 0] },
      ] }],
    },
    'invalid-coord.json': {
      width: 2, height: 2,
      pixels: [{ x: 9, y: 0, layers: [] }],
    },
  };
  const out = {};
  for (const [name, scene] of Object.entries(cases)) {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(scene));
    out[name] = path;
  }
  // 纯语法错误（非合法 JSON），验证行列位置标注
  const syntaxPath = join(dir, 'invalid-syntax.json');
  writeFileSync(syntaxPath, '{\n  "width": 4,\n  "height": 2,\n  "pixels": [\n}\n');
  out['invalid-syntax.json'] = syntaxPath;
  return out;
}

// 同深度次序 + 相交体积的确定性小场景，返回手工期望值
export function writeTieCase(dir) {
  // 像素 (0,0)：
  //  volume id1 [0,4) sig .5 红；volume id4 [4,8) sig .5 蓝（同深度 4：先结束 1 再开始 4）
  //  z=4 还有 holdout id9 → 次序：end1 → holdout9 → start4，蓝色体积被切断
  //  surface id2(id小) 与 id7(id大) 同在 z=2，a 分别 .25 / .5
  const scene = {
    width: 1, height: 1,
    pixels: [{
      x: 0, y: 0,
      layers: [
        { id: 7, type: 'surface', z: 2, a: 0.5, rgb: [0, 0, 1] },
        { id: 4, type: 'volume', z0: 4, z1: 8, sigma: 0.5, rgb: [0, 0, 1] },
        { id: 9, type: 'holdout', z: 4 },
        { id: 1, type: 'volume', z0: 0, z1: 4, sigma: 0.5, rgb: [1, 0, 0] },
        { id: 2, type: 'surface', z: 2, a: 0.25, rgb: [0, 1, 0] },
      ],
    }],
  };
  // 段 0-2：sig .5 dt2 → T=e^-1，吸收 A1=1-e^-1，红色
  const T02 = Math.exp(-1);
  // z=2 表面 id2 先：share2=T02*.25 绿；再 id7：share7=T02*.75*.5 蓝
  const share2 = T02 * 0.25;
  const T2 = T02 * 0.75;
  const share7 = T2 * 0.5;
  const T2b = T2 * 0.5;
  // 段 2-4：红体积仍活跃，sig .5 dt2
  const A24 = T2b * (1 - Math.exp(-1));
  const T4 = T2b * Math.exp(-1);
  // z=4 end1 → holdout9 → T=0，蓝色体积零贡献
  // 红色直色 rgb=(1,0,0)，其贡献 = 两段红色吸收之和
  const redContrib = (1 - T02) + A24;
  const expected = {
    r: redContrib,
    g: share2 * 1,
    b: share7 * 1,
    A: redContrib + share2 + share7,
    T: 0,
    tAtSurface2In: T02,
    tAt4: T4,
  };
  const path = join(dir, 'tie-order.json');
  writeFileSync(path, JSON.stringify(scene));
  return { path, expected };
}
