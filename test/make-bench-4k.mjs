// 边界基准：4096×2160 最大画布 + 较短录制，验证快照预算自适应与工作内存上限。
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CxrWriter } from '../tools/cxr-writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'bench');
mkdirSync(OUT, { recursive: true });

const W = 4096;
const H = 2160;
const N = 1200;

const keyPx = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    keyPx.set([x & 0xff, y & 0xff, (x ^ y) & 0xff, 255], i);
  }
}

const w = new CxrWriter(W, H);
w.addKeyframe(0, keyPx);
const dpx = new Uint8Array(32 * 32 * 4).fill(123);
for (let f = 1; f < N; f++) {
  w.addDelta(f, f - 1, f % 300 === 0 ? [[10, 10, 200, 100, 60, 40]] : [], [
    { x: (f * 13) % (W - 32), y: (f * 29) % (H - 32), w: 32, h: 32, pixels: dpx },
  ]);
}
const buf = w.build();
const outPath = join(OUT, `bench-${W}x${H}-${N}.cxr`);
writeFileSync(outPath, buf);
console.log(JSON.stringify({ file: outPath, sizeMiB: +(buf.length / 1048576).toFixed(2) }));
