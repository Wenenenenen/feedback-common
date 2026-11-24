// e2e.js — Node 端到端: 读样本 ZIP, 走完整管线并校验产物
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readZip } from '../app/js/zip-reader.js';
import { parseWav, renderMix, encodeWav } from '../app/js/wav-codec.js';
import { solve } from '../app/js/solver.js';
import { importPackage } from '../app/js/importer.js';
import { buildSample } from '../app/js/sample-data.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.error(`FAIL: ${name} ${detail}`); }
};

// ---- 1. 真实样本 ZIP 走 importPackage ----
const zipBuf = readFileSync(join(here, '..', 'samples', 'dub-candidates.zip'));
const fakeFile = { name: 'dub-candidates.zip', arrayBuffer: async () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength) };
const { instance, takeAudio, warnings } = await importPackage(fakeFile);
check('import takes', instance.takes.length === 2);
check('import cues', instance.cues.length === 3);
check('no warnings', warnings.length === 0, warnings.join(';'));
check('audio map size', takeAudio.size === 2);
check('audio frames', takeAudio.get(0).frames === 24000 && takeAudio.get(1).frames === 24000);

// ---- 2. 求解 ----
const r = solve(instance);
check('solve ok', r.ok);
check('solve cost', r.totalCost === 9);

// ---- 3. 渲染补零交付轨 ----
const takeSamples = new Map([...takeAudio].map(([t, w]) => [t, w.samples]));
const mix = renderMix(r.chosen, takeSamples, instance.frames);
check('mix length', mix.length === instance.frames, `len=${mix.length}`);

// 每个未被覆盖的帧应为零, 被覆盖的帧应与源一致
let zeroCount = 0;
for (const c of r.chosen) {
  const src = takeSamples.get(c.take);
  for (let i = 0; i < c.len; i++) check('mix copied frame', mix[c.dst + i] === src[c.src + i]);
}
for (let i = 0; i < mix.length; i++) {
  const covered = r.chosen.some((c) => i >= c.dst && i < c.dst + c.len);
  if (!covered) { zeroCount++; check('zero padding', mix[i] === 0); }
}
check('has padding', zeroCount > 0, `zeros=${zeroCount}`);

// ---- 4. 编码 WAV 再解析, 数据往返一致 ----
const blob = encodeWav(mix);
const ab = await blob.arrayBuffer();
const round = parseWav(ab, 'delivery.wav');
check('wav roundtrip frames', round.frames === mix.length);
let same = true;
for (let i = 0; i < mix.length; i++) if (round.samples[i] !== mix[i]) { same = false; break; }
check('wav roundtrip samples', same);
check('wav header rate', round.sampleRate === 48000);

// ---- 5. readZip 直读校验 ----
const files = await readZip(await fakeFile.arrayBuffer());
check('zip entries', [...files.keys()].sort().join(',') === ['cues.json', 'format.txt', 't0.wav', 't1.wav'].join(','));
check('zip json bytes', files.get('cues.json').length > 0);

// ---- 6. 内置示例数据自洽且可解 ----
const sample = buildSample();
check('sample takes', sample.takeAudio.size === 4);
check('sample cues', sample.instance.cues.length === 6);
const sr = solve(sample.instance);
check('sample solvable', sr.ok, JSON.stringify(sr).slice(0, 200));
if (sr.ok) {
  const ts = new Map([...sample.takeAudio].map(([t, w]) => [t, w.samples]));
  const smix = renderMix(sr.chosen, ts, sample.instance.frames);
  check('sample mix length', smix.length === sample.instance.frames);
  const sb = encodeWav(smix);
  check('sample wav size', sb.size === 44 + sample.instance.frames * 2);
  // 验证全部约束
  let prev = null, sw = 0;
  for (const c of sr.chosen) {
    const cue = sample.instance.cues[sr.chosen.indexOf(c)];
    check('sample slot', c.dst >= cue.slot[0] && c.dst + c.len <= cue.slot[1]);
    if (prev) {
      check('sample gap', c.dst >= prev.dst + prev.len + sample.instance.gap);
      if (c.take === prev.take) check('sample src monotonic', c.src >= prev.src + prev.len);
      if (c.take !== prev.take) sw++;
    }
    prev = c;
  }
  check('sample switch budget', sw <= sample.instance.changes, `sw=${sw}`);
}

