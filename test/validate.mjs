// 合成与样例验证：
//   node test/validate.mjs
// 覆盖：解析/96 上限、样例精确结果、MWPM 与暴力枚举对拍、零代价边不连接、
//   默认 root 约定、锚点定向与同分量多锚点冲突、冲突路径、导出与 SVG。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MAX_GRID, normalizeDocument, parseDirectorJSON, buildModel, solveModel, bruteForceSolve,
  evaluateFlips, planAnchors, orientWithAnchors, traceBetween, edgeDetail,
  buildExportBundle, buildSymbolRows, cellId,
} from '../js/directors.js';
import { buildSymbolSVG } from '../js/exporters.js';

const __dir = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function section(n) { console.log('\n== ' + n + ' =='); }

// 确定性 PRNG
function makeRng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

// ---------------------------------------------------------------------------
section('1. 官方样例 samples/fiber-directors.json');
{
  const p = join(__dir, '..', 'samples', 'fiber-directors.json');
  const text = readFileSync(p, 'utf8');
  const parsed = parseDirectorJSON(text);
  check('样例解析无错误', parsed.errors.length === 0, JSON.stringify(parsed.errors));
  const model = buildModel(parsed.doc);
  check('样例为单一连通分量', model.components.length === 1, `comps=${model.components.length}`);
  check('样例 9 个有效格', model.activeIds.length === 9, `n=${model.activeIds.length}`);
  check('样例 9 条正代价边（8 环边 + 1 叶边）', model.edges.length === 9, `e=${model.edges.length}`);
  const sol = solveModel(model);
  check('样例环上负点积边为偶数 => 全局代价 0', sol.totalCost === 0, `cost=${sol.totalCost}`);
  const expectFlips = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0];
  check('样例翻向与手算一致 (2,0)/(2,1)/(2,2) 翻转',
    expectFlips.every((v, i) => sol.flips[i] === v),
    `got=${Array.from(sol.flips)}`);
  const chk = evaluateFlips(model, sol.flips);
  check('翻向独立复核代价一致', chk.totalCost === sol.totalCost);
  // 导入锚点 [0,0,+1] 与默认 root 相同
  const plan = planAnchors(model, sol.flips, parsed.doc.anchors);
  check('样例锚点被接受且无冲突', plan.accepted.length === 1 && plan.conflicts.length === 0);
  const o = orientWithAnchors(model, sol.flips, plan.accepted);
  check('样例 +1 锚点后 (0,0) 保持', o.flips[0] === 0);
}

// ---------------------------------------------------------------------------
section('2. 解析与上限/字段校验');
{
  const tooBig = { width: 97, height: 2, rows: [[[1, 0, 1]], [[1, 0, 1]]] };
  const r1 = normalizeDocument(tooBig);
  check('width>96 被拒绝', !!r1.doc === false && r1.errors.some((e) => e.path === 'width'));

  const ok96 = { width: 96, height: 96, rows: Array.from({ length: 96 }, () => Array(96).fill([1, 0, 10])) };
  const r2 = normalizeDocument(ok96);
  check('96×96 被接受', r2.errors.length === 0, JSON.stringify(r2.errors[0]));

  const zeroVec = { width: 1, height: 1, rows: [[[0, 0, 10]]] };
  check('[0,0] 向量被拒绝', normalizeDocument(zeroVec).errors.some((e) => e.path.includes('rows[0][0]')));

  const badConf = { width: 1, height: 1, rows: [[[1, 0, 256]]] };
  check('置信度 256 被拒绝', normalizeDocument(badConf).errors.length > 0);

  const anchorSpace = { width: 2, height: 1, rows: [[[1, 0, 9], null]], anchors: [[1, 0, 1]] };
  check('锚点落在空格被拒绝', normalizeDocument(anchorSpace).errors.some((e) => e.path === 'anchors[0]'));

  const badJson = parseDirectorJSON('{not json');
  check('非法 JSON 返回解析错误而非抛异常', badJson.doc === null && /JSON/.test(badJson.errors[0].message));
  check('MAX_GRID 常量为 96', MAX_GRID === 96);
}

// ---------------------------------------------------------------------------
section('3. 零代价边 / 空格不连接');
{
  // 两个垂直向量 dot=0 => 无连接
  const d1 = normalizeDocument({ width: 2, height: 1, rows: [[[1, 0, 255], [0, 1, 255]]] }).doc;
  const m1 = buildModel(d1);
  check('原点积 0 的边不连接', m1.edges.length === 0 && m1.components.length === 2);

  // 置信度 0 => minConf 0 => 不连接
  const d2 = normalizeDocument({ width: 2, height: 1, rows: [[[1, 0, 255], [1, 0, 0]]] }).doc;
  const m2 = buildModel(d2);
  check('置信度 0 导致零代价边不连接', m2.edges.length === 0 && m2.components.length === 2);

  // 空格切断
  const d3 = normalizeDocument({ width: 3, height: 1, rows: [[[1, 0, 9], null, [1, 0, 9]]] }).doc;
  const m3 = buildModel(d3);
  check('空格把两侧分成两个分量', m3.components.length === 2);
}

