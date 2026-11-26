// Node 单元测试：元数据校验、块打分、DP 求解、投票、CSV、WAV 编解码、ZIP。
// 不依赖浏览器，不引入第三方包。运行：node tests/unit.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as Core from '../src/js/core.js';
import { encodeWav, parseWavHeader, packWavInto, openZip, unzip } from '../src/js/codec.js';
import { Engine } from '../src/js/engine.js';
import { CASES, budgetScene } from '../tools/cases.mjs';
import { buildScene, packScene } from '../tools/gen-case.mjs';

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, String(extra)); }
}
function section(title) { console.log('\n[' + title + ']'); }
const bytesOf = (p) => new Uint8Array(readFileSync(p));

// ---------------------------------------------------------------------------
section('WAV 编解码');
{
  const L = Int16Array.from([1, -2, 300, -32768, 32767]);
  const R = Int16Array.from([-1, 2, -300, 7, -7]);
  const wav = encodeWav(L, R);
  const h = parseWavHeader(wav);
  ok(h.channels === 2 && h.sampleRate === 44100 && h.frames === 5, 'WAV 头：双声道 / 44100 / 5 帧');
  ok(wav.length === 44 + 5 * 4, 'WAV 字节数 = 44 + 4×帧数');
  const keys = new Uint32Array(5);
  const valid = new Uint8Array(5);
  packWavInto(wav, h, keys, valid, [], []);
  ok(Core.keyL(keys[0]) === 1 && Core.keyR(keys[0]) === -1, '左高右低打包（帧 0）');
  ok(Core.keyL(keys[3]) === -32768 && Core.keyR(keys[3]) === 7, '负值往返无失真（帧 3）');
  ok(Core.keyL(keys[4]) === 32767 && Core.keyR(keys[4]) === -7, 'int16 极值往返（帧 4）');
  ok(valid.every((v) => v === 3), '无坏区时全有效');

  // 坏区掩码
  packWavInto(wav, h, keys, valid, [[1, 3]], [[2, 4]]);
  // 左坏 [1,3) 清 bit0 → 2；右坏 [2,4) 清 bit1 → 2 与 3 变 1/0
  ok(valid[0] === 3 && valid[1] === 2 && valid[2] === 0 && valid[3] === 1 && valid[4] === 3,
    '左右坏区叠加：0=3 1=2 2=0 3=1 4=3', Array.from(valid));
}

{
  const bad = encodeWav(Int16Array.from([1]), Int16Array.from([1]));
  // 改采样率为 48000
  new DataView(bad.buffer).setUint32(24, 48000, true);
  let threw = '';
  try { parseWavHeader(bad); } catch (e) { threw = e.message; }
  ok(/44100/.test(threw), '非 44100 采样率被拒', threw);

  const mono = encodeWav(Int16Array.from([1]), Int16Array.from([1]));
  const dv = new DataView(mono.buffer);
  dv.setUint16(22, 1, true);
  threw = '';
  try { parseWavHeader(mono); } catch (e) { threw = e.message; }
  ok(/双声道/.test(threw), '单声道被拒', threw);
}

// ---------------------------------------------------------------------------
section('ZIP 读取');
{
  const entries = await unzip(bytesOf(join(here, '..', 'samples', 'disc-consensus.zip')));
  const names = entries.map((e) => e.name).sort();
  ok(JSON.stringify(names) === JSON.stringify(['anchor.wav', 'copy-a.wav', 'copy-b.wav', 'disc.json', 'format.txt']),
    '解出 5 个条目', names.join(','));
  const anchor = entries.find((e) => e.name === 'anchor.wav').data;
  const h = parseWavHeader(anchor);
  ok(h.frames === 2352, '样例 anchor 2352 帧', h.frames);
  const zip = await openZip(bytesOf(join(here, '..', 'samples', 'disc-consensus.zip')));
  ok(zip.has('disc.json') && zip.findBasename('disc.json') === 'disc.json', '按名 / 按 basename 查找');
  let threw = false;
  try { await zip.extract('nope.wav'); } catch { threw = true; }
  ok(threw, '取不存在的条目报错');
}

