// 引擎：导入压缩包、建索引、调度打分/投票、生成结果与导出载荷。
// 浏览器走 Worker + SharedArrayBuffer 并行；Node 或无 SAB 环境走单线程回退，结果一致。

import { openZip, parseWavHeader, packWavInto, encodeWav } from './codec.js';
import * as Core from './core.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------------------
// 共享内存分配（优先 SAB，退化为普通 buffer）
// ---------------------------------------------------------------------------

function allocBytes(bytes) {
  const useSab = typeof SharedArrayBuffer === 'function';
  return useSab ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
}

function allocU32(n) { return new Uint32Array(allocBytes(n * 4)); }
function allocU8(n) { return new Uint8Array(allocBytes(n)); }

// ---------------------------------------------------------------------------
// 执行器：Worker 池 / 单线程内联
// ---------------------------------------------------------------------------

class InlineExecutor {
  constructor() { this.mode = '单线程'; }

  async scoreTasks(tasks) {
    const out = [];
    for (const t of tasks) out.push(scoreOne(t));
    return out;
  }

  async voteTasks(tasks) {
    for (const t of tasks) Core.voteRange(t.reads, t.start, t.end, t.out);
  }

  dispose() {}
}

function scoreOne(t) {
  const tables = [];
  for (let b = t.blockStart; b < t.blockEnd; b++) {
    tables.push(Core.scoreBlock(
      t.anchorKeys, t.anchorValid, 0,
      t.copyKeys, t.copyValid, 0,
      t.blocks[b], t.anchorFrames, t.copyFrames,
    ));
  }
  return { copyIndex: t.copyIndex, blockStart: t.blockStart, tables };
}

class WorkerExecutor {
  constructor(size) {
    this.mode = `${size} 线程`;
    this.size = size;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    this.seq = 0;
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => this.onMessage(ev.data);
      w.onerror = (ev) => this.onError(ev);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  onError(ev) {
    const err = new Error('Worker 出错：' + (ev.message || '未知错误'));
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  onMessage(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    this.idle.push(p.worker);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg);
    this.pump();
  }

  call(worker, payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject, worker });
      worker.postMessage({ id, ...payload });
    });
  }

  pump() {
    while (this.idle.length && this.queue.length) {
      const { payload, resolve, reject } = this.queue.shift();
      const worker = this.idle.pop();
      const id = this.nextId++;
      this.pending.set(id, {
        worker,
        resolve: (msg) => { resolve(msg); },
        reject,
      });
      worker.postMessage({ id, ...payload });
    }
  }

  async runAll(payloads) {
    const promises = payloads.map((payload) => new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
    }));
    this.pump();
    return Promise.all(promises);
  }

  async scoreTasks(tasks) {
    // 每个任务单独跑；返回顺序与输入一致
    const messages = await this.runAll(tasks.map((t) => ({
      type: 'score',
      copyIndex: t.copyIndex,
      blockStart: t.blockStart,
      blockEnd: t.blockEnd,
      anchorKeys: t.anchorKeys,
      anchorValid: t.anchorValid,
      copyKeys: t.copyKeys,
      copyValid: t.copyValid,
      blocks: t.blocks,
      anchorFrames: t.anchorFrames,
      copyFrames: t.copyFrames,
    })));
    return messages.map((msg) => {
      const tables = [];
      const ints = new Int32Array(msg.tables);
      const stride = 2 * Core.OFFSET_COUNT;
      for (let b = 0, o = 0; b < msg.blockCount; b++, o += stride) {
        tables.push({
          eq: ints.slice(o, o + Core.OFFSET_COUNT),
          neq: ints.slice(o + Core.OFFSET_COUNT, o + stride),
        });
      }
      return { copyIndex: msg.copyIndex, blockStart: msg.blockStart, tables };
    });
  }

  async voteTasks(tasks) {
    await this.runAll(tasks.map((t) => ({
      type: 'vote',
      reads: t.reads,
      start: t.start,
      end: t.end,
      out: t.out,
    })));
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.queue = [];
  }
}

