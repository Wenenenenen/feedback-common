// Node 测试：JS 光栅器对照 samples/extracted/expected.json 全量校验。
// 运行：node tests/node_check.mjs <samples-dir>
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { renderBand, mergeBands, inspectPixel, validateScene, ValidationError } from '../src/web/js/renderer.js';
import { encodePng } from '../src/web/js/png.js';

const samplesDir = process.argv[2];
if (!samplesDir) { console.error('用法: node node_check.mjs <samples-dir>'); process.exit(2); }

const expected = JSON.parse(readFileSync(join(samplesDir, 'expected.json'), 'utf8'));
let failures = 0;
let passes = 0;

function approx(a, b, eps) { return Math.abs(a - b) <= eps; }

for (const name of Object.keys(expected)) {
  const scene = JSON.parse(readFileSync(join(samplesDir, name), 'utf8'));
  const size = scene.width;
  const t0 = performance.now();
  const band = renderBand(scene, size, null, 0, size);
  const frame = mergeBands([band], size, scene.background_linear_rgb);
  const ms = performance.now() - t0;

  let bad = 0;
  for (const e of expected[name]) {
    const got = inspectPixel(frame, e.x, e.y);
    const tag = `${name}(${e.x},${e.y})`;
    if (got.hits.length !== e.hits.length) { bad++; console.log(`FAIL ${tag} 片元数 ${got.hits.length}!=${e.hits.length}`); continue; }
    for (let k = 0; k < e.hits.length; k++) {
      const gh = got.hits[k], eh = e.hits[k];
      if (gh.id !== eh.id) { bad++; console.log(`FAIL ${tag} 片元${k} id ${gh.id}!=${eh.id}`); break; }
      if (!approx(gh.depth, eh.depth, 1e-6)) { bad++; console.log(`FAIL ${tag} depth ${gh.depth}!=${eh.depth}`); break; }
      for (let ch = 0; ch < 4; ch++)
        if (!approx(gh.rgba[ch], eh.rgba[ch], 1e-6)) { bad++; console.log(`FAIL ${tag} rgba[${ch}]`); break; }
    }
    for (let ch = 0; ch < 3; ch++)
      if (!approx(got.linear_rgb[ch], e.linear_rgb[ch], 1e-6)) { bad++; console.log(`FAIL ${tag} linear[${ch}] ${got.linear_rgb[ch]}!=${e.linear_rgb[ch]}`); break; }
    for (let ch = 0; ch < 3; ch++)
      if (Math.abs(got.png_rgb8[ch] - e.png_rgb8[ch]) > 1) { bad++; console.log(`FAIL ${tag} png[${ch}]`); break; }
  }
  if (bad) { failures++; console.log(`FAIL ${name}: ${bad} 项不符 (${ms.toFixed(0)}ms)`); }
  else { passes++; console.log(`PASS ${name}: ${expected[name].length} 参考像素 (${ms.toFixed(0)}ms)`); }
}

// 非法场景：重复 id 必须拒绝
try {
  const dup = JSON.parse(readFileSync(join(samplesDir, 'invalid-duplicate.json'), 'utf8'));
  validateScene(dup);
  console.log('FAIL invalid-duplicate: 未拒绝'); failures++;
} catch (e) {
  if (e instanceof ValidationError) { console.log('PASS invalid-duplicate: 已拒绝（' + e.message + '）'); passes++; }
  else { console.log('FAIL invalid-duplicate: 异常类型错误 ' + e); failures++; }
}

// reversed 场景逐像素一致（rgb8 全帧）
function fullFrame(name) {
  const scene = JSON.parse(readFileSync(join(samplesDir, name), 'utf8'));
  const band = renderBand(scene, scene.width, null, 0, scene.height);
  return mergeBands([band], scene.width, scene.background_linear_rgb);
}
const pairs = [['crossing.json', 'crossing-reversed.json'], ['stack32.json', 'stack32-reversed.json']];
for (const [a, b] of pairs) {
  const fa = fullFrame(a), fb = fullFrame(b);
  let same = true;
  for (let i = 0; i < fa.rgb8.length; i++) if (fa.rgb8[i] !== fb.rgb8[i]) { same = false; break; }
  if (same) { console.log(`PASS ${a} 与 ${b} 逐像素一致`); passes++; }
  else { console.log(`FAIL ${a} 与 ${b} 存在像素差异`); failures++; }
}

// PNG 编码冒烟测试：魔数 + IHDR + 尺寸 + 可被严格结构解析
const scene = JSON.parse(readFileSync(join(samplesDir, 'crossing.json'), 'utf8'));
const band = renderBand(scene, 64, null, 0, 64);
const frame64 = mergeBands([band], 64, scene.background_linear_rgb);
const png = encodePng(frame64.rgb8, 64, 64);
const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
if (sig.every((v, i) => png[i] === v) && png.length > 100) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (dv.getUint32(16, false) === 64 && dv.getUint32(20, false) === 64) {
    console.log(`PASS PNG 编码冒烟 (${png.length} 字节, 64x64)`); passes++;
  } else { console.log('FAIL PNG IHDR 尺寸'); failures++; }
} else { console.log('FAIL PNG 魔数'); failures++; }

console.log(`\n${passes} 通过, ${failures} 失败`);
process.exit(failures ? 1 : 0);
