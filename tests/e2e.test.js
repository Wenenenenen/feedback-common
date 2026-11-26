/* 端到端冒烟：模拟 UI 工作流，校验 PNG 输出与逐纹素行为 */
const fs = require('node:fs');
const zlib = require('node:zlib');
const C = require('../src/core.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); }
}

const scene = JSON.parse(fs.readFileSync(__dirname + '/../cases-extract/展板.json', 'utf8'));
ok(C.validateScene(scene) === null, '样例场景校验通过');

const model = C.createModel(scene);
const tex = C.makeBaseTexture(scene);
ok(tex.length === scene.texture[0] * scene.texture[1] * 3, '底色纹理尺寸');
ok(tex[0] === 212 && tex[1] === 221 && tex[2] === 224, '基色正确');

// 1. 在铭牌上画红笔
const p1 = C.paintStroke(model, tex, { points: [[23808, 14208]], diameter: 10, rgb: [255, 0, 0], a: 255 });
ok(p1.count > 0, '铭牌笔画上色 ' + p1.count + ' 纹素');

// 2. 被铭牌遮挡的底板纹素（投影点在铭牌区域）不允许红：检查所有红纹素归属面都是 2/3
let badOccluded = 0;
for (let i = 0; i < model.nTex; i++) {
  if (tex[i * 3] === 255 && tex[i * 3 + 1] === 0 && tex[i * 3 + 2] === 0) {
    if (model.owner[i] < 2) badOccluded++;
  }
}
ok(badOccluded === 0, '被遮挡底板纹素未沾色');

// 3. 在底板裸露区画蓝笔（左下角区域）
const p2 = C.paintStroke(model, tex, { points: [[6000, 6000]], diameter: 10, rgb: [0, 0, 255], a: 255 });
ok(p2.count > 0, '底板笔画上色 ' + p2.count + ' 纹素');
for (const i of p2.indices) ok(model.owner[i] < 2, '蓝笔只落在底板面');

// 4. 半透明混色公式
const tex2 = C.makeBaseTexture(scene);
C.paintStroke(model, tex2, { points: [[6000, 6000]], diameter: 10, rgb: [10, 20, 30], a: 100 });
const i0 = (() => {
  for (let i = 0; i < model.nTex; i++) {
    if (tex2[i * 3] !== 212 || tex2[i * 3 + 1] !== 221) return i;
  }
  return -1;
})();
ok(i0 >= 0, '半透明笔有改动');
const exp = (orig, brush) => Math.floor(((255 - 100) * orig + 100 * brush + 127) / 255);
ok(tex2[i0 * 3] === exp(212, 10), 'R 通道混色公式');
ok(tex2[i0 * 3 + 1] === exp(221, 20), 'G 通道混色公式');
ok(tex2[i0 * 3 + 2] === exp(224, 30), 'B 通道混色公式');

// 5. 撤销/重做
const before = tex.slice();
for (let k = 0; k < p2.indices.length; k++) {
  const o = p2.indices[k] * 3;
  tex[o] = p2.old[k * 3]; tex[o + 1] = p2.old[k * 3 + 1]; tex[o + 2] = p2.old[k * 3 + 2];
}
// 撤销后 p1 的红仍在，p2 的蓝消失
let redStill = 0, blueGone = true;
for (let i = 0; i < model.nTex; i++) {
  if (tex[i * 3] === 255 && tex[i * 3 + 1] === 0) redStill++;
  if (tex[i * 3 + 2] === 255 && tex[i * 3] === 0 && tex[i * 3 + 1] === 0) blueGone = false;
}
ok(redStill > 0 && blueGone, '撤销 p2 后 p1 保留');

// 6. 导出 PNG 并完整解析
const png = C.encodePng(tex, model.texW, model.texH);
ok(png[0] === 137 && png[1] === 80 && png[2] === 78 && png[3] === 71, 'PNG 签名');
const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
ok(dv.getUint32(16) === model.texW && dv.getUint32(20) === model.texH, 'PNG IHDR 尺寸');
ok(png[25] === 2, 'PNG 颜色类型为真彩色 RGB');
// 拼接所有 IDAT 并解压，比对每个纹素
const chunks = [];
let off = 8;
while (off < png.length) {
  const len = dv.getUint32(off);
  const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
  if (type === 'IDAT') chunks.push(Buffer.from(png.subarray(off + 8, off + 8 + len)));
  off += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(chunks));
let mismatch = 0;
const rowLen = model.texW * 3 + 1;
for (let y = 0; y < model.texH; y++) {
  if (raw[y * rowLen] !== 0) mismatch++;
  for (let x = 0; x < model.texW * 3; x++) {
    if (raw[y * rowLen + 1 + x] !== tex[y * model.texW * 3 + x]) mismatch++;
  }
}
ok(mismatch === 0, 'PNG 像素与纹理逐字节一致（含未归属区）');

// 7. 预览渲染包含背景色与基色
const pr = C.renderPreview(model, tex);
ok(pr.rgba[0] === 32 && pr.rgba[1] === 36 && pr.rgba[2] === 40, '预览背景 RGB(32,36,40)');

// 8. 非法导入：坏字段名报告且不影响现有状态
const bad = JSON.parse(JSON.stringify(scene));
bad.faces[0].v[2] = 9999;
ok(/faces\[0\]\.v\[2\]/.test(C.validateScene(bad)), '越界索引报告具体字段');
const bad2 = JSON.parse(JSON.stringify(scene));
bad2.texture = [0, 96];
ok(/texture\[0\]/.test(C.validateScene(bad2)), '纹理尺寸字段报告');

// 9. 折线 256 点上限
const manyPts = Array.from({ length: 257 }, (_, k) => [k * 100, k * 100]);
ok(C.validateStroke({ points: manyPts, diameter: 4, rgb: [1, 1, 1], a: 10 }) !== null, '257 点拒绝');
ok(C.validateStroke({ points: manyPts.slice(0, 256), diameter: 4, rgb: [1, 1, 1], a: 10 }) === null, '256 点接受');

console.log(`\n端到端：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
