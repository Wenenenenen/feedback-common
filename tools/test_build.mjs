/*
 * 构建产物校验：
 *  1. 从 index.html 抽出全部 <script>，在 Node 的“浏览器式”全局环境里执行，
 *     确认剥离 ESM 语法后 FlowEngine / FlowZip / UI 绑定均可用；
 *  2. 用内置演示数据走完整渲染管线；
 *  3. 生成 ZIP 落盘，用系统 unzip 校验完整性，再逐字节比对解压内容。
 */
import { writeFileSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.equal(scripts.length, 4, '应内联 4 段脚本（engine/zip/demo/ui）');

// 浏览器式全局：没有 module/exports，验证 typeof 守卫与剥离结果
const sandbox = {
  console,
  performance,
  setTimeout,
  TextEncoder,
  TextDecoder,
  Blob: class { constructor(parts) { this.parts = parts; } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  document: { addEventListener: () => {}, getElementById: () => null, createElement: () => ({ click() {} }) },
  atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const s of scripts) {
  vm.runInContext(s, sandbox, { filename: 'inline-script.js' });
}
assert.ok(sandbox.FlowEngine, 'FlowEngine 未挂到全局');
assert.ok(sandbox.FlowZip, 'FlowZip 未挂到全局');
assert.ok(sandbox.FlowDemoData, '演示数据未挂到全局');
console.log('  内联脚本执行通过：FlowEngine / FlowZip / FlowDemoData 全局可用');

// 用内置演示数据走管线
const decode = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'));
const E = sandbox.FlowEngine;
const ds = E.loadDataset({
  aPPM: { name: 'a.ppm', bytes: decode(sandbox.FlowDemoData.aPPM) },
  bPPM: { name: 'b.ppm', bytes: decode(sandbox.FlowDemoData.bPPM) },
  aBIN: { name: 'a.bin', bytes: decode(sandbox.FlowDemoData.aBIN) },
  bBIN: { name: 'b.bin', bytes: decode(sandbox.FlowDemoData.bBIN) },
});
const passes = {
  passA: E.computeRoundTrip(ds.flowA, ds.flowB, ds.width, ds.height),
  passB: E.computeRoundTrip(ds.flowB, ds.flowA, ds.width, ds.height),
};
const r32 = E.renderFrame(ds, 32, 10, passes);
assert.equal(r32.width * r32.height, ds.width * ds.height);
console.log(`  内置演示数据渲染通过：${ds.width}×${ds.height}，贡献 ${r32._count} 条`);

// ZIP 往返：写出 -> unzip -t / 解压 -> 字节比对
const dir = mkdtempSync(join(tmpdir(), 'flow-zip-'));
const entries = [0, 1, 32, 63, 64].map((n) => {
  const r = n === 0 ? E.endpointFrame(ds, 0)
    : n === 64 ? E.endpointFrame(ds, 1)
      : E.renderFrame(ds, n, 10, passes);
  const tag = String(n).padStart(2, '0');
  return [
    { name: `frame_${tag}.ppm`, data: E.encodePPM(r.rgb, r.width, r.height) },
    { name: `class_${tag}.p5`, data: E.encodeP5(r.cls, r.width, r.height) },
  ];
}).flat();
const zipBytes = sandbox.FlowZip.buildZip(entries);
const zipPath = join(dir, 'out.zip');
writeFileSync(zipPath, zipBytes);

const testOut = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
assert.ok(testOut.includes('No errors detected'), `unzip -t 报错：\n${testOut}`);
console.log('  unzip -t 完整性通过');

execFileSync('unzip', ['-q', zipPath, '-d', dir]);
for (const entry of entries) {
  const got = new Uint8Array(readFileSync(join(dir, entry.name)));
  assert.equal(got.length, entry.data.length, `${entry.name} 长度不符`);
  assert.ok(got.every((v, i) => v === entry.data[i]), `${entry.name} 字节不符`);
}
console.log(`  ZIP 解压往返通过：${entries.length} 个文件逐字节一致（${readdirSync(dir).length - 1} 个数据文件）`);
rmSync(dir, { recursive: true, force: true });
console.log('\n构建产物全部通过');
