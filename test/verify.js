'use strict';
/*
 * verify.js — caustic-core.js 的独立验证
 *   1. 手工可算的精确用例(遮挡/出界/退化/投影)
 *   2. 样例文件能量守恒:入射 = 遮挡 + 出界 + 落板;像素总和 = 落板总和
 *   3. 随机配置守恒性 fuzz
 *   4. 超采样参考对照(粗容差,抓量级错误)
 *   5. 满额(512 源片/16 挡板/128×96)性能 < 20s
 * 运行: node test/verify.js
 */
const path = require('path');
const fs = require('fs');
const core = require(path.join(__dirname, '..', 'caustic-core.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? '  | ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

function pix(r, i, j) {
  const idx = (j * r.width + i) * 3;
  return [r.pixels[idx], r.pixels[idx + 1], r.pixels[idx + 2]];
}
function entryOf(r, id, color) {
  return r.entries.find(e => e.source === id && e.color === color);
}
function conservation(r, label) {
  let maxRes = 0;
  for (const e of r.entries) {
    if (e.degenerate) continue;
    const res = Math.abs(e.incident - e.occluded - e.outOfBounds - e.landed);
    maxRes = Math.max(maxRes, res);
  }
  let pixSum = 0;
  for (let k = 0; k < r.pixels.length; k++) pixSum += r.pixels[k];
  const landedRes = Math.abs(pixSum - r.totals.landed);
  check(label + ': 逐条守恒 入射=遮挡+出界+落板 (残差 ' + maxRes.toExponential(2) + ')',
    maxRes <= 1e-9, 'maxRes=' + maxRes);
  check(label + ': 像素总和=落板总和 (残差 ' + landedRes.toExponential(2) + ')',
    landedRes <= 1e-9, 'res=' + landedRes);
}

console.log('== 1. 手工精确用例 ==');

/* A: 无挡板,竖直投影,三角形恰为像素 (0,0) 的一半 */
{
  const m = { width: 2, height: 2, sources: [{ id: 't', vertices: [[0, 0, 1], [1, 0, 1], [0, 1, 1]], slopes: [[0, 0], [0, 0], [0, 0]], powerPerXY: [1, 2, 3] }], blockers: [] };
  const r = core.analyze(m);
  const p = pix(r, 0, 0);
  check('A 像素(0,0) RGB = [0.5,1,1.5]', near(p[0], 0.5, 1e-12) && near(p[1], 1, 1e-12) && near(p[2], 1.5, 1e-12), p.join(','));
  const e = entryOf(r, 't', 'R');
  check('A 入射0.5 落板0.5', near(e.incident, 0.5, 1e-12) && near(e.landed, 0.5, 1e-12) && e.occluded === 0 && e.outOfBounds === 0);
}

/* B: 挡板阴影 [0,0.5]^2 完全落在三角形内 → 遮挡 0.25 */
{
  const m = { width: 2, height: 2, sources: [{ id: 't', vertices: [[0, 0, 1], [1, 0, 1], [0, 1, 1]], slopes: [[0, 0], [0, 0], [0, 0]], powerPerXY: [1, 0, 0] }], blockers: [{ z: 0.5, rect: [0, 0, 0.5, 0.5] }] };
  const r = core.analyze(m);
  const e = entryOf(r, 't', 'R');
  check('B 入射0.5 遮挡0.25 落板0.25', near(e.incident, 0.5, 1e-12) && near(e.occluded, 0.25, 1e-12) && near(e.landed, 0.25, 1e-12),
    JSON.stringify(e));
  check('B 像素(0,0) R = 0.25', near(pix(r, 0, 0)[0], 0.25, 1e-12));
}

/* C: 斜向投影平移,落点移入板内 */
{
  const m = { width: 4, height: 2, sources: [{ id: 't', vertices: [[0, 0, 2], [1, 0, 2], [0, 1, 2]], slopes: [[1, 0], [0, 0], [0, 0]], powerPerXY: [1, 0, 0] }], blockers: [] };
  const r = core.analyze(m);
  check('C 像素(2,0) R = 0.5(平移 z*dx=2)', near(pix(r, 2, 0)[0], 0.5, 1e-12));
  check('C 像素(0,0) R = 0', pix(r, 0, 0)[0] === 0);
}

/* D: 部分出界,扣挡(无挡)后计出界 */
{
  const m = { width: 4, height: 2, sources: [{ id: 't', vertices: [[0, 0, 2], [1, 0, 2], [0, 1, 2]], slopes: [[1.75, 0], [0, 0], [0, 0]], powerPerXY: [1, 0, 0] }], blockers: [] };
  /* 平移 3.5:落点 (3.5,0),(4.5,0),(3.5,1);板内为四边形面积 0.5-0.125=0.375 */
  const r = core.analyze(m);
  const e = entryOf(r, 't', 'R');
  check('D 落板0.375 出界0.125', near(e.landed, 0.375, 1e-12) && near(e.outOfBounds, 0.125, 1e-12), JSON.stringify(e));
  check('D 像素(3,0) R = 0.375', near(pix(r, 3, 0)[0], 0.375, 1e-12));
}

/* E: 落点三角形面积为零 → 指出源片与颜色 */
{
  const m = { width: 4, height: 4, sources: [{ id: 'deg', vertices: [[0, 0, 2], [1, 0, 2], [0, 1, 3]], slopes: [[0, -1], [0, 0], [0, 0]], powerPerXY: [1, 1, 1] }], blockers: [] };
  const r = core.analyze(m);
  check('E 退化列表含 (deg,R)', r.degenerate.some(d => d.source === 'deg' && d.color === 'R'));
  check('E 退化列表不含 (deg,G)', !r.degenerate.some(d => d.source === 'deg' && d.color === 'G'));
  const e = entryOf(r, 'deg', 'R');
  check('E 退化条目标记 degenerate 且后三项为 0', e.degenerate && e.occluded === 0 && e.outOfBounds === 0 && e.landed === 0);
}

/* F: 挡板阴影随方向平移:z=1, dx=0.5 → 阴影右移 0.5 */
{
  const m = { width: 4, height: 2, sources: [{ id: 't', vertices: [[0, 0, 2], [2, 0, 2], [0, 2, 2]], slopes: [[0.5, 0], [0, 0], [0, 0]], powerPerXY: [1, 0, 0] }], blockers: [{ z: 1, rect: [0, 0, 1, 1] }] };
  /* 落点三角形 (1,0),(3,0),(1,2),面积2,密度=入射2/2=1;阴影平移 (0.5,0) → [0.5,0,1.5,1]。
     阴影∩落点:三角形区域 x>=1,y>=0,x+y<=3,与矩形之交为 [1,1.5]×[0,1],面积 0.5 */
  const r = core.analyze(m);
  const e = entryOf(r, 't', 'R');
  check('F 遮挡0.5(阴影平移)', near(e.occluded, 0.5, 1e-12), JSON.stringify(e));
}

/* G: 两块挡板阴影重叠 → 并集只扣一次 */
{
  const m = { width: 4, height: 4, sources: [{ id: 't', vertices: [[0, 0, 1], [4, 0, 1], [0, 4, 1]], slopes: [[0, 0], [0, 0], [0, 0]], powerPerXY: [1, 0, 0] }], blockers: [{ z: 0.5, rect: [0, 0, 2, 2] }, { z: 0.5, rect: [1, 1, 3, 3] }] };
  /* 并集覆盖三角形内区域:[0,2]² 全在三角形内(面积4);
     [1,3]²∩三角形 = 4 − 角上 x+y>4 的直角三角形(直角边2,面积2) = 2;
     交集 [1,2]² 面积1。并集面积 = 4+2-1 = 5。密度=8/8=1。 */
  const r = core.analyze(m);
  const e = entryOf(r, 't', 'R');
  check('G 遮挡按并集 5', near(e.occluded, 5, 1e-12), JSON.stringify(e));
  check('G 落板 8-5=3', near(e.landed, 3, 1e-12));
}

console.log('== 2. 样例文件 ==');
{
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'caustic-footprints.json'), 'utf8'));
  const errs = core.validate(sample);
  check('样例通过校验', errs.length === 0, errs.join(';'));
  const r = core.analyze(sample);
  conservation(r, '样例');
  console.log('  样例逐片逐色:');
  for (const e of r.entries) {
    console.log('    ' + e.source + ' ' + e.color + ' 入射=' + e.incident.toFixed(9) +
      ' 遮挡=' + e.occluded.toFixed(9) + ' 出界=' + e.outOfBounds.toFixed(9) +
      ' 落板=' + e.landed.toFixed(9) + (e.degenerate ? ' [退化]' : ''));
  }
}

