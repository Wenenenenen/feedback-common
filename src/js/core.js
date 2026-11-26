// 核心算法：元数据校验、块打分、带平局规则的偏移求解、按声道投票、争议表/对齐表。
// 纯函数，无 DOM、无第三方依赖；浏览器（主线程 / Worker）与 Node 测试共用同一份实现。
//
// 坐标约定：
//   源帧   —— 某读档 WAV 内的帧号（0 起）
//   盘面帧 —— 以基准为准的帧号（0 起，长度 = 基准帧数）
//   副本块在盘面上的区间 = [nom + 偏移, nom + 偏移 + len)

export const SAMPLE_RATE = 44100;
export const MAX_FRAMES = SAMPLE_RATE * 90; // 90 秒
export const MAX_COPIES = 7;
export const MAX_BLOCKS = 256;
export const OFFSET_MIN = -12;
export const OFFSET_MAX = 12;
export const OFFSET_COUNT = OFFSET_MAX - OFFSET_MIN + 1; // 25
export const SECTOR_FRAMES = 588;

// 声道帧状态（数值即图例顺序，勿改）。
export const STATUS_ADOPT = 0;
export const STATUS_NO_MAJORITY = 1;
export const STATUS_INSUFFICIENT = 2;
export const STATUS_GAP = 3;
export const STATUS_LABELS = ['采用', '未过严格过半', '票数不足', '无有效票'];
export const STATUS_SHORT = ['采用', '未过半', '票数不足', '缺口'];
export const STATUS_REASONS = ['采用', '票数未严格过半', '不足两票', '无有效票'];

export class ValidationError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ValidationError';
    this.detail = detail || null;
  }
}

function fail(message, detail) {
  throw new ValidationError(message, detail);
}

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

export const OFFSETS = Int8Array.from({ length: OFFSET_COUNT }, (_, i) => OFFSET_MIN + i);

// ---------------------------------------------------------------------------
// 元数据校验
// ---------------------------------------------------------------------------

/** 把坏区列表整理为升序、互不相交的半开区间。 */
export function normalizeSpans(spans, frames, where = '坏区') {
  if (!Array.isArray(spans)) fail(`${where}必须是区间列表`);
  const list = [];
  for (const item of spans) {
    if (!Array.isArray(item) || item.length !== 2) fail(`${where}的区间必须是 [起, 止) 两元素数组`);
    const [s, e] = item;
    if (!isInt(s) || !isInt(e)) fail(`${where}的区间端点必须是整数`);
    if (s < 0 || e > frames) fail(`${where}区间 [${s}, ${e}) 超出 0..${frames}`);
    if (s >= e) fail(`${where}区间 [${s}, ${e}) 为空或反向`);
    list.push([s, e]);
  }
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const span of list) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) {
      if (span[1] > last[1]) last[1] = span[1];
    } else {
      merged.push([span[0], span[1]]);
    }
  }
  return merged;
}

/**
 * 校验并规范化 disc.json。
 * @param {any} meta
 * @param {Map<string, {frames:number}>} wavInfo
 */
