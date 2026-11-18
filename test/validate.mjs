// 合成用例验证：EDT 精确性、对角邻接规则、反色、纯环方向、RAW 尺寸等。
import { runPipeline, binarize, padBackground, exactDistanceTransformSquared, zhangSuenThinning }
  from '../js/skeleton.js';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }
}

// 1. EDT 与暴力法对比（随机小图，含补边）
{
  const w = 17, h = 13;
  const bin = new Uint8Array(w * h);
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < bin.length; i++) bin[i] = rnd() < 0.4 ? 1 : 0;
  const { data, w: pw, h: ph } = padBackground(bin, w, h);
  const d2 = exactDistanceTransformSquared(data, pw, ph);
  let maxErr = 0;
  const bg = [];
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) if (data[y * pw + x] === 0) bg.push([x, y]);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    let best = Infinity;
    for (const [bx, by] of bg) best = Math.min(best, (bx - x) ** 2 + (by - y) ** 2);
    maxErr = Math.max(maxErr, Math.abs(d2[y * pw + x] - best));
  }
  check('EDT 与暴力法一致', maxErr === 0, `maxErr=${maxErr}`);
}

// 2. 对角邻接：无正交桥 -> 相连（度1+度1，一条边）；有桥 -> 经桥相连
{
  // 2x2 仅主对角两像素
  const gray = new Uint8Array(4 * 4);
  gray[1 * 4 + 1] = 255; gray[2 * 4 + 2] = 255;
  const r = runPipeline(gray, 4, 4, { threshold: 128, spacing: 1 });
  check('纯对角两像素细化后保留', r.nodes.length + r.edges.length > 0);
  const totalSkel = r.skeleton.reduce((a, b) => a + b, 0);
  // 两像素对角相连 -> 两个端点 + 一条边，长度 sqrt(2)
  check('对角相连成一条边', r.edges.length === 1 && r.nodes.length === 2,
    `edges=${r.edges.length} nodes=${r.nodes.length} skel=${totalSkel}`);
  if (r.edges.length === 1) check('对角边长 sqrt(2)', Math.abs(r.edges[0].length - Math.SQRT2) < 1e-9,
    `len=${r.edges[0].length}`);
}
{
  // L 形：对角位置但有正交桥 -> 度2 链，无分叉
  const gray = new Uint8Array(5 * 5);
  gray[1 * 5 + 1] = 255; gray[1 * 5 + 2] = 255; gray[2 * 5 + 2] = 255;
  const r = runPipeline(gray, 5, 5, { threshold: 128, spacing: 1 });
  check('L 形无分叉节点', r.nodes.every((n) => n.type !== 'branch'),
    JSON.stringify(r.nodes.map((n) => n.type)));
}

// 3. 反色在阈值后执行：全白图反色 -> 全背景 -> 空结果
{
  const gray = new Uint8Array(9 * 9).fill(255);
  const r = runPipeline(gray, 9, 9, { threshold: 128, invert: true, spacing: 1 });
  check('全白反色后为空', r.nodes.length === 0 && r.edges.length === 0 &&
    r.widthMap.every((v) => v === 0));
}

// 4. 贴边前景不被裁掉：顶边一条横线
{
  const gray = new Uint8Array(20 * 10);
  for (let x = 2; x < 18; x++) { gray[0 * 20 + x] = 255; gray[1 * 20 + x] = 255; }
  const r = runPipeline(gray, 20, 10, { threshold: 128, spacing: 1 });
  let skelTop = 0;
  for (let x = 0; x < 20; x++) skelTop += r.skeleton[0 * 20 + x] + r.skeleton[1 * 20 + x];
  check('贴边前景骨架保留在上边缘附近', skelTop > 0 && r.edges.length === 1,
    `skelTop=${skelTop} edges=${r.edges.length}`);
}