console.log('== 3. 随机构型守恒性 fuzz ==');
{
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20261129);
  let allOk = true, worst = 0;
  for (let trial = 0; trial < 100; trial++) {
    const W = 1 + Math.floor(rnd() * 16), H = 1 + Math.floor(rnd() * 16);
    const ns = 1 + Math.floor(rnd() * 6), nb = Math.floor(rnd() * 5);
    const sources = [];
    for (let i = 0; i < ns; i++) {
      const cx = rnd() * W, cy = rnd() * H, z = 1 + rnd() * 3;
      const verts = [];
      for (let k = 0; k < 3; k++) verts.push([cx + (rnd() - 0.5) * 4, cy + (rnd() - 0.5) * 4, z + rnd()]);
      const slopes = [], pow = [];
      for (let c = 0; c < 3; c++) { slopes.push([(rnd() - 0.5), (rnd() - 0.5)]); pow.push(rnd()); }
      sources.push({ id: 's' + i, vertices: verts, slopes, powerPerXY: pow });
    }
    const blockers = [];
    for (let b = 0; b < nb; b++) {
      const l = rnd() * W, bt = rnd() * H;
      blockers.push({ z: 0.3 + rnd() * 0.6, rect: [l, bt, l + rnd() * 3, bt + rnd() * 3] });
    }
    const r = core.analyze({ width: W, height: H, sources, blockers });
    let maxRes = 0;
    for (const e of r.entries) {
      if (e.degenerate) continue;
      maxRes = Math.max(maxRes, Math.abs(e.incident - e.occluded - e.outOfBounds - e.landed));
    }
    let pixSum = 0;
    for (let k = 0; k < r.pixels.length; k++) pixSum += r.pixels[k];
    maxRes = Math.max(maxRes, Math.abs(pixSum - r.totals.landed));
    worst = Math.max(worst, maxRes);
    if (maxRes > 1e-9) allOk = false;
  }
  check('100 组随机构型守恒 (最差残差 ' + worst.toExponential(2) + ')', allOk, 'worst=' + worst);
}

