/* 跨语言一致性：JS 实现 vs Python 参考实现（expected.json） */
'use strict';
const path = require('path');

/* ---- 最小 DOM 桩：app.js 顶层会触碰 document/window ---- */
function any() {
  const f = function () {};
  return new Proxy(f, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
      if (k === 'clientWidth') return 900;
      if (k === 'width' || k === 'height') return 300;
      if (k === 'style' || k === 'dataset') return {};
      if (k === 'classList') return { toggle() {}, add() {}, remove() {} };
      return any();
    },
    set() { return true; },
    apply() { return any(); },
  });
}
global.window = global;
global.addEventListener = () => {};
global.removeEventListener = () => {};
global.document = any();
global.getComputedStyle = () => ({ getPropertyValue: () => '#ffffff' });
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.FileReader = function () {};
global.Blob = function () {};
global.URL = { createObjectURL: () => '', revokeObjectURL: () => {} };
require(path.join(__dirname, '..', 'web', 'samples.js')); // defines window.SAMPLES
const app = require(path.join(__dirname, '..', 'web', 'app.js'));

const expected = require(path.join(__dirname, 'expected.json'));
let fails = 0;
function assert(cond, msg) { if (!cond) { fails++; console.log('FAIL', msg); } }

for (const name of ['odd-standard', 'odd-reversed', 'stress']) {
  const d = window.SAMPLES[name];
  const errs = app.validateInput(d);
  assert(errs.length === 0, `${name} validation: ${errs.join(';')}`);
  app.loadDataset(d, name);
  const got = app.S;
  const exp = expected[name];

  // 金字塔尺寸
  const sizes = got.pyramid.map(l => [l.w, l.h]);
  assert(JSON.stringify(sizes) === JSON.stringify(exp.sizes),
    `${name} pyramid sizes ${JSON.stringify(sizes)} != ${JSON.stringify(exp.sizes)}`);

  // 逐盒判定
  let pyrTotal = 0, exhTotal = 0;
  for (const eb of exp.boxes) {
    const r = got.results.get(eb.id);
    assert(!!r, `${name} box ${eb.id} missing`);
    if (!r) continue;
    assert(r.status === eb.status, `${name}/${eb.id} status ${r.status} != ${eb.status}`);
    if (eb.rect) assert(JSON.stringify(r.rect) === JSON.stringify(eb.rect),
      `${name}/${eb.id} rect ${JSON.stringify(r.rect)} != ${JSON.stringify(eb.rect)}`);
    if (eb.near_depth !== null && eb.near_depth !== undefined)
      assert(Math.abs(r.nearDepth - eb.near_depth) < 1e-12,
        `${name}/${eb.id} nearDepth ${r.nearDepth} != ${eb.near_depth}`);
    if (eb.agg !== null && eb.agg !== undefined) {
      assert(r.pyramidValue === eb.agg, `${name}/${eb.id} pyramidValue ${r.pyramidValue} != ${eb.agg}`);
      assert(r.exhaustiveValue === eb.exh, `${name}/${eb.id} exhaustive ${r.exhaustiveValue} != ${eb.exh}`);
      assert(r.match === true, `${name}/${eb.id} pyramid != exhaustive`);
      assert(r.visits === eb.pyr_visits, `${name}/${eb.id} visits ${r.visits} != ${eb.pyr_visits}`);
      assert(r.pixels === eb.exh_pixels, `${name}/${eb.id} pixels ${r.pixels} != ${eb.exh_pixels}`);
      pyrTotal += r.visits; exhTotal += r.pixels;
    }
  }
  assert(pyrTotal === exp.tot_pyr, `${name} total pyr visits ${pyrTotal} != ${exp.tot_pyr}`);
  assert(exhTotal === exp.tot_exh, `${name} total exh ${exhTotal} != ${exp.tot_exh}`);
  assert(got.stats.mismatch === 0, `${name} mismatch count ${got.stats.mismatch}`);
  console.log(`PASS ${name}: ${got.boxes.length} boxes, sizes=${JSON.stringify(sizes)}, pyr=${pyrTotal}, exh=${exhTotal}`);
}

/* 校验路径：invalid-depth 必须报错且不加载 */
const inv = window.SAMPLES['invalid-depth'];
const invErrs = app.validateInput(inv);
assert(invErrs.some(e => e.includes('超出 [0,1]')), `invalid-depth not rejected: ${invErrs}`);
console.log('PASS invalid-depth rejected:', invErrs[0]);

/* 节点覆盖：底向上对齐。根节点覆盖整幅图像；任意节点覆盖不越界且宽高≥1 */
{
  app.loadDataset(window.SAMPLES['odd-standard'], 'odd-standard');
  const p = app.S.pyramid;
  const top = p.length - 1;
  const root = app.nodeCover(p, top, 0, 0);
  assert(JSON.stringify(root) === JSON.stringify([0, 0, 7, 5]), `root cover ${root} != full image [0,0,7,5]`);
  for (let L = 0; L < p.length; L++) {
    for (let ny = 0; ny < p[L].h; ny++) for (let nx = 0; nx < p[L].w; nx++) {
      const c = app.nodeCover(p, L, nx, ny);
      assert(c[0] >= 0 && c[1] >= 0 && c[2] <= 7 && c[3] <= 5 && c[2] > c[0] && c[3] > c[1],
        `L${L}(${nx},${ny}) bad cover ${c}`);
    }
  }
  // 奇数尺寸边界节点：L2(1,1) 的覆盖右/下沿被图像尺寸截断，而非延伸到 8/6
  const edge = app.nodeCover(p, 2, 1, 1);
  assert(edge[2] <= 7 && edge[3] <= 5, `odd edge node overflows: ${edge}`);
  console.log('PASS odd-size node cover bottom-up alignment; root covers full image, all nodes in bounds');
}

/* 孔洞编辑后重算：把 blocked 盒矩形内像素刷成清屏值，应变 visible */
{
  app.loadDataset(window.SAMPLES['odd-standard'], 'odd-standard');
  const before = app.S.results.get('blocked').status;
  assert(before === 'occluded', 'blocked should start occluded');
  const r = app.S.results.get('blocked');
  const [x0, y0, x1, y1] = r.rect;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) app.S.depth[y * app.S.W + x] = 1;
  app.runAll();
  const after = app.S.results.get('blocked').status;
  assert(after === 'visible', `hole paint should make blocked visible, got ${after}`);
  console.log('PASS hole edit recompute: occluded -> visible');
}

console.log(fails === 0 ? '\nALL CROSS-LANGUAGE TESTS PASSED' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