// 5. 纯环：方向为邻居 (y,x) 较小者，闭合重复起点，宽度统计不计重复终点
{
  // 3x3 环（中间空）
  const gray = new Uint8Array(5 * 5);
  const pts = [[1, 1], [2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3]];
  for (const [x, y] of pts) gray[y * 5 + x] = 255;
  const r = runPipeline(gray, 5, 5, { threshold: 128, spacing: 1 });
  check('方形环 -> 1 环节点 + 1 自环', r.nodes.length === 1 && r.nodes[0].type === 'ring' &&
    r.edges.length === 1 && r.edges[0].nodes[0] === r.edges[0].nodes[1],
    JSON.stringify({ nodes: r.nodes, edges: r.edges.map((e) => e.nodes) }));
  if (r.edges.length === 1) {
    const pl = r.edges[0].polyline;
    const first = pl[0], last = pl[pl.length - 1];
    check('环折线闭合（重复起点）', first[0] === last[0] && first[1] === last[1]);
    check('环节点为最小 (y,x)', first[0] === 1 && first[1] === 1, JSON.stringify(first));
    // 最小(y,x)=(1,1)，其骨架邻居为 (2,1) 与 (1,2)，(y,x) 较小者为 (2,1)
    check('环遍历首步为 (y,x) 较小邻居', pl[1][0] === 2 && pl[1][1] === 1, JSON.stringify(pl[1]));
    check('环宽度统计不计重复终点', r.edges[0].pixel_count === pl.length - 1);
  }
}

// 6. 相邻分叉像素合成一个节点：2x2 全骨架块各边伸链
{
  // 十字加粗使分叉区为多个相邻度>=3像素
  const gray = new Uint8Array(15 * 15);
  for (let y = 5; y <= 9; y++) for (let x = 1; x <= 13; x++) gray[y * 15 + x] = 255; // 横条
  for (let x = 6; x <= 8; x++) for (let y = 1; y <= 13; y++) gray[y * 15 + x] = 255; // 竖条
  const r = runPipeline(gray, 15, 15, { threshold: 128, spacing: 1 });
  const branches = r.nodes.filter((n) => n.type === 'branch');
  check('加粗十字 -> 恰好 1 个分叉节点', branches.length === 1,
    `branch nodes=${branches.length}`);
  check('加粗十字 -> 4 条边', r.edges.length === 4, `edges=${r.edges.length}`);
}

// 7. RAW 宽度图尺寸与空图
{
  const gray = new Uint8Array(9 * 7); // 全背景
  const r = runPipeline(gray, 9, 7, { threshold: 128, spacing: 0.25 });
  check('空图宽度图全 0 且尺寸正确', r.widthMap.length === 63 && r.widthMap.every((v) => v === 0));
  check('空图无节点边', r.nodes.length === 0 && r.edges.length === 0);
}

// 8. 阈值切换结果不同且各自自洽（模拟页面切换阈值）
{
  const gray = new Uint8Array(11 * 11);
  for (let y = 4; y <= 6; y++) for (let x = 1; x <= 9; x++) gray[y * 11 + x] = 200;
  const a = runPipeline(gray, 11, 11, { threshold: 128, spacing: 1 });
  const b = runPipeline(gray, 11, 11, { threshold: 201, spacing: 1 });
  check('阈值 128 有骨架', a.edges.length === 1);
  check('阈值 201 无前景', b.nodes.length === 0 && b.edges.length === 0);
}

// 9. 宽度 = 2*距离*间距（直条验证）
{
  const gray = new Uint8Array(21 * 11);
  for (let y = 4; y <= 6; y++) for (let x = 2; x <= 18; x++) gray[y * 21 + x] = 255; // 3px 高横条
  const r = runPipeline(gray, 21, 11, { threshold: 128, spacing: 0.5 });
  if (r.edges.length === 1) {
    // 3px 高条中心距背景 2px -> 宽 = 2*2*0.5 = 2.0
    check('3px 条宽度 = 2*2*0.5', Math.abs(r.edges[0].width.mean - 2.0) < 1e-6,
      `mean=${r.edges[0].width.mean}`);
  } else check('3px 条单条边', false, `edges=${r.edges.length}`);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