console.log('== 4. 超采样参考对照 ==');
{
  function triA(a, b, c) { return 0.5 * Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])); }
  function inTri(L, x, y) {
    let s = 0;
    for (let k = 0; k < 3; k++) {
      const a = L[k], b = L[(k + 1) % 3];
      const cr = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (cr > 0) s |= 1; else if (cr < 0) s |= 2;
    }
    return s !== 3;
  }
  function reference(model, sub) {
    const W = model.width, H = model.height;
    const ref = new Float64Array(W * H * 3);
    for (const src of model.sources) {
      const v = src.vertices;
      const srcXY = triA(v[0], v[1], v[2]);
      for (let c = 0; c < 3; c++) {
        const dx = src.slopes[c][0], dy = src.slopes[c][1];
        const L = v.map(p => [p[0] + p[2] * dx, p[1] + p[2] * dy]);
        const la = triA(L[0], L[1], L[2]);
        if (la === 0) continue;
        const density = src.powerPerXY[c] * srcXY / la;
        if (density === 0) continue;
        const shadows = (model.blockers || []).map(b =>
          [b.rect[0] + b.z * dx, b.rect[1] + b.z * dy, b.rect[2] + b.z * dx, b.rect[3] + b.z * dy]);
        const x0 = Math.max(0, Math.floor(Math.min(L[0][0], L[1][0], L[2][0])));
        const x1 = Math.min(W - 1, Math.floor(Math.max(L[0][0], L[1][0], L[2][0])));
        const y0 = Math.max(0, Math.floor(Math.min(L[0][1], L[1][1], L[2][1])));
        const y1 = Math.min(H - 1, Math.floor(Math.max(L[0][1], L[1][1], L[2][1])));
        for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
          let cnt = 0;
          for (let sy = 0; sy < sub; sy++) for (let sx = 0; sx < sub; sx++) {
            const x = px + (sx + 0.5) / sub, y = py + (sy + 0.5) / sub;
            if (!inTri(L, x, y)) continue;
            let blocked = false;
            for (const s of shadows) {
              if (x > s[0] && x < s[2] && y > s[1] && y < s[3]) { blocked = true; break; }
            }
            if (!blocked) cnt++;
          }
          if (cnt) ref[(py * W + px) * 3 + c] += density * cnt / (sub * sub);
        }
      }
    }
    return ref;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(777);
  let worstRel = 0;
  for (let trial = 0; trial < 5; trial++) {
    const W = 8, H = 6;
    const sources = [];
    for (let i = 0; i < 4; i++) {
      const cx = 1 + rnd() * 6, cy = 1 + rnd() * 4, z = 1.5 + rnd();
      const verts = [];
      for (let k = 0; k < 3; k++) verts.push([cx + (rnd() - 0.5) * 3, cy + (rnd() - 0.5) * 3, z + rnd() * 0.5]);
      const slopes = [], pow = [];
      for (let c = 0; c < 3; c++) { slopes.push([(rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.6]); pow.push(0.2 + rnd() * 0.8); }
      sources.push({ id: 's' + i, vertices: verts, slopes, powerPerXY: pow });
    }
    const blockers = [];
    for (let b = 0; b < 3; b++) {
      const l = rnd() * 6, bt = rnd() * 4;
      blockers.push({ z: 0.4 + rnd() * 0.5, rect: [l, bt, l + 0.5 + rnd() * 2, bt + 0.5 + rnd() * 2] });
    }
    const model = { width: W, height: H, sources, blockers };
    const exact = core.analyze(model);
    const ref = reference(model, 64);
    let maxPix = 0, maxErr = 0;
    for (let k = 0; k < ref.length; k++) {
      maxPix = Math.max(maxPix, exact.pixels[k]);
      maxErr = Math.max(maxErr, Math.abs(exact.pixels[k] - ref[k]));
    }
    /* 64×64 子采样的边界误差量级 ~ 密度×边界长/64,取 0.05×max(1,maxPix) 之外的余量 */
    const tol = 0.05 * Math.max(1, maxPix);
    worstRel = Math.max(worstRel, maxErr / tol);
    check('超采样对照 #' + trial + ' (最大偏差 ' + maxErr.toExponential(2) + ' / 容差 ' + tol.toExponential(2) + ')', maxErr <= tol);
  }
}

