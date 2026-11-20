// test/cross-check.mjs — 将 core.mjs 的输出与 Python 参考实现快照逐像素比对
// 运行: node test/cross-check.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { reprojectSequence, Reason } from '../src/core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = join(HERE, '..', 'reference', 'snapshots');
const DATA_DIR = join(HERE, '..', 'sample-data');

const REASON_TO_ENUM = {
  accepted: Reason.ACCEPTED,
  'first-frame': Reason.FIRST_FRAME,
  'current-depth-null': Reason.DEPTH_NULL,
  'no-valid-out-of-bounds': Reason.NO_VALID_OUT_OF_BOUNDS,
  'no-valid-depth-null': Reason.NO_VALID_DEPTH_NULL,
  'no-valid-depth-threshold': Reason.NO_VALID_DEPTH_THRESHOLD,
};

const TOL = 1e-10;
let failures = 0;
let checks = 0;

for (const file of readdirSync(SNAP_DIR).filter((f) => f.endsWith('.json')).sort()) {
  const snap = JSON.parse(readFileSync(join(SNAP_DIR, file), 'utf8'));
  const seq = JSON.parse(readFileSync(join(DATA_DIR, snap.case), 'utf8'));
  const params = {
    tau: snap.params.tau,
    historyWeight: snap.params.history_weight,
    cap: snap.params.cap,
  };
  const res = reprojectSequence(seq, params);
  let caseFails = 0;

  if (res.frames.length !== snap.frames.length) {
    console.error(`✗ ${file}: 帧数不符 ${res.frames.length} vs ${snap.frames.length}`);
    failures++;
    continue;
  }

  for (let fi = 0; fi < snap.frames.length; fi++) {
    const got = res.frames[fi];
    const exp = snap.frames[fi];
    const n = snap.width * snap.height;
    for (let p = 0; p < n; p++) {
      for (let c = 0; c < 3; c++) {
        const g = got.color[p * 3 + c];
        const e = exp.color[p][c];
        checks++;
        if (Math.abs(g - e) > TOL * Math.max(1, Math.abs(e))) {
          if (caseFails < 8) {
            console.error(`✗ ${file} f${fi} p${p} c${c}: JS=${g} PY=${e}`);
          }
          caseFails++;
        }
      }
      checks++;
      if (got.count[p] !== exp.count[p]) {
        if (caseFails < 8) console.error(`✗ ${file} f${fi} p${p} count: JS=${got.count[p]} PY=${exp.count[p]}`);
        caseFails++;
      }
      checks++;
      const gotReason = got.reason[p];
      const expReason = REASON_TO_ENUM[exp.reason[p]];
      if (gotReason !== expReason) {
        if (caseFails < 8) console.error(`✗ ${file} f${fi} p${p} reason: JS=${gotReason} PY=${expReason}(${exp.reason[p]})`);
        caseFails++;
      }
    }
  }
  if (caseFails) {
    console.error(`✗ ${file}: ${caseFails} 处不符`);
    failures++;
  } else {
    console.log(`✓ ${file}  (${snap.frames.length} 帧 × ${snap.width * snap.height} 像素)`);
  }
}

console.log(`\n共 ${checks} 项数值/枚举比对`);
if (failures) {
  console.error(`失败: ${failures} 个用例`);
  process.exit(1);
}
console.log('全部通过：JS 实现与 Python 参考实现一致。');
