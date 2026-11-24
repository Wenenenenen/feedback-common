// 算法核心测试：与 Python 暴力参照、手工四面体算例交叉验证。
// 运行：node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  validateTable,
  forward,
  locateInterval,
  roundHalfUp,
  parseP6,
  encodeP6,
  InverseSolver,
  parseBounds,
  parseAnchor,
  parseWeights,
} from '../src/lut-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// ---------------------------------------------------------------------------
// 工具：构造确定性测试表
// ---------------------------------------------------------------------------

function makeTable(axes, fn) {
  const counts = axes.map((a) => a.length);
  const nodes = [];
  for (let ir = 0; ir < counts[0]; ir++) {
    for (let ig = 0; ig < counts[1]; ig++) {
      for (let ib = 0; ib < counts[2]; ib++) {
        nodes.push(fn(axes[0][ir], axes[1][ig], axes[2][ib]));
      }
    }
  }
  return validateTable({ axes, nodes });
}

// 制造折返 + 平区：R 通道出现折叠（63->0），G 高段为平区
function foldedTable() {
  const axes = [
    [0, 10, 30, 63],
    [0, 20, 50, 63],
    [0, 15, 45, 63],
  ];
  return makeTable(axes, (r, g, b) => {
    const outR = Math.round((r * (63 - r) * 255) / (31.5 * 31.5)); // 抛物线折返
    const outG = g >= 50 ? 200 : Math.round((g / 50) * 200); // 平区
    const outB = Math.round((b / 63) * 255);
    return [Math.min(255, outR), outG, outB];
  });
}

test('roundHalfUp：半值向上取整', () => {
  assert.equal(roundHalfUp(0, 2), 0);
  assert.equal(roundHalfUp(1, 2), 1); // 0.5 -> 1
  assert.equal(roundHalfUp(3, 2), 2); // 1.5 -> 2
  assert.equal(roundHalfUp(5, 4), 1); // 1.25 -> 1
  assert.equal(roundHalfUp(7, 4), 2); // 1.75 -> 2
  assert.equal(roundHalfUp(255 * 7 + 1, 14), Math.floor((255 * 7 + 1) / 14) + 1);
});

test('locateInterval：边界与末段', () => {
  const ax = [0, 20, 63];
  assert.equal(locateInterval(ax, 0), 0);
  assert.equal(locateInterval(ax, 19), 0);
  assert.equal(locateInterval(ax, 20), 1);
  assert.equal(locateInterval(ax, 62), 1);
  assert.equal(locateInterval(ax, 63), 1);
});

test('四面体插值：节点处返回节点值', () => {
  const table = foldedTable();
  const nR = table.axisCounts[1] * table.axisCounts[2];
  const nG = table.axisCounts[2];
  const idx = (ir, ig, ib) => ir * nR + ig * nG + ib;
  const checks = [
    [0, 0, 0],
    [0, 20, 63],
    [10, 50, 45],
    [63, 63, 63],
  ];
  for (const [r, g, b] of checks) {
    const out = forward(table, r, g, b);
    // 这些码本身就是网格节点，直接按轴值定位节点
    const ir = table.axes[0].indexOf(r);
    const ig = table.axes[1].indexOf(g);
    const ib = table.axes[2].indexOf(b);
    const base = idx(ir, ig, ib) * 3;
    const node = [table.nodes[base], table.nodes[base + 1], table.nodes[base + 2]];
    assert.deepEqual(out, node, `node at ${r},${g},${b}`);
  }
});

test('四面体插值：与独立的权重公式手工算例一致', () => {
  // 2x2x2 表，轴 [0,63]，手算 (20,40,10)
  const axes = [
    [0, 63],
    [0, 63],
    [0, 63],
  ];
  const vals = {};
  const nodes = [];
  for (const r of [0, 63]) {
    for (const g of [0, 63]) {
      for (const b of [0, 63]) {
        const v = [r * 4, g * 4, b * 4]; // 线性，插值应精确
        vals[`${r},${g},${b}`] = v;
        nodes.push(v);
      }
    }
  }
  const table = validateTable({ axes, nodes });
  const out = forward(table, 20, 40, 10);
  // 线性表 => 精确结果
  assert.deepEqual(out, [80, 160, 40]);
});

test('四面体插值：非线性节点的手算（含半值向上取整）', () => {
  // 2x2x2：分数 r=20/63, g=40/63, b=10/63；降序 g,r,b
  const axes = [
    [0, 63],
    [0, 63],
    [0, 63],
  ];
  const v000 = [10, 0, 0];
  const v100 = [20, 0, 0];
  const v010 = [30, 0, 0];
  const v001 = [40, 0, 0];
  const v110 = [50, 0, 0];
  const v101 = [60, 0, 0];
  const v011 = [70, 0, 0];
  const v111 = [80, 0, 0];
  // B 最快排列
  const nodes = [v000, v001, v010, v011, v100, v101, v110, v111];
  const table = validateTable({ axes, nodes });
  const out = forward(table, 20, 40, 10);

  // 排序：q0=g(40), q1=r(20), q2=b(10)；D=63
  // w = [1-40/63, (40-20)/63, (20-10)/63, 10/63] -> [23,20,10,10]/63
  // 角：c0=v000=10, c1=v010=30, c2=v110=50, c3=v111=80
  const num = 10 * 23 + 30 * 20 + 50 * 10 + 80 * 10; // 2130
  const expect = roundHalfUp(num, 63); // 33.81 -> 34
  assert.equal(out[0], expect);
  assert.equal(out[0], 34);
  assert.equal(out[1], 0);
  assert.equal(out[2], 0);
});

