// test/engine.test.js — 用 node -I 风格独立运行：node test/engine.test.js
const fs = require('fs');
const path = require('path');
const E = require(path.join(__dirname, '..', 'engine.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('  ok -', name);
  } else {
    failures++;
    console.error('FAIL -', name, detail || '');
  }
}
function approx(a, b, tol = 1e-6) { return Math.abs(a - b) <= tol; }

function freshRetained(scene) {
  const model = E.buildModel(scene);
  const rt = E.createRetained(model);
  return { model, rt };
}

// ---------- 1. 样例：prime 与全量一致，逐批次增量与全量一致 ----------
console.log('# 样例场景全流程');
const sample = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'samples', 'retained-tile-cases.json'), 'utf8'));
{
  const { model, rt } = freshRetained(sample);
  const primeLog = E.prime(rt);
  let full = E.fullRender(model);
  let d = E.diffBuffers(rt.canvas, full);
  check('prime 后增量 == 全量', d.count === 0, `mismatch=${d.count} max=${d.maxAbs}`);

  sample.edits.forEach((patches, i) => {
    E.validatePatches(model, patches);
    const log = E.applyBatch(rt, patches, { from: 'sample', index: i });
    full = E.fullRender(model);
    d = E.diffBuffers(rt.canvas, full);
    check(`批次 ${i + 1} 后增量 == 全量`, d.count === 0,
      `mismatch=${d.count} max=${d.maxAbs.toExponential(2)}` +
      (d.count ? ' first@' + JSON.stringify(d.pixels[0]) : ''));
    check(`批次 ${i + 1} 有重算瓦片`, log.stats.recomputed > 0,
      JSON.stringify(log.recomputedTiles));
  });
}

// ---------- 2. 平移：旧位置必须被覆盖（亮边检测） ----------
console.log('# 平移旧位置覆盖');
{
  const scene = {
    size: [64, 64], tile: 16,
    root: { id: 'root', r: 0, opacity: 1, clip: null, offset: [0, 0], children: [
      { id: 'g', r: 0, opacity: 1, clip: null, offset: [0, 0], children: [
        { id: 'a', box: [4, 4, 8, 8], rgba: [1, 0, 0, 1] }
      ] }
    ] }
  };
  const { model, rt } = freshRetained(scene);
  E.prime(rt);
  E.applyBatch(rt, [{ id: 'g', offset: [32, 32] }]);
  const full = E.fullRender(model);
  const d = E.diffBuffers(rt.canvas, full);
  check('组平移 32,32 后逐像素一致', d.count === 0, `mismatch=${d.count}`);
  // 旧位置像素必须全零
  let leftover = 0;
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) {
    const i = (y * 64 + x) * 4;
    if (rt.canvas[i + 3] !== 0) leftover++;
  }
  check('旧位置无残留像素（无亮边）', leftover === 0, `leftover=${leftover}`);
  // 新位置有颜色（叶子 4,4 + 组平移 32,32 = 画布 36,36）
  const ni = (36 * 64 + 36) * 4;
  check('新位置已绘制', approx(rt.canvas[ni], 1) && approx(rt.canvas[ni + 3], 1),
    'got ' + Array.from(rt.canvas.slice(ni, ni + 4)));
}

// ---------- 3. 只改左边不重画右边：脏区精确性 ----------
console.log('# 脏区精确性');
{
  const scene = {
    size: [64, 64], tile: 16,
    root: { id: 'root', r: 0, opacity: 1, clip: null, offset: [0, 0], children: [
      { id: 'g', r: 0, opacity: 1, clip: null, offset: [0, 0], children: [
        { id: 'a', box: [40, 40, 8, 8], rgba: [0, 1, 0, 1] }
      ] }
    ] }
  };
  const { model, rt } = freshRetained(scene);
  E.prime(rt);
  const log = E.applyBatch(rt, [{ id: 'g', offset: [-8, 0] }]);
  const recomputed = log.recomputedTiles.root || [];
  const maxTx = Math.max(...recomputed.map(k => parseInt(k.split(',')[0], 10)));
  check('左移 8px 不重算最右列瓦片', maxTx <= 2, `tiles=${JSON.stringify(recomputed)}`);
  const full = E.fullRender(model);
  check('左移后仍与全量一致', E.diffBuffers(rt.canvas, full).count === 0);
}

