// 核心数学不变量测试：node tests/run-tests.mjs
import {
  Frac, Studio,
  parseCurveObject, curveToObject, queryAt, insertKnot, removeKnotAt,
  moveProjectedPoint, setWeight, evalHomogeneousSide,
  tessellate, buildExportSVG, evalPointFloat,
} from '../rks.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function eqF(a, b, msg) { ok(a instanceof Frac && b instanceof Frac && a.eq(b), msg + ` (got ${a}, want ${b})`); }
function section(name) { console.log('\n=== ' + name + ' ==='); }

/* ---------------- Frac ---------------- */
section('Frac 精确约分与解析');
{
  eqF(Frac.parse('3/4'), new Frac(3n, 4n), 'parse 3/4');
  eqF(Frac.parse('-6/8'), new Frac(-3n, 4n), '负分数约分');
  eqF(Frac.parse('0.25'), new Frac(1n, 4n), '小数 0.25');
  eqF(Frac.parse('7'), new Frac(7n), '整数');
  ok(Frac.parse('10/4').toString() === '5/2', '输出约分 5/2: ' + Frac.parse('10/4'));
  ok(Frac.parse('4/2').toString() === '2', '整数不带分母');
  ok(Frac.parse('1/-2').toString() === '-1/2', '分母为负转正');
  ok(Frac.parse('1/3').add(Frac.parse('1/6')).eq(Frac.parse('1/2')), '1/3+1/6=1/2');
  ok(Frac.parse('5/7').toDecimal(6) === '0.714286', '十进制四舍五入: ' + Frac.parse('5/7').toDecimal(6));
}

/* ---------------- 样例黄金值 ---------------- */
section('样例曲线黄金求值/导数');
const sampleText = readFileSync(join(here, '..', 'samples', 'rational-knot.json'), 'utf8');
const sampleObj = JSON.parse(sampleText);
const parsed = parseCurveObject(sampleObj);
ok(parsed.ok, '样例解析成功: ' + (parsed.errors || []).join(';'));
const c0 = parsed.curve;
{
  const q = queryAt(c0, '1/2');
  ok(q.ok, 'u=1/2 查询成功');
  eqF(q.point.x, new Frac(5n, 7n), 'x(1/2)=5/7');
  eqF(q.point.y, new Frac(5n, 7n), 'y(1/2)=5/7');
  ok(q.left && q.right, '内部点有左右导数');
  eqF(q.left.dx, new Frac(-8n, 7n), "x'_-(1/2)=-8/7");
  eqF(q.left.dy, new Frac(8n, 7n), "y'_-(1/2)=8/7");
  eqF(q.right.dx, new Frac(-8n, 7n), "x'_+(1/2)=-8/7（光滑点两侧相同）");
  eqF(q.right.dy, new Frac(8n, 7n), "y'_+(1/2)=8/7");
}
{
  const q0 = queryAt(c0, '0');
  ok(q0.right && q0.left === null, '左端点只显示右导数');
  const q1 = queryAt(c0, '1');
  ok(q1.left && q1.right === null, '右端点只显示左导数');
  // 贝塞尔端点插值
  eqF(q0.point.x, Frac.parse('1'), 'C(0)=P0 投影 x=1');
  eqF(q0.point.y, Frac.parse('0'), 'C(0) y=0');
  eqF(q1.point.x, Frac.parse('0'), 'C(1)=P2 x=0');
  eqF(q1.point.y, Frac.parse('1'), 'C(1) y=1');
}

/* ---------------- 浮点有限差分核对左右导数 ---------------- */
section('导数 vs 有限差分（含重节点）');
function finiteDiffChecks(c, label, us) {
  for (const ustr of us) {
    const u = Frac.parse(ustr);
    const un = u.toNumber();
    const q = queryAt(c, u);
    if (!q.ok) { ok(false, label + ' query ' + ustr); continue; }
    const eps = 1e-6;
    for (const side of ['left', 'right']) {
      const h = side === 'left' ? -eps : eps;
      const pA = evalPointFloat(c, null, un);
      const pB = evalPointFloat(c, null, un + h);
      if (!pA || !pB) continue;
      const fdx = (pB[0] - pA[0]) / h;
      const fdy = (pB[1] - pA[1]) / h;
      const d = q[side];
      const ex = Math.abs(d.dx.toNumber() - fdx);
      const ey = Math.abs(d.dy.toNumber() - fdy);
      const tol = 2e-3; // 二阶差分误差 O(eps * max f'') 量级
      ok(ex < tol && ey < tol,
        `${label} u=${ustr} ${side} 导数精确值(${d.dx.toDecimal(5)},${d.dy.toDecimal(5)}) ~ 差分(${fdx.toFixed(5)},${fdy.toFixed(5)}) err=${ex.toExponential(1)},${ey.toExponential(1)}`);
    }
  }
}
finiteDiffChecks(c0, 'sample', ['0.1', '1/2', '0.8', '0.25', '0.75']);