// ---------------------------------------------------------------------------
section('4. MWPM 全局最优 vs 暴力枚举（随机小网格，含空格/零代价）');
{
  const rnd = makeRng(20261127);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  let compared = 0, nonZero = 0;
  for (let it = 0; it < 2500; it++) {
    const W = ri(1, 5), H = ri(1, 5), holeP = rnd() * 0.45;
    const rows = [];
    for (let y = 0; y < H; y++) {
      const row = [];
      for (let x = 0; x < W; x++) {
        if (rnd() < holeP) { row.push(null); continue; }
        let dx = ri(-5, 5), dy = ri(-5, 5);
        if (dx === 0 && dy === 0) dx = 1;
        row.push([dx, dy, ri(0, 12)]);
      }
      rows.push(row);
    }
    const { doc, errors } = normalizeDocument({ width: W, height: H, rows });
    if (errors.length) { check('随机用例校验', false, JSON.stringify(errors)); break; }
    const model = buildModel(doc);
    if (model.components.some((c) => c.nodes.length > 18)) continue;
    const sol = solveModel(model);
    const bf = bruteForceSolve(model);
    const self = evaluateFlips(model, sol.flips);
    if (self.totalCost !== sol.totalCost) { check('解自洽', false, `it=${it} ${self.totalCost}!=${sol.totalCost}`); break; }
    if (sol.totalCost !== bf.totalCost) {
      check('MWPM==暴力最优', false, `it=${it} ${W}x${H} got=${sol.totalCost} want=${bf.totalCost}\n` + JSON.stringify({ width: W, height: H, rows }));
      break;
    }
    compared++;
    if (sol.totalCost > 0) nonZero++;
  }
  check(`完成 ${compared} 个随机网格对拍且全部等于暴力全局最优`, compared > 1500, `compared=${compared}`);
  check(`其中 ${nonZero} 个存在非零违反（确实测到受挫情形）`, nonZero > 50, `nonZero=${nonZero}`);
}

// ---------------------------------------------------------------------------
section('5. 受挫环：全局解只切断“代价最小”的一条环边');
{
  // 2x2 四格成一个四元环。构造恰好奇数条负点积边 => 环受挫，必须违反一条边。
  // 直接用随机搜索找一个这样的例子，并验证最优代价 == 最小环边权重。
  const rnd = makeRng(555);
  let found = null;
  for (let t = 0; t < 200 && !found; t++) {
    const rows = [];
    for (let y = 0; y < 2; y++) {
      const row = [];
      for (let x = 0; x < 2; x++) {
        let dx = Math.floor(rnd() * 7) - 3, dy = Math.floor(rnd() * 7) - 3;
        if (dx === 0 && dy === 0) dx = 1;
        row.push([dx, dy, 1 + Math.floor(rnd() * 9)]);
      }
      rows.push(row);
    }
    const doc = normalizeDocument({ width: 2, height: 2, rows }).doc;
    const m = buildModel(doc);
    if (m.components.length === 1 && m.edges.length === 4) {
      const neg = m.edges.filter((e) => e.t === 1).length;
      if (neg % 2 === 1) found = { doc, m };
    }
  }
  check('构造出奇数负边的受挫 2×2 环', !!found);
  if (found) {
    const sol = solveModel(found.m);
    const minW = Math.min(...found.m.edges.map((e) => e.weight));
    check('受挫环全局代价 = 最小边权重（选择最便宜的断线）', sol.totalCost === minW,
      `cost=${sol.totalCost} minW=${minW}`);
    const nBad = sol.components[0].violated.length;
    check('受挫环恰好违反一条边', nBad === 1, `bad=${nBad}`);
  }
}

// ---------------------------------------------------------------------------
section('6. 默认 root 约定与锚点定向');
{
  // 3 格直线，全部正点积 => 默认最小(y,x)格不翻，其余也不翻
  const doc = normalizeDocument({ width: 3, height: 1, rows: [[[2, 0, 9], [2, 1, 9], [2, 0, 9]]] }).doc;
  const m = buildModel(doc);
  const sol = solveModel(m);
  check('无锚点时分量行列最小格不翻', sol.flips[m.components[0].root] === 0 && m.components[0].root === 0);
  check('正点积链全部保持', Array.from(sol.flips).every((v) => v === 0));

  // 在最右格放 -1 锚点 => 整个分量整体翻转（代价不变），右格变 1、root 变 1
  const plan = planAnchors(m, sol.flips, [{ x: 2, y: 0, sign: -1, i: cellId(2, 0, 3) }]);
  const o = orientWithAnchors(m, sol.flips, plan.accepted);
  check('−1 锚点使该分量整体翻转且锚点格为 1', o.flips[2] === 1 && o.flips[0] === 1);
  check('整体翻转不改变总代价', evaluateFlips(m, o.flips).totalCost === sol.totalCost);
}

