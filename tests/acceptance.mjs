// 严格对齐题目 qa-gen 验收点的 6 个难点场景：node tests/acceptance.mjs
import {
  Frac, Studio, parseCurveObject, insertKnot, removeKnotAt,
  curveToObject, evalHomogeneousSide, evalPointFloat, buildExportSVG,
} from '../rks.mjs';

let pass = 0, fail = 0;
const fails = [];
function ok(c, m) { if (c) { pass++; } else { fail++; fails.push(m); console.error('  ✗', m); } }
function section(s) { console.log('\n— ' + s); }

/* AP1: 不等权五次曲线，两个相差 2^-60 的内部参数，精确插入/齐次对照/删回 */
section('AP1 五次 + 2^-60 间距双节点');
{
  const p = 5, N = 8;
  const knots = [];
  for (let i = 0; i <= p; i++) knots.push('0');
  knots.push('1/3', '2/3');
  for (let i = 0; i <= p; i++) knots.push('1');
  const points = [];
  for (let i = 0; i < N; i++) {
    const w = Frac.parse(i % 2 ? '2/3' : '5/4');
    points.push([Frac.parse(i * 7 - 20).mul(w).toString(), Frac.parse((i * i * 3) % 19 - 9).mul(w).toString(), w.toString()]);
  }
  const c = parseCurveObject({ degree: p, knots, points }).curve;
  const base = JSON.stringify(curveToObject(c));
  const eps = new Frac(1n, 2n ** 60n);
  const u1 = new Frac(1, 2), u2 = u1.add(eps);
  let cur = insertKnot(c, u1).curve;
  cur = insertKnot(cur, u2).curve;
  ok(cur.points.length === N + 2, '两次插入 +2 CP');
  ok(cur.knots.filter((k) => k.eq(u1) || k.eq(u2)).length === 2, '两个极近节点在 bigint 下未合并');
  for (const us of ['0', '1/7', '1/2', u2.toString(), '2/3', '1']) {
    const u = Frac.parse(us);
    const side = u.eq(c.knots.at(-1)) ? 'left' : 'right';
    const A = evalHomogeneousSide(c, u, side);
    const B = evalHomogeneousSide(cur, u, side);
    ok(A.X.eq(B.X) && A.Y.eq(B.Y) && A.W.eq(B.W), '齐次系数在 ' + us + ' 完全相等');
  }
  for (const target of [u2, u1]) {
    const idxs = [];
    for (let i = p + 1; i <= cur.points.length - 1; i++) if (cur.knots[i].eq(target)) idxs.push(i);
    const rm = removeKnotAt(cur, idxs[0]);
    ok(rm.ok, '删回 ' + target.toString().slice(0, 12) + '… 成功');
    if (rm.ok) cur = rm.curve;
  }
  ok(JSON.stringify(curveToObject(cur)) === base, '逐项还原原曲线');
}

/* AP2: 新增齐次点三分量同步乘 1+2^-60，投影 CP 不动，但重插校验失败 */
section('AP2 2^-60 齐次微扰阻止删除');
{
  const st = new Studio({ degree: 2, knots: ['0', '0', '0', '1', '1', '1'],
    points: [['0', '0', '1'], ['3', '1', '2'], ['2', '4', '1']] });
  st.insertKnot('1/2');
  const i = 2, p0 = st.curve.points[i];
  const lam = new Frac(2n ** 60n + 1n, 2n ** 60n);
  st.setHomogeneousPoint(i, p0.X.mul(lam).toString(), p0.Y.mul(lam).toString(), p0.W.mul(lam).toString());
  const p1 = st.curve.points[i];
  ok(p1.X.div(p1.W).eq(p0.X.div(p0.W)) && p1.Y.div(p1.W).eq(p0.Y.div(p0.W)), '该控制点投影未移动');
  const r = st.removeKnotValue('1/2');
  ok(!r.ok && /不完全相等/.test(r.error), '精确重插发现 2^-60 差异并拒绝: ' + r.error);
  // setWeight(W*λ) 等价于三分量同步 λ 缩放
  const st2 = new Studio({ degree: 2, knots: ['0', '0', '0', '1', '1', '1'],
    points: [['0', '0', '1'], ['3', '1', '2'], ['2', '4', '1']] });
  st2.insertKnot('1/2');
  const before = st2.curve.points[i];
  st2.setWeight(i, before.W.mul(lam).toString());
  const after = st2.curve.points[i];
  ok(after.X.eq(before.X.mul(lam)) && after.Y.eq(before.Y.mul(lam)) && after.W.eq(before.W.mul(lam)),
    '改权重路径产生完全相同的同步缩放');
  ok(!st2.removeKnotValue('1/2').ok, '权重微扰后同样不可删');
}

