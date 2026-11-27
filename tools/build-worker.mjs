// 生成 src/worker-source.js：把 src/core.js 与 src/worker-runner.js 拼成一个
// 可直接喂给 Blob Worker 的源码字符串（file:// 下无需 fetch）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = fs.readFileSync(path.join(ROOT, 'src', 'core.js'), 'utf8');
const runner = fs.readFileSync(path.join(ROOT, 'src', 'worker-runner.js'), 'utf8');
const bundle = core + '\n;\n' + runner;
const out =
  '/* 自动生成，请勿手改：node tools/build-worker.mjs */\n' +
  'globalThis.PM_WORKER_SRC = ' + JSON.stringify(bundle) + ';\n';
fs.writeFileSync(path.join(ROOT, 'src', 'worker-source.js'), out);
console.log('src/worker-source.js', out.length, 'bytes');
