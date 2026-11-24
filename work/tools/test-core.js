#!/usr/bin/env node
'use strict';
// 核心回归测试：node work/tools/test-core.js
const OC = require('../../opus-core.js');
const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, '../../test/fixtures');
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('  FAIL: ' + m); } }
function eq(a, b, m) { ok(a === b, m + ' (expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a) + ')'); }
function section(t) { console.log('\n# ' + t); }

// ---- 独立页校验 ----
function verifyOutput(bufIn) {
  const buf = Buffer.from(bufIn);
  let off = 0; const pages = [];
  while (off + 27 <= buf.length) {
    if (Buffer.from(buf.subarray(off, off + 4)).toString('latin1') !== 'OggS') return { ok: false, why: 'capture@' + off };
    const nseg = buf[off + 26], hdr = 27 + nseg;
    let body = 0; for (let i = 0; i < nseg; i++) body += buf[off + 27 + i];
    const total = hdr + body; const pg = Buffer.from(buf.subarray(off, off + total));
    const stored = pg.readUInt32LE(22); pg[22] = pg[23] = pg[24] = pg[25] = 0;
    const calc = OC.crcUpdate(0, pg, 0, pg.length);
    pages.push({ off, flags: buf[off + 5], serial: buf.readUInt32LE(off + 14), seq: buf.readUInt32LE(off + 18), granulePos: buf.readBigInt64LE(off + 6), ok: stored === calc });
    off += total;
  }
  if (off !== buf.length) return { ok: false, why: 'trailing' };
  if (!pages.every(p => p.ok)) return { ok: false, why: 'crc' };
  const chains = {}; for (const p of pages) (chains[p.serial] || (chains[p.serial] = [])).push(p);
  for (const s in chains) {
    const ps = chains[s];
    if (!ps.every((p, i) => p.seq === i)) return { ok: false, why: 'seq ' + s };
    if (ps[0].flags !== 0x02) return { ok: false, why: 'bos ' + s };
    if (!(ps[ps.length - 1].flags & 4)) return { ok: false, why: 'eos ' + s };
    if (ps.slice(1).some(p => p.flags & 2)) return { ok: false, why: 'extra bos ' + s };
    if (ps.slice(0, -1).some(p => p.flags & 4)) return { ok: false, why: 'extra eos ' + s };
  }
  return { ok: true, pages, chains };
}

section('Opus 成帧时长');
const F = OC.parseOpusPacket;
eq(F(Uint8Array.from([0xf8, 1]), 0).samples, 960, 'code0 CELT 20ms');
eq(F(Uint8Array.from([0x00, 1]), 0).samples, 480, 'code0 SILK 10ms');
eq(F(Uint8Array.from([0x20, 1]), 0).samples, 480, 'code0 SILK MB 10ms');
eq(F(Uint8Array.from([0x80, 1]), 0).samples, 120, 'code0 CELT 2.5ms');
eq(F(Uint8Array.from([0xf9, 1, 2, 3, 4]), 0).samples, 1920, 'code1 2x20ms');
eq(F(Uint8Array.from([0xfa, 2, 0xaa, 0xbb, 0xcc]), 0).samples, 1920, 'code2 2x20ms');
eq(F(Uint8Array.from([0xfb, 0x03, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 0).samples, 2880, 'code3 CBR 3x20ms');
eq(F(Uint8Array.from([0xfb, 0x83, 1, 1, 0xaa, 0xbb, 0xcc]), 0).samples, 2880, 'code3 VBR 3x20ms');
const p48 = [0x83, 0x30]; for (let i = 0; i < 48; i++) p48.push(i);
eq(F(Uint8Array.from(p48), 0).samples, 5760, 'code3 48x2.5ms = 120ms');
function throws(fn, label) { try { fn(); ok(false, label + ' 应抛错'); } catch (e) { ok(e && e.kind !== undefined || /code|包|帧/.test(e.message), label + ' 抛错'); } }
throws(() => F(Uint8Array.from([0xf9, 1, 2, 3]), 0), 'code1 奇数载荷');
throws(() => F(Uint8Array.from([0xfb, 0x00]), 0), 'code3 M=0');
throws(() => F(Uint8Array.from([0xfb, 0x03, 1, 2, 3, 4]), 0), 'code3 CBR 不整除');
throws(() => F(Uint8Array.from([]), 0), '空包');

section('样例解析（tone.opus）');
const tonePath = path.join(FIX, '../../..', 'samples', 'opus-cut-cases.zip');
// tone.opus 来自 zip，测试时从解压目录或内嵌不存在时不跑
const tone = (() => {
  const candidates = ['/tmp/opus-inspect/tone.opus'];
  for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c);
  return null;
})();
if (tone) {
  const idx = OC.parse(tone);
  const ch = idx.chains[0];
  eq(idx.chains.length, 1, '单链');
  eq(ch.header.preSkip, 312, 'pre-skip 312');
  eq(ch.B, 0, 'B=0');
  eq(ch.E, 198888, 'E=198888');
  eq(ch.playLen, 198576, '可播 198576 样本');
  eq(idx.globalSamples, 198576, '全局轴 198576');
  eq(idx.warnings.length, 0, '无警告');
}

section('跨页拼包（span60 X-paged）');
{
  const spanPath = path.join(FIX, 'span60_xpage.opus');
  if (fs.existsSync(spanPath)) {
    const idx = OC.parse(fs.readFileSync(spanPath));
    const rows = OC.tabulate(idx);
    const spans = rows.packets.filter(p => p.spansPages).length;
    eq(spans, rows.packets.length, '全部包跨页');
    eq(idx.warnings.length, 0, '跨页解析无警告');
    eq(idx.globalSamples, 144000, '可播总长');
    // 跨页往返
    const sel = OC.select(idx, 20000, 100000);
    const out = OC.buildOutput(idx, sel.plans);
    ok(verifyOutput(out.data).ok, '跨页输出结构有效');
    eq(OC.parse(out.data).globalSamples, 80000, '跨页输出可播 80000');
  } else { console.log('  (skip: span60_xpage.opus 未生成)'); }
}

section('选择与输出往返（单链）');
{
  const buf = fs.readFileSync(path.join(FIX, 'mono20.opus'));
  const idx = OC.parse(buf);
  const S = 20000, T = 80000;
  const sel = OC.select(idx, S, T);
  eq(sel.plans.length, 1, '一条计划');
  const p = sel.plans[0];
  eq(p.Si, S + 312, 'Si = S + chain playStart');
  eq(p.preSkip, p.Si - p.K, 'pre-skip = Si - K');
  eq(p.eosGranule, p.Ti - p.K, 'EOS 粒度 = Ti - K');
  ok(p.trim < p.packets[p.packets.length - 1].samples, '末包裁量小于末包样本数');
  const out = OC.buildOutput(idx, sel.plans);
  const v = verifyOutput(out.data);
  ok(v.ok, '输出结构校验: ' + (v.why || 'ok'));
  eq(out.data.length, out.totalBytes, '字节数一致');
  const idx2 = OC.parse(out.data);
  eq(idx2.globalSamples, T - S, '可播长度 = T - S');
  eq(idx2.chains[0].header.preSkip, p.preSkip, '输出 pre-skip 正确');
  // 字节一致性：源包 === 输出包
  const srcPlanPkts = p.packets.map(x => Buffer.from(x.pkt.body));
  const outPkts = idx2.chains[0].audio.map(a => Buffer.from(a.pkt.body));
  eq(outPkts.length, srcPlanPkts.length, '输出包数一致');
  let same = true; for (let i = 0; i < outPkts.length; i++) if (!outPkts[i].equals(srcPlanPkts[i])) same = false;
  ok(same, '所有音频包原字节不变');
}

section('多链跨边界往返');
{
  const parts = ['mono20.opus', 'mono60.opus', 'mono10.opus'].map(f => fs.readFileSync(path.join(FIX, f)));
  const all = Buffer.concat(parts);
  const idx = OC.parse(all);
  eq(idx.chains.length, 3, '三条链');
  eq(idx.globalSamples, 288000, '全局 288000');
  const sel = OC.select(idx, 90000, 110000);
  eq(sel.plans.length, 2, '跨两条链');
  const out = OC.buildOutput(idx, sel.plans);
  const v = verifyOutput(out.data);
  ok(v.ok, '输出结构: ' + (v.why || 'ok'));
  const idx2 = OC.parse(out.data);
  eq(idx2.globalSamples, 20000, '可播 20000');
  eq(idx2.chains.length, 2, '输出两条链');
  const serials = idx2.chains.map(c => c.serial);
  eq(new Set(serials).size, 2, '输出序列号互异');
}

section('预卷（80ms 规则）');
{
  const idx = OC.parse(fs.readFileSync(path.join(FIX, 'mono20.opus')));
  const audio = idx.chains[0].audio;
  // 选一个远离链首的点
  const S = 50000, T = 60000;
  const p = OC.select(idx, S, T).plans[0];
  const target = Math.max(idx.chains[0].B, p.Si - OC.PREROLL);
  let exp = 0; for (let i = 0; i < audio.length; i++) if (audio[i].unt_start <= target) exp = i;
  eq(p.startIdx, exp, '起始包取不晚于 max(B,S-3840) 的最后一个包');
  ok(p.Si - audio[p.startIdx].unt_start >= OC.PREROLL - 960, '预卷至少约 80ms');
  // 链首附近：预卷不足取链首
  const p2 = OC.select(idx, 1000, 5000).plans[0];
  eq(p2.startIdx, 0, '预卷不足取链首');
}

section('边界与错误');
{
  const idx = OC.parse(fs.readFileSync(path.join(FIX, 'mono20.opus')));
  throws2(() => OC.select(idx, 100, 100), 'S=T 报错');
  const sel = OC.select(idx, idx.globalSamples + 10, idx.globalSamples + 20);
  eq(sel.plans.length, 0, '区间在可播范围外无计划');
  const clip = OC.select(idx, idx.globalSamples - 1000, idx.globalSamples + 99999).plans[0];
  eq(clip.Ti, idx.chains[0].E, 'T 超界被夹到 E');
}
function throws2(fn, label) { try { fn(); ok(false, label); } catch (e) { ok(true, label); } }

section('损坏处理');
{
  const src = fs.readFileSync(path.join(FIX, 'mono20.opus'));
  const bad = Buffer.from(src); bad[9600] ^= 0xff;
  const idx = OC.parse(bad);
  ok(idx.scanError && idx.scanError.kind === 'crc', '坏页报 CRC 并定位');
  eq(idx.scanError.offset, 9456, '坏页偏移 9456');
  eq(idx.pageCount, 3, '保留坏页之前的 3 个有效页');
  const trunc = Buffer.from(src.subarray(0, 10000));
  const idx2 = OC.parse(trunc);
  ok(idx2.scanError && idx2.scanError.kind === 'truncated', '截断报错并定位');
  eq(idx2.pageCount, 3, '截断保留有效页');
  let threw = false; try { OC.parse(Buffer.alloc(0)); } catch (e) { threw = true; }
  ok(threw, '空输入抛错');
  // 无音频
  const hdrOnly = Buffer.concat([src.subarray(0, 137)]);
  threw = false; try { const i3 = OC.parse(hdrOnly); threw = !!(i3.chains[0] && i3.chains[0].fatal); } catch (e) { threw = true; }
  ok(threw, '无音频链被标为无效');
}

section('帧粒度：EOS 单页夹到 0');
{
  const p = path.join(FIX, 'eos_first.opus');
  if (fs.existsSync(p)) {
    const idx = OC.parse(fs.readFileSync(p));
    eq(idx.chains[0].B, 0, 'G<D 且 EOS → B=0');
    eq(idx.warnings.length, 0, '夹到 0 不告警');
  } else { console.log('  (skip: eos_first.opus 未生成)'); }
}

console.log('\n=== ' + (fail ? 'FAIL' : 'PASS') + ' ' + pass + ' / ' + (pass + fail) + ' ===');
process.exit(fail ? 1 : 0);
