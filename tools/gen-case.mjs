// 生成测试压缩包（Node，无第三方依赖）。
// 用法：node tools/gen-case.mjs <输出.zip> [选项]
//   --copies N        副本数（默认 2，最多 7）
//   --frames N        基准帧数（默认 2352）
//   --seconds N       基准秒数（覆盖 --frames）
//   --blocks N        每副本块数（默认 1，最多 256）
//   --unique          每帧双声道值唯一（仅限 frames ≤ 30000）
//   --seed N          伪随机种子
//   --bad 'r:c:s:e'   坏区（r=0 基准 / 1.. 副本号，c=0 左 / 1 右，s..e 源坐标）；逗号分隔多条
//   --shift LIST      各副本整体平移（逗号分隔）
// 输出压缩包内：anchor.wav, copy-N.wav, disc.json, format.txt

import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

function wavBytes(L, R) {
  const frames = L.length;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + frames * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(44100, 24);
  buf.writeUInt32LE(44100 * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(L[i], 44 + i * 4);
    buf.writeInt16LE(R[i], 44 + i * 4 + 2);
  }
  return buf;
}

function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名
    local.writeUInt16LE(8, 8);      // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

// ---------------------------------------------------------------------------
// 场景生成
// ---------------------------------------------------------------------------

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

/** 随机但可复现的基准：左 = 有符号 16 位伪随机，右 = 左取反（双声道不同）。 */
function randomAnchor(frames, rand) {
  const L = new Int16Array(frames);
  const R = new Int16Array(frames);
  let s = 0x9e3779b9;
  for (let i = 0; i < frames; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    const v = (s & 0xffff) - 32768;
    L[i] = v;
    R[i] = -v > 32767 ? -v - 65536 : -v;
  }
  return { L, R };
}

function uniqueAnchor(frames) {
  const L = new Int16Array(frames);
  const R = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    L[i] = (i % 30000) + 1000;
    R[i] = -((i % 30000) + 1000);
  }
  return { L, R };
}

export function buildScene(opts) {
  const frames = opts.frames;
  const copies = opts.copies;
  const rand = opts.rand || rng(opts.seed || 12345);
  const anchor = opts.unique ? uniqueAnchor(frames) : randomAnchor(frames, rand);
  const scene = {
    anchor,
    copies: [],
    copyMeta: [],
    copySegments: [],
  };
  for (let c = 0; c < copies; c++) {
    const spec = opts.copySpecs ? opts.copySpecs[c] : null;
    const blocks = spec ? spec.blocks : defaultBlocks(frames, opts.blocks || 1, opts.shift ? opts.shift[c] || 0 : 0);
    const offsets = blocks.map((b) => (b.off !== undefined ? b.off : 0));
    const srcLen = blocks.reduce((s, b) => s + b.len, 0);
    const L = new Int16Array(srcLen);
    const R = new Int16Array(srcLen);
    let cursor = 0;
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      // 块内容取基准 [content, content+len)；缺省 content = nom + off
      const content = b.content !== undefined ? b.content : b.nom + offsets[bi];
      for (let i = 0; i < b.len; i++) {
        const s = cursor + i;
        const p = content + i;
        if (p >= 0 && p < frames) {
          L[s] = anchor.L[p];
          R[s] = anchor.R[p];
        }
      }
      cursor += b.len;
    }
    let srcCursor = 0;
    const blockRows = blocks.map((b) => {
      const row = [srcCursor, b.nom, b.len];
      srcCursor += b.len;
      return row;
    });
    scene.copies.push({ L, R });
    scene.copyMeta.push({ name: `copy-${c + 1}.wav`, blocks: blockRows, bad: (spec && spec.bad) || [[], []] });
    scene.copySegments.push({ blocks: blocks.map((b, i) => ({ nom: b.nom, len: b.len, off: offsets[i] })) });
  }
  return scene;
}

function defaultBlocks(frames, count, shift) {
  const blocks = [];
  const per = Math.floor(frames / count);
  for (let i = 0; i < count; i++) {
    const len = i === count - 1 ? frames - per * i : per;
    blocks.push({ nom: per * i, len, off: shift });
  }
  return blocks;
}

export function packScene(scene, opts = {}) {
  const files = [];
  files.push({ name: 'anchor.wav', data: wavBytes(scene.anchor.L, scene.anchor.R) });
  scene.copies.forEach((c, i) => {
    files.push({ name: `copy-${i + 1}.wav`, data: wavBytes(c.L, c.R) });
  });
  const meta = {
    anchor: { file: 'anchor.wav', bad: opts.anchorBad || [[], []] },
    copies: scene.copyMeta.map((c) => ({ file: c.name, blocks: c.blocks, bad: c.bad })),
  };
  files.push({ name: 'disc.json', data: Buffer.from(JSON.stringify(meta)) });
  files.push({ name: 'format.txt', data: Buffer.from(FORMAT_TEXT) });
  return makeZip(files);
}

export const FORMAT_TEXT =
  'anchor定义输出长度，copies是其余读档。blocks各行为源起帧、名义盘面起帧、长度，按源坐标递增且源区间不重叠。' +
  'bad给左右两条源坐标的半开坏区间列表。基准直接映射，副本在名义位置上加所选偏移。' +
  '候选评分只用落在基准内且双方左右声道都有效的帧，双侧值都相等才算相等。';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argMap(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const out = argv[0];
  if (!out || out.startsWith('--')) {
    console.error('用法：node tools/gen-case.mjs <输出.zip> [--copies N] [--frames N] [--seconds N] [--blocks N] [--unique] [--seed N] [--shift LIST] [--bad "r:c:s:e,..."]');
    process.exit(2);
  }
  const a = argMap(argv.slice(1));
  const frames = a.seconds ? Math.round(Number(a.seconds) * 44100) : Number(a.frames || 2352);
  const copies = Math.min(7, Number(a.copies || 2));
  const blocks = Math.min(256, Number(a.blocks || 1));
  const shift = a.shift ? String(a.shift).split(',').map(Number) : [];
  const scene = buildScene({ frames, copies, blocks, unique: !!a.unique, seed: Number(a.seed || 12345), shift });
  const badPerRead = Array.from({ length: copies + 1 }, () => [[], []]);
  if (a.bad) {
    for (const spec of String(a.bad).split(',').filter(Boolean)) {
      const [r, ch, s, e] = spec.split(':').map(Number);
      badPerRead[r][ch].push([s, e]);
    }
  }
  for (let c = 0; c < copies; c++) scene.copyMeta[c].bad = badPerRead[c + 1];
  const zip = packScene(scene, { anchorBad: badPerRead[0] });
  writeFileSync(out, zip);
  console.log(`wrote ${out} copies=${copies} frames=${frames} blocks=${blocks} size=${(zip.length / 1e6).toFixed(2)}MB`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