// ---------------------------------------------------------------------------
section('7. 同分量多锚点冲突（定位、不覆盖）');
{
  const doc = normalizeDocument({ width: 3, height: 1, rows: [[[2, 0, 9], [2, 0, 9], [2, 0, 9]]] }).doc;
  const m = buildModel(doc);
  const sol = solveModel(m);
  const two = [
    { x: 0, y: 0, sign: 1, i: 0 },
    { x: 2, y: 0, sign: -1, i: 2 }, // 全正链上与 +1@0 矛盾
  ];
  const plan = planAnchors(m, sol.flips, two);
  check('两个锚点产生一个冲突', plan.conflicts.length === 1 && plan.accepted.length === 0);
  check('冲突被判定为朝向矛盾', plan.conflicts[0].contradictory === true);
  check('冲突记录含两个可定位坐标', plan.conflicts[0].anchors.length === 2 &&
    plan.conflicts[0].anchors[0].x === 0 && plan.conflicts[0].anchors[1].x === 2);

  // 一致的重复锚点：仍报 multiple 但 contradictory=false
  const same = planAnchors(m, sol.flips, [
    { x: 0, y: 0, sign: 1, i: 0 }, { x: 1, y: 0, sign: 1, i: 1 },
  ]);
  check('一致重复锚点标记为非矛盾 multiplicity 冲突', same.conflicts.length === 1 &&
    same.conflicts[0].contradictory === false);

  // traceBetween 给出路径
  const tr = traceBetween(m, sol.flips, 0, 2);
  check('冲突路径可追踪且包含 2 条边', tr.reachable && tr.pathEdges.length === 2);
}

// ---------------------------------------------------------------------------
section('8. 边详情字段完整');
{
  const p = join(__dir, '..', 'samples', 'fiber-directors.json');
  const m = buildModel(parseDirectorJSON(readFileSync(p, 'utf8')).doc);
  const sol = solveModel(m);
  const d = edgeDetail(m, sol.flips, 0);
  const need = ['dot', 'preferenceText', 'flipAText', 'flipBText', 'actualRelationText', 'weight', 'violated', 'chargedCost'];
  check('edgeDetail 含原点积/偏好/翻向/代价等字段', need.every((k) => k in d), JSON.stringify(Object.keys(d)));
}

// ---------------------------------------------------------------------------
section('9. 导出：符号行、完整包、CSV、SVG');
{
  const p = join(__dir, '..', 'samples', 'fiber-directors.json');
  const doc = parseDirectorJSON(readFileSync(p, 'utf8')).doc;
  const m = buildModel(doc);
  const sol = solveModel(m);
  const sym = buildSymbolRows(m, sol.flips);
  check('符号网格尺寸为 3 行 ×4 列', sym.glyphRows.length === 3 && sym.glyphRows[0].length === 4);
  check('空格符号为 ·', sym.glyphRows[0][3] === '·');
  const bundle = buildExportBundle(m, { ...sol, engine: 'planar-dual-mwpm' }, { effective: new Map() }, []);
  check('bundle.totals.totalViolationCost 存在', bundle.totals.totalViolationCost === 0);
  check('bundle.components 为 1 项且含 cells/root', bundle.components.length === 1 &&
    Array.isArray(bundle.components[0].cells) && bundle.components[0].root.length === 2);
  check('bundle.violatedEdges 为数组', Array.isArray(bundle.violatedEdges));
  const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  check('bundle.symbolMap.glyphText 含八向箭头符号', typeof bundle.symbolMap.glyphText === 'string' &&
    [...bundle.symbolMap.glyphText].some((ch) => arrows.includes(ch)));
  const svg = buildSymbolSVG(m, sol.flips, { violatedEdges: [], totalCost: 0 });
  check('符号图导出为 SVG 字符串', svg.trimStart().startsWith('<?xml') && svg.includes('<svg') && svg.includes('</svg>'));
}

// ---------------------------------------------------------------------------
section('10. 96×96 连贯场规模与耗时');
{
  const rnd = makeRng(424242);
  const W = 96, H = 96, rows = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) {
      if (rnd() < 0.06) { row.push(null); continue; }
      const ang = 0.9 * Math.sin(x / 11) + 0.7 * Math.cos(y / 13) + (rnd() - .5) * .4;
      let dx = Math.round(10 * Math.cos(ang)), dy = Math.round(10 * Math.sin(ang));
      if (dx === 0 && dy === 0) dx = 1;
      row.push([dx, dy, 40 + Math.floor(rnd() * 216)]);
    }
    rows.push(row);
  }
  const { doc, errors } = normalizeDocument({ width: W, height: H, rows });
  check('96×96 连贯场解析通过', errors.length === 0);
  const m = buildModel(doc);
  const t0 = performance.now();
  const sol = solveModel(m);
  const ms = performance.now() - t0;
  check('96×96 连贯场 2 秒内完成精确求解', ms < 2000, `${ms.toFixed(0)}ms`);
  check('9216 格全部被处理（含空格）', m.size === 9216);
  const chk = evaluateFlips(m, sol.flips);
  check('96×96 解自洽', chk.totalCost === sol.totalCost);
}

console.log(`\n${failures === 0 ? '全部通过 ✅' : `有 ${failures} 项失败 ❌`}`);
process.exit(failures === 0 ? 0 : 1);