console.log('== 5. 满额性能(512 源片 / 16 挡板 / 128×96)==');
{
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(12345);
  const sources = [];
  for (let i = 0; i < 512; i++) {
    const cx = rnd() * 140 - 6, cy = rnd() * 108 - 6, z = 2 + rnd() * 3;
    const verts = [];
    for (let k = 0; k < 3; k++) {
      const a = rnd() * Math.PI * 2, rr = 0.5 + rnd() * 2.5;
      verts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a), z + rnd() * 0.5]);
    }
    const slopes = [], pow = [];
    for (let c = 0; c < 3; c++) { slopes.push([rnd() * 2 - 1, rnd() * 2 - 1]); pow.push(rnd()); }
    sources.push({ id: 's' + i, vertices: verts, slopes, powerPerXY: pow });
  }
  const blockers = [];
  for (let b = 0; b < 16; b++) {
    const l = rnd() * 120, bt = rnd() * 88;
    blockers.push({ z: 0.5 + rnd(), rect: [l, bt, l + 1 + rnd() * 8, bt + 1 + rnd() * 6] });
  }
  const model = { width: 128, height: 96, sources, blockers };
  const errs = core.validate(model);
  check('满额输入通过校验', errs.length === 0, errs.join(';'));
  const t0 = process.hrtime.bigint();
  const r = core.analyze(model);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  满额计算耗时 ' + ms.toFixed(1) + ' ms');
  check('20 秒内完成', ms < 20000, ms + 'ms');
  conservation(r, '满额');
}

console.log(failures === 0 ? '\n全部通过' : '\n有 ' + failures + ' 项失败');
process.exit(failures === 0 ? 0 : 1);
