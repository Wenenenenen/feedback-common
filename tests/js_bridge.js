/*
 * js_bridge.js — 供 Python 交叉验证调用的 Node 桥接。
 * 自带最小 PNG 解码（zlib 内置），不使用第三方库。
 * 用法: node tests/js_bridge.js <image.png> <zero|reflect101> '<notches json>' <out.json>
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const DSP = require(path.join(__dirname, '..', 'src', 'dsp.js'));

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const chunk = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      if (chunk[12] !== 0) throw new Error('interlace unsupported');
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error('only 8-bit RGB/RGBA supported, got bd=' + bitDepth + ' ct=' + colorType);
  }
  const channels = colorType === 2 ? 3 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8ClampedArray(width * height * 4);
  const prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = line[x]; break;
        case 1: v = line[x] + a; break;
        case 2: v = line[x] + b; break;
        case 3: v = line[x] + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = line[x] + pr;
          break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      line[x] = v & 255;
    }
    line.copy(prev);
    for (let x = 0; x < width; x++) {
      const sp = x * channels, dp = (y * width + x) * 4;
      data[dp] = line[sp];
      data[dp + 1] = line[sp + 1];
      data[dp + 2] = line[sp + 2];
      data[dp + 3] = channels === 4 ? line[sp + 3] : 255;
    }
  }
  return { width, height, data };
}

const [, , imgPath, mode, notchesJson, outPath] = process.argv;
const imageData = decodePNG(imgPath);
if (imageData.width > 512 || imageData.height > 512) {
  throw new Error('单边不得超过 512');
}
const notches = JSON.parse(notchesJson);
const decoded = DSP.decodeLinearRGB(imageData);
const res = DSP.process(decoded, mode, notches);

// 原尺寸线性输出（三通道交错展平）
const w = res.width, h = res.height;
const outLin = [];
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let ch = 0; ch < 3; ch++) {
  outLin.push(res.outputChannels[ch][y * w + x]);
}
const payload = {
  width: res.width, height: res.height, W: res.W, H: res.H,
  maxImag: res.maxImag,
  beforeMeans: res.beforeMeans, afterMeans: res.afterMeans,
  notchBefore: res.notchReport.map((q) => q.magnitudeBefore),
  notchAfter: res.notchReport.map((q) => q.magnitudeAfter),
  outLin,
};
fs.writeFileSync(outPath, JSON.stringify(payload));
console.log('wrote', outPath);