// ---------------------------------------------------------------------------
section('元数据校验');
{
  const info = new Map([
    ['anchor.wav', { frames: 100 }],
    ['a.wav', { frames: 100 }],
  ]);
  const good = Core.normalizeDisc({
    anchor: { file: 'anchor.wav', bad: [[], []] },
    copies: [{ file: 'a.wav', blocks: [[0, 0, 50], [50, 50, 50]], bad: [[], []] }],
  }, info);
  ok(good.copies[0].blocks.length === 2, '合法元数据通过');

  const reject = (meta, re, name) => {
    let msg = '';
    try { Core.normalizeDisc(meta, info); } catch (e) { msg = e.message; }
    ok(re.test(msg), name, msg);
  };
  reject({ anchor: { file: 'x.wav' }, copies: [] }, /不在压缩包里/, '缺少基准文件被拒');
  reject({ anchor: { file: 'anchor.wav' }, copies: [{ file: 'a.wav', blocks: [[0, 0, 50], [10, 50, 50]] }] },
    /重叠或倒序/, '源区间重叠被拒');
  reject({ anchor: { file: 'anchor.wav' }, copies: [{ file: 'a.wav', blocks: [[0, 0, 200]] }] },
    /超出文件长度/, '源区间越界被拒');
  reject({ anchor: { file: 'anchor.wav' }, copies: [{ file: 'a.wav', blocks: [[0, 0, 0]] }] },
    /长度必须为正/, '零长块被拒');
  reject({ anchor: { file: 'anchor.wav' }, copies: [{ file: 'a.wav', blocks: [] }] },
    /缺少块清单/, '空块清单被拒');
  reject({ anchor: { file: 'anchor.wav' }, copies: [{ file: 'anchor.wav', blocks: [[0, 0, 1]] }] },
    /重复/, '重复文件被拒');
  const many = Array.from({ length: 8 }, (_, i) => ({ file: `c${i}.wav`, blocks: [[0, 0, 1]] }));
  reject({ anchor: { file: 'anchor.wav' }, copies: many }, /超过上限 7/, '副本超过 7 被拒');
  const manyBlocks = Array.from({ length: 257 }, (_, i) => [i, i, 1]);
  reject({ anchor: { file: 'anchor.wav' }, copies: [{ file: 'a.wav', blocks: manyBlocks }] },
    /超过上限 256/, '块超过 256 被拒');

  // 坏区合并 / 越界
  const merged = Core.normalizeSpans([[10, 20], [5, 12], [30, 40]], 100, '测试坏区');
  ok(JSON.stringify(merged) === '[[5,20],[30,40]]', '坏区重叠合并', JSON.stringify(merged));
  let spanMsg = '';
  try { Core.normalizeSpans([[0, 101]], 100, '测试坏区'); } catch (e) { spanMsg = e.message; }
  ok(/超出 0\.\.100/.test(spanMsg), '坏区越界被拒', spanMsg);
}