export function normalizeDisc(meta, wavInfo) {
  if (!meta || typeof meta !== 'object') fail('disc.json 必须是对象');
  if (!meta.anchor || typeof meta.anchor !== 'object') fail('disc.json 缺少 anchor');
  if (!Array.isArray(meta.copies)) fail('disc.json 的 copies 必须是数组');
  if (meta.copies.length > MAX_COPIES) {
    fail(`副本数 ${meta.copies.length} 超过上限 ${MAX_COPIES}`);
  }
  const resolve = (name, where) => {
    if (typeof name !== 'string' || !name) fail(`${where}缺少文件名`);
    const info = wavInfo.get(name);
    if (!info) fail(`${where}引用的文件不在压缩包里：${name}`);
    if (!(info.frames > 0)) fail(`${name} 没有采样帧`);
    if (info.frames > MAX_FRAMES) {
      fail(`${name} 长 ${info.frames} 帧，超过 90 秒上限 ${MAX_FRAMES} 帧`);
    }
    return info;
  };

  const anchorInfo = resolve(meta.anchor.file, 'anchor');
  const anchorBad = meta.anchor.bad || [[], []];
  if (!Array.isArray(anchorBad)) fail('基准 bad 必须是 [左坏区, 右坏区]');
  const anchor = {
    file: meta.anchor.file,
    frames: anchorInfo.frames,
    bad: [
      normalizeSpans(anchorBad[0] || [], anchorInfo.frames, '基准左声道坏区'),
      normalizeSpans(anchorBad[1] || [], anchorInfo.frames, '基准右声道坏区'),
    ],
  };

  const copies = [];
  const seen = new Set([anchor.file]);
  for (let ci = 0; ci < meta.copies.length; ci++) {
    const c = meta.copies[ci];
    const where = `副本 #${ci + 1}`;
    if (!c || typeof c !== 'object') fail(`${where}必须是对象`);
    const info = resolve(c.file, where);
    if (seen.has(c.file)) fail(`${where}的文件与之前重复：${c.file}`);
    seen.add(c.file);
    if (!Array.isArray(c.blocks) || c.blocks.length === 0) fail(`${where}缺少块清单 blocks`);
    if (c.blocks.length > MAX_BLOCKS) fail(`${where}有 ${c.blocks.length} 块，超过上限 ${MAX_BLOCKS}`);
    const blocks = [];
    let prevEnd = -1;
    for (let bi = 0; bi < c.blocks.length; bi++) {
      const row = c.blocks[bi];
      if (!Array.isArray(row) || row.length !== 3) {
        fail(`${where}第 ${bi + 1} 块必须是 [源起帧, 名义盘面起帧, 长度]`);
      }
      const [src, nom, len] = row;
      if (!isInt(src) || !isInt(nom) || !isInt(len)) {
        fail(`${where}第 ${bi + 1} 块的三个字段都必须是整数`);
      }
      if (len <= 0) fail(`${where}第 ${bi + 1} 块长度必须为正`);
      if (src < 0 || src + len > info.frames) {
        fail(`${where}第 ${bi + 1} 块源区间 [${src}, ${src + len}) 超出文件长度 ${info.frames}`);
      }
      if (src < prevEnd) {
        fail(`${where}第 ${bi + 1} 块的源区间 [${src}, ${src + len}) 与前一块重叠或倒序`);
      }
      prevEnd = src + len;
      blocks.push({ src, nom, len });
    }
    const bad = c.bad || [[], []];
    if (!Array.isArray(bad)) fail(`${where} bad 必须是 [左坏区, 右坏区]`);
    copies.push({
      file: c.file,
      frames: info.frames,
      blocks,
      bad: [
        normalizeSpans(bad[0] || [], info.frames, `${where}左声道坏区`),
        normalizeSpans(bad[1] || [], info.frames, `${where}右声道坏区`),
      ],
    });
  }
  return { anchor, copies };
}

// ---------------------------------------------------------------------------
// 采样打包与有效位图
// ---------------------------------------------------------------------------

/** 双声道打包成一个 u32；左声道在高 16 位。 */
export function packKeys(pcm, frames) {
  const keys = new Uint32Array(frames);
  for (let i = 0, j = 0; i < frames; i++, j += 2) {
    keys[i] = (((pcm[j] & 0xffff) << 16) | (pcm[j + 1] & 0xffff)) >>> 0;
  }
  return keys;
}

/** 有效位图：bit0 左声道有效，bit1 右声道有效。坏区清零对应位。 */
export function buildValidMask(frames, spansL, spansR) {
  const valid = new Uint8Array(frames).fill(3);
  applySpansToMask(valid, spansL, spansR);
  return valid;
}