/* ---------------- 插入齐次不变性 ---------------- */
section('节点插入：齐次曲线完全不变');
function randomCurve(seed, p, N, opts = {}) {
  // 确定性伪随机
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  // 合法夹持节点：两端各 p+1 个；内部出现数 N-p-1
  // 合法内部节点：K=N-p-1 个出现位置，分组（每组重数 1..p），组值均匀落在 (0,2)
  const K = N - p - 1;
  const runs = [];
  let remain = K;
  while (remain > 0) {
    let mult = rnd() < 0.7 ? 1 : 1 + Math.floor(rnd() * p);
    mult = Math.max(1, Math.min(mult, p, remain));
    runs.push(mult);
    remain -= mult;
  }
  const G = runs.length;
  const interior = [];
  runs.forEach((mult, g) => {
    const v = new Frac(2 * (g + 1), G + 1);
    for (let z = 0; z < mult; z++) interior.push(v);
  });
  interior.sort((a, b) => a.cmp(b));
  const knots = [];
  for (let i = 0; i <= p; i++) knots.push(new Frac(0));
  for (const v of interior) knots.push(v);
  for (let i = 0; i <= p; i++) knots.push(new Frac(2));
  const points = [];
  for (let i = 0; i < N; i++) {
    const x = new Frac(Math.floor(rnd() * 100) - 50, 4);
    const y = new Frac(Math.floor(rnd() * 100) - 50, 4);
    let w = new Frac(Math.floor(rnd() * 8) + 1, 2);
    if (opts.negativeWeights && i === (opts.negIndex ?? 2)) w = w.neg();
    points.push({ X: x.mul(w), Y: y.mul(w), W: w });
  }
  return { degree: p, knots, points };
}

function homogeneousEqualAtAll(c1, c2, label) {
  const us = ['0', '1/12', '1/6', '1/4', '1/3', '5/12', '1/2', '7/12', '2/3', '3/4', '5/6', '11/12', '2'];
  for (const usv of us) {
    const u = Frac.parse(usv);
    if (u.lt(c1.knots[0]) || u.gt(c1.knots.at(-1))) continue;
    const A = evalHomogeneousSide(c1, u, u.eq(c1.knots.at(-1)) ? 'left' : 'right');
    const B = evalHomogeneousSide(c2, u, u.eq(c2.knots.at(-1)) ? 'left' : 'right');
    ok(A.X.eq(B.X) && A.Y.eq(B.Y) && A.W.eq(B.W), `${label} 齐次值在 u=${usv} 完全相等`);
  }
}

for (const [p, N] of [[2, 3], [2, 8], [3, 6], [4, 9], [5, 12], [3, 4]]) {
  const c = randomCurve(1000 + p * 31 + N, p, N);
  const u = Frac.parse('1/2');
  const ir = insertKnot(c, u);
  ok(ir.ok, `p=${p} N=${N} 插入 1/2 成功: ${ir.error || ''}`);
  if (ir.ok) {
    ok(ir.curve.points.length === N + 1 && ir.curve.knots.length === N + p + 2, '数量 +1');
    homogeneousEqualAtAll(c, ir.curve, `p=${p} N=${N} 插入后`);
    // 再插一个分数
    const ir2 = insertKnot(ir.curve, Frac.parse('2/3'));
    ok(ir2.ok, `p=${p} 二次插入 2/3 成功`);
    if (ir2.ok) homogeneousEqualAtAll(c, ir2.curve, `p=${p} 两次插入后`);
  }
}

