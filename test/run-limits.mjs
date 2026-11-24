// 上限保护测试：128MiB 文件、2 万帧、4096 维度边界。
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCxr, MAX_FRAMES, MAX_FILE_BYTES } from '../core/decoder.js';
import { CxrWriter } from '../tools/cxr-writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'limit-out');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

let failures = 0;
const check = (cond, msg) => {
  if (!cond) { failures++; console.error('  ✗ ' + msg); }
  else console.log('  ✓ ' + msg);
};

const solid = (w, h) => {
  const px = new Uint8Array(w * h * 4);
  px.fill(200);
  return px;
};

// ---- 1. 超过 2 万帧：在第 20000 帧处截断，已解析帧仍可查看 ----
{
  const W = 4;
  const H = 4;
  const w = new CxrWriter(W, H);
  w.addKeyframe(0, solid(W, H));
  const dpx = solid(1, 1);
  for (let f = 1; f <= MAX_FRAMES + 50; f++) {
    w.addDelta(f, f - 1, [], [{ x: 0, y: 0, w: 1, h: 1, pixels: dpx }]);
  }
  const buf = w.build();
  const parsed = parseCxr(buf.buffer.slice(0));
  check(parsed.frames.length === MAX_FRAMES, `帧数在 ${MAX_FRAMES} 处停止（实际 ${parsed.frames.length}）`);
  check(parsed.truncated !== null && parsed.truncated.reason.includes(String(MAX_FRAMES)), '截断原因标明帧数上限');
  check(parsed.frames.every((f) => f.valid), '上限前的帧全部有效可查看');
}

// ---- 2. 恰好 2 万帧：不算截断 ----
{
  const W = 4;
  const H = 4;
  const w = new CxrWriter(W, H);
  w.addKeyframe(0, solid(W, H));
  const dpx = solid(1, 1);
  for (let f = 1; f < MAX_FRAMES; f++) {
    w.addDelta(f, f - 1, [], [{ x: 0, y: 0, w: 1, h: 1, pixels: dpx }]);
  }
  const parsed = parseCxr(w.build().buffer.slice(0));
  check(parsed.frames.length === MAX_FRAMES, `恰好 ${MAX_FRAMES} 帧被完整接收`);
  check(parsed.truncated === null, '恰好上限不截断');
}

// ---- 3. 画布维度超 4096（u16 最大 65535，手工构造超界头部）----
function headerWith(width, height) {
  const b = new Uint8Array(8);
  b.set([0x43, 0x58, 0x52, 0x31], 0);
  new DataView(b.buffer).setUint16(4, width, true);
  new DataView(b.buffer).setUint16(6, height, true);
  return b.buffer.slice(0);
}
for (const [w, h, label] of [[4097, 16, '宽度 4097'], [16, 4097, '高度 4097'], [65535, 16, '宽度 65535']]) {
  let threw = null;
  try { parseCxr(headerWith(w, h)); } catch (e) { threw = e; }
  check(threw !== null && threw.message.includes('画布'), `${label} 被拒绝`);
}

// ---- 4. 文件超过 128MiB（伪造头部 + 超大缓冲，不写真实帧）----
{
  const big = new Uint8Array(MAX_FILE_BYTES + 16);
  big.set([0x43, 0x58, 0x52, 0x31], 0); // CXR1
  big.set([16, 0, 16, 0], 4);
  let threw = null;
  try { parseCxr(big.buffer.slice(0)); } catch (e) { threw = e; }
  check(threw !== null && threw.message.includes('128MiB'), '超 128MiB 文件被拒绝');
}

// ---- 5. 合法 4096×2160 边界不被误杀 ----
{
  const W = 4096;
  const H = 2160;
  // 只验证头部通过、尺寸被接受；不真的分配满画布脏块（内存过大）
  const header = new Uint8Array(8);
  header.set([0x43, 0x58, 0x52, 0x31], 0);
  const dv = new DataView(header.buffer);
  dv.setUint16(4, W, true);
  dv.setUint16(6, H, true);
  let threw = null;
  try {
    const parsed = parseCxr(header.buffer.slice(0));
    check(parsed.width === W && parsed.height === H, '4096×2160 头部被接受');
  } catch (e) { threw = e; }
  check(threw === null, '4096×2160 不报错');
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '全部上限保护检查通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
