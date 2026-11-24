// make-fixtures.js — 生成测试用 ZIP 夹具(无解实例), 输出到 tests/fixtures/
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readZip } from '../app/js/zip-reader.js';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'fixtures'), { recursive: true });

// 复刻 e2e 里的 STORE zip 打包器
function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = []; const central = []; let offset = 0;
  for (const [name, content] of entries) {
    const nb = enc.encode(name);
    const local = new Uint8Array(30 + nb.length + content.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
    dv.setUint16(8, 0, true);
    dv.setUint32(14, 0, true);
    dv.setUint32(18, content.length, true); dv.setUint32(22, content.length, true);
    dv.setUint16(26, nb.length, true);
    local.set(nb, 30); local.set(content, 30 + nb.length);
    const cd = new Uint8Array(46 + nb.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(8, 20, true);
    cv.setUint16(12, 0, true);
    cv.setUint32(16, 0, true);
    cv.setUint32(20, content.length, true); cv.setUint32(24, content.length, true);
    cv.setUint16(28, nb.length, true); cv.setUint32(42, offset, true);
    cd.set(nb, 46);
    central.push(cd); chunks.push(local); offset += local.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, cdStart, true);
  const total = cdStart + cdSize + 22;
  const out = new Uint8Array(total); let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

// 基于真实样本, 把第 2 句(索引1)所有候选的 gap 破坏: dst 全部提前到第 1 句音频内部
const samplePath = join(here, '..', 'samples', 'dub-candidates.zip');
const buf = readFileSync(samplePath);
const files = await readZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const json = JSON.parse(new TextDecoder().decode(files.get('cues.json')));
// 第 1 句选中后音频最早结束于 dst+len; 让第 2 句所有 dst 远早于该结束+gap
json.cues[1].candidates.forEach((c) => { c[3] = json.cues[0].slot[0]; c[4] = 6000; });
const entries = [
  ['cues.json', new TextEncoder().encode(JSON.stringify(json))],
  [json.takes[0], files.get(json.takes[0])],
  [json.takes[1], files.get(json.takes[1])],
];
const out = makeZip(entries);
const dest = join(here, 'fixtures', 'infeasible.zip');
writeFileSync(dest, out);
console.log('wrote', dest, out.byteLength, 'bytes');
