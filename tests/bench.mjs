// 性能基准：100 万条记录
// 指标：解析+全量演算 ≤ 10s；随后 20 次任意跳帧合计 ≤ 2s
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseL21P } from '../js/parser.js';
import { simulate, jumpToFrame } from '../js/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, '..', 'bench-1m.l21p');
const buf = readFileSync(path);

const t0 = performance.now();
const parsed = parseL21P(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const t1 = performance.now();
if (!parsed.ok) { console.error(parsed.errors); process.exit(1); }
const { doc } = parsed;
console.log(`解析 ${doc.recordCount.toLocaleString()} 条：${(t1 - t0).toFixed(0)} ms`);

const t2 = performance.now();
const { checkpoints } = simulate(doc, 10000);
const t3 = performance.now();
console.log(`全量演算+检查点（${checkpoints.length} 个）：${(t3 - t2).toFixed(0)} ms`);
console.log(`解析+演算合计：${(t3 - t0).toFixed(0)} ms（预算 10000 ms）`);

// 20 次确定性伪随机跳帧，覆盖头尾与中段
let h = 0xdeadbeef;
const rnd = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
const t4 = performance.now();
let cells = 0;
for (let k = 0; k < 20; k++) {
  const F = (rnd() * doc.totalFrames) | 0;
  const st = jumpToFrame(doc, checkpoints, F);
  cells += st.channels[0].display[0];
}
const t5 = performance.now();
console.log(`20 次任意跳帧合计：${(t5 - t4).toFixed(0)} ms（预算 2000 ms），校验值 ${cells}`);

const pass = (t3 - t0) < 10000 && (t5 - t4) < 2000;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
