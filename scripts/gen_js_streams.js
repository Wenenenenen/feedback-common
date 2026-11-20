/* 用 JS 编码器为每个样例/层数产出 .g53 流，供 Python 参考反向解析验证 */
const fs = require('fs');
const path = require('path');
const zlibNode = require('zlib');
const G53 = require('../src/g53.js');

const zlib = {
  deflate: (u8) => zlibNode.deflateSync(Buffer.from(u8)),
  inflate: (u8) => new Uint8Array(zlibNode.inflateSync(Buffer.from(u8))),
};

const rawDir = path.join(__dirname, '..', 'work', 'sample-raw');
const outDir = path.join(__dirname, '..', 'work', 'js-out');
fs.mkdirSync(outDir, { recursive: true });

for (const fn of fs.readdirSync(rawDir).filter(f => f.endsWith('.u8'))) {
  const m = fn.match(/_(\d+)x(\d+)\.u8$/);
  const w = +m[1], h = +m[2];
  const pix = Array.from(fs.readFileSync(path.join(rawDir, fn)));
  const maxL = G53.maxLevels(w, h);
  for (let L = 0; L <= maxL; L++) {
    const enc = G53.encodeStream(pix, w, h, L, zlib);
    const out = path.join(outDir, `${w}x${h}-L${L}.g53`);
    fs.writeFileSync(out, Buffer.from(enc.stream));
    // 同时输出每层解压负载，供字节级比较
    const layerDir = path.join(outDir, 'layers');
    fs.mkdirSync(layerDir, { recursive: true });
  }
}
console.log('JS streams written to', outDir);
