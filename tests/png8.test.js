/* PNG 模块验证：对照 PIL 输出 + 自身回写往返 + 全部滤镜类型 */
const fs = require('fs');
const path = require('path');
const pako = require('pako');
const PNG8 = require('../src/png8.js');
const G53 = require('../src/g53.js');

const zlib = {
  deflate: u8 => pako.deflate(u8),
  inflate: u8 => pako.inflate(u8),
  crc32: G53.crc32,
};

let fails = 0;
const dir = path.join(__dirname, '..', 'work', 'samples-extract');
for (const fn of fs.readdirSync(dir).filter(f => f.endsWith('.png'))) {
  const buf = fs.readFileSync(path.join(dir, fn));
  const { width: w, height: h, pixels: px } = PNG8.decode(buf, zlib);
  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'work', 'sample-raw', `${fn.replace('.png', '')}_${w}x${h}.u8`));
  const match = px.length === raw.length && px.every((v, i) => v === raw[i]);
  const re = PNG8.encode(px, w, h, zlib);
  const dec2 = PNG8.decode(re, zlib);
  const rt = dec2.width === w && dec2.height === h &&
    dec2.pixels.every((v, i) => v === px[i]);
  if (!match || !rt) fails++;
  console.log(fn, `${w}x${h}`, 'matches-PIL:', match, 'png-roundtrip:', rt,
    'reencoded:', re.length, 'bytes');
}

// 滤镜覆盖：手工构造带 5 种滤镜的 PNG 数据
{
  const w = 4, h = 5;
  const src = new Uint8Array(w * h).map((_, i) => (i * 37) & 255);
  const png = PNG8.encode(src, w, h, zlib);
  // 取出 IDAT，替换为含各滤镜的原始数据后重压
  const filters = [0, 1, 2, 3, 4];
  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) {
    const f = filters[y];
    raw[y * (w + 1)] = f;
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      const a = x > 0 ? src[y * w + x - 1] : 0;
      const b = y > 0 ? src[(y - 1) * w + x] : 0;
      const c = (y > 0 && x > 0) ? src[(y - 1) * w + x - 1] : 0;
      let delta;
      switch (f) {
        case 0: delta = v; break;
        case 1: delta = v - a; break;
        case 2: delta = v - b; break;
        case 3: delta = v - ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          delta = v - pr; break;
        }
      }
      raw[y * (w + 1) + 1 + x] = delta & 255;
    }
  }
  // 重写 IDAT
  const comp = zlib.deflate(raw);
  const out = new Uint8Array(png.length);
  out.set(png);
  // 简化：直接重新组装
  const parts = [png.subarray(0, 8 + 25)]; // 签名+IHDR（IHDR 固定 25 字节）
  function chunk(type, body) {
    const tb = new Uint8Array(4);
    for (let i = 0; i < 4; i++) tb[i] = type.charCodeAt(i);
    const head = new Uint8Array(8);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, body.length);
    head.set(tb, 4);
    const crcIn = new Uint8Array(4 + body.length);
    crcIn.set(tb, 0); crcIn.set(body, 4);
    const crc = new Uint8Array(4);
    const cv = new DataView(crc.buffer);
    cv.setUint32(0, G53.crc32(crcIn));
    const full = new Uint8Array(12 + body.length);
    full.set(head, 0); full.set(body, 8); full.set(crc, 8 + body.length);
    return full;
  }
  const rebuilt = Buffer.concat([
    Buffer.from(png.subarray(0, 33)),
    Buffer.from(chunk('IDAT', comp)),
    Buffer.from(chunk('IEND', new Uint8Array(0))),
  ]);
  const dec = PNG8.decode(new Uint8Array(rebuilt), zlib);
  const ok = dec.pixels.every((v, i) => v === src[i]);
  if (!ok) fails++;
  console.log('全部 5 种 PNG 滤镜解码:', ok);
}
console.log(fails === 0 ? 'PNG 模块全部通过' : `失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
