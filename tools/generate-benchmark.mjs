// tools/generate-benchmark.mjs —— 生成满额编织纹样（约 1 万线段、5 万交点）
// 用法：node tools/generate-benchmark.mjs > /tmp/woven-full.json
// 网格 + 阶梯折线混合，保证几何合规、交点规模达标。

let id = 0;
const strands = [];
const add = (points, closed = false, gap = 2) => {
  strands.push({ id: ++id, points, closed, gap });
};

// 1) 规则网格：H 条横线 × V 条竖线 = H*V 个交点（满额 5 万）
const H = 100, V = 500;
const gridW = V * 4 + 4, gridH = H * 4 + 4;
for (let i = 0; i < H; i++) {
  const y = i * 4 + 2;
  add([[0, y], [gridW, y]]);
}
for (let j = 0; j < V; j++) {
  const x = j * 4 + 2;
  add([[x, 0], [x, gridH]]);
}

// 2) 阶梯折线（多段横竖线），凑到约 1 万条线段。
//    放在网格下方独立横带，每条折线占独立行带、互不接触。
let made = strands.reduce((n, s) => n + (s.closed ? s.points.length : s.points.length - 1), 0);
const targetSegs = 10000;
const stairs = 24; // 每条阶梯折线的段数
let bandY = gridH + 20;
let stairIdx = 0;
while (made + stairs <= targetSegs) {
  const pts = [];
  let x = (stairIdx % 40) * 10; // 横向错开，但都在网格宽度内、独立 y 带
  let y = bandY;
  pts.push([x, y]);
  for (let k = 0; k < stairs; k++) {
    if (k % 2 === 0) { x += 6; pts.push([x, y]); }
    else { y += 4; pts.push([x, y]); }
  }
  add(pts);
  made += stairs;
  bandY += stairs * 2 + 12; // 下一条折线的独立行带
  stairIdx++;
}

// 3) 少量闭线矩形，放在阶梯带之后的独立区域，互不接触
let cx = 0;
const cy = bandY + 20;
for (let k = 0; k < 20; k++) {
  add([[cx, cy], [cx + 8, cy], [cx + 8, cy + 8], [cx, cy + 8]], true, 1);
  cx += 20;
  made += 4;
}

// 4) 少量锁定，分散在网格中
const pins = [];
for (let i = 0; i < 20; i++) {
  const hLine = (i * 5) % H;
  const vLine = (i * 53) % V;
  pins.push({ at: [vLine * 4 + 2, hLine * 4 + 2], above: hLine + 1 });
}

const data = { strands, pins };
const segCount = strands.reduce(
  (n, s) => n + (s.closed ? s.points.length : s.points.length - 1), 0,
);
process.stderr.write(
  `strands=${strands.length} segments=${segCount} pins=${pins.length}\n`,
);
process.stdout.write(JSON.stringify(data));