// ---------- 3b. 用户痛点复现：模糊组左移，旧位置无亮边、右侧不重画 ----------
console.log('# 亮边与过度重画');
{
  const scene = { size: [64, 64], tile: 16, root: {
    id: 'root', r: 0, opacity: 1, clip: null, offset: [0, 0], children: [
      { id: 'g', r: 2, opacity: 1, clip: null, offset: [0, 0], children: [
        { id: 'a', box: [36, 36, 8, 8], rgba: [1, 0, 0, 1] }
      ] }
    ] } };
  const { model, rt } = freshRetained(scene);
  E.prime(rt);
  const log = E.applyBatch(rt, [{ id: 'g', offset: [-16, 0] }]);
  const recomputed = new Set(log.recomputedTiles.root);
  check('左移不重算右侧瓦片 3,2', !recomputed.has('3,2'));
  check('旧位置瓦片 1,2 已失效覆盖', (log.damagedTiles.root || []).includes('1,2'));
  check('模糊组移动后逐像素一致', E.diffBuffers(rt.canvas, E.fullRender(model)).count === 0);
  const oldAlpha = rt.canvas[(40 * 64 + 38) * 4 + 3];
  check('旧位置无亮边残留', oldAlpha === 0, 'alpha=' + oldAlpha);
}

// ---------- 4. 嵌套模糊：平移覆盖旧+新位置，含模糊扩张 ----------
console.log('# 嵌套模糊');
{
  const scene = {
    size: [96, 96], tile: 16,
    root: { id: 'root', r: 0, opacity: 1, clip: null, offset: [0, 0], children: [
      { id: 'outer', r: 3, opacity: 0.5, clip: null, offset: [0, 0], children: [
        { id: 'inner', r: 2, opacity: 1, clip: null, offset: [0, 0], children: [
          { id: 'dot', box: [10, 10, 2, 2], rgba: [1, 0, 0, 1] }
        ] }
      ] }
    ] }
  };
  const { model, rt } = freshRetained(scene);
  E.prime(rt);
  const log = E.applyBatch(rt, [{ id: 'inner', offset: [20, 0] }]);
  const full = E.fullRender(model);
  const d = E.diffBuffers(rt.canvas, full);
  check('嵌套模糊平移后逐像素一致', d.count === 0,
    `mismatch=${d.count} max=${d.maxAbs.toExponential(2)}`);
  check('outer 与 inner 均有重算瓦片',
    (log.recomputedTiles.outer || []).length > 0 &&
    (log.recomputedTiles.inner || []).length > 0,
    JSON.stringify(log.recomputedTiles));
  // 模糊扩张：dot 旧盒 [10,10,2,2]，inner r=2 -> [8,8,6,6]；outer r=3 -> [5,5,12,12]
  const outerDamaged = (log.damagedTiles.outer || []).map(k => k.split(',').map(Number));
  const coversOld = outerDamaged.some(([tx, ty]) => tx === 0 && ty === 0);
  check('外层模糊扩张覆盖旧位置瓦片', coversOld, JSON.stringify(outerDamaged));
}

// ---------- 5. 裁剪、透明度、同组重排 ----------
console.log('# 裁剪 / 透明度 / 重排');
{
  const scene = {
    size: [64, 64], tile: 16,
    root: { id: 'root', r: 0, opacity: 1, clip: null, offset: [0, 0], children: [
      { id: 'g', r: 1, opacity: 1, clip: null, offset: [0, 0], children: [
        { id: 'b', box: [8, 8, 20, 20], rgba: [0, 0, 1, 0.8] },
        { id: 'y', box: [12, 12, 20, 20], rgba: [1, 1, 0, 0.6] }
      ] }
    ] }
  };
  const { model, rt } = freshRetained(scene);
  E.prime(rt);

  E.applyBatch(rt, [{ id: 'g', clip: [10, 10, 14, 14] }]);
  check('加裁框后一致', E.diffBuffers(rt.canvas, E.fullRender(model)).count === 0);

  E.applyBatch(rt, [{ id: 'g', opacity: 0.25 }]);
  check('改透明度后一致', E.diffBuffers(rt.canvas, E.fullRender(model)).count === 0);

  const log = E.applyBatch(rt, [{ id: 'g', children: ['y', 'b'] }]);
  check('同组重排后一致', E.diffBuffers(rt.canvas, E.fullRender(model)).count === 0);
  check('重排触发 g 重算', (log.recomputedTiles.g || []).length > 0);

  E.applyBatch(rt, [{ id: 'g', clip: null, opacity: 1, children: ['b', 'y'] }]);
  check('多补丁批次后一致', E.diffBuffers(rt.canvas, E.fullRender(model)).count === 0);
}

