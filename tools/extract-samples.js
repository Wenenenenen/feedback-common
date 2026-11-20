// 解压样例包到 samples/extracted/（零依赖，读取 ZIP 中央目录，支持 stored / deflate）。
// 测试与样例说明需要该目录；目录已存在时默认跳过（--force 可覆盖）。
// 用法：node tools/extract-samples.js [--force]

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = join(ROOT, 'samples', 'group-transform-denoiser-cases.zip');
const OUT = join(ROOT, 'samples', 'extracted');
const force = process.argv.includes('--force');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

if (!force && (await exists(OUT))) {
  console.log('samples/extracted/ 已存在，跳过（--force 覆盖）');
  process.exit(0);
}

const buf = await readFile(ZIP);
if (buf.readUInt32LE(0) !== 0x04034b50 && buf.readUInt32LE(buf.length - 22) !== 0x06054b50) {
  throw new Error('不是 ZIP 文件');
}

// 定位 EOCD
let eocd = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) {
    eocd = i;
    break;
  }
}
if (eocd < 0) throw new Error('ZIP 缺少中央目录结尾记录');
const count = buf.readUInt16LE(eocd + 10);
let p = buf.readUInt32LE(eocd + 16);

await mkdir(OUT, { recursive: true });
for (let i = 0; i < count; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
  const method = buf.readUInt16LE(p + 10);
  const compSize = buf.readUInt32LE(p + 20);
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const localOffset = buf.readUInt32LE(p + 42);
  const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
  p += 46 + nameLen + extraLen + commentLen;

  const target = normalize(join(OUT, name));
  if (!target.startsWith(OUT + sep) && target !== OUT) throw new Error(`ZIP 条目越界：${name}`);
  if (name.endsWith('/')) {
    await mkdir(target, { recursive: true });
    continue;
  }
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('本地文件头损坏');
  const lNameLen = buf.readUInt16LE(localOffset + 26);
  const lExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lNameLen + lExtraLen;
  const raw = buf.subarray(dataStart, dataStart + compSize);
  const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
  if (!data) throw new Error(`不支持的压缩方式 ${method}（${name}）`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}
console.log(`已解压 ${count} 个条目 → samples/extracted/`);
