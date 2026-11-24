// 正确性测试：JS 解码器 vs Python 独立参考实现，逐字节比对。
// 同时验证索引元数据（valid/reason/offset/truncated）与重建像素。
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCxr, CxrDecoder } from '../core/decoder.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const REF = join(HERE, '..', 'tools', 'reference_decoder.py');
const REF_OUT = join(HERE, 'ref-out');

let failures = 0;
let checks = 0;

function assert(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.error('  ✗ ' + msg);
  }
}

rmSync(REF_OUT, { recursive: true, force: true });
mkdirSync(REF_OUT, { recursive: true });

for (const name of readdirSync(FIX).sort()) {
  if (!name.endsWith('.cxr')) continue;
  console.log(`\n== ${name}`);
  const path = join(FIX, name);
  const bytes = readFileSync(path);
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );

  const parsed = parseCxr(ab);
  const dec = new CxrDecoder(parsed);

  const dumpDir = join(REF_OUT, name.replace(/\.cxr$/, ''));
  rmSync(dumpDir, { recursive: true, force: true });
  const validIdx = parsed.frames.filter((f) => f.valid).map((f) => f.index);
  const refStdout = execFileSync(
    'python3',
    ['-I', REF, path, '--dump-dir', dumpDir, '--frames', validIdx.join(',')],
    { encoding: 'utf8' },
  );
  const refMeta = JSON.parse(readFileSync(join(dumpDir, 'index.json'), 'utf8'));

  // ---- 索引一致性 ----
  assert(
    parsed.frames.length === refMeta.frames.length,
    `帧数 ${parsed.frames.length} != 参考 ${refMeta.frames.length}`,
  );
  for (let i = 0; i < Math.min(parsed.frames.length, refMeta.frames.length); i++) {
    const a = parsed.frames[i];
    const b = refMeta.frames[i];
    assert(a.offset === b.offset, `帧${i} offset ${a.offset}!=${b.offset}`);
    assert(a.valid === b.valid, `帧${i} valid ${a.valid}!=${b.valid}`);
    assert(a.key === b.key, `帧${i} key 不一致`);
    assert(
      (a.seq ?? null) === (b.seq ?? null),
      `帧${i} seq ${a.seq}!=${b.seq}`,
    );
    assert(
      (a.anchorIndex ?? -1) === (b.anchorIndex ?? -1),
      `帧${i} anchor ${a.anchorIndex}!=${b.anchorIndex}`,
    );
    assert(a.moves.length === b.moves.length, `帧${i} 移动数不一致`);
    assert(a.dirty.length === b.dirty.length, `帧${i} 脏块数不一致`);
    if (!a.valid && b.reason) {
      assert(!!a.reason, `帧${i} JS 未给出非法原因，参考：${b.reason}`);
    }
  }
  const tA = parsed.truncated;
  const tB = refMeta.truncated;
  assert(
    (tA === null) === (tB === null) && (tA === null || tA.offset === tB.offset),
    `截断信息不一致：${JSON.stringify(tA)} vs ${JSON.stringify(tB)}`,
  );

  // ---- 像素逐字节一致（正序 + 逆序 + 随机顺序，覆盖快照复用路径） ----
  const orders = [
    validIdx.slice(),
    validIdx.slice().reverse(),
    validIdx.filter((_, i) => i % 7 === 0).sort((x, y) => (x * 31) % 97 - (y * 31) % 97),
  ];
  for (const order of orders) {
    for (const idx of order) {
      const got = dec.decode(idx);
      const refFile = join(dumpDir, `f${idx}.rgba`);
      if (!existsSync(refFile)) {
        assert(false, `参考缺少帧 ${idx} 的 rgba`);
        continue;
      }
      const want = new Uint8Array(readFileSync(refFile));
      assert(got.length === want.length, `帧${idx} 长度 ${got.length}!=${want.length}`);
      let diff = -1;
      const n = Math.min(got.length, want.length);
      for (let i = 0; i < n; i++) {
        if (got[i] !== want[i]) { diff = i; break; }
      }
      assert(diff < 0, `帧${idx} 像素在字节 ${diff} 不一致`);
    }
  }

  // ---- 非法帧不可重建 ----
  for (const f of parsed.frames) {
    if (!f.valid) {
      let threw = false;
      try { dec.decode(f.index); } catch { threw = true; }
      assert(threw, `非法帧 ${f.index} 不应可重建`);
    }
  }
  console.log(
    `  帧数=${parsed.frames.length} 有效=${validIdx.length} ` +
    `截断=${parsed.truncated ? parsed.truncated.offset : '无'} ` +
    `参考输出=${refStdout.trim()}`,
  );
}

console.log(`\n${checks - failures}/${checks} 项检查通过`);
process.exit(failures ? 1 : 0);