test('平分排序：分数相同按 RGB 轴序，结果与四面体恒等式一致', () => {
  // r=g=b 时三个分数相同，轴序 0,1,2；角为 000,100,110,111
  const axes = [
    [0, 63],
    [0, 63],
    [0, 63],
  ];
  const nodes = [];
  for (let ir = 0; ir < 2; ir++) {
    for (let ig = 0; ig < 2; ig++) {
      for (let ib = 0; ib < 2; ib++) {
        nodes.push([ir * 10 + ig * 5 + ib, 0, 0]);
      }
    }
  }
  const table = validateTable({ axes, nodes });
  const out = forward(table, 21, 21, 21); // 分数 1/3
  // 权重 [2/3, 0, 0, 1/3]（q0=q1=q2=1/3 -> w1=0,w2=0）
  const v000 = 0;
  const v100 = 10;
  const v110 = 15;
  const v111 = 16;
  const expect = roundHalfUp(v000 * 2 + v100 * 0 + v110 * 0 + v111 * 1, 3);
  assert.equal(out[0], expect);
});

test('反查全局最优：与全枚举暴力一致（折返+平区表）', () => {
  const table = foldedTable();
  const solver = new InverseSolver(table, table.bounds, [32, 32, 32], [1, 1, 1]);

  // 全枚举参照
  const all = [];
  for (let r = 0; r < 64; r++) {
    for (let g = 0; g < 64; g++) {
      for (let b = 0; b < 64; b++) {
        all.push({ code: [r, g, b], out: forward(table, r, g, b) });
      }
    }
  }

  const targets = [
    [0, 0, 0],
    [255, 255, 255],
    [128, 100, 200],
    [37, 199, 88],
    [250, 200, 5],
    [1, 1, 1],
    [200, 200, 200],
  ];
  for (const t of targets) {
    const got = solver.query(t[0], t[1], t[2]);
    let best = null;
    let bestKey = null;
    for (const { code, out } of all) {
      const err =
        (out[0] - t[0]) ** 2 + (out[1] - t[1]) ** 2 + (out[2] - t[2]) ** 2;
      const man =
        Math.abs(code[0] - 32) + Math.abs(code[1] - 32) + Math.abs(code[2] - 32);
      const key = [err, man, code[0], code[1], code[2]];
      const lexicographicallyLess =
        bestKey === null ||
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] &&
          (key[1] < bestKey[1] ||
            (key[1] === bestKey[1] &&
              (key[2] < bestKey[2] ||
                (key[2] === bestKey[2] &&
                  (key[3] < bestKey[3] ||
                    (key[3] === bestKey[3] && key[4] < bestKey[4])))))));
      if (lexicographicallyLess) {
        bestKey = key;
        best = code;
      }
    }
    assert.deepEqual(got, best, `target ${t.join(',')}`);
  }
});

test('反查平局规则：权重 / anchor / 字典序三级裁决', () => {
  // 构造两个码输出完全相同的平区表，验证字典序与 anchor 裁决
  const axes = [
    [0, 63],
    [0, 63],
    [0, 63],
  ];
  const nodes = [];
  for (let ir = 0; ir < 2; ir++) {
    for (let ig = 0; ig < 2; ig++) {
      for (let ib = 0; ib < 2; ib++) {
        // 所有点输出同一个色 => 全 64^3 码映射到同一输出
        nodes.push([100, 100, 100]);
      }
    }
  }
  const table = validateTable({ axes, nodes });

  // 默认 anchor 32,32,32：曼哈顿最近且字典序最小
  let solver = new InverseSolver(table, table.bounds, [32, 32, 32], [1, 1, 1]);
  assert.deepEqual(solver.query(100, 100, 100), [32, 32, 32]);
  assert.deepEqual(solver.query(0, 0, 0), [32, 32, 32]); // 任意目标误差都相同

  // 改 anchor
  solver.setAnchor([10, 40, 5]);
  assert.deepEqual(solver.query(100, 100, 100), [10, 40, 5]);

  // anchor 相同曼哈顿的多个码：取字典序最小，例如 anchor [0,0,0]
  solver = new InverseSolver(table, table.bounds, [0, 0, 0], [1, 1, 1]);
  assert.deepEqual(solver.query(100, 100, 100), [0, 0, 0]);
});