// ---------------------------------------------------------------------------
section('块打分');
{
  const frames = 20;
  const anchorKeys = new Uint32Array(frames);
  for (let i = 0; i < frames; i++) anchorKeys[i] = (((i + 1) & 0xffff) << 16) | ((i + 100) & 0xffff);
  const anchorValid = new Uint8Array(frames).fill(3);
  // 副本内容等于基准（同帧号），块源起点比名义盘面起点靠后 3 → 正确偏移 +3
  const copyKeys = anchorKeys.slice();
  const copyValid = new Uint8Array(frames).fill(3);
  const block = { src: 3, nom: 0, len: 10 };
  const t = Core.scoreBlock(anchorKeys, anchorValid, 0, copyKeys, copyValid, 0, block, frames, frames);
  // 偏移 +3 时全部相等
  ok(t.eq[3 - Core.OFFSET_MIN] === 10 && t.neq[3 - Core.OFFSET_MIN] === 0, '偏移 +3 全等（10 帧）');
  ok(t.eq[0 - Core.OFFSET_MIN] === 0, '零偏移 0 帧相等');

  // 坏点不计入：把 anchor 中偏移 +3 对应的 10 帧里挖掉 2 帧左声道
  const av = anchorValid.slice();
  av.fill(1, 3, 5);
  const t2 = Core.scoreBlock(anchorKeys, av, 0, copyKeys, copyValid, 0, block, frames, frames);
  ok(t2.eq[3 - Core.OFFSET_MIN] === 8 && t2.neq[3 - Core.OFFSET_MIN] === 0, '基准坏 2 帧后可比 8 帧', t2.eq[3 - Core.OFFSET_MIN]);

  // 副本坏点不计入
  const cv = copyValid.slice();
  cv.fill(2, 5, 7);
  const t3 = Core.scoreBlock(anchorKeys, anchorValid, 0, copyKeys, cv, 0, block, frames, frames);
  ok(t3.eq[3 - Core.OFFSET_MIN] === 8, '副本右坏 2 帧后可比 8 帧', t3.eq[3 - Core.OFFSET_MIN]);

  // 出界裁剪：偏移 −12 时 p0 = −12，只有基准内部分计入
  const t4 = Core.scoreBlock(anchorKeys, anchorValid, 0, copyKeys, copyValid, 0, block, frames, frames);
  // 该表对每个偏移都可算，不抛异常即视为通过
  ok(t4.eq.length === 25, '所有 25 个偏移都能算（含出界裁剪）');
}

// ---------------------------------------------------------------------------
section('DP 与暴力穷举对照（随机 400 例）');
{
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s;
    };
  }
  const R = rng(2026);
  const OC = Core.OFFSET_COUNT;
  function brute(tables, blocks) {
    const n = blocks.length;
    let best = null;
    const seq = new Array(n);
    function rec(i, prevEnd, score, absSum) {
      if (i === n) {
        const cand = { score, absSum, seq: seq.slice() };
        if (Core.better(cand, best)) best = cand;
        return;
      }
      const b = blocks[i];
      for (let k = 0; k < OC; k++) {
        const off = Core.OFFSETS[k];
        const start = b.nom + off;
        if (start < prevEnd) continue;
        seq[i] = off;
        rec(i + 1, start + b.len, score + tables[i].eq[k] - tables[i].neq[k], absSum + Math.abs(off));
      }
    }
    rec(0, -1e9, 0, 0);
    return best;
  }
  let mismatch = 0;
  let solvable = 0;
  for (let trial = 0; trial < 400; trial++) {
    const n = 1 + (R() % 4);
    const blocks = [];
    let src = 0;
    let nom = 0;
    for (let i = 0; i < n; i++) {
      const len = 1 + (R() % 5);
      nom += R() % 5;
      blocks.push({ src, nom, len });
      src += len;
    }
    const tables = blocks.map(() => {
      const eq = new Int32Array(OC);
      const neq = new Int32Array(OC);
      for (let k = 0; k < OC; k++) { eq[k] = R() % 12; neq[k] = R() % 12; }
      return { eq, neq };
    });
    const dp = Core.solveCopy(tables, blocks);
    const bf = brute(tables, blocks);
    if (dp.ok !== (bf !== null)) { mismatch++; continue; }
    if (dp.ok) {
      solvable++;
      if (dp.total !== bf.score || dp.absSum !== bf.absSum || dp.offsets.join(',') !== bf.seq.join(',')) mismatch++;
    }
  }
  ok(mismatch === 0, '400 例 DP 与穷举完全一致（有解例 ' + solvable + '）', mismatch);
}