function applySpansToMask(valid, spansL, spansR) {
  // 左坏清 bit0（&= 0xFE）；右坏清 bit1（&= 0xFD）。两者可叠加。
  for (const [s, e] of spansL) {
    for (let i = s; i < e; i++) valid[i] &= 0xfe;
  }
  for (const [s, e] of spansR) {
    for (let i = s; i < e; i++) valid[i] &= 0xfd;
  }
}

/** 就地重建有效位图（改坏区后复用内存）。 */
export function refillValidMask(valid, spansL, spansR) {
  valid.fill(3);
  applySpansToMask(valid, spansL, spansR);
}

export const keyL = (key) => ((key >>> 16) << 16) >> 16;
export const keyR = (key) => (key << 16) >> 16;

/** 二分查某帧是否落在半开区间列表内。 */
export function spansCover(spans, frame) {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = spans[mid];
    if (frame < s) hi = mid - 1;
    else if (frame >= e) lo = mid + 1;
    else return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 块打分
// ---------------------------------------------------------------------------

/**
 * 一块在 −12..12 各偏移下的相等/不等帧数。
 *
 * 允许对“切片”打分（Worker 用）：keys/valid 从 base 开始编号，
 * 但 block 的 src/nom 与 anchorFrames/copyFrames 都是绝对坐标，
 * 从而切片无关结果、与整份数据打分完全一致。
 *
 * 只统计落在基准内、且基准与副本左右声道都有效的帧；双声道值都相等才算相等。
 * @returns {{eq:Int32Array, neq:Int32Array}} 下标 k 对应偏移 OFFSET_MIN + k
 */
export function scoreBlock(anchorKeys, anchorValid, aBase, copyKeys, copyValid, cBase,
  block, anchorFrames, copyFrames) {
  const { src, nom, len } = block;
  const eq = new Int32Array(OFFSET_COUNT);
  const neq = new Int32Array(OFFSET_COUNT);
  for (let k = 0; k < OFFSET_COUNT; k++) {
    const p0 = nom + OFFSETS[k];
    let i0 = 0;
    let i1 = len;
    if (p0 < 0) i0 = -p0;
    if (p0 + len > anchorFrames) i1 = anchorFrames - p0;
    if (src + len > copyFrames) i1 = Math.min(i1, copyFrames - src);
    let e = 0;
    let n = 0;
    let i = i0;
    const pa0 = p0 - aBase;
    const ps0 = src - cBase;
    for (; i + 3 < i1; i += 4) {
      const pa = pa0 + i;
      const ps = ps0 + i;
      if ((anchorValid[pa] & copyValid[ps]) === 3) {
        if (anchorKeys[pa] === copyKeys[ps]) e++; else n++;
      }
      if ((anchorValid[pa + 1] & copyValid[ps + 1]) === 3) {
        if (anchorKeys[pa + 1] === copyKeys[ps + 1]) e++; else n++;
      }
      if ((anchorValid[pa + 2] & copyValid[ps + 2]) === 3) {
        if (anchorKeys[pa + 2] === copyKeys[ps + 2]) e++; else n++;
      }
      if ((anchorValid[pa + 3] & copyValid[ps + 3]) === 3) {
        if (anchorKeys[pa + 3] === copyKeys[ps + 3]) e++; else n++;
      }
    }
    for (; i < i1; i++) {
      const pa = pa0 + i;
      const ps = ps0 + i;
      if ((anchorValid[pa] & copyValid[ps]) === 3) {
        if (anchorKeys[pa] === copyKeys[ps]) e++; else n++;
      }
    }
    eq[k] = e;
    neq[k] = n;
  }
  return { eq, neq };
}

// ---------------------------------------------------------------------------
// 偏移求解：DP，平局依次比得分、绝对偏移和、有符号偏移序列
// ---------------------------------------------------------------------------

function cmpSeq(a, b) {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

/** 部分解偏序：得分高 > 绝对偏移和小 > 有符号序列字典序小。 */
export function better(a, b) {
  if (!b) return true;
  if (a.score !== b.score) return a.score > b.score;
  if (a.absSum !== b.absSum) return a.absSum < b.absSum;
  return cmpSeq(a.seq, b.seq) < 0;
}

/**
 * 对一份副本求各块偏移。约束：第 i 块盘面起点 ≥ 第 i−1 块盘面终点。
 * @param {{eq:Int32Array, neq:Int32Array}[]} tables 逐块打分表（与 blocks 同序）
 * @param {{src:number,nom:number,len:number}[]} blocks
 * @returns {{ok:true, offsets:number[], total:number, absSum:number}
 *          |{ok:false, blockIndex:number}}
 */
export function solveCopy(tables, blocks) {
  const n = blocks.length;
  if (n === 0) return { ok: true, offsets: [], total: 0, absSum: 0 };
  let states = new Map();
  const b0 = blocks[0];
  for (let k = 0; k < OFFSET_COUNT; k++) {
    const off = OFFSETS[k];
    const cand = {
      score: tables[0].eq[k] - tables[0].neq[k],
      absSum: Math.abs(off),
      seq: [off],
      lastEnd: b0.nom + off + b0.len,
    };
    const old = states.get(cand.lastEnd);
    if (better(cand, old)) states.set(cand.lastEnd, cand);
  }
  for (let i = 1; i < n; i++) {
    const b = blocks[i];
    const eq = tables[i].eq;
    const neq = tables[i].neq;
    const prevList = Array.from(states.values());
    const next = new Map();
    for (let k = 0; k < OFFSET_COUNT; k++) {
      const off = OFFSETS[k];
      const start = b.nom + off;
      let bestPrev = null;
      for (let j = 0; j < prevList.length; j++) {
        const prev = prevList[j];
        if (prev.lastEnd > start) continue;
        if (better(prev, bestPrev)) bestPrev = prev;
      }
      if (bestPrev === null) continue;
      const cand = {
        score: bestPrev.score + eq[k] - neq[k],
        absSum: bestPrev.absSum + Math.abs(off),
        seq: bestPrev.seq.concat(off),
        lastEnd: b.nom + off + b.len,
      };
      const old = next.get(cand.lastEnd);
      if (better(cand, old)) next.set(cand.lastEnd, cand);
    }
    if (next.size === 0) return { ok: false, blockIndex: i };
    states = next;
  }
  let best = null;
  for (const st of states.values()) if (better(st, best)) best = st;
  return { ok: true, offsets: best.seq, total: best.score, absSum: best.absSum };
}

/** 由偏移与打分表生成逐块明细。 */
export function detailsOf(blocks, tables, offsets) {
  return blocks.map((b, i) => {
    const k = offsets[i] - OFFSET_MIN;
    const eq = tables[i].eq[k];
    const neq = tables[i].neq[k];
    return {
      index: i,
      srcStart: b.src,
      srcEnd: b.src + b.len,
      nom: b.nom,
      len: b.len,
      offset: offsets[i],
      discStart: b.nom + offsets[i],
      discEnd: b.nom + offsets[i] + b.len,
      eq,
      neq,
      comparable: eq + neq,
      score: eq - neq,
    };
  });
}

/** 对齐一份副本（整份数据、单线程）：逐块打分 + DP。 */
export function alignCopy(anchor, copy, blocks) {
  const tables = blocks.map((b) =>
    scoreBlock(anchor.keys, anchor.valid, 0, copy.keys, copy.valid, 0, b, anchor.frames, copy.frames));
  const solved = solveCopy(tables, blocks);
  if (!solved.ok) return { ok: false, blockIndex: solved.blockIndex };
  return {
    ok: true,
    offsets: solved.offsets,
    total: solved.total,
    absSum: solved.absSum,
    details: detailsOf(blocks, tables, solved.offsets),
  };
}

/** 由逐块明细生成盘片段（已按 DP 保证有序不重叠）。 */
export function segmentsOf(details) {
  return details
    .map((d) => ({
      start: d.discStart,
      end: d.discEnd,
      src: d.srcStart,
      len: d.len,
      block: d.index,
      offset: d.offset,
    }))
    .sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// 投票
// ---------------------------------------------------------------------------

const HAS_SAB = typeof SharedArrayBuffer === 'function';

function foldBuffer(bytes) {
  return HAS_SAB ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
}

/**
 * 分配投票输出缓冲。可用 SharedArrayBuffer 时用它分配，
 * 这样把 subarray 视图 postMessage 给 Worker 后 Worker 的写入对主线程可见。
 * 状态数组初始化为“无有效票”，便于暴露漏写的分片。
 */
export function makeVoteBuffers(frames) {
  const out = {
    outL: new Int16Array(foldBuffer(frames * 2)),
    outR: new Int16Array(foldBuffer(frames * 2)),
    statusL: new Uint8Array(foldBuffer(frames)),
    statusR: new Uint8Array(foldBuffer(frames)),
    votesL: new Uint8Array(foldBuffer(frames)),
    votesR: new Uint8Array(foldBuffer(frames)),
    topL: new Uint8Array(foldBuffer(frames)),
    topR: new Uint8Array(foldBuffer(frames)),
  };
  out.statusL.fill(STATUS_GAP);
  out.statusR.fill(STATUS_GAP);
  return out;
}

/** 输出缓冲的 subarray 视图；投票分片用。 */
export function voteSlice(out, start, end) {
  return {
    outL: out.outL.subarray(start, end),
    outR: out.outR.subarray(start, end),
    statusL: out.statusL.subarray(start, end),
    statusR: out.statusR.subarray(start, end),
    votesL: out.votesL.subarray(start, end),
    votesR: out.votesR.subarray(start, end),
    topL: out.topL.subarray(start, end),
    topR: out.topR.subarray(start, end),
  };
}

/**
 * 对 [start, end) 逐帧投票，输出写到下标 p − start（分片并行用）。
 * 每份读档每声道最多一票；至少两票且最高票数严格过半才采用，否则写 0 并标争议。
 * @param {{frames:number,keys:Uint32Array,valid:Uint8Array,
 *          segments:{start:number,end:number,src:number}[]}[]} reads
 *         segments 的 src 是相对该读档 keys 的下标（切片时已平移）。
 * @param {number} start 绝对盘面起帧
 * @param {number} end 绝对盘面止帧（不含）
 * @param {object} out makeVoteBuffers(end - start) 的结果
 */
export function voteRange(reads, start, end, out) {
  const { outL, outR, statusL, statusR, votesL, votesR, topL, topR } = out;
  const nR = reads.length;
  const cursors = new Int32Array(nR);
  for (let c = 0; c < nR; c++) {
    const segs = reads[c].segments;
    let lo = 0;
    let hi = segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].end <= start) lo = mid + 1; else hi = mid;
    }
    cursors[c] = lo;
  }
  const span = end - start;
  const countL = new Uint16Array(65536);
  const countR = new Uint16Array(65536);
  const genL = new Int32Array(65536);
  const genR = new Int32Array(65536);
  let gen = 0;

  for (let p = start; p < end; p++) {
    const o = p - start;
    gen++;
    let nL = 0;
    let nRV = 0;
    let bestL = 0;
    let bestR = 0;
    let valL = 0;
    let valR = 0;
    for (let c = 0; c < nR; c++) {
      const list = reads[c].segments;
      if (list.length === 0) continue;
      let idx = cursors[c];
      while (idx < list.length && p >= list[idx].end) idx++;
      cursors[c] = idx;
      if (idx >= list.length) continue;
      const seg = list[idx];
      if (p < seg.start) continue;
      const s = seg.src + (p - seg.start);
      const rd = reads[c];
      if (s < 0 || s >= rd.frames) continue;
      const vm = rd.valid[s];
      if (vm === 0) continue;
      const key = rd.keys[s];
      if (vm & 1) {
        const v = (key >>> 16) & 0xffff;
        if (genL[v] !== gen) { genL[v] = gen; countL[v] = 1; } else countL[v]++;
        nL++;
        if (countL[v] > bestL) { bestL = countL[v]; valL = v; }
      }
      if (vm & 2) {
        const v = key & 0xffff;
        if (genR[v] !== gen) { genR[v] = gen; countR[v] = 1; } else countR[v]++;
        nRV++;
        if (countR[v] > bestR) { bestR = countR[v]; valR = v; }
      }
    }
    votesL[o] = nL;
    votesR[o] = nRV;
    topL[o] = bestL;
    topR[o] = bestR;
    if (nL === 0) statusL[o] = STATUS_GAP;
    else if (nL < 2) statusL[o] = STATUS_INSUFFICIENT;
    else if (bestL * 2 <= nL) statusL[o] = STATUS_NO_MAJORITY;
    else { statusL[o] = STATUS_ADOPT; outL[o] = (valL << 16) >> 16; }
    if (nRV === 0) statusR[o] = STATUS_GAP;
    else if (nRV < 2) statusR[o] = STATUS_INSUFFICIENT;
    else if (bestR * 2 <= nRV) statusR[o] = STATUS_NO_MAJORITY;
    else { statusR[o] = STATUS_ADOPT; outR[o] = (valR << 16) >> 16; }
  }
  return span;
}

