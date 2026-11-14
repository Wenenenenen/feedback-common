// JS 与 Python 两份独立实现的全帧逐像素交叉核对（256x256）。
// 仅在存在 python3 的环境运行；要求两实现 rgb8 字节级一致。
// 用法：node tests/crosscheck.mjs <samples-dir>
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { renderBand, mergeBands } from '../src/web/js/renderer.js';

const samplesDir = process.argv[2];
if (!samplesDir) { console.error('用法: node crosscheck.mjs <samples-dir>'); process.exit(2); }

const size = 256;
const pyScript = `
import json, sys
sys.path.insert(0, 'src/py')
import alpha_render as ar
d = json.load(sys.stdin)
fb = ar.render_frame(d['scene'], d['size'])
sys.stdout.buffer.write(bytes(fb.rgb8))
`;
let failures = 0;
for (const name of ['gradient', 'clipping', 'shared-edge', 'equal-depth', 'occlusion', 'stack32']) {
  const scene = JSON.parse(readFileSync(`${samplesDir}/${name}.json`, 'utf8'));
  const jf = mergeBands([renderBand(scene, size, null, 0, size)], size, scene.background_linear_rgb);
  const py = spawnSync('python3', ['-I', '-c', pyScript], { input: JSON.stringify({ scene, size }) }).stdout;
  let diff = 0, maxd = 0;
  for (let i = 0; i < jf.rgb8.length; i++) {
    const d = Math.abs(jf.rgb8[i] - py[i]);
    if (d) { diff++; maxd = Math.max(maxd, d); }
  }
  const ok = diff === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(12)} 差异通道 ${String(diff).padStart(6)} 最大差 ${maxd}`);
}
console.log(`\n${failures ? failures + ' 个场景不一致' : 'JS 与 Python 全帧字节级一致'}`);
process.exit(failures ? 1 : 0);
