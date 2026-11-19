// 端到端：跑通两个样例，导出 PNG 与 JSON，检查关键字段与融合探针。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePng, encodePng } from '../app/js/png.js';
import { buildMosaic, buildExportJson } from '../app/js/mosaic.js';

await mkdir('tests/out', { recursive: true });
for (const dir of process.argv.slice(2)) {
  const name = dir.split('/').filter(Boolean).pop();
  const match = JSON.parse(await readFile(join(dir, 'matches.json'), 'utf8'));
  const images = [];
  for (const n of match.images) {
    const buf = await readFile(join(dir, n));
    images.push({ name: n, ...(await decodePng(buf.buffer.slice(buf.byteOffset))) });
  }
  const r = buildMosaic(images, match, 3, match.reference);
  console.log(`\n[${name}] 画布 ${r.canvas.width}x${r.canvas.height} origin=(${r.canvas.originX},${r.canvas.originY})`);
  console.log('  生成树:', r.tree.treeEdges.map((e) => `${e.a}-${e.b}`).join(', '));
  console.log('  闭环:', r.loops.map((l) => `${l.a}-${l.b} max=${l.maxResidual.toFixed(3)}`).join('; ') || '无');
  let transparent = 0, opaque = 0;
  for (let i = 3; i < r.rgba.length; i += 4) {
    if (r.rgba[i] === 0) transparent++;
    if (r.rgba[i] === 255) opaque++;
  }
  console.log(`  像素: 全透明 ${transparent}，不透明 ${opaque}，半透明 ${r.canvas.width * r.canvas.height - transparent - opaque}`);
  const png = await encodePng(r.canvas.width, r.canvas.height, r.rgba);
  await writeFile(join('tests/out', `${name}-mosaic.png`), png);
  const payload = buildExportJson(r, images.map((i) => i.name));
  await writeFile(join('tests/out', `${name}-mosaic.json`), JSON.stringify(payload, null, 2));
  // JSON 字段检查
  const ok = payload.canvas.offset[0] === r.canvas.offsetX &&
    payload.image_to_canvas.length === images.length &&
    payload.edges.every((e) => Array.isArray(e.inliers)) &&
    payload.image_to_reference.every((m) => m.length === 3 && m[2][2] !== 0);
  console.log('  导出 JSON 字段完整:', ok ? 'OK' : 'FAIL');
  // 全透明像素必须 RGBA 全 0
  let allZero = true;
  for (let i = 0; i < r.rgba.length; i += 4) {
    if (r.rgba[i + 3] === 0 && (r.rgba[i] || r.rgba[i + 1] || r.rgba[i + 2])) { allZero = false; break; }
  }
  console.log('  全透明处 RGB 也为 0（透明 RGB 不贡献）:', allZero ? 'OK' : 'FAIL');
}
console.log('\n产物写入 tests/out/');