/** 整盘投票（单线程，测试与回退路径用）。 */
export function voteFrames(anchorFrames, reads) {
  const out = makeVoteBuffers(anchorFrames);
  voteRange(reads, 0, anchorFrames, out);
  return out;
}

/** 统计争议与缺口（按声道帧计）。 */
export function voteStats(frames, statusL, statusR) {
  let disputes = 0;
  let gaps = 0;
  let gapL = 0;
  let gapR = 0;
  for (let i = 0; i < frames; i++) {
    const a = statusL[i];
    const b = statusR[i];
    if (a !== STATUS_ADOPT) disputes++;
    if (b !== STATUS_ADOPT) disputes++;
    if (a === STATUS_GAP) { gaps++; gapL++; }
    if (b === STATUS_GAP) { gaps++; gapR++; }
  }
  return { disputes, gaps, gapL, gapR, channelFrames: frames * 2 };
}

// ---------------------------------------------------------------------------
// 扇区摘要
// ---------------------------------------------------------------------------

/** 每 588 帧一个扇区；返回两声道各状态帧数。 */
export function summarizeSectors(frames, statusL, statusR) {
  const sectors = Math.ceil(frames / SECTOR_FRAMES);
  const countsL = new Uint16Array(sectors * 4);
  const countsR = new Uint16Array(sectors * 4);
  for (let s = 0; s < sectors; s++) {
    const start = s * SECTOR_FRAMES;
    const end = Math.min(frames, start + SECTOR_FRAMES);
    let l0 = 0, l1 = 0, l2 = 0, l3 = 0;
    let r0 = 0, r1 = 0, r2 = 0, r3 = 0;
    for (let i = start; i < end; i++) {
      const a = statusL[i];
      const b = statusR[i];
      if (a === 0) l0++; else if (a === 1) l1++; else if (a === 2) l2++; else l3++;
      if (b === 0) r0++; else if (b === 1) r1++; else if (b === 2) r2++; else r3++;
    }
    countsL.set([l0, l1, l2, l3], s * 4);
    countsR.set([r0, r1, r2, r3], s * 4);
  }
  return { sectors, countsL, countsR };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csv(rows) {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * 争议表：每个声道把连续同状态的未采用帧合并成一段。
 * 列：声道,起帧,止帧(不含),帧数,起扇区,止扇区,原因,有效票数范围,最高票数范围
 */
export function buildDisputesCsv(statusL, statusR, votesL, votesR, topL, topR) {
  const rows = [['声道', '起帧', '止帧(不含)', '帧数', '起扇区', '止扇区', '原因', '有效票数范围', '最高票数范围']];
  const chans = [
    ['左', statusL, votesL, topL],
    ['右', statusR, votesR, topR],
  ];
  for (const [name, status, votes, top] of chans) {
    const n = status.length;
    let i = 0;
    while (i < n) {
      const st = status[i];
      if (st === STATUS_ADOPT) { i++; continue; }
      let j = i + 1;
      while (j < n && status[j] === st) j++;
      let vmin = votes[i];
      let vmax = votes[i];
      let tmin = top[i];
      let tmax = top[i];
      for (let k = i + 1; k < j; k++) {
        const v = votes[k];
        const t = top[k];
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
        if (t < tmin) tmin = t;
        if (t > tmax) tmax = t;
      }
      rows.push([
        name,
        i,
        j,
        j - i,
        Math.floor(i / SECTOR_FRAMES) + 1,
        Math.floor((j - 1) / SECTOR_FRAMES) + 1,
        STATUS_REASONS[st],
        vmin === vmax ? String(vmin) : `${vmin}–${vmax}`,
        tmin === tmax ? String(tmin) : `${tmin}–${tmax}`,
      ]);
      i = j;
    }
  }
  return csv(rows);
}

/** 对齐表：每个副本每块一行。 */
export function buildAlignmentCsv(copies) {
  const rows = [[
    '读档', '块', '源起帧', '源止帧', '名义盘面起帧', '采用偏移',
    '盘面起帧', '盘面止帧', '块长度', '得分', '可比帧', '相等帧', '不等帧',
  ]];
  for (const copy of copies) {
    if (!copy.ok) {
      rows.push([copy.label, '', '', '', '', `无解（首次排不下：第 ${copy.failBlock + 1} 块）`, '', '', '', '', '', '', '']);
      continue;
    }
    for (const d of copy.details) {
      rows.push([
        copy.label, d.index, d.srcStart, d.srcEnd, d.nom, d.offset,
        d.discStart, d.discEnd, d.len, d.score, d.comparable, d.eq, d.neq,
      ]);
    }
  }
  return csv(rows);
}

// ---------------------------------------------------------------------------
// 单帧与扇区查询
// ---------------------------------------------------------------------------

export function findSegment(segments, frame) {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (frame < seg.start) hi = mid - 1;
    else if (frame >= seg.end) lo = mid + 1;
    else return seg;
  }
  return null;
}

/** 某帧每个读档的覆盖与取值（含基准，基准 segments 为恒等映射）。 */
export function frameReadRows(reads, frame) {
  return reads.map((read) => {
    const seg = findSegment(read.segments, frame);
    if (!seg) return { label: read.label, covered: false };
    const srcFrame = seg.src + (frame - seg.start);
    const key = read.keys[srcFrame];
    const vm = read.valid[srcFrame];
    return {
      label: read.label,
      covered: true,
      block: seg.block,
      offset: seg.offset,
      srcFrame,
      validL: !!(vm & 1),
      validR: !!(vm & 2),
      valueL: keyL(key),
      valueR: keyR(key),
    };
  });
}

/** 某帧每个声道的计票明细（只算有效读档，每档一票）。 */
export function frameTally(reads, frame) {
  const tally = [new Map(), new Map()];
  for (const read of reads) {
    const seg = findSegment(read.segments, frame);
    if (!seg) continue;
    const srcFrame = seg.src + (frame - seg.start);
    const key = read.keys[srcFrame];
    const vm = read.valid[srcFrame];
    if (vm & 1) {
      const v = keyL(key);
      tally[0].set(v, (tally[0].get(v) || 0) + 1);
    }
    if (vm & 2) {
      const v = keyR(key);
      tally[1].set(v, (tally[1].get(v) || 0) + 1);
    }
  }
  return tally.map((m) =>
    Array.from(m.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value - b.value));
}
