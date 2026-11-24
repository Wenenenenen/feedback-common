// 性能基准录制生成器。
// 默认场景：1920×1080、10000 帧、每帧一个 32×32 脏块（题面工作负载），
// 另含移动块、一个 CRC 坏帧断链与后续关键帧恢复、截断尾帧。
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CxrWriter } from '../tools/cxr-writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'bench');
mkdirSync(OUT, { recursive: true });

const W = 1920;
const H = 1080;
const N = 10000;

function keyframePixels(w, h, seed) {
  const px = new Uint8Array(w * h * 4);
  // 可预测的条带图案，避免随机数生成成为耗时大头
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = (x + seed) & 0xff;
      px[i + 1] = (y * 3 + seed) & 0xff;
      px[i + 2] = (x ^ y ^ seed) & 0xff;
      px[i + 3] = 255;
    }
  }
  return px;
}

const t0 = performance.now();
const w = new CxrWriter(W, H);
w.addKeyframe(0, keyframePixels(W, H, 0));

const dirtyPx = new Uint8Array(32 * 32 * 4);
for (let i = 0; i < dirtyPx.length; i += 4) {
  dirtyPx.set([(i * 7) & 0xff, (i * 13) & 0xff, (i * 17) & 0xff, 255], i);
}

for (let f = 1; f < N; f++) {
  const seq = f;
  // 每 500 帧插入一个移动块（窗口拖动语义：从旧位置搬到新位置）
  const moves = [];
  if (f % 500 === 0) {
    const mx = (f * 7) % (W - 200);
    const my = (f * 11) % (H - 120);
    moves.push([mx, my, 160, 90, mx + 24, my + 16]);
  }
  const dx = (f * 37) % (W - 32);
  const dy = (f * 53) % (H - 32);
  const dirty = [{ x: dx, y: dy, w: 32, h: 32, pixels: dirtyPx }];

  if (f === 4242) {
    // CRC 坏帧：断链，随后的差量帧必须停用，直到关键帧
    w.addDelta(seq, seq - 1, moves, dirty, { badCrc: true });
  } else if (f === 4243 || f === 4244) {
    // 断链期间的合法差量记录，仍须拒绝
    w.addDelta(seq, seq - 1, moves, dirty);
  } else if (f === 4245) {
    // 合法关键帧恢复
    w.addKeyframe(seq, keyframePixels(W, H, f & 0xff));
  } else {
    w.addDelta(seq, seq - 1, moves, dirty);
  }
}

// 截断尾帧：前面所有成功帧仍可查看
w.appendTruncatedFrame(120, Buffer.from(new Uint8Array(20).fill(0xab)));

const buf = w.build();
const outPath = join(OUT, `bench-${W}x${H}-${N}.cxr`);
writeFileSync(outPath, buf);
const t1 = performance.now();
console.log(
  JSON.stringify({
    file: outPath,
    sizeMiB: +(buf.length / 1048576).toFixed(2),
    genMs: Math.round(t1 - t0),
    frames: N,
    canvas: [W, H],
  }),
);
