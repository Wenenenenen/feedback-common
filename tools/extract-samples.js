// 解包样例：把 samples/<name>-cases.zip 解到 samples/extracted/。
// 零依赖（读 ZIP + 原生 DecompressionStream），避免依赖系统的 unzip。
// 样例是外部数据，只解到隔离目录，不执行包内任何内容。
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../js/zip.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'samples', 'focus-pyramid-stack-cases.zip');
const OUT = join(ROOT, 'samples', 'extracted');

export async function extractSamples({ force = false } = {}) {
  await mkdir(OUT, { recursive: true });
  if (!force) {
    try {
      await access(join(OUT, 'manifest.json'));
      return OUT;
    } catch {
      // 未解包，继续
    }
  }
  const entries = await readZip(await readFile(ZIP));
  for (const [name, data] of entries) {
    if (name.includes('..') || name.startsWith('/')) throw new Error(`ZIP 含可疑路径：${name}`);
    const dest = join(OUT, name);
    if (!dest.startsWith(OUT)) throw new Error(`ZIP 路径越界：${name}`);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data);
  }
  return OUT;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await extractSamples({ force: process.argv.includes('--force') });
  console.log(`样例已解包到 ${out}`);
}