test('非对称权重改变最优码', () => {
  const table = foldedTable();
  const s1 = new InverseSolver(table, table.bounds, [32, 32, 32], [1, 1, 1]);
  const s8 = new InverseSolver(table, table.bounds, [32, 32, 32], [8, 1, 1]);
  const t = [128, 100, 200];
  const a = s1.query(...t);
  const b = s8.query(...t);
  // 高 R 权重下，R 残差应不大于等权结果
  const oa = forward(table, ...a);
  const ob = forward(table, ...b);
  assert.ok(Math.abs(ob[0] - t[0]) <= Math.abs(oa[0] - t[0]));
});

test('闭区间收紧后候选只来自区间内', () => {
  const table = foldedTable();
  const bounds = [[10, 20], [0, 63], [5, 5]];
  const solver = new InverseSolver(table, bounds, [32, 32, 32], [1, 1, 1]);
  for (let i = 0; i < 50; i++) {
    const t = [(i * 37) % 256, (i * 91) % 256, (i * 173) % 256];
    const code = solver.query(...t);
    assert.ok(code[0] >= 10 && code[0] <= 20);
    assert.equal(code[2], 5);
  }
  assert.equal(solver.candidateCount, 11 * 64 * 1);
});

test('P6 解析与回写往返一致；码值不拉伸', () => {
  const w = 4;
  const h = 2;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 7) % 64; // 全部 <= 63
  const bytes = encodeP6(w, h, rgb);
  const parsed = parseP6(bytes);
  assert.equal(parsed.width, w);
  assert.equal(parsed.height, h);
  assert.deepEqual(Array.from(parsed.rgb), Array.from(rgb));
});

test('P6 解析拒绝超尺寸与坏魔数', () => {
  const big = encodeP6(513, 2, new Uint8Array(513 * 2 * 3));
  assert.throws(() => parseP6(big), /512/);
  assert.throws(() => parseP6(new TextEncoder().encode('P5\n1 1\n255\n\0\0\0')), /P6/);
});

test('表校验：各类非法字段均指出字段名', () => {
  const good = JSON.parse(
    readFileSync(join(root, '_samples_extract', 'table.json'), 'utf-8')
  );
  const bads = [
    [{ ...good, axes: [[0, 63], [0, 63]] }, /axes/],
    [{ ...good, axes: [[5, 63], [0, 63], [0, 63]] }, /axes/], // 首不为 0
    [{ ...good, axes: [[0, 20, 20, 63], [0, 63], [0, 63]] }, /axes/], // 非严格递增
    [{ ...good, axes: [[0, 63], [0, 63], [0, 63]] }, /nodes/], // 数量不符
    [{ ...good, nodes: good.nodes.slice(0, -1) }, /nodes/],
    [{ ...good, bounds: [[0, 64], [0, 63], [0, 63]] }, /bounds/],
    [{ ...good, bounds: [[30, 10], [0, 63], [0, 63]] }, /bounds/],
    [{ ...good, anchor: [0, 64] }, /anchor/],
    [{ ...good, weights: [1, 9, 1] }, /weights/],
    [{ ...good, weights: [1, 0, 1] }, /weights/],
  ];
  for (const [obj, re] of bads) {
    assert.throws(() => validateTable(obj), re);
  }
});

test('样本表：JS 反查与 Python 参照输出逐像素一致', async () => {
  const caseDir = join(root, '_samples_extract');
  const tableObj = JSON.parse(readFileSync(join(caseDir, 'table.json'), 'utf-8'));
  const table = validateTable(tableObj);
  const target = parseP6(readFileSync(join(caseDir, 'target.ppm')));
  const solver = new InverseSolver(
    table,
    table.bounds,
    table.anchor,
    table.weights
  );
  const codes = await solver.solveImage(target.rgb);

  const refRgb = readFileSync(join(caseDir, 'proof_ref.ppm'));
  const ref = parseP6(refRgb);
  assert.equal(ref.width, target.width);
  assert.equal(ref.height, target.height);
  assert.equal(ref.rgb.length, codes.length);

  // JS 码图正向一遍得到校样色，与参照校样逐字节比
  let diffs = 0;
  for (let p = 0; p < codes.length / 3; p++) {
    const o = p * 3;
    const proof = forward(table, codes[o], codes[o + 1], codes[o + 2]);
    for (let c = 0; c < 3; c++) {
      if (proof[c] !== ref.rgb[o + c]) {
        diffs++;
        assert.fail(
          `pixel ${p} channel ${c}: js=${proof[c]} ref=${ref.rgb[o + c]} code=${codes[o]},${codes[o + 1]},${codes[o + 2]}`
        );
      }
    }
  }
  assert.equal(diffs, 0);

  // 码图与参照码图也应一致
  const refCodes = parseP6(readFileSync(join(caseDir, 'codes_ref.ppm')));
  assert.deepEqual(Array.from(codes), Array.from(refCodes.rgb));
});