/* ---------------- 插入/删除往返 + 严格条件 ---------------- */
section('删除：重插完全相等 + 正权重');
{
  const ins = insertKnot(c0, '1/2');
  ok(ins.ok, '样例插入 1/2');
  const c1 = ins.curve;
  // 找到 1/2 的内部出现下标
  const r = c1.knots.findIndex((k, i) => i >= 3 && k.eq(Frac.parse('1/2')));
  const rm = removeKnotAt(c1, r);
  ok(rm.ok, '立即删除刚插入的节点成功: ' + (rm.error || ''));
  if (rm.ok) {
    ok(JSON.stringify(curveToObject(rm.curve)) === JSON.stringify(curveToObject(c0)),
      '删除后与原曲线逐字段完全一致');
    ok(rm.curve.points.every((pt) => pt.W.sign() > 0), '减点后权重全正');
  }
}
{
  // 两次插入同一点提高重数，再逐次删除
  let cur = insertKnot(c0, '1/2').curve;
  cur = insertKnot(cur, '1/2').curve;
  ok(cur.knots.filter((k) => k.eq(Frac.parse('1/2'))).length === 2, '1/2 重数为 2');
  const range = { first: 3, last: cur.points.length - 1 };
  const r2 = cur.knots.findIndex((k, i) => i >= range.first && i <= range.last && k.eq(Frac.parse('1/2')));
  let rm1 = removeKnotAt(cur, r2);
  ok(rm1.ok, '双重点删除一次成功: ' + (rm1.error || ''));
  if (rm1.ok) {
    const r1 = rm1.curve.knots.findIndex((k, i) => i >= 3 && k.eq(Frac.parse('1/2')));
    const rm2 = removeKnotAt(rm1.curve, r1);
    ok(rm2.ok, '再删除一次成功: ' + (rm2.error || ''));
    if (rm2.ok) ok(JSON.stringify(curveToObject(rm2.curve)) === JSON.stringify(curveToObject(c0)),
      '双重插入逐次删除后复原');
  }
}
{
  // 移动控制点后，删除必须失败，且原对象不被修改
  const ins = insertKnot(c0, '1/2').curve;
  const before = JSON.stringify(curveToObject(ins));
  const moved = moveProjectedPoint(ins, 1, '2', '2');
  ok(moved.ok, '移动一个新控制点');
  const r = moved.curve.knots.findIndex((k, i) => i >= 3 && k.eq(Frac.parse('1/2')));
  const rm = removeKnotAt(moved.curve, r);
  ok(!rm.ok, '移动后删除被拒绝');
  ok(JSON.stringify(curveToObject(moved.curve)) !== before, '移动确实改变了曲线');
  // 失败调用本身不改变输入
  const snapshotInput = JSON.stringify(curveToObject(moved.curve));
  removeKnotAt(moved.curve, r);
  ok(JSON.stringify(curveToObject(moved.curve)) === snapshotInput, '失败的 removeKnotAt 不改输入');
}

/* ---------------- Studio 撤销/重做/失败不吞 redo ---------------- */
section('Studio 历史语义');
{
  const st = new Studio(sampleObj);
  const s0 = st.snapshot();
  ok(st.insertKnot('1/2').ok, 'studio 插入');
  const s1 = st.snapshot();
  ok(s1 !== s0, '状态改变');
  ok(st.canUndo && !st.canRedo, '可撤销不可重做');
  st.undo();
  ok(st.snapshot() === s0, 'undo 回到 s0');
  ok(st.canRedo, '现在可重做');
  // 一次失败编辑不能吞掉 redo
  const failed = st.removeKnotAt(999);
  ok(!failed.ok, '非法删除失败');
  ok(st.canRedo, '失败后 redo 仍在');
  ok(st.snapshot() === s0, '失败后曲线不变');
  st.redo();
  ok(st.snapshot() === s1, 'redo 完整恢复 s1');
  // 新的成功编辑清空 redo 分支
  st.undo();
  ok(st.canRedo, '再次可重做');
  ok(st.movePoint(0, '1.5', '0.25').ok, '成功移动点');
  ok(!st.canRedo, '新成功编辑清空 redo');
  st.undo();
  ok(st.snapshot() === s0, '移动可撤销');
}

/* ---------------- 改权重保投影 ---------------- */
section('权重编辑保持投影坐标');
{
  const c = c0;
  const i = 1;
  const before = queryAt(c, '1/2').point;
  const wr = setWeight(c, i, '2');
  ok(wr.ok, '权重改为 2');
  if (wr.ok) {
    const old = c.points[i];
    const nw = wr.curve.points[i];
    const ratio = Frac.parse('2').div(old.W); // 2 / (3/4) = 8/3
    ok(nw.X.eq(old.X.mul(ratio)) && nw.Y.eq(old.Y.mul(ratio)) && nw.W.eq(old.W.mul(ratio)),
      '齐次 X,Y,W 按 newW/oldW 同比缩放');
    // 该 CP 的投影仍是 X_old/W_old = 1
    ok(nw.X.div(nw.W).eq(Frac.parse('1')), '改权重后该点投影 x=1');
  }
  const bad = setWeight(c, 0, '0');
  ok(!bad.ok, '权重 0 被拒绝');
}