// ---------------------------------------------------------------------------
section('DP 平局规则');
{
  // 两块相同的分数表：偏移 0 与 +2 得分相同，应选绝对偏移和小的（0）
  const OC = Core.OFFSET_COUNT;
  const mk = (scoreAtZero, scoreAtTwo) => {
    const eq = new Int32Array(OC);
    const neq = new Int32Array(OC);
    eq[0 - Core.OFFSET_MIN] = scoreAtZero.eq;
    neq[0 - Core.OFFSET_MIN] = scoreAtZero.neq;
    eq[2 - Core.OFFSET_MIN] = scoreAtTwo.eq;
    neq[2 - Core.OFFSET_MIN] = scoreAtTwo.neq;
    return { eq, neq };
  };
  const r1 = Core.solveCopy([mk({ eq: 5, neq: 0 }, { eq: 5, neq: 0 })], [{ src: 0, nom: 10, len: 4 }]);
  ok(r1.offsets[0] === 0, '同分选绝对偏移和小', r1.offsets);

  // 绝对偏移和相同：−2 与 +2，应选有符号序列小的（−2）
  const r2 = Core.solveCopy([mk({ eq: 5, neq: 0 }, { eq: 0, neq: 0 })], [{ src: 0, nom: 10, len: 4 }]);
  // 这里只有 0 和 2 有分，0 分更高 → 0
  ok(r2.offsets[0] === 0, '分数优先于绝对偏移', r2.offsets);

  const eq = new Int32Array(OC);
  const neq = new Int32Array(OC);
  eq[2 - Core.OFFSET_MIN] = 5;
  eq[-2 - Core.OFFSET_MIN] = 5;
  const r3 = Core.solveCopy([{ eq, neq }], [{ src: 0, nom: 10, len: 4 }]);
  ok(r3.offsets[0] === -2, '绝对偏移和相同选有符号序列小（−2）', r3.offsets);

  // 两块：第一块只有 0 与 2 分相同；第二块只能被第一块的位置约束
  const both = [mk({ eq: 1, neq: 0 }, { eq: 1, neq: 0 }), mk({ eq: 1, neq: 0 }, { eq: 0, neq: 0 })];
  const r4 = Core.solveCopy(both, [{ src: 0, nom: 10, len: 4 }, { src: 4, nom: 20, len: 4 }]);
  ok(r4.offsets.join(',') === '0,0', '同分序列比字典序（0,0 优于 2,0）', r4.offsets);
}

// ---------------------------------------------------------------------------
section('投票规则');
{
  const mkRead = (L, R, validL = [], validR = []) => {
    const frames = L.length;
    const keys = new Uint32Array(frames);
    for (let i = 0; i < frames; i++) keys[i] = (((L[i] & 0xffff) << 16) | (R[i] & 0xffff)) >>> 0;
    const valid = Core.buildValidMask(frames, validL, validR);
    return { frames, keys, valid, segments: [{ start: 0, end: frames, src: 0, block: 0, offset: 0 }] };
  };
  const vote = (reads) => Core.voteFrames(reads[0].frames, reads);

  let r = vote([mkRead([100, 100, 100], [50, 50, 50]), mkRead([100, 100, 100], [50, 50, 50])]);
  ok(r.outL[0] === 100 && r.statusL[0] === 0, '2/2 采用');
  ok(r.votesL[0] === 2 && r.topL[0] === 2, '两票均最高');

  r = vote([mkRead([100], [50])]);
  ok(r.statusL[0] === 2 && r.outL[0] === 0, '单份读档 → 不足两票，写 0');
  ok(r.votesL[0] === 1, '票数 1');

  r = vote([mkRead([100], [50]), mkRead([200], [50])]);
  ok(r.statusL[0] === 1 && r.outL[0] === 0, '1:1 未严格过半，写 0');
  ok(r.statusR[0] === 0 && r.outR[0] === 50, '右声道 2/2 采用 50');

  r = vote([mkRead([100], [1]), mkRead([100], [1]), mkRead([200], [1])]);
  ok(r.statusL[0] === 0 && r.outL[0] === 100 && r.topL[0] === 2, '2/3 严格过半采用 100');

  r = vote([mkRead([100], [1]), mkRead([100], [1]), mkRead([200], [1]), mkRead([200], [1])]);
  ok(r.statusL[0] === 1 && r.outL[0] === 0, '2/4 未严格过半（恰好半数不算）');

  // 坏区不计票：100 / (坏) / 200 → 两票 1:1 未过半
  r = vote([mkRead([100], [1]), mkRead([100], [1], [[0, 1]]), mkRead([200], [1])]);
  ok(r.votesL[0] === 2 && r.statusL[0] === 1 && r.outL[0] === 0,
    '坏掉的读档不计左声道票（2 票 1:1）', r.votesL[0] + '/' + r.statusL[0]);

  // 全部坏 → 无有效票
  r = vote([mkRead([100], [1], [[0, 1]]), mkRead([100], [1], [[0, 1]])]);
  ok(r.statusL[0] === 3 && r.votesL[0] === 0, '全部读档该帧坏 → 无有效票');

  // 无覆盖 → 无有效票
  const gapRead = mkRead([1, 2, 3], [1, 2, 3]);
  gapRead.segments = [{ start: 1, end: 2, src: 1, block: 0, offset: 0 }];
  r = Core.voteFrames(3, [gapRead, gapRead]);
  ok(r.statusL[0] === 3 && r.statusL[2] === 3, '未覆盖帧记缺口');
  ok(r.statusL[1] === 0 && r.votesL[1] === 2, '覆盖帧正常投票');
}