// ---------- 6. 撤销：逆向批次后回到原始像素 ----------
console.log('# 撤销等价');
{
  const scene = JSON.parse(JSON.stringify(sample));
  const { model, rt } = freshRetained(scene);
  E.prime(rt);
  const before = new Float32Array(rt.canvas);
  const inverse = [
    [{ id: 'outer', opacity: 1 }, { id: 'inner', offset: [0, 0] }, { id: 'outer', clip: null }],
    [{ id: 'far', children: ['blue', 'gold'] }],
    [{ id: 'outer', clip: null }],
    [{ id: 'inner', offset: [0, 0] }]
  ];
  sample.edits.forEach(p => E.applyBatch(rt, p));
  inverse.forEach(p => E.applyBatch(rt, p));
  // 逆放后模型回到初始场景；先与“当前模型的全新全量图”逐位对照，
  // 再与最初缓冲对照（仅允许模糊累加顺序造成的浮点差，<=0.02）。
  const freshFull = E.fullRender(model);
  const d0 = E.diffBuffers(rt.canvas, freshFull, 0);
  check('逆序回放后与全新全量图逐位一致', d0.count === 0,
    `mismatch=${d0.count} max=${d0.maxAbs}`);
  const d = E.diffBuffers(rt.canvas, before, 0.02);
  check('逆序回放后像素在浮点容差内复原', d.count === 0,
    `mismatch=${d.count} max=${d.maxAbs}`);
}

// ---------- 7. 盒模糊固定窗口面积：与独立参考公式对拍 ----------
console.log('# 盒模糊窗口面积');
{
  // r=1 时一个孤立不透明像素，模糊后中心 alpha = 1/9
  const scene = {
    size: [16, 16], tile: 16,
    root: { id: 'root', r: 1, opacity: 1, clip: null, offset: [0, 0], children: [
      { id: 'p', box: [8, 8, 1, 1], rgba: [1, 1, 1, 1] }
    ] }
  };
  const { model, rt } = freshRetained(scene);
  E.prime(rt);
  const i = (8 * 16 + 8) * 4;
  check('中心 alpha=1/9（固定 3x3 窗口）', approx(rt.canvas[i + 3], 1 / 9, 1e-6),
    'got ' + rt.canvas[i + 3]);
  // 角像素 alpha=1/9（越界按透明，不缩小窗口）
  const c = (0 * 16 + 0) * 4;
  check('角落 alpha=1/9（越界透明，窗口不缩）', approx(rt.canvas[c + 3], 0, 1e-6));
  const edge = (7 * 16 + 8) * 4;
  check('窗口边缘像素 alpha=1/9', approx(rt.canvas[edge + 3], 1 / 9, 1e-6),
    'got ' + rt.canvas[edge + 3]);
  const full = E.fullRender(model);
  check('模糊路径增量==全量', E.diffBuffers(rt.canvas, full).count === 0);
}