/* AP3: 指定节点/点位的黄金左右导数 + 改末端权重不取错段 */
section('AP3 重复节点双侧导数黄金值');
{
  const st = new Studio({ degree: 2, knots: ['0', '0', '0', '1', '1', '2', '2', '2'],
    points: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]].map(([x, y]) => [String(x), String(y), '1']) });
  const q = st.queryPlain('1');
  ok(q.point.x === '2' && q.point.y === '0', 'C(1)=(2,0)');
  ok(q.left.dx === '2' && q.left.dy === '0', '左导数 (2,0)，实际 (' + q.left.dx + ',' + q.left.dy + ')');
  ok(q.right.dx === '0' && q.right.dy === '2', '右导数 (0,2)，实际 (' + q.right.dx + ',' + q.right.dy + ')');
  st.setWeight(4, '3');
  const q2 = st.queryPlain('1');
  ok(q2.left.dx === '2' && q2.left.dy === '0', '改末端权后左导数仍 (2,0)，没有取错段');
  ok(q2.right.dx === '0' && q2.right.dy === '2', '右起点切向不依赖末端权，仍 (0,2)');
}

/* AP4: 历史序列 + 端节点删除/零权重两失败不影响 JSON 与 redo */
section('AP4 失败不吞 redo');
{
  const st = new Studio({ degree: 2, knots: ['0', '0', '0', '1', '1', '1'],
    points: [['1', '0', '1'], ['3/4', '3/4', '3/4'], ['0', '1', '1']] });
  st.insertKnot('1/2'); st.insertKnot('1/3'); st.setWeight(1, '7'); st.movePoint(0, '2', '2');
  const target = st.exportJSON(0);
  st.undo();
  const atUndo = st.exportJSON(0);
  ok(!st.removeKnotAt(0).ok, '端下标 0 删除失败');
  ok(!st.removeKnotValue('0').ok, '按端值删除失败');
  ok(!st.setWeight(2, '0').ok, '权重 0 失败');
  ok(st.exportJSON(0) === atUndo, '两/三项失败后 JSON 与撤销瞬间一致');
  ok(st.canRedo, 'redo 保留');
  st.redo();
  ok(st.exportJSON(0) === target, 'redo 精确回到撤销前状态');
}

/* AP5: 极端权重三次窄峰；从导出 SVG 文本解析端点，查 u=1/50 与密集点 */
section('AP5 0.25 SVG 契约（极端窄峰）');
{
  const c = parseCurveObject({ degree: 3, knots: ['0', '0', '0', '0', '1', '1', '1', '1'],
    points: [['0', '0', '1'], ['10000', '0', '100'], ['0', '0', '1'], ['0', '0', '1000000']] }).curve;
  const { svg } = buildExportSVG(c);
  const segRe = /data-u0="([^"]+)" data-u1="([^"]+)"[^]*?points="([^"]+)"/g;
  const segs = [];
  let m;
  while ((m = segRe.exec(svg))) {
    const nums = m[3].match(/-?\d+(\.\d+)?/g).map(Number);
    segs.push({ u0: Number(m[1]), u1: Number(m[2]), x0: nums[0], y0: nums[1], x1: nums[2], y1: nums[3] });
  }
  ok(segs.length > 1, '从 SVG 文本解析出多段: ' + segs.length);
  function errAt(u) {
    const s = segs.find((z) => u >= z.u0 - 1e-10 && u <= z.u1 + 1e-10);
    if (!s) return Infinity;
    const t = (u - s.u0) / (s.u1 - s.u0);
    const qx = s.x0 + t * (s.x1 - s.x0), qy = s.y0 + t * (s.y1 - s.y0);
    const r = evalPointFloat(c, null, u);
    return Math.hypot(qx - r[0], qy - r[1]);
  }
  const e002 = errAt(0.02);
  ok(e002 <= 0.25, 'u=0.02 误差 ' + e002.toFixed(4) + ' <= .25（窄峰被细分捕获）');
  let worst = 0;
  for (let i = 0; i <= 20000; i++) worst = Math.max(worst, errAt(i / 20000));
  ok(worst <= 0.25, '20001 密集采样最大误差 ' + worst.toFixed(4) + ' <= .25');
}

/* AP6: 权重 1,-1/4,1 二次中点插入得全正权 4 点；精确可反演但必须因负权拒绝 */
section('AP6 负候选权重闸门');
{
  const pt = (x, y, w) => [String(x * w), String(y * w), String(w)];
  const c = parseCurveObject({ degree: 2, knots: ['0', '0', '0', '1', '1', '1'],
    points: [pt(0, 0, 1), pt(1, 1, -1 / 4), pt(2, 0, 1)] }).curve;
  const P = insertKnot(c, '1/2').curve;
  ok(P.points.every((q) => q.W.sign() > 0), '插入后四点权重全正: ' + P.points.map((q) => q.W.toString()).join(','));
  const rm = removeKnotAt(P, 3);
  ok(!rm.ok && /负|为正/.test(rm.error), '精确反演得到 -1/4 候选权重，仍拒绝: ' + rm.error);
}

console.log(`\nACCEPTANCE: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