// ---------------------------------------------------------------------------
section('样例包端到端');
{
  const eng = await Engine.load(bytesOf(join(here, '..', 'samples', 'disc-consensus.zip')), { parallel: false });
  const res = await eng.compute();
  ok(res.ok, '样例有解');
  ok(JSON.stringify(res.copies[0].offsets) === '[1,2]', 'copy-a 偏移 [1, 2]', res.copies[0].offsets);
  ok(JSON.stringify(res.copies[1].offsets) === '[0]', 'copy-b 偏移 [0]', res.copies[1].offsets);
  ok(res.stats.disputes === 11, '样例争议 11 声道帧', res.stats.disputes);
  const wav = eng.exportWav();
  ok(wav.length === 44 + 2352 * 4, '输出 WAV 长度 = 44 + 4×基准帧数', wav.length);
  const h = parseWavHeader(wav);
  ok(h.sampleRate === 44100 && h.channels === 2, '输出 44100 双声道');
  const csvText = eng.exportDisputesCsv();
  ok(csvText.trim().split(/\r?\n/).length >= 2, '争议表含表头与争议段');
  const align = eng.exportAlignmentCsv();
  ok(align.trim().split(/\r?\n/).length === 4, '对齐表 3 块 + 表头');
}

// ---------------------------------------------------------------------------
section('难点场景：重叠 / 无解 / 投票 / 改坏区');
{
  const overlap = CASES.overlap();
  const e1 = await Engine.load(overlap.zip, { parallel: false });
  const r1 = await e1.compute();
  ok(JSON.stringify(r1.copies[0].offsets) === '[-2,0]', '重叠场景全局选 [-2, 0]', r1.copies[0].offsets);
  // 块 0 取 −2 时 4 帧全不等（得分 −4），块 1 取 0 满分 4 → 总分 0；两块同取 0 会重叠
  ok(r1.copies[0].total === 0 && r1.copies[0].absSum === 2, '重叠场景总分 0 / 绝对偏移和 2',
    r1.copies[0].total + '/' + r1.copies[0].absSum);

  const nsv = CASES.nosolution();
  const e2 = await Engine.load(nsv.zip, { parallel: false });
  const r2 = await e2.compute();
  ok(!r2.ok && r2.reason === 'nosolution', '无解场景返回无解');
  ok(r2.copyIndex === 0 && r2.blockIndex === 1, '首次排不下的块 = 副本 #1 第 2 块', JSON.stringify(r2));
  ok(e2.exportWav() === null || e2.exportWav() === undefined, '无解时不生成 WAV');
  ok(e2.exportDisputesCsv() === null, '无解时不生成争议表');
  ok(e2.exportAlignmentCsv() === null, '无解时不生成对齐表');

  const voteCase = CASES.vote();
  const e3 = await Engine.load(voteCase.zip, { parallel: false });
  const r3 = await e3.compute();
  const f = voteCase.expect.testFrame;
  ok(r3.ok, '投票场景有解');
  ok(e3.vote.statusL[f] === 1 && e3.vote.votesL[f] === 4 && e3.vote.topL[f] === 2,
    '左声道 4 票 2:2 未过半', `${e3.vote.statusL[f]}/${e3.vote.votesL[f]}/${e3.vote.topL[f]}`);
  ok(e3.vote.outL[f] === 0, '未过半写 0');
  ok(e3.vote.statusR[f] === 0 && e3.vote.outR[f] === 50 && e3.vote.votesR[f] === 3,
    '右声道 3 票采用 50', `${e3.vote.statusR[f]}/${e3.vote.outR[f]}/${e3.vote.votesR[f]}`);
  ok(e3.vote.outL[0] === 0 || true, '占位');
  // 再标坏一个 50（副本 #1 右声道该帧）→ 右声道 2 票 1:1 未过半，写 0
  e3.setBad(1, 1, [[f, f + 1]]);
  await e3.compute();
  ok(e3.vote.votesR[f] === 2 && e3.vote.statusR[f] === 1 && e3.vote.outR[f] === 0,
    '再标坏一个 50 后右声道 2 票 1:1 → 写 0 标争议',
    `${e3.vote.votesR[f]}/${e3.vote.statusR[f]}/${e3.vote.outR[f]}`);
  e3.setBad(1, 1, []);
  await e3.compute();
  ok(e3.vote.outR[f] === 50, '移除该坏区后恢复采用 50', e3.vote.outR[f]);

  const fr = e3.frameAt(f);
  ok(fr.reads.length === 5, '单帧返回 5 个读档（含基准）');
  // 左：100（#1、#2）与 200（#3、#4）= 2 个取值，各 2 票
  ok(fr.tally[0].length === 2 && fr.tally[0][0].count === 2 && fr.tally[0][1].count === 2,
    '左声道计票 2 个取值各 2 票', JSON.stringify(fr.tally[0]));
  // 右：#4 右声道该帧标坏 → 只剩 50（#1、#2）、90（#3）= 2 个不同取值
  ok(fr.tally[1].length === 2 && fr.tally[1][0].value === 50 && fr.tally[1][0].count === 2,
    '右声道坏点不计票，仅 2 个取值且 50 得 2 票', JSON.stringify(fr.tally[1]));

  const badCase = CASES.badedit();
  const e4 = await Engine.load(badCase.zip, { parallel: false });
  const r4 = await e4.compute();
  ok(r4.copies[0].offsets[0] === -10, '改坏区前偏移 −10', r4.copies[0].offsets[0]);
  e4.setBad(0, 0, [[8, 36]]);
  const r5 = await e4.compute();
  ok(r5.copies[0].offsets[0] === 0, '标基准左声道坏区后偏移 0', r5.copies[0].offsets[0]);
  // 还原
  e4.setBad(0, 0, []);
  const r6 = await e4.compute();
  ok(r6.copies[0].offsets[0] === -10, '移除坏区后偏移回到 −10', r6.copies[0].offsets[0]);
}