// ---- 7. 规格上限拦截(手工构造越界 ZIP 包) ----
const { LIMITS } = await import('../app/js/importer.js');
check('limit constants', LIMITS.maxCues === 240 && LIMITS.maxCandidates === 96 && LIMITS.maxTakes === 8);

// 用真实样本做底, 分别改坏后重新打包成 ZIP(仅 STORE, 手写最小 zip)
function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nb = enc.encode(name);
    const local = new Uint8Array(30 + nb.length + content.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);  // flags
    dv.setUint16(8, 0, true);  // STORE
    dv.setUint16(10, 0, true); dv.setUint16(12, 0, true); // 时间/日期
    dv.setUint32(14, 0, true); // CRC
    dv.setUint32(18, content.length, true); // 压缩大小
    dv.setUint32(22, content.length, true); // 未压缩大小
    dv.setUint16(26, nb.length, true);
    local.set(nb, 30); local.set(content, 30 + nb.length);
    const cd = new Uint8Array(46 + nb.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(8, 20, true);  // 解压所需版本
    cv.setUint16(10, 0, true);  // flags
    cv.setUint16(12, 0, true);  // STORE
    cv.setUint16(14, 0, true); cv.setUint16(16, 0, true); // 时间/日期
    cv.setUint32(16, 0, true); // CRC
    cv.setUint32(20, content.length, true); // 压缩大小
    cv.setUint32(24, content.length, true); // 未压缩大小
    cv.setUint16(28, nb.length, true);       // 名字长度
    cv.setUint32(42, offset, true);
    cd.set(nb, 46);
    central.push(cd);
    chunks.push(local);
    offset += local.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);
  const total = cdStart + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out.buffer;
}

const baseJson = JSON.parse(new TextDecoder().decode(files.get('cues.json')));
const wavBytes = (t) => files.get(baseJson.takes[t]);

async function expectReject(mutator, label) {
  const j = structuredClone(baseJson);
  mutator(j);
  const entries = [['cues.json', new TextEncoder().encode(JSON.stringify(j))]];
  for (let t = 0; t < j.takes.length; t++) entries.push([j.takes[t], wavBytes(t)]);
  const z = makeZip(entries);
  let err = null;
  try { await importPackage({ name: 'bad.zip', arrayBuffer: async () => z }); }
  catch (e) { err = e.message; }
  check(`${label} rejected`, err !== null, `got: ${err}`);
}

await expectReject((j) => { j.cues = j.cues.concat(Array(238).fill(j.cues[0])); }, '241 cues');
await expectReject((j) => { j.cues[0].candidates = j.cues[0].candidates.concat(Array(95).fill(j.cues[0].candidates[0])); }, '97 candidates');
// changes=13 不抛错而是降级, 单独验证
{
  const j = structuredClone(baseJson); j.changes = 13;
  const entries = [['cues.json', new TextEncoder().encode(JSON.stringify(j))], [j.takes[0], wavBytes(0)], [j.takes[1], wavBytes(1)]];
  const out = await importPackage({ name: 'z.zip', arrayBuffer: async () => makeZip(entries) });
  check('changes clamped 12', out.instance.changes === 12 && out.warnings.length === 1);
}
await expectReject((j) => { j.frames = 48000 * 181; }, 'frames > 180s');
// 整句候选都越槽 -> 求解时该句成为死句(导入不拦, 求解器拦)
{
  const j = structuredClone(baseJson);
  for (const c of j.cues[1].candidates) c[3] = j.cues[1].slot[1] - c[4] + 1;
  const entries = [['cues.json', new TextEncoder().encode(JSON.stringify(j))], [j.takes[0], wavBytes(0)], [j.takes[1], wavBytes(1)]];
  const out = await importPackage({ name: 'z.zip', arrayBuffer: async () => makeZip(entries) });
  const sr = solve(out.instance);
  check('all-overflow cue unsolvable', !sr.ok && sr.failedCue === 1, JSON.stringify(sr));
}
await expectReject((j) => { j.cues[0].candidates[0][2] = 99999999; }, 'src out of wav range');
await expectReject((j) => { j.gap = -1; }, 'negative gap');

// ---- 8. 非法 WAV 头被拒 ----
const bad = new Uint8Array(64);
let badThrew = false;
try { parseWav(bad.buffer, 'bad.wav'); } catch (e) { badThrew = /WAV|RIFF/.test(e.message); }
check('bad wav rejected', badThrew);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
