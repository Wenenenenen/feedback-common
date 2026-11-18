'use strict';
/* 用 samples 包内的用例校验 ../clahe.js：
 * - 8bit 灰度/RGB 非隔行 PNG 解码（Node 内置 zlib）
 * - 逐像素比对 expected/*.png
 * - 核对 reference.json 中的关键值
 * 运行：node test/verify.js <解压后的样例目录>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const CLAHE = require(path.join(__dirname, '..', 'clahe.js'));

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  if (!ihdr || ihdr.bitDepth !== 8 || ihdr.interlace !== 0 || ![0, 2].includes(ihdr.colorType))
    throw new Error('unsupported PNG in test decoder');
  const ch = ihdr.colorType === 0 ? 1 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * ch;
  const out = Buffer.alloc(ihdr.h * stride);
  let p = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[p++];
    const row = raw.subarray(p, p + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= ch && prev ? prev[x - ch] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    p += stride;
  }
  return { ...ihdr, channels: ch, data: out };
}

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node test/verify.js <samples-dir>');
  process.exit(2);
}
const cases = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8'));
const ref = JSON.parse(fs.readFileSync(path.join(dir, 'reference.json'), 'utf8'));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failures++;
};

for (const [file, { tiles, clip }] of Object.entries(cases)) {
  const img = decodePNG(fs.readFileSync(path.join(dir, file)));
  const [tx, ty] = tiles;
  let out, tilesOut;
  if (img.channels === 1) {
    ({ out, tiles: tilesOut } = CLAHE.applyGray(img.data, img.w, img.h, tx, ty, clip));
  } else {
    const r = CLAHE.applyRgb(img.data, img.w, img.h, tx, ty, clip);
    out = r.out;
    tilesOut = r.tiles;
  }
  check(`${file}: tile count`, tilesOut.length === tx * ty, `${tilesOut.length} == ${tx * ty}`);

  const expFile = path.join(dir, 'expected', file);
  if (fs.existsSync(expFile)) {
    const exp = decodePNG(fs.readFileSync(expFile));
    let diff = 0;
    for (let i = 0; i < exp.data.length; i++) if (exp.data[i] !== out[i]) diff++;
    check(`${file}: pixel-exact vs expected`, diff === 0, `${diff} differing bytes`);
  }

  const r = ref[file];
  if (r) {
    if (r.tile00Map100 !== undefined)
      check(`${file}: tile00 map[100]`, tilesOut[0].map[100] === r.tile00Map100,
        `got ${tilesOut[0].map[100]}, want ${r.tile00Map100}`);
    if (r.tileCount !== undefined)
      check(`${file}: reference tileCount`, tilesOut.length === r.tileCount);
    if (r.uniformValue !== undefined) {
      const uniform = out.every((v) => v === out[0]);
      check(`${file}: uniform output`, uniform && out[0] === r.uniformValue,
        `value ${out[0]}, want ${r.uniformValue}`);
    }
    if (file === 'graylike-rgb.png') {
      let ok = true;
      for (let p = 0; p < img.w * img.h; p++) {
        if (!(out[p * 3] === out[p * 3 + 1] && out[p * 3 + 1] === out[p * 3 + 2])) { ok = false; break; }
      }
      check(`${file}: R=G=B preserved`, ok);
    }
  }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