function makeExecutor(parallel, workers) {
  if (!parallel) return new InlineExecutor();
  if (typeof Worker === 'undefined') return new InlineExecutor();
  if (typeof SharedArrayBuffer !== 'function') return new InlineExecutor();
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  const size = Math.max(1, Math.min(workers || 4, hc));
  if (size < 2) return new InlineExecutor();
  return new WorkerExecutor(size);
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

export class Engine {
  constructor() {
    this.project = null;      // {anchor, copies}
    this.anchorKeys = null;
    this.anchorValid = null;
    this.copyKeys = [];       // Uint32Array[]
    this.copyValid = [];      // Uint8Array[]
    this.aligned = null;      // {ok, copies:[{ok, offsets, details, segments}], failed}
    this.vote = null;         // makeVoteBuffers 结果
    this.sector = null;
    this.timings = null;
    this.wavBytes = null;
    this.alignedAt = -1;      // 失配标记：坏区改动后置空
    this.executor = null;
    this.parallel = true;
    this.workerCount = 4;
  }

  /** 从 ZIP 字节载入；不做任何对齐计算。 */
  static async load(bytes, options = {}) {
    const engine = new Engine();
    engine.parallel = options.parallel !== false;
    engine.workerCount = options.workers || 4;
    await engine.importZip(bytes);
    return engine;
  }

  async importZip(bytes) {
    const t0 = now();
    const zip = await openZip(bytes);
    let discName = zip.has('disc.json') ? 'disc.json' : zip.findBasename('disc.json');
    if (!discName) throw new Core.ValidationError('压缩包里没有 disc.json');
    const discText = new TextDecoder('utf-8').decode(await zip.extract(discName));
    let meta;
    try {
      meta = JSON.parse(discText);
    } catch {
      throw new Core.ValidationError('disc.json 不是合法 JSON');
    }
    if (!meta || typeof meta !== 'object' || !meta.anchor) {
      throw new Core.ValidationError('disc.json 缺少 anchor');
    }
    const copiesMeta = Array.isArray(meta.copies) ? meta.copies : null;
    if (!copiesMeta) throw new Core.ValidationError('disc.json 的 copies 必须是数组');
    if (copiesMeta.length > Core.MAX_COPIES) {
      throw new Core.ValidationError(`副本数 ${copiesMeta.length} 超过上限 ${Core.MAX_COPIES}`);
    }

    const fileNames = [meta.anchor.file, ...copiesMeta.map((c) => c && c.file)];
    const entryOf = new Map();
    const wavInfo = new Map();
    for (const fn of fileNames) {
      if (typeof fn !== 'string' || !fn) throw new Core.ValidationError('disc.json 里有缺失的文件名');
      if (entryOf.has(fn)) continue;
      const entry = zip.has(fn) ? fn : zip.findBasename(fn);
      if (!entry) throw new Core.ValidationError(`压缩包里没有读档文件：${fn}`);
      entryOf.set(fn, entry);
    }

    // 逐文件解压、校验头、打包键；坏区稍后统一刷新
    const packed = new Map();
    for (const [fn, entry] of entryOf) {
      const wav = await zip.extract(entry);
      let header;
      try {
        header = parseWavHeader(wav);
      } catch (err) {
        throw new Core.ValidationError(`${fn}：${err.message}`);
      }
      if (header.frames <= 0) throw new Core.ValidationError(`${fn} 没有采样帧`);
      if (header.frames > Core.MAX_FRAMES) {
        throw new Core.ValidationError(`${fn} 长 ${header.frames} 帧，超过 90 秒上限 ${Core.MAX_FRAMES}`);
      }
      const keys = allocU32(header.frames);
      const valid = allocU8(header.frames);
      packWavInto(wav, header, keys, valid, [], []);
      wavInfo.set(fn, { frames: header.frames });
      packed.set(fn, { keys, valid });
    }

    const project = Core.normalizeDisc(meta, wavInfo);
    this.project = project;
    this.anchorKeys = packed.get(project.anchor.file).keys;
    this.anchorValid = packed.get(project.anchor.file).valid;
    this.copyKeys = project.copies.map((c) => packed.get(c.file).keys);
    this.copyValid = project.copies.map((c) => packed.get(c.file).valid);
    this.applyBad();
    this.loadMs = now() - t0;
    this.discName = discName;
    this.anchorFile = project.anchor.file;
    return this;
  }

  /** 按 project.bad 重建所有有效位图（基准与副本）。 */
  applyBad() {
    const a = this.project.anchor;
    Core.refillValidMask(this.anchorValid, a.bad[0], a.bad[1]);
    for (let c = 0; c < this.project.copies.length; c++) {
      const copy = this.project.copies[c];
      Core.refillValidMask(this.copyValid[c], copy.bad[0], copy.bad[1]);
    }
    this.alignedAt += 1; // 使已算结果失效
    this.aligned = null;
    this.vote = null;
    this.sector = null;
    this.wavBytes = null;
  }

  setBad(readIndex, channel, spans) {
    // readIndex 0 = 基准，1.. = 副本
    const frames = readIndex === 0 ? this.project.anchor.frames : this.project.copies[readIndex - 1].frames;
    const where = `${this.readLabel(readIndex)}${channel === 0 ? '左' : '右'}声道坏区`;
    const normalized = Core.normalizeSpans(spans, frames, where);
    if (readIndex === 0) this.project.anchor.bad[channel] = normalized;
    else this.project.copies[readIndex - 1].bad[channel] = normalized;
    this.applyBad();
    return normalized;
  }

  readLabel(readIndex) {
    if (readIndex === 0) return '基准';
    return `副本 #${readIndex}`;
  }

  readFile(readIndex) {
    if (readIndex === 0) return this.project.anchor.file;
    return this.project.copies[readIndex - 1].file;
  }

  /** 页面/导出用的读档列表（含基准）。 */
  reads() {
    return [
      { index: 0, label: '基准', file: this.project.anchor.file, frames: this.project.anchor.frames, isAnchor: true },
      ...this.project.copies.map((c, i) => ({
        index: i + 1, label: `副本 #${i + 1}`, file: c.file, frames: c.frames, isAnchor: false,
      })),
    ];
  }

  /** 对齐 + 投票全流程。 */
  async compute(options = {}) {
    if (!this.project) throw new Error('尚未导入项目');
    const total0 = now();
    if (!this.executor) {
      this.executor = makeExecutor(this.parallel && options.parallel !== false, this.workerCount);
    }
    const tScore0 = now();

    const anchor = {
      keys: this.anchorKeys,
      valid: this.anchorValid,
      frames: this.project.anchor.frames,
    };
    const copies = this.project.copies;
    const tasks = [];
    const CHUNK = 48;
    for (let c = 0; c < copies.length; c++) {
      const blocks = copies[c].blocks;
      for (let b = 0; b < blocks.length; b += CHUNK) {
        tasks.push({
          copyIndex: c,
          blockStart: b,
          blockEnd: Math.min(blocks.length, b + CHUNK),
          anchorKeys: anchor.keys,
          anchorValid: anchor.valid,
          copyKeys: this.copyKeys[c],
          copyValid: this.copyValid[c],
          blocks,
          anchorFrames: anchor.frames,
          copyFrames: copies[c].frames,
        });
      }
    }
    const scored = await this.executor.scoreTasks(tasks);
    const tablesPerCopy = copies.map(() => []);
    for (const item of scored) {
      const arr = tablesPerCopy[item.copyIndex];
      for (let i = 0; i < item.tables.length; i++) arr[item.blockStart + i] = item.tables[i];
    }
    const tDp0 = now();

    let failed = null;
    const copiesResult = [];
    for (let c = 0; c < copies.length; c++) {
      const copy = copies[c];
      const solved = Core.solveCopy(tablesPerCopy[c], copy.blocks);
      if (!solved.ok) {
        failed = { copyIndex: c, blockIndex: solved.blockIndex };
        copiesResult.push({
          ok: false,
          label: `副本 #${c + 1}`,
          file: copy.file,
          failBlock: solved.blockIndex,
          blocks: copy.blocks,
        });
        continue;
      }
      const details = Core.detailsOf(copy.blocks, tablesPerCopy[c], solved.offsets);
      copiesResult.push({
        ok: true,
        label: `副本 #${c + 1}`,
        file: copy.file,
        offsets: solved.offsets,
        total: solved.total,
        absSum: solved.absSum,
        details,
        segments: Core.segmentsOf(details),
      });
    }
    const dpMs = now() - tDp0;
    const scoreMs = tDp0 - tScore0;

    if (failed) {
      this.aligned = { ok: false, failed, copies: copiesResult };
      this.vote = null;
      this.sector = null;
      this.wavBytes = null;
      this.timings = { score: scoreMs, dp: dpMs, vote: 0, total: now() - total0 };
      return this.resultView();
    }

    // 投票：把每份副本的有效片段裁到 [0, anchorFrames)
    const frames = anchor.frames;
    const voteReads = [];
    for (let c = 0; c < copiesResult.length; c++) {
      const res = copiesResult[c];
      const segments = [];
      for (const seg of res.segments) {
        const start = Math.max(0, seg.start);
        const end = Math.min(frames, seg.end);
        if (end <= start) continue;
        segments.push({
          start,
          end,
          src: seg.src + (start - seg.start),
          block: seg.block,
          offset: seg.offset,
        });
      }
      voteReads.push({
        frames: copies[c].frames,
        keys: this.copyKeys[c],
        valid: this.copyValid[c],
        segments,
      });
    }

    const voteOut = Core.makeVoteBuffers(frames);
    const tVote0 = now();
    const wc = this.executor instanceof InlineExecutor ? 1 : Math.min(8, this.executor.size);
    const vt = [];
    for (let i = 0; i < wc; i++) {
      const start = Math.floor((frames * i) / wc);
      const end = Math.floor((frames * (i + 1)) / wc);
      vt.push({ reads: voteReads, start, end, out: Core.voteSlice(voteOut, start, end) });
    }
    await this.executor.voteTasks(vt);
    const voteMs = now() - tVote0;

    this.vote = voteOut;
    this.aligned = { ok: true, copies: copiesResult };
    this.sector = Core.summarizeSectors(frames, voteOut.statusL, voteOut.statusR);
    this.stats = Core.voteStats(frames, voteOut.statusL, voteOut.statusR);
    this.wavBytes = encodeWav(voteOut.outL, voteOut.outR, Core.SAMPLE_RATE);
    this.timings = { score: scoreMs, dp: dpMs, vote: voteMs, total: now() - total0 };
    return this.resultView();
  }

  /** 供页面读取的概要，避免把大数组当结构化数据反复复制。 */
  resultView() {
    if (!this.aligned) return { ok: false, empty: true };
    if (!this.aligned.ok) {
      const f = this.aligned.failed;
      return {
        ok: false,
        reason: 'nosolution',
        copyIndex: f.copyIndex,
        copyLabel: `副本 #${f.copyIndex + 1}`,
        copyFile: this.project.copies[f.copyIndex].file,
        blockIndex: f.blockIndex,
        block: this.project.copies[f.copyIndex].blocks[f.blockIndex],
        copies: this.aligned.copies,
        timings: this.timings,
      };
    }
    return {
      ok: true,
      frames: this.project.anchor.frames,
      copies: this.aligned.copies,
      stats: this.stats,
      sector: this.sector,
      timings: this.timings,
      votes: this.vote,
    };
  }

  /** 帧视图数据（单帧）。 */
  frameAt(frame) {
    const all = this.allReadsWithSegments();
    // 计票只算副本（基准不投票）；基准仍在 reads 里供对照
    const voters = all.filter((r) => r.index > 0);
    return {
      reads: Core.frameReadRows(all, frame),
      tally: Core.frameTally(voters, frame),
      left: {
        status: this.vote ? this.vote.statusL[frame] : Core.STATUS_GAP,
        votes: this.vote ? this.vote.votesL[frame] : 0,
        top: this.vote ? this.vote.topL[frame] : 0,
        out: this.vote ? this.vote.outL[frame] : 0,
      },
      right: {
        status: this.vote ? this.vote.statusR[frame] : Core.STATUS_GAP,
        votes: this.vote ? this.vote.votesR[frame] : 0,
        top: this.vote ? this.vote.topR[frame] : 0,
        out: this.vote ? this.vote.outR[frame] : 0,
      },
    };
  }

  allReadsWithSegments() {
    const out = [];
    const a = this.project.anchor;
    out.push({
      label: '基准',
      index: 0,
      file: a.file,
      frames: a.frames,
      keys: this.anchorKeys,
      valid: this.anchorValid,
      segments: [{ start: 0, end: a.frames, src: 0, block: 0, offset: 0 }],
    });
    if (this.aligned && this.aligned.ok) {
      for (let c = 0; c < this.aligned.copies.length; c++) {
        const res = this.aligned.copies[c];
        out.push({
          label: res.label,
          index: c + 1,
          file: res.file,
          frames: this.project.copies[c].frames,
          keys: this.copyKeys[c],
          valid: this.copyValid[c],
          segments: res.segments,
        });
      }
    } else {
      for (let c = 0; c < this.project.copies.length; c++) {
        out.push({
          label: `副本 #${c + 1}`,
          index: c + 1,
          file: this.project.copies[c].file,
          frames: this.project.copies[c].frames,
          keys: this.copyKeys[c],
          valid: this.copyValid[c],
          segments: [],
        });
      }
    }
    return out;
  }

  exportWav() {
    return this.wavBytes;
  }

  exportDisputesCsv() {
    if (!this.vote) return null;
    const v = this.vote;
    return Core.buildDisputesCsv(v.statusL, v.statusR, v.votesL, v.votesR, v.topL, v.topR);
  }

  exportAlignmentCsv() {
    if (!this.aligned || !this.aligned.ok) return null;
    return Core.buildAlignmentCsv(this.aligned.copies.map((c) => ({
      ok: c.ok,
      label: `${c.label}（${c.file}）`,
      details: c.details,
      failBlock: c.failBlock,
    })));
  }

  dispose() {
    if (this.executor) this.executor.dispose();
    this.executor = null;
  }
}