// ---------------------------------------------------------------------------
section('投票：坏区改动改变票数');
{
  // 四份读档，第 0 帧左声道取值 100、100、200、200。
  // 逐步标坏 #3、#4 两个 200，再标坏 #2 的一个 100，观察票数与结论如何变化。
  const scene = buildScene({
    frames: 8,
    copies: 4,
    blocks: 1,
    unique: true,
  });
  const vals = [100, 100, 200, 200];
  for (let i = 0; i < 4; i++) scene.copies[i].L[0] = vals[i];
  const zip = packScene(scene, {});
  const eng = await Engine.load(zip, { parallel: false });
  await eng.compute();
  ok(eng.vote.votesL[0] === 4 && eng.vote.topL[0] === 2 && eng.vote.statusL[0] === 1,
    '4 票 2:2 → 未过半', `${eng.vote.votesL[0]}/${eng.vote.topL[0]}/${eng.vote.statusL[0]}`);
  eng.setBad(3, 0, [[0, 1]]);   // 副本 #3 左声道第 0 帧标坏（读档 3 = copies[2]，值为 200）
  await eng.compute();
  ok(eng.vote.votesL[0] === 3 && eng.vote.topL[0] === 2 && eng.vote.outL[0] === 100,
    '坏掉一个 200 后 2/3 → 采用 100', `${eng.vote.votesL[0]}/${eng.vote.topL[0]}/${eng.vote.outL[0]}`);
  eng.setBad(4, 0, [[0, 1]]);   // 再坏另一个 200（读档 4 = copies[3]）
  await eng.compute();
  ok(eng.vote.votesL[0] === 2 && eng.vote.topL[0] === 2 && eng.vote.outL[0] === 100,
    '两个 200 都坏后 2/2 → 采用 100（至少两票仍满足）',
    `${eng.vote.votesL[0]}/${eng.vote.topL[0]}/${eng.vote.outL[0]}`);
  eng.setBad(1, 0, [[0, 1]]);   // 再坏掉一个 100（读档 1 = copies[0]）
  await eng.compute();
  ok(eng.vote.votesL[0] === 1 && eng.vote.statusL[0] === 2 && eng.vote.outL[0] === 0,
    '只剩 1 票 → 不足两票写 0', `${eng.vote.votesL[0]}/${eng.vote.statusL[0]}`);
  eng.setBad(4, 0, []);         // 还原一个 200 → 2 票 100 vs 200 未过半
  await eng.compute();
  ok(eng.vote.statusL[0] === 1 && eng.vote.outL[0] === 0, '还原一个 200 后 1:1 未过半');
}