// ---------- 8. 校验：非法输入被拒 ----------
console.log('# 输入校验');
{
  const base = { size: [32, 32], tile: 16, root: {
    id: 'root', r: 0, opacity: 1, clip: null, offset: [0, 0],
    children: [{ id: 'a', box: [0, 0, 4, 4], rgba: [1, 1, 1, 1] }] } };
  const t = (mut, label) => {
    const s = JSON.parse(JSON.stringify(base));
    try { mut(s); E.buildModel(s); check(label, false, '应当抛错'); }
    catch (e) { check(label, true); }
  };
  t(s => { s.size = [2000, 32]; }, '拒绝超大画布');
  t(s => { s.root.children[0].rgba = [2, 0, 0, 1]; }, '拒绝越界 rgba');
  t(s => { s.root.r = 9; }, '拒绝 r>8');
  {
    const model = E.buildModel(base);
    try {
      E.validatePatches(model, [{ id: 'root', offset: [1, 0] }]);
      check('拒绝根平移', false);
    } catch (e) { check('拒绝根平移', true); }
    try {
      E.validatePatches(model, [{ id: 'a', offset: [1, 0] }]);
      check('拒绝叶子平移补丁', false);
    } catch (e) { check('拒绝叶子平移补丁', true); }
  }
}

// ---------- 9. 大场景压力（128 节点 / 1024 画布上限附近） ----------
console.log('# 压力场景');
{
  const children = [];
  for (let g = 0; g < 30; g++) {
    const leaves = [];
    for (let l = 0; l < 3; l++) {
      const id = 'leaf_' + g + '_' + l;
      leaves.push({ id, box: [(g * 23 + l * 7) % 900, (g * 31 + l * 11) % 900, 12, 12],
        rgba: [(g % 3) / 2, (l % 3) / 2, 0.5, 0.7] });
    }
    children.push({ id: 'grp_' + g, r: g % 4, opacity: 0.9, clip: null,
      offset: [0, 0], children: leaves });
  }
  // 30 组 * 4 节点(组+3叶) = 120
  const scene = { size: [1024, 1024], tile: 16,
    root: { id: 'root', r: 0, opacity: 1, clip: null, offset: [0, 0], children } };
  const t0 = Date.now();
  const { model, rt } = freshRetained(scene);
  E.prime(rt);
  const t1 = Date.now();
  let d = E.diffBuffers(rt.canvas, E.fullRender(model));
  check('1024²/120 节点 prime 一致', d.count === 0, `max=${d.maxAbs}`);
  const log = E.applyBatch(rt, [
    { id: 'grp_7', offset: [40, -24] },
    { id: 'grp_23', opacity: 0.3 }
  ]);
  const t2 = Date.now();
  d = E.diffBuffers(rt.canvas, E.fullRender(model));
  check('压力场景批次后一致', d.count === 0, `mismatch=${d.count}`);
  const totalTiles = 64 * 64;
  check('增量重算远小于全量瓦片', log.stats.recomputed < totalTiles,
    `recomputed=${log.stats.recomputed} vs ${totalTiles}`);
  console.log(`  计时: prime=${t1 - t0}ms batch=${t2 - t1}ms ` +
    `recomputed=${log.stats.recomputed} damaged=${log.stats.damaged}`);
}

// ---------- 10. 空组 / 完全裁掉 / 零透明度 ----------
console.log('# 边界情形');
{
  const scene = { size: [32, 32], tile: 16, root: {
    id: 'root', r: 0, opacity: 1, clip: null, offset: [0, 0], children: [
      { id: 'empty', r: 2, opacity: 1, clip: null, offset: [0, 0], children: [] },
      { id: 'g', r: 0, opacity: 0, clip: null, offset: [0, 0], children: [
        { id: 'a', box: [4, 4, 6, 6], rgba: [1, 0, 0, 1] }
      ] }
    ] } };
  const { model, rt } = freshRetained(scene);
  E.prime(rt);
  check('空组与零透明度 prime 一致', E.diffBuffers(rt.canvas, E.fullRender(model)).count === 0);
  E.applyBatch(rt, [{ id: 'g', opacity: 0.5, clip: [100, 100, 4, 4] }]);
  check('裁框完全移出后一致', E.diffBuffers(rt.canvas, E.fullRender(model)).count === 0);
  E.applyBatch(rt, [{ id: 'g', clip: [5, 5, 3, 3], opacity: 1 }]);
  check('裁框恢复后一致', E.diffBuffers(rt.canvas, E.fullRender(model)).count === 0);
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