/* ---------------- 删除的正权重硬条件（重插可相等但候选负权重） ---------------- */
section('删除正权重闸门');
{
  const pt = (x, y, w) => [String(x * w), String(y * w), String(w)];
  const C = parseCurveObject({
    degree: 2, knots: ['0', '0', '0', '1', '1', '1'],
    points: [pt(0, 0, 1), pt(1, 1, -1 / 5), pt(2, 0, 1)],
  }).curve;
  const P = insertKnot(C, '1/2').curve;
  ok(P.points.every((q) => q.W.sign() > 0), '插入态当前权重全正: ' + P.points.map((q) => q.W.toString()).join(','));
  const rm = removeKnotAt(P, 3);
  ok(!rm.ok && /权重/.test(rm.error), '精确逆候选含负权重时仍拒绝: ' + rm.error);
  ok(P.points.length === 4, '拒绝后输入曲线不变');

  // Studio 按值删除 + queryPlain
  const st = new Studio(sampleObj);
  ok(st.insertKnot('1/2').ok, 'studio 插入');
  const rv = st.removeKnotValue('1/2');
  ok(rv.ok, 'removeKnotValue 1/2 成功');
  ok(st.curve.points.length === 3, '按值删除后回到 3 点');
  const qp = st.queryPlain('1/2');
  ok(qp.ok && qp.point.x === '5/7' && qp.left.dx === '-8/7' && qp.right.dy === '8/7',
    'queryPlain 输出纯字符串精确值');
  ok(qp.left.dxDecimal && typeof qp.left.dxDecimal === 'string', 'queryPlain 带十进制字符串');
  const seg = st.segmentsData();
  ok(seg.count > 0 && seg.limit === 0.25 && typeof seg.svg === 'string', 'segmentsData 可用');
}

/* ---------------- 重复节点左右导数不同 ---------------- */
section('重复节点显示两侧导数');
{
  // 真正的尖角：p=2 且内部二重节点，控制点构造为不可约的折角
  // U=[0,0,0,.5,.5,1,1,1]，曲线在 u=.5 插值 P2，两侧切向分别沿 P2-P1 / P3-P2
  const corner = parseCurveObject({
    degree: 2,
    knots: ['0', '0', '0', '1/2', '1/2', '1', '1', '1'],
    points: [
      ['0', '0', '1'],
      ['1', '0', '1'],
      ['1', '1', '1'],
      ['2', '1', '1'],
      ['2', '2', '1'],
    ],
  }).curve;
  const q = queryAt(corner, '1/2');
  ok(q.left && q.right, '二重节点处两侧导数都存在');
  const neq = !q.left.dx.eq(q.right.dx) || !q.left.dy.eq(q.right.dy);
  ok(neq, '尖角二重节点处左右导数不同: L=(' + q.left.dx.toString() + ',' + q.left.dy.toString() +
    ') R=(' + q.right.dx.toString() + ',' + q.right.dy.toString() + ')');
  // 二阶单侧有限差分核对精确左右导数
  const Uf = corner.knots.map((k) => k.toNumber());
  const un = 0.5, h = 1e-4;
  const f0 = evalPointFloat(corner, Uf, un);
  const fm1 = evalPointFloat(corner, Uf, un - h);
  const fm2 = evalPointFloat(corner, Uf, un - 2 * h);
  const fp1 = evalPointFloat(corner, Uf, un + h);
  const fp2 = evalPointFloat(corner, Uf, un + 2 * h);
  const bwdX = (3 * f0[0] - 4 * fm1[0] + fm2[0]) / (2 * h);
  const bwdY = (3 * f0[1] - 4 * fm1[1] + fm2[1]) / (2 * h);
  const fwdX = (-3 * f0[0] + 4 * fp1[0] - fp2[0]) / (2 * h);
  const fwdY = (-3 * f0[1] + 4 * fp1[1] - fp2[1]) / (2 * h);
  ok(Math.abs(q.left.dx.toNumber() - bwdX) < 1e-3 && Math.abs(q.left.dy.toNumber() - bwdY) < 1e-3,
    `左导数精确(${q.left.dx.toDecimal(4)},${q.left.dy.toDecimal(4)}) ~ 后差(${bwdX.toFixed(4)},${bwdY.toFixed(4)})`);
  ok(Math.abs(q.right.dx.toNumber() - fwdX) < 1e-3 && Math.abs(q.right.dy.toNumber() - fwdY) < 1e-3,
    `右导数精确(${q.right.dx.toDecimal(4)},${q.right.dy.toDecimal(4)}) ~ 前差(${fwdX.toFixed(4)},${fwdY.toFixed(4)})`);

  // 纯插入得到的二重节点仍光滑（插入保持曲线），但两侧都必须给出且相等
  let cc = insertKnot(c0, '1/2').curve;
  cc = insertKnot(cc, '1/2').curve;
  const q2 = queryAt(cc, '1/2');
  ok(q2.left && q2.right, '插入产生的二重节点同样显示两侧');
  ok(q2.left.dx.eq(q2.right.dx) && q2.left.dy.eq(q2.right.dy), '光滑重节点两侧导数相等（符合预期）');
  finiteDiffChecks(cc, 'double-knot-smooth', ['0.3', '0.49']);
}

