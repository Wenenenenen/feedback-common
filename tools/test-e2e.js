#!/usr/bin/env node
/* 端到端：加载 samples/label-margin.json，跑完整管线，对照暴力结果并校验 P5 输出 */
'use strict';
const fs = require('fs');
const path = require('path');
const Core = require(path.join(__dirname, '..', 'js', 'sdt-core.js'));

function buildP5(W, H, labels) {
  const header = Buffer.from(`P5\n${W} ${H}\n32\n`, 'ascii');
  return Buffer.concat([header, Buffer.from(labels)]);
}

function main() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'label-margin.json'), 'utf8'));
  const { width: W, height: H, seeds, spacing, wrap, radius, margin } = data;
  const [sx, sy] = spacing;

  // 种子网格
  const seedGrid = new Uint8Array(W * H);
  const coordMap = new Map();
  for (const [c, r, lab] of seeds) {
    if (seedGrid[r * W + c] !== 0) throw new Error('重复坐标');
    seedGrid[r * W + c] = lab;
    if (!coordMap.has(lab)) coordMap.set(lab, []);
    coordMap.get(lab).push(c, r);
  }
  const typedMap = new Map([...coordMap].map(([l, a]) => [l, Int32Array.from(a)]));

  // 管线：单标签分批模拟 + 合并（覆盖 mergePartials 路径）
  const ids = [...typedMap.keys()];
  const parts = ids.map(id => Core.runLabels(W, H, typedMap, [id], sx, sy, wrap, null));
  const top = parts.length === 1 ? parts[0] : Core.mergePartials(W, H, parts);
  const { out, filled } = Core.applyFill(W, H, top, radius, margin);

  // 暴力参考
  const bf = Core.bruteForce(W, H, seeds, sx, sy, wrap, radius, margin);
  let fails = 0;
  for (let p = 0; p < W * H; p++) {
    const t = bf.info[p];
    const checks = [
      [top.d1[p], t.d1 === Core.INF ? Core.INF : t.d1, 'd1'],
      [top.l1[p], t.l1, 'l1'], [top.r1[p], t.r1, 'r1'], [top.c1[p], t.c1, 'c1'],
      [top.d2[p], t.d2 === Core.INF ? Core.INF : t.d2, 'd2'],
      [top.l2[p], t.l2, 'l2'], [top.r2[p], t.r2, 'r2'], [top.c2[p], t.c2, 'c2'],
      [out[p], bf.ref[p], 'fill'],
    ];
    for (const [g, w, n] of checks) if (g !== w) {
      console.log(`MISMATCH ${n} p=${p} got=${g} want=${w}`); fails++;
    }
  }
  if (fails) { console.log(`FAIL ${fails}`); process.exit(1); }
  console.log(`OK 样例管线 ${W}×${H}：全部字段与暴力一致，填充 ${filled} 格`);

  // 手工核验环绕距离（样例 spacing=[2,1]，wrap=true）：
  // 种子 (11,3,3) 到格 (0,3)：dx=min(11,12-11)=1, dy=0 → d²=(1*2)²=4
  // 该格最近种子是 (0,2,1) 的 d²=1，但 (11,3) 的环绕距离应能在暴力与管线上一致
  const p03 = 3 * W + 0;
  const wrapD = (Math.min(11, W - 11) * sx) ** 2; // =4
  // 暴力枚举中确认存在到种子 (11,3) 距离为 4 的候选
  const allD = [];
  for (const [sc0, sr0, lab] of seeds) {
    let dx = Math.abs(0 - sc0), dy = Math.abs(3 - sr0);
    dx = Math.min(dx, W - dx); dy = Math.min(dy, H - dy);
    allD.push([(dx * sx) ** 2 + (dy * sy) ** 2, lab, sr0, sc0]);
  }
  const cand = allD.find(x => x[1] === 3 && x[2] === 3 && x[3] === 11);
  if (!cand || cand[0] !== wrapD) { console.log('FAIL 环绕距离核验', cand, wrapD); process.exit(1); }
  // 管线最近种子应为 (0,2,1)，d²=1
  if (top.d1[p03] !== 1 || top.l1[p03] !== 1 || top.r1[p03] !== 2 || top.c1[p03] !== 0) {
    console.log(`FAIL 格(0,3) 最近种子 got d=${top.d1[p03]} l=${top.l1[p03]} @${top.r1[p03]},${top.c1[p03]}`);
    process.exit(1);
  }
  console.log(`OK 环绕核验：种子(11,3) 到格(0,3) 最短 dx=1 → d²=${wrapD}；该格实际最近为(0,2) d²=1`);

  // P5 字节校验
  const p5 = buildP5(W, H, out);
  const headerStr = `P5\n${W} ${H}\n32\n`;
  const hdr = p5.slice(0, headerStr.length).toString('ascii');
  if (hdr !== headerStr) { console.log('FAIL P5 头:', JSON.stringify(hdr)); process.exit(1); }
  if (p5.length !== headerStr.length + W * H) { console.log('FAIL P5 长度'); process.exit(1); }
  for (let p = 0; p < W * H; p++) if (p5[headerStr.length + p] !== out[p]) {
    console.log('FAIL P5 像素不一致'); process.exit(1);
  }
  console.log(`OK P5：头 ${JSON.stringify(headerStr.replace(/\n/g, '\\n'))}，${W * H} 个原始标签字节，最大样值 32`);
  console.log('样例标签矩阵（行优先）：');
  for (let r = 0; r < H; r++) {
    console.log('  ' + Array.from(out.slice(r * W, (r + 1) * W)).map(v => String(v).padStart(2)).join(' '));
  }
}

main();