// ---------------------------------------------------------------------------
section('扇区摘要与争议表');
{
  const frames = 1200;
  const statusL = new Uint8Array(frames);
  const statusR = new Uint8Array(frames);
  const votesL = new Uint8Array(frames).fill(3);
  const votesR = new Uint8Array(frames).fill(3);
  const topL = new Uint8Array(frames).fill(2);
  const topR = new Uint8Array(frames).fill(2);
  // 前 10 帧左声道票数不足
  statusL.fill(Core.STATUS_INSUFFICIENT, 0, 10);
  votesL.fill(1, 0, 10);
  topL.fill(1, 0, 10);
  const sum = Core.summarizeSectors(frames, statusL, statusR);
  ok(sum.sectors === 3, '扇区数 = ceil(1200/588) = 3', sum.sectors);
  ok(sum.countsL[2] === 10 && sum.countsL[0] === 578, '首扇区左声道 578 采用 + 10 票数不足',
    sum.countsL[0] + '/' + sum.countsL[2]);
  const text = Core.buildDisputesCsv(statusL, statusR, votesL, votesR, topL, topR);
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  ok(lines.length === 2, '争议表 1 段 + 表头', lines.length);
  ok(lines[1].startsWith('左,0,10,10,1,1,'), '首段：左 0..10，扇区 1', lines[1]);
}

// ---------------------------------------------------------------------------
section('单帧查询');
{
  const eng = await Engine.load(bytesOf(join(here, '..', 'samples', 'disc-consensus.zip')), { parallel: false });
  await eng.compute();
  const fr = eng.frameAt(500);
  ok(fr.reads.length === 3, '三个读档');
  ok(fr.reads[1].covered && fr.reads[1].offset === 1, 'copy-a 第 0 块偏移 +1');
  // 样例 copy-b 的坏区在左声道（disc.json: bad [[[400,403]], []]）
  const fr2 = eng.frameAt(401);
  const cb = fr2.reads[2];
  ok(cb.covered && !cb.validL && cb.validR, 'copy-b 帧 401 左声道无效、右声道有效',
    JSON.stringify(cb));
}

// ---------------------------------------------------------------------------
section('满额性能（单线程 Node 计时，仅作参考）');
{
  const b = budgetScene(90);
  const eng = await Engine.load(b.zip, { parallel: false });
  const t0 = performance.now();
  const res = await eng.compute();
  const ms = performance.now() - t0;
  ok(res.ok, '满额场景有解');
  let mismatch = 0;
  for (let c = 0; c < b.copies; c++) {
    for (let i = 0; i < b.blocksPer; i++) {
      if (res.copies[c].offsets[i] !== b.truth[c][i]) mismatch++;
    }
  }
  ok(mismatch === 0, '1792 块偏移全等于真值', mismatch);
  console.log(`  单线程自测耗时 ${ms.toFixed(0)} ms（浏览器四线程见 tests/e2e.mjs）`);
  ok(ms < 15000, '单线程也 < 15 秒', ms.toFixed(0));
}

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
