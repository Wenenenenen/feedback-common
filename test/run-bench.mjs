// Node 端性能基准：索引定位时间、十次跳帧、工作内存（扣除输入文件本体）。
// 浏览器实测由 test/playwright-bench.mjs 负责，二者口径一致。
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseCxr, CxrDecoder } from '../core/decoder.js';

const path = process.argv[2];
if (!path) {
  console.error('用法: node test/run-bench.mjs <file.cxr>');
  process.exit(2);
}

const bytes = readFileSync(path);
const fileBytes = bytes.length;
// 独立 ArrayBuffer，模拟浏览器里 FileReader / arrayBuffer() 的驻留输入
const ab = bytes.buffer.slice(
  bytes.byteOffset,
  bytes.byteOffset + bytes.byteLength,
);

gc();
const baseline = process.memoryUsage().arrayBuffers;
const heapBaseline = process.memoryUsage().heapUsed;

const tIdx0 = performance.now();
const parsed = parseCxr(ab);
const tIdx1 = performance.now();

const dec = new CxrDecoder(parsed);
const valid = parsed.frames.filter((f) => f.valid);
const lastValid = valid[valid.length - 1].index;

// 首次定位：跳到末帧（最坏情况之一：离锚点最远）
const tFirst0 = performance.now();
dec.decode(lastValid);
const tFirst1 = performance.now();

// 十次跳帧：确定性伪随机，覆盖远距离/近距离/回看
let seed = 20261125;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const targets = Array.from({ length: 10 }, () =>
  valid[Math.floor(rnd() * valid.length)].index,
);
const tJump0 = performance.now();
for (const t of targets) dec.decode(t);
const tJump1 = performance.now();

gc();
const after = process.memoryUsage();
const workingBytes =
  Math.max(0, after.arrayBuffers - baseline - fileBytes) +
  Math.max(0, after.heapUsed - heapBaseline);

const report = {
  file: path,
  fileMiB: +(fileBytes / 1048576).toFixed(2),
  canvas: [parsed.width, parsed.height],
  frames: parsed.frames.length,
  validFrames: valid.length,
  invalidFrames: parsed.frames.length - valid.length,
  truncated: parsed.truncated,
  indexMs: +(tIdx1 - tIdx0).toFixed(1),
  locateBudgetMs: 3000,
  firstLocateMs: +(tIdx1 - tIdx0 + tFirst1 - tFirst0).toFixed(1),
  firstDecodeMs: +(tFirst1 - tFirst0).toFixed(1),
  tenJumpsMs: +(tJump1 - tJump0).toFixed(1),
  jumpBudgetMs: 5000,
  jumpTargets: targets,
  snapshots: dec.snapshots.size,
  workingMiB: +(workingBytes / 1048576).toFixed(1),
  workingBudgetMiB: 384,
  arrayBuffersMiB: +(after.arrayBuffers / 1048576).toFixed(1),
  heapUsedMiB: +(after.heapUsed / 1048576).toFixed(1),
};
console.log(JSON.stringify(report, null, 1));

const fail =
  report.firstLocateMs > 3000 ||
  report.tenJumpsMs > 5000 ||
  report.workingMiB > 384;
process.exit(fail ? 1 : 0);