/* ---------------- SVG 误差契约（模拟检查器） ---------------- */
section('SVG 折线 0.25 误差契约');
function checkSVGContract(c, label) {
  const built = buildExportSVG(c);
  const segs = built.segments;
  ok(segs.length > 0, label + ' 生成段数 >0: ' + segs.length);
  let worst = 0;
  for (const s of segs) {
    // 以导出字符串中的十进制端点为准（模拟外部检查器）
    const u0 = Number(s.u0.toDecimal(12)), u1 = Number(s.u1.toDecimal(12));
    // 端点坐标用 exactEndpointStrings 同源逻辑：直接用 float 端点近似即可，
    // 这里更严格地从生成的 SVG 文本解析。
    const m = built.svg.match(new RegExp('data-u0="' + s.u0.toDecimal(12).replace('.', '\\.') +
      '"[^\\n]*points="([^"]+)"'));
    let p0, p1;
    if (m) {
      const [a, b] = m[1].split(' ');
      p0 = a.split(',').map(Number); p1 = b.split(',').map(Number);
    } else {
      p0 = evalPointFloat(c, null, u0); p1 = evalPointFloat(c, null, u1);
    }
    for (let j = 0; j <= 120; j++) {
      const t = j / 120;
      const u = u0 + t * (u1 - u0);
      const ref = evalPointFloat(c, null, u);
      if (!ref) continue;
      const qx = p0[0] + t * (p1[0] - p0[0]);
      const qy = p0[1] + t * (p1[1] - p0[1]);
      worst = Math.max(worst, Math.hypot(ref[0] - qx, ref[1] - qy));
    }
  }
  ok(worst <= 0.25, label + ` 每段参数线性插值最大误差 ${worst.toFixed(4)} <= 0.25（段数 ${segs.length}）`);
  ok(built.maxDeviation < 0.25, label + ' 自报最大偏差 < 0.25: ' + built.maxDeviation.toFixed(4));
  return worst;
}
checkSVGContract(c0, 'sample');
for (const [p, N] of [[2, 20], [3, 30], [5, 24], [4, 40]]) {
  checkSVGContract(randomCurve(77 + p, p, N), `random p=${p} N=${N}`);
}
{
  // 尖角轮廓：二重/三重节点密集
  let cc = parseCurveObject({
    degree: 3,
    knots: ['0','0','0','0','1/3','1/3','2/3','2/3','1','1','1','1'],
    points: [['0','0','1'],['1','2','1'],['2','0','1'],['3','2','1'],['4','0','1'],['5','1','1'],['6','0','1'],['7','2','1']],
  }).curve;
  checkSVGContract(cc, 'sharp multi-knot');
}

/* ---------------- 512 上限 ---------------- */
section('规模上限');
{
  const big = { degree: 2, knots: [], points: [] };
  for (let i = 0; i < 513; i++) big.points.push([String(i), String((i * i) % 97), '1']);
  big.knots = ['0', '0', '0'];
  for (let i = 0; i < 513 - 3; i++) big.knots.push(String(i + 1));
  big.knots.push('511', '511', '511');
  const r = parseCurveObject(big);
  ok(!r.ok && r.errors.some((e) => e.includes('512')), '513 控制点被拒绝');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail) { console.error('\n失败项:\n - ' + failures.join('\n - ')); process.exit(1); }
