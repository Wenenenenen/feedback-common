// PFM 编解码往返 + 底行优先字节序验证。
// 用法: node tools/test_pfm.mjs
import { encodePFM, parsePFM } from "../app/cube-core.js";

const w = 4, h = 3;
// 顶行优先数据，每个纹素 RGB = (row*10+col, 0, 0) 便于识别行列。
const data = new Float32Array(w * h * 3);
for (let row = 0; row < h; row++) {
  for (let col = 0; col < w; col++) {
    data[(row * w + col) * 3] = row * 10 + col;
  }
}
const bytes = encodePFM(w, h, data);
const text = new TextDecoder().decode(bytes.subarray(0, 30));
console.log("header:", JSON.stringify(text));

// 手工解析：PFM 第一像素行应为输入的最后一行。
const headerEnd = bytes.indexOf(0x0a, bytes.indexOf(0x0a, bytes.indexOf(0x0a) + 1) + 1) + 1;
const dv = new DataView(bytes.buffer, bytes.byteOffset + headerEnd);
const firstRowFirstPixel = dv.getFloat32(0, true);
console.log("PFM 底行优先: 首像素 =", firstRowFirstPixel, "(应=20)");

const back = parsePFM(bytes);
let worst = 0;
for (let i = 0; i < data.length; i++) worst = Math.max(worst, Math.abs(back.data[i] - data[i]));
console.log("往返尺寸", back.width, back.height, "最大差", worst);

// 大端 PFM 也应能读回。
const leHeader = new TextEncoder().encode(`PF\n${w} ${h}\n1.0\n`);
const beBody = new Uint8Array(w * h * 3 * 4);
const bev = new DataView(beBody.buffer);
for (let row = 0; row < h; row++) {
  // 大端文件按底行优先写。
  for (let k = 0; k < w * 3; k++) bev.setFloat32((row * w * 3 + k) * 4, data[((h - 1 - row) * w * 3) + k], false);
}
const mixed = new Uint8Array(leHeader.length + beBody.length);
mixed.set(leHeader, 0); mixed.set(beBody, leHeader.length);
const backBE = parsePFM(mixed);
let worstBE = 0;
for (let i = 0; i < data.length; i++) worstBE = Math.max(worstBE, Math.abs(backBE.data[i] - data[i]));
console.log("大端读回最大差", worstBE);

if (!text.startsWith("PF\n4 3\n-1.0\n") || firstRowFirstPixel !== 20 || worst !== 0 || worstBE !== 0) {
  process.exit(1);
}
console.log("PFM OK");
