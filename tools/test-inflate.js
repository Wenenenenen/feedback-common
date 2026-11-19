/* Cross-validate the hand-written inflate against Node zlib on real PNGs. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const BINFLATE = require('../web/bc-inflate.js');

let failures = 0;
const check = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + m); if (!c) failures++; };

function idatChunks(file) {
  const buf = fs.readFileSync(file);
  let pos = 8; const chunks = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') chunks.push(new Uint8Array(buf.subarray(pos + 8, pos + 8 + len)));
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  let total = 0; for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }
  return merged;
}

const CASES = path.join(__dirname, '..', '_cases_extracted');
const pngs = fs.readdirSync(CASES).filter((f) => f.endsWith('.png'));
for (const name of pngs) {
  const z = idatChunks(path.join(CASES, name));
  const expected = zlib.inflateSync(Buffer.from(z));
  const got = BINFLATE.inflateZlib(z);
  let same = got.length === expected.length;
  for (let i = 0; same && i < got.length; i++) if (got[i] !== expected[i]) same = false;
  check(same, `${name}: inflate matches zlib (${got.length} bytes)`);
}

// Synthetic coverage: raw deflate blocks (fixed/dynamic/stored), all levels.
const samples = [
  Buffer.alloc(500, 0),
  Buffer.from([...Array(2000)].map((_, i) => i & 255)),
  Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(100)),
  Buffer.from([...Array(300)].map(() => (Math.random() * 256) | 0)),
];
for (const [idx, data] of samples.entries()) {
  for (const level of [0, 1, 6, 9]) {
    const compressed = zlib.deflateSync(data, { level });
    const got = BINFLATE.inflateZlib(new Uint8Array(compressed));
    let same = got.length === data.length;
    for (let i = 0; same && i < got.length; i++) if (got[i] !== data[i]) same = false;
    check(same, `synthetic ${idx} level ${level}: inflate matches (${got.length} bytes)`);
  }
}

// Multi-block: force many blocks via tiny window-level chunking
const big = Buffer.from('abcdefgh'.repeat(5000));
const comp = zlib.deflateSync(big, { level: 9, memLevel: 1 });
const got = BINFLATE.inflateZlib(new Uint8Array(comp));
check(Buffer.from(got).equals(big), 'large repetitive stream decodes');

console.log(failures === 0 ? '\nALL INFLATE TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
