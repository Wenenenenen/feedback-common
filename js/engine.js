// engine.js — 观战快照分片通道的确定性模拟引擎（无依赖，浏览器 / Node 通用）
//
// 线格式（与 samples/spectator-channel.json 的 wire 描述一致）：
//   片头 12 字节小端：tick:u32 base:u32 index:u16 total:u16
//   载荷：至多 256 字节的连续记录
//   尾部 4 字节：CRC32/IEEE（小端），覆盖片头与载荷的全部字节
//   记录：tag=0 删除  9B  (tag:u8 id:u32 gen:u32)
//         tag=1 新增/更新 17B (tag:u8 id:u32 gen:u32 x:i32 y:i32)
//   记录按 id 升序，同 id 删除在前；全量只允许 tag=1；空记录也发一片。

export const VERSION = 1;
export const HEADER_SIZE = 12;
export const CRC_SIZE = 4;
export const MAX_PAYLOAD = 256;
export const KEEP_SNAPSHOTS = 8;
export const BASE_LATENCY = 1;
export const PACKET_ARCHIVE = 600;
export const RECORD_DEL_SIZE = 9;
export const RECORD_UPD_SIZE = 17;

/* ---------------- SoA 快照（并行类型化数组，按 id 升序） ---------------- */
// 快照热路径每 tick 每席都要拷贝，类型化数组比对象数组省一个数量级的 GC。

export function makeSnapshot(n) {
  return { ids: new Int32Array(n), gens: new Int32Array(n), xs: new Int32Array(n), ys: new Int32Array(n) };
}
export function cloneSnapshot(s) {
  return { ids: s.ids.slice(), gens: s.gens.slice(), xs: s.xs.slice(), ys: s.ys.slice() };
}
export function snapshotToObjects(s) {
  const out = new Array(s.ids.length);
  for (let i = 0; i < s.ids.length; i++) out[i] = { id: s.ids[i], gen: s.gens[i], x: s.xs[i], y: s.ys[i] };
  return out;
}
// 把对象型实体列表转成按 id 升序的 SoA 快照
export function objectsToSnapshot(list) {
  const sorted = list.slice().sort((a, b) => a.id - b.id);
  const s = makeSnapshot(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    s.ids[i] = sorted[i].id; s.gens[i] = sorted[i].gen;
    s.xs[i] = sorted[i].x; s.ys[i] = sorted[i].y;
  }
  return s;
}
// 在有序 id 数组里二分查找，未命中返回 -1
function binFind(ids, id) {
  let lo = 0, hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid] === id) return mid;
    if (ids[mid] < id) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

// 双指针有序归并：从基线快照生成增量记录（换代先删老代再插新代）
export function diffSnapshots(oldS, newS) {
  const records = [];
  let i = 0, j = 0;
  const a = oldS, b = newS;
  while (i < a.ids.length && j < b.ids.length) {
    const oid = a.ids[i], nid = b.ids[j];
    if (oid < nid) {
      records.push({ tag: 0, id: oid, gen: a.gens[i] });
      i++;
    } else if (oid > nid) {
      records.push({ tag: 1, id: b.ids[j], gen: b.gens[j], x: b.xs[j], y: b.ys[j] });
      j++;
    } else {
      if (a.gens[i] !== b.gens[j]) {
        records.push({ tag: 0, id: oid, gen: a.gens[i] }); // 先删，且匹配老代
        records.push({ tag: 1, id: nid, gen: b.gens[j], x: b.xs[j], y: b.ys[j] });
      } else if (a.xs[i] !== b.xs[j] || a.ys[i] !== b.ys[j]) {
        records.push({ tag: 1, id: nid, gen: b.gens[j], x: b.xs[j], y: b.ys[j] });
      }
      i++; j++;
    }
  }
  while (i < a.ids.length) { records.push({ tag: 0, id: a.ids[i], gen: a.gens[i] }); i++; }
  while (j < b.ids.length) { records.push({ tag: 1, id: b.ids[j], gen: b.gens[j], x: b.xs[j], y: b.ys[j] }); j++; }
  sortRecords(records);
  return records;
}

// 把增量记录应用到基线快照（拷贝后再改）；返回新快照，或 { error } 表示整帧作废
export function applyDelta(baseS, records) {
  const n = baseS.ids.length;
  const alive = new Uint8Array(n).fill(1);
  const gens = baseS.gens.slice();
  const xs = baseS.xs.slice();
  const ys = baseS.ys.slice();
  const adds = [];

  // 第一遍：校验 + 修改。记录已按 id 升序、同 id 删除在前。
  for (const r of records) {
    const idx = binFind(baseS.ids, r.id);
    if (r.tag === 0) {
      if (idx < 0 || !alive[idx] || baseS.gens[idx] !== r.gen) return { error: 'delete-gen-mismatch' };
      alive[idx] = 0;
    } else if (idx >= 0) {
      if (alive[idx]) {
        if (baseS.gens[idx] !== r.gen) return { error: 'update-without-delete' };
        xs[idx] = r.x; ys[idx] = r.y;
      } else {
        // 同 id 先删后插（换代）：重新占用该槽位
        gens[idx] = r.gen; xs[idx] = r.x; ys[idx] = r.y;
        alive[idx] = 1;
      }
    } else {
      adds.push(r); // 基线中不存在的全新 id
    }
  }
  // 第二遍：紧凑存活实体（保持 id 升序）+ 追加新实体（records 已按 id 升序，adds 亦有序）
  let keep = 0;
  for (let k = 0; k < n; k++) if (alive[k]) keep++;
  const out = makeSnapshot(keep + adds.length);
  let p = 0;
  for (let k = 0; k < n; k++) {
    if (!alive[k]) continue;
    out.ids[p] = baseS.ids[k]; out.gens[p] = gens[k];
    out.xs[p] = xs[k]; out.ys[p] = ys[k];
    p++;
  }
  const keptEnd = p;
  // 归并存活段 [0,keptEnd) 与新增段 adds（各自 id 升序）
  const merged = makeSnapshot(out.ids.length);
  let ai = 0, bi = 0, mi = 0;
  while (ai < keptEnd && bi < adds.length) {
    if (out.ids[ai] < adds[bi].id) {
      merged.ids[mi] = out.ids[ai]; merged.gens[mi] = out.gens[ai];
      merged.xs[mi] = out.xs[ai]; merged.ys[mi] = out.ys[ai]; ai++;
    } else {
      merged.ids[mi] = adds[bi].id; merged.gens[mi] = adds[bi].gen;
      merged.xs[mi] = adds[bi].x; merged.ys[mi] = adds[bi].y; bi++;
    }
    mi++;
  }
  while (ai < keptEnd) {
    merged.ids[mi] = out.ids[ai]; merged.gens[mi] = out.gens[ai];
    merged.xs[mi] = out.xs[ai]; merged.ys[mi] = out.ys[ai]; ai++; mi++;
  }
  while (bi < adds.length) {
    merged.ids[mi] = adds[bi].id; merged.gens[mi] = adds[bi].gen;
    merged.xs[mi] = adds[bi].x; merged.ys[mi] = adds[bi].y; bi++; mi++;
  }
  return merged;
}


// 事件 / 提交理由代码（UI 与测试共用同一套词汇）
export const EVT = Object.freeze({
  SEND_FULL: 'send-full',
  SEND_DELTA: 'send-delta',
  DROP: 'drop',
  CORRUPT: 'corrupt',
  DUPLICATE: 'duplicate',
  DELAY: 'delay',
  ACK_DELAYED: 'ack-delayed',
  ACK_SENT: 'ack-sent',
  ACK_RECV: 'ack-recv',
  PARSE_FAIL: 'parse-fail',
  STALE_DROP: 'stale-drop',
  DEDUP: 'dedup',
  SHARD_CONFLICT: 'shard-conflict',
  BASELINE_MISSING: 'baseline-missing',
  RESYNC_SENT: 'resync-sent',
  ASSEMBLED_WAITING: 'assembled-waiting',
  COMMIT_FULL: 'commit-full',
  COMMIT_DELTA: 'commit-delta',
  COMMIT_FULL_RESYNC: 'commit-full-resync',
  ACTION_NO_MATCH: 'action-no-match',
});

/* ---------------- CRC32/IEEE ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- 确定性随机源（MT19937） ---------------- */

export class Rng {
  constructor(seed) {
    this.mt = new Uint32Array(624);
    this.idx = 624;
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      this.mt[i] = (1812433253 * (this.mt[i - 1] ^ (this.mt[i - 1] >>> 30)) + i) >>> 0;
    }
  }
  next() {
    if (this.idx >= 624) {
      for (let i = 0; i < 624; i++) {
        const y = ((this.mt[i] & 0x80000000) | (this.mt[(i + 1) % 624] & 0x7fffffff)) >>> 0;
        this.mt[i] = this.mt[(i + 397) % 624] ^ (y >>> 1);
        if (y & 1) this.mt[i] = (this.mt[i] ^ 0x9908b0df) >>> 0;
      }
      this.idx = 0;
    }
    let y = this.mt[this.idx++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
  // [0, n) 的整数
  below(n) { return this.next() % n; }
  chance(p) { return this.next() / 4294967296 < p; }
  save() { return { mt: Array.from(this.mt), idx: this.idx }; }
  static restore(s) {
    const r = Object.create(Rng.prototype);
    r.mt = Uint32Array.from(s.mt);
    r.idx = s.idx;
    return r;
  }
}

/* ---------------- 线格式编解码 ---------------- */

function writeRecord(view, offset, rec) {
  view.setUint8(offset, rec.tag);
  view.setUint32(offset + 1, rec.id >>> 0, true);
  view.setUint32(offset + 5, rec.gen >>> 0, true);
  if (rec.tag === 1) {
    view.setInt32(offset + 9, rec.x | 0, true);
    view.setInt32(offset + 13, rec.y | 0, true);
  }
}

// 记录排序：id 升序，同 id 删除(tag=0)在前
export function sortRecords(records) {
  records.sort((a, b) => (a.id - b.id) || (a.tag - b.tag));
}

function payloadLength(records) {
  let n = 0;
  for (const r of records) n += r.tag === 0 ? RECORD_DEL_SIZE : RECORD_UPD_SIZE;
  return n;
}

// 把记录切成 ≤256B 的载荷并加上片头与 CRC，返回 Uint8Array 分片数组
export function encodePackets(tick, base, records) {
  sortRecords(records);
  const chunks = [];
  let off = 0;
  if (records.length === 0) {
    chunks.push(new Uint8Array(0));
  } else {
    let cur = [];
    let curLen = 0;
    for (const r of records) {
      const size = r.tag === 0 ? RECORD_DEL_SIZE : RECORD_UPD_SIZE;
      if (curLen + size > MAX_PAYLOAD && cur.length) {
        chunks.push({ recs: cur, len: curLen });
        cur = [];
        curLen = 0;
      }
      cur.push(r);
      curLen += size;
    }
    if (cur.length) chunks.push({ recs: cur, len: curLen });
  }
  const total = chunks.length;
  return chunks.map((chunk, index) => {
    const payload = chunk instanceof Uint8Array ? chunk : (() => {
      const p = new Uint8Array(chunk.len);
      const v = new DataView(p.buffer);
      let o = 0;
      for (const r of chunk.recs) { writeRecord(v, o, r); o += r.tag === 0 ? RECORD_DEL_SIZE : RECORD_UPD_SIZE; }
      return p;
    })();
    const pkt = new Uint8Array(HEADER_SIZE + payload.length + CRC_SIZE);
    const hv = new DataView(pkt.buffer);
    hv.setUint32(0, tick >>> 0, true);
    hv.setUint32(4, base >>> 0, true);
    hv.setUint16(8, index, true);
    hv.setUint16(10, total, true);
    pkt.set(payload, HEADER_SIZE);
    hv.setUint32(HEADER_SIZE + payload.length, crc32(pkt, 0, HEADER_SIZE + payload.length), true);
    return pkt;
  });
}

// 严格解析；失败返回 { ok:false, reason }，成功返回头信息与记录
export function parsePacket(bytes) {
  if (bytes.length < HEADER_SIZE + CRC_SIZE) return { ok: false, reason: 'too-short' };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tick = v.getUint32(0, true);
  const base = v.getUint32(4, true);
  const index = v.getUint16(8, true);
  const total = v.getUint16(10, true);
  if (total === 0 || index >= total) return { ok: false, reason: 'bad-header' };
  const payloadEnd = bytes.length - CRC_SIZE;
  if (payloadEnd - HEADER_SIZE > MAX_PAYLOAD) return { ok: false, reason: 'payload-oversize' };
  const wantCrc = v.getUint32(payloadEnd, true);
  if (crc32(bytes, 0, payloadEnd) !== wantCrc) return { ok: false, reason: 'crc' };
  const records = [];
  let off = HEADER_SIZE;
  const seenIds = new Set();
  while (off < payloadEnd) {
    const tag = bytes[off];
    if (tag !== 0 && tag !== 1) return { ok: false, reason: 'bad-tag' };
    const size = tag === 0 ? RECORD_DEL_SIZE : RECORD_UPD_SIZE;
    if (off + size > payloadEnd) return { ok: false, reason: 'truncated-record' };
    const rec = { tag, id: v.getUint32(off + 1, true), gen: v.getUint32(off + 5, true) };
    if (tag === 1) { rec.x = v.getInt32(off + 9, true); rec.y = v.getInt32(off + 13, true); }
    if (base === 0) {
      if (tag !== 1) return { ok: false, reason: 'full-has-delete' };
      if (seenIds.has(rec.id)) return { ok: false, reason: 'full-duplicate-id' };
      seenIds.add(rec.id);
    }
    records.push(rec);
    off += size;
  }
  return { ok: true, tick, base, index, total, records };
}

/* ---------------- 世界源帧 ---------------- */

// 生成型世界：固定容量实体池，每帧死亡数==出生数（始终 2048 个实体），
// id 复用时 gen+1；每个实体带席位可见位掩码（seenBy 不进入协议）。
export class GeneratedWorld {
  constructor({ seats = 2, capacity = 2048, totalTicks = 20000, seed = 20261124 } = {}) {
    this.kind = 'generated';
    this.seats = seats;
    this.capacity = capacity;
    this.totalTicks = totalTicks;
    this.seed = seed;
    this.tick = 0;
    this.rng = new Rng(seed);
    this.ids = new Int32Array(capacity);
    this.gens = new Int32Array(capacity);
    this.xs = new Int32Array(capacity);
    this.ys = new Int32Array(capacity);
    this.mask = new Uint8Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.ids[i] = i + 1;
      this.gens[i] = 1;
      this.xs[i] = this.rng.below(1000);
      this.ys[i] = this.rng.below(1000);
      // 保证每个席至少能看到实体：低 seats 个实体各占一个席
      this.mask[i] = i < seats ? (1 << i) : 1 + this.rng.below(1 << seats);
    }
    this._frame = null;
  }

  advance() {
    this.tick++;
    // 持久 Rng（状态随检查点保存/恢复，序列确定）；整数阈值代替浮点 chance
    const r = this.rng;
    const cap = this.capacity;
    const MOVE = Math.floor(4294967296 * 0.08);   // ~8%
    const VIS = Math.floor(4294967296 * 0.002);   // ~0.2%
    const HALF = 2147483648;
    for (let i = 0; i < cap; i++) {
      if (r.next() < MOVE) {
        const dir = r.next() < HALF ? 1 : -1;
        this.xs[i] = (this.xs[i] + dir * (1 + r.below(6)) + 1000) % 1000;
      }
      if (r.next() < MOVE) {
        const dir = r.next() < HALF ? 1 : -1;
        this.ys[i] = (this.ys[i] + dir * (1 + r.below(6)) + 1000) % 1000;
      }
      if (r.next() < VIS) {
        const bit = 1 << r.below(this.seats);
        this.mask[i] = r.next() < HALF
          ? (this.mask[i] | bit) & ((1 << this.seats) - 1)
          : (this.mask[i] & ~bit) || 1;
      }
    }
    // 换代：约 1% 实体死亡并在同槽位以 gen+1 重生（id 复用、不同代数）
    const churn = Math.max(1, Math.floor(cap * 0.01));
    for (let n = 0; n < churn; n++) {
      const i = r.below(cap);
      this.gens[i]++;
      this.xs[i] = r.below(1000);
      this.ys[i] = r.below(1000);
      this.mask[i] = 1 + r.below(1 << this.seats);
    }
    this._frame = null;
  }

  // 完整世界源帧（按 id 升序）
  frame() {
    if (this._frame) return this._frame;
    const out = [];
    for (let i = 0; i < this.capacity; i++) {
      const seenBy = [];
      for (let s = 0; s < this.seats; s++) if (this.mask[i] & (1 << s)) seenBy.push(s + 1);
      out.push({ id: this.ids[i], gen: this.gens[i], x: this.xs[i], y: this.ys[i], seenBy });
    }
    out.sort((a, b) => a.id - b.id);
    this._frame = out;
    return out;
  }

  // 某席的可见投影（发端先筛可见实体，seenBy 不进入协议）；直接产出 SoA
  projection(seat) {
    const bit = 1 << (seat - 1);
    let count = 0;
    for (let i = 0; i < this.capacity; i++) if (this.mask[i] & bit) count++;
    const s = makeSnapshot(count);
    let p = 0;
    // ids 本就是 1..capacity 升序，投影天然有序
    for (let i = 0; i < this.capacity; i++) {
      if (this.mask[i] & bit) {
        s.ids[p] = this.ids[i]; s.gens[p] = this.gens[i];
        s.xs[p] = this.xs[i]; s.ys[p] = this.ys[i];
        p++;
      }
    }
    return s;
  }

  checkpoint() {
    return {
      kind: this.kind, tick: this.tick, rng: this.rng.save(),
      ids: this.ids.slice(), gens: this.gens.slice(), xs: this.xs.slice(),
      ys: this.ys.slice(), mask: this.mask.slice(),
    };
  }
  static restore(cp, params) {
    const w = Object.create(GeneratedWorld.prototype);
    Object.assign(w, params);
    w.tick = cp.tick;
    w.rng = Rng.restore(cp.rng);
    w.ids = cp.ids; w.gens = cp.gens; w.xs = cp.xs; w.ys = cp.ys; w.mask = cp.mask;
    w._frame = null;
    return w;
  }
}

// 脚本型世界（导入样例 / 自定义帧）
export class ScriptedWorld {
  constructor(frames, seats) {
    this.kind = 'scripted';
    this.frames = frames;
    this.seats = seats;
    this.totalTicks = frames.length;
    this.capacity = Math.max(...frames.map(f => f.entities.length), 1);
    this.tick = 0;
  }
  advance() { this.tick++; }
  frame() { return this.frames[this.tick - 1].entities; }
  projection(seat) {
    return objectsToSnapshot(this.frame().filter(e => e.seenBy.includes(seat)));
  }
  checkpoint() { return { kind: this.kind, tick: this.tick }; }
  static restore(cp, params) {
    const w = Object.create(ScriptedWorld.prototype);
    Object.assign(w, params);
    w.tick = cp.tick;
    return w;
  }
}

/* ---------------- 发端（每席一个） ---------------- */

export class SeatSender {
  constructor(seat) {
    this.seat = seat;
    this.ring = []; // 最近 KEEP_SNAPSHOTS 份已发完整投影
    this.lastAcked = 0;
    this.resyncPending = false;
  }
  requestResync() { this.resyncPending = true; }
  onAck(tick) { if (tick > this.lastAcked) this.lastAcked = tick; }

  // 返回 { base, packets, records, kind }，并把本次完整投影（SoA）压入保留环
  send(tick, projection) {
    const snapshot = cloneSnapshot(projection);
    let base = 0;
    let records;
    let kind;
    const baseSnap = this.lastAcked > 0 && !this.resyncPending
      ? this.ring.find(s => s.tick === this.lastAcked) : null;
    if (this.resyncPending || !baseSnap) {
      // 全量：只允许 tag=1
      base = 0;
      records = new Array(snapshot.ids.length);
      for (let i = 0; i < snapshot.ids.length; i++) {
        records[i] = { tag: 1, id: snapshot.ids[i], gen: snapshot.gens[i], x: snapshot.xs[i], y: snapshot.ys[i] };
      }
      kind = EVT.SEND_FULL;
      this.resyncPending = false;
    } else {
      // 增量：必须从指定基线拷贝再改；换代先删老代再插新代
      base = baseSnap.tick;
      records = diffSnapshots(baseSnap.snapshot, snapshot);
      kind = EVT.SEND_DELTA;
    }
    const packets = encodePackets(tick, base, records);
    this.ring.push({ tick, snapshot });
    if (this.ring.length > KEEP_SNAPSHOTS) this.ring.shift();
    return { base, packets, records, kind };
  }
}

/* ---------------- 收端（每席一个） ---------------- */

export class SeatReceiver {
  constructor(seat) {
    this.seat = seat;
    this.ring = []; // 只保留已提交快照，最近 8 份
    this.lastCommitted = 0;
    this.pending = new Map(); // tick -> 组装槽
    this.resyncRequested = false;   // 恢复未完成期间持续保留
    this._resyncReported = false;   // 请求是否已通过可靠通道上报发端
    this._resyncActive = false; // 本次全量恢复是否由 resync 触发
  }

  // 触发全量恢复：重新打开上报通道（每个新请求只上报一次）
  _requestResync() {
    this.resyncRequested = true;
    this._resyncReported = false;
  }

  // 处理一个到达的分片；返回事件数组（可能级联提交多帧）
  incoming(packet) {
    const events = [];
    const parsed = parsePacket(packet);
    if (!parsed.ok) {
      events.push({ code: EVT.PARSE_FAIL, detail: parsed.reason });
      return events;
    }
    const { tick, base, index, total, records } = parsed;
    if (tick <= this.lastCommitted) {
      events.push({ code: EVT.STALE_DROP, tick, index });
      return events;
    }
    let slot = this.pending.get(tick);
    if (slot && slot.voided) {
      if (base === 0) {
        // 全量恢复帧接管该 tick：丢弃坏槽，重建为全量槽
        this.pending.delete(tick);
        slot = null;
        events.push({ code: EVT.SHARD_CONFLICT, tick, detail: 'recovery-replaces-voided' });
      } else {
        events.push({ code: EVT.SHARD_CONFLICT, tick, detail: 'frame-already-voided' });
        return events;
      }
    }
    if (!slot) {
      slot = { tick, base, total, shards: new Map(), parsed: new Map(), voided: false, abandoned: false, reason: null, assembled: false };
      this.pending.set(tick, slot);
    }
    if (slot.abandoned && base === 0) {
      // 缺基线的增量槽被随后的全量恢复帧接管
      this.pending.delete(tick);
      slot = { tick, base, total, shards: new Map(), parsed: new Map(), voided: false, abandoned: false, reason: null, assembled: false };
      this.pending.set(tick, slot);
    }
    if (slot.base !== base) {
      // 同 tick 不同基线：协议层面的内容冲突，整帧作废
      slot.voided = true;
      slot.reason = 'base-mismatch';
      this._requestResync();
      events.push({ code: EVT.SHARD_CONFLICT, tick, detail: slot.reason });
      return events;
    }
    if (slot.shards.has(index)) {
      const prev = slot.shards.get(index);
      if (bytesEqual(prev, packet)) {
        events.push({ code: EVT.DEDUP, tick, index });
      } else {
        // 内容冲突的同号片：该帧作废，并请求全量恢复
        slot.voided = true;
        slot.reason = 'conflicting-shard-' + index;
        this._requestResync();
        events.push({ code: EVT.SHARD_CONFLICT, tick, index });
      }
      return events;
    }
    slot.shards.set(index, packet);
    slot.parsed.set(index, records);
    if (slot.shards.size === slot.total && !slot.assembled) {
      slot.assembled = true;
      this._tryAssemble(slot, events);
      // 全量帧就绪即尝试跨越缺口；增量帧只在按序时进入级联
      if (slot.readySnapshot && (slot.base === 0 || tick === this.lastCommitted + 1)) {
        this._commitCascade(events);
      }
    }
    this._prune();
    return events;
  }

  _tryAssemble(slot, events) {
    const { tick, base } = slot;
    // 按 index 顺序拼合全部分片的记录
    const records = [];
    for (let i = 0; i < slot.total; i++) {
      const part = slot.parsed.get(i);
      if (!part) { slot.abandoned = true; return; }
      records.push(...part);
    }
    if (base === 0) {
      // 全量：parser 保证全 tag1 且 id 唯一，记录经 encode 已按 id 升序，直接按序填充
      const s = makeSnapshot(records.length);
      for (let i = 0; i < records.length; i++) {
        s.ids[i] = records[i].id; s.gens[i] = records[i].gen;
        s.xs[i] = records[i].x; s.ys[i] = records[i].y;
      }
      slot.readySnapshot = s;
      // 只要收端仍挂着未完成的恢复请求，到达的全量帧就是恢复帧
      slot.isRecovery = this.resyncRequested || this._resyncActive;
      if (tick !== this.lastCommitted + 1) {
        events.push({ code: EVT.ASSEMBLED_WAITING, tick, expect: this.lastCommitted + 1, full: true });
      }
      return;
    }
    const baseSnap = this.ring.find(s => s.tick === base);
    if (!baseSnap) {
      // 缺增量基线：请求全量恢复，本帧放弃（绝不显示半帧）
      slot.abandoned = true;
      this._requestResync();
      events.push({ code: EVT.BASELINE_MISSING, tick, base });
      return;
    }
    // 从基线拷贝再改（SoA，双路径校验代数规则）
    const result = applyDelta(baseSnap.snapshot, records);
    if (result.error) {
      slot.voided = true;
      slot.reason = result.error;
      events.push({ code: EVT.SHARD_CONFLICT, tick, detail: result.error });
      return;
    }
    slot.readySnapshot = result;
  }

  _commitCascade(events) {
    let next = this.lastCommitted + 1;
    // 有界推进，避免极端缺口下的长循环
    for (let guard = 0; guard < this.pending.size + 1; guard++) {
      const slot = this.pending.get(next);
      if (!slot) {
        // 缺口：找最近一个已就绪的全量帧，用它跨过缺口建立新基线
        const jump = Array.from(this.pending.keys())
          .filter(t => t > next)
          .sort((a, b) => a - b)
          .find(t => {
            const s = this.pending.get(t);
            return s && !s.voided && !s.abandoned && s.readySnapshot && s.base === 0;
          });
        if (jump === undefined) break;
        for (const t of Array.from(this.pending.keys())) if (t < jump) this.pending.delete(t);
        next = jump;
        continue;
      }
      if (slot.voided || slot.abandoned) {
        this.pending.delete(next);
        next++;
        continue;
      }
      if (!slot.readySnapshot) break; // 未收齐，停止等待
      if (slot.base === 0) {
        // 全量帧：无条件新基线，丢弃此前所有缺口帧
        for (const t of Array.from(this.pending.keys())) if (t < next) this.pending.delete(t);
      }
      this.ring.push({ tick: next, snapshot: slot.readySnapshot });
      if (this.ring.length > KEEP_SNAPSHOTS) this.ring.shift();
      this.lastCommitted = next;
      this.pending.delete(next);
      events.push({
        code: slot.base === 0
          ? (slot.isRecovery ? EVT.COMMIT_FULL_RESYNC : EVT.COMMIT_FULL)
          : EVT.COMMIT_DELTA,
        tick: next, base: slot.base, count: slot.readySnapshot.length,
      });
      if (slot.base === 0) {
        this._resyncActive = false;
        this._resyncReported = false;
        this.resyncRequested = false;
      }
      next++;
    }
  }

  // 收端每 tick 调用：把 resync 请求取走（可靠送达发端）；
  // resyncRequested 保留到恢复全量帧真正提交，防止请求被消费后恢复语义丢失
  consumeResync() {
    if (this.resyncRequested && !this._resyncReported) {
      this._resyncReported = true;
      this._resyncActive = true;
      return true;
    }
    return false;
  }

  _prune() {
    for (const tick of this.pending.keys()) if (tick <= this.lastCommitted) this.pending.delete(tick);
  }

  committedSnapshot(tick) {
    const s = this.ring.find(x => x.tick === tick);
    return s ? s.snapshot : null;
  }
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ---------------- 网络安排 ---------------- */
// 动作（at = 调度处理的 tick，同 at 按数组顺序处理）：
//   drop      {at,seat,tick,index?}
//   corrupt   {at,seat,tick,index?,offset?,times?}
//   duplicate {at,seat,tick,index?,at2?}            at2 缺省=当 tick 再投一次
//   delay     {at,seat,tick,index?,to}              to = 新的绝对投递 tick
//   ack-delay {at,seat,ticks,count?}                 接下来 count 个 ack 延后 ticks
export const ACTION_TYPES = ['drop', 'corrupt', 'duplicate', 'delay', 'ack-delay'];

export function validateAction(a) {
  if (!ACTION_TYPES.includes(a.type)) return `未知动作类型 ${a.type}`;
  if (!Number.isInteger(a.at) || a.at < 1) return 'at 必须是正整数';
  if (!Number.isInteger(a.seat) || a.seat < 1) return 'seat 必须是正整数';
  if (a.type === 'ack-delay') {
    if (!Number.isInteger(a.ticks) || a.ticks < 1) return 'ticks 必须 ≥1';
    if (a.count !== undefined && (!Number.isInteger(a.count) || a.count < 1)) return 'count 必须 ≥1';
    return null;
  }
  if (!Number.isInteger(a.tick) || a.tick < 1) return 'tick 必须是正整数';
  if (a.index !== undefined && (!Number.isInteger(a.index) || a.index < 0)) return 'index 必须是非负整数';
  if (a.type === 'delay' && (!Number.isInteger(a.to) || a.to <= a.at)) return 'delay 的 to 必须晚于 at';
  if (a.type === 'corrupt' && a.offset !== undefined && (!Number.isInteger(a.offset) || a.offset < 0))
    return 'offset 必须是非负整数';
  return null;
}

/* ---------------- 模拟器 ---------------- */

const CP_EVERY = 500;
const EVENT_CAP = 6000;

// 每帧每席的统计列
const ST = Object.freeze({
  SENT: 0, DELIVERED: 1, DROPPED: 2, CORRUPT: 3, DUPLICATE: 4,
  DELAYED: 5, COMMITTED: 6, BASE: 7, COLS: 8,
});
export { ST };

export class Simulator {
  constructor(opts = {}) {
    this.params = {
      seats: opts.seats ?? 2,
      capacity: opts.capacity ?? 2048,
      totalTicks: opts.totalTicks ?? 20000,
      seed: opts.seed ?? 20261124,
    };
    this.schedule = (opts.schedule ?? []).map(a => ({ ...a }));
    for (const a of this.schedule) {
      const err = validateAction(a);
      if (err) throw new Error(`网络安排非法（${JSON.stringify(a)}）：${err}`);
    }
    this.schedule.sort((a, b) => a.at - b.at);
    this.customFrames = opts.customFrames ?? null;
    this._reset();
  }

  _reset() {
    const p = this.params;
    this.world = this.customFrames
      ? new ScriptedWorld(this.customFrames, p.seats)
      : new GeneratedWorld(p);
    this.senders = [];
    this.receivers = [];
    for (let s = 1; s <= p.seats; s++) {
      this.senders.push(new SeatSender(s));
      this.receivers.push(new SeatReceiver(s));
    }
    // 每席的在途帧：frameTick -> { base, packets:[{bytes, deliverAt, extra:[]}] }
    this.inFlight = this.params.seats === 2 ? [new Map(), new Map()] : Array.from({ length: p.seats }, () => new Map());
    this.controls = Array.from({ length: p.seats }, () => []); // 可靠控制消息 {deliverAt,kind,value}
    this.ackHolds = Array.from({ length: p.seats }, () => []); // 剩余延后天数队列
    this.actionCursor = 0;
    this._lastEmittedCommit = new Array(p.seats).fill(0);
    this.tick = 0;
    this.events = [];
    const T = this.world.totalTicks;
    this.stats = Array.from({ length: p.seats }, () =>
      Array.from({ length: ST.COLS }, () => new Int32Array(T)));
    // 描述符：[seat][tick-1] = { base,total,records,statuses:Uint8Array, committed, voided, reason }
    this.descriptors = Array.from({ length: p.seats }, () => new Array(T).fill(null));
    // 分片字节有界归档：[seat] -> Map(frameTick -> packets[])，供 UI 回看，超出窗口淘汰
    this.packetArchive = Array.from({ length: p.seats }, () => new Map());
    this.checkpoints = [];
    this._saveCheckpoint(); // tick 0
  }

  _emit(seat, code, tick, detail = {}) {
    this.events.push({ tick: this.tick, seat, code, ...detail });
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP);
  }

  step() {
    this.tick++;
    const t = this.tick;
    this.world.advance();

    for (let si = 0; si < this.params.seats; si++) {
      const seat = si + 1;
      // 1) 可靠控制消息到期（ack / resync），先于本 tick 发送，发端据此选基线
      const ctl = this.controls[si];
      for (let i = ctl.length - 1; i >= 0; i--) {
        if (ctl[i].deliverAt === t) {
          const m = ctl.splice(i, 1)[0];
          if (m.kind === 'ack') {
            this.senders[si].onAck(m.value);
            this._emit(seat, EVT.ACK_RECV, t, { ackTick: m.value });
          } else {
            this.senders[si].requestResync();
            this._emit(seat, EVT.RESYNC_SENT, t, {});
          }
        }
      }

      // 2) 先交付本 tick 到期的在途分片（动作已在前序 tick 作用于这些包）
      for (const [frameTick, fr] of Array.from(this.inFlight[si].entries())) {
        fr.packets.forEach((pkt, index) => {
          if (pkt.deliverAt === t) this._deliver(seat, si, frameTick, index, pkt.bytes, descOf(this, si, frameTick), false);
          for (const ex of pkt.extra) {
            if (ex === t) this._deliver(seat, si, frameTick, index, pkt.bytes, descOf(this, si, frameTick), true);
          }
        });
      }

      // 3) 收端产生的 resync 请求可靠上行
      const rc = this.receivers[si];
      if (rc.consumeResync()) {
        this.controls[si].push({ deliverAt: t + BASE_LATENCY, kind: 'resync' });
      }

      // 4) 发端：先筛可见实体，再决定全量 / 增量，分片发出（下一 tick 才交付）
      const projection = this.world.projection(seat);
      const sent = this.senders[si].send(t, projection);
      this._emit(seat, sent.kind, t, { base: sent.base, shards: sent.packets.length, records: sent.records.length });
      const frame = {
        base: sent.base,
        packets: sent.packets.map(bytes => ({ bytes, deliverAt: t + BASE_LATENCY, extra: [] })),
      };
      this.inFlight[si].set(t, frame);
      const desc = {
        base: sent.base, total: sent.packets.length, records: sent.records.length,
        statuses: new Uint8Array(sent.packets.length), committed: 0, voided: false, reason: '',
        deliverAts: sent.packets.map(() => t + BASE_LATENCY),
      };
      this.descriptors[si][t - 1] = desc;
      this.stats[si][ST.SENT][t - 1] = sent.packets.length;

      // 5) 本 tick 的安排动作（数组顺序，同 tick 动作作用于刚发出的帧与 ack）
      this._applyActions(seat, si, t, desc);

      // 6) 清理已 fully delivered 的在途帧；清理前把最终字节（含损坏/延迟/副本）归档
      for (const [frameTick, fr] of Array.from(this.inFlight[si].entries())) {
        this._archivePackets(si, frameTick, fr);
        const open = fr.packets.some(p => p.deliverAt > t || p.extra.some(x => x > t));
        if (!open) this.inFlight[si].delete(frameTick);
      }

      // 7) 提交后发 ack（可被 ack-delay 安排延后）
      const committedTick = rc.lastCommitted;
      if (this._lastEmittedCommit[si] !== committedTick) {
        const hold = this.ackHolds[si].length ? this.ackHolds[si][0] : 0;
        if (hold > 0) {
          this.ackHolds[si].shift();
          this.controls[si].push({ deliverAt: t + BASE_LATENCY + hold, kind: 'ack', value: committedTick });
          this._emit(seat, EVT.ACK_DELAYED, t, { ackTick: committedTick, hold });
        } else {
          this.controls[si].push({ deliverAt: t + BASE_LATENCY, kind: 'ack', value: committedTick });
          this._emit(seat, EVT.ACK_SENT, t, { ackTick: committedTick });
        }
        this._lastEmittedCommit[si] = committedTick;
      }
      if (committedTick > 0) {
        const d = this.descriptors[si][committedTick - 1];
        if (d) d.committed = 1;
        this.stats[si][ST.COMMITTED][committedTick - 1] = 1;
        this.stats[si][ST.BASE][committedTick - 1] = d ? d.base : 0;
      }
    }

    if (this.tick % CP_EVERY === 0 && this.tick < this.world.totalTicks) this._saveCheckpoint();
  }

  _archivePackets(si, frameTick, frame) {
    const arch = this.packetArchive[si];
    arch.set(frameTick, frame.packets.map(p => ({
      bytes: p.bytes.slice(), deliverAt: p.deliverAt, extra: p.extra.slice(),
    })));
    // 有界：每席保留最近 PACKET_ARCHIVE 帧的原始分片
    const cap = PACKET_ARCHIVE;
    if (arch.size > cap) {
      const over = arch.size - cap;
      let n = 0;
      for (const key of arch.keys()) { if (n++ >= over) break; arch.delete(key); }
    }
  }

  // UI 取某帧分片（优先在途，其次归档）
  archivedPackets(si, frameTick) {
    const live = this.inFlight[si].get(frameTick);
    if (live) return live.packets;
    return this.packetArchive[si].get(frameTick) || null;
  }

  _deliver(seat, si, frameTick, index, bytes, desc, isDuplicate) {
    if (isDuplicate && desc) desc.statuses[index] |= 16;
    if (desc) desc.statuses[index] |= 1;
    this.stats[si][ST.DELIVERED][this.tick - 1]++;
    const evs = this.receivers[si].incoming(bytes);
    for (const e of evs) {
      this._emit(seat, e.code, e.tick ?? frameTick, { ...e, frameTick, shard: index });
      if (e.code === EVT.SHARD_CONFLICT && desc) { desc.voided = true; desc.reason = e.detail || 'conflict'; }
    }
  }

  _applyActions(seat, si, t, desc) {
    const actions = this.schedule;
    while (this.actionCursor < actions.length && actions[this.actionCursor].at < t) this.actionCursor++;
    // cursor 是全局的，但动作按席处理；先收集本 tick 全部动作再按席过滤
    for (let i = this.actionCursor; i < actions.length && actions[i].at === t; i++) {
      const a = actions[i];
      if (a.seat !== seat) continue;
      if (a.type === 'ack-delay') {
        const count = a.count ?? 1;
        for (let k = 0; k < count; k++) this.ackHolds[si].push(a.ticks);
        this._emit(seat, EVT.ACK_DELAYED, t, { hold: a.ticks, count });
        continue;
      }
      const fr = this.inFlight[si].get(a.tick);
      if (!fr) { this._emit(seat, EVT.ACTION_NO_MATCH, t, { action: a.type, target: a.tick }); continue; }
      const idxs = a.index === undefined ? fr.packets.map((_, i) => i) : [a.index];
      for (const index of idxs) {
        const pkt = fr.packets[index];
        if (!pkt) { this._emit(seat, EVT.ACTION_NO_MATCH, t, { action: a.type, target: a.tick, index }); continue; }
        const d = this.descriptors[si][a.tick - 1];
        if (a.type === 'drop') {
          pkt.deliverAt = -1;
          pkt.extra = [];
          if (d) d.statuses[index] |= 2;
          this.stats[si][ST.DROPPED][t - 1]++;
          this._emit(seat, EVT.DROP, t, { frameTick: a.tick, index });
        } else if (a.type === 'corrupt') {
          const times = a.times ?? 1;
          const off = a.offset ?? (pkt.bytes.length > HEADER_SIZE + CRC_SIZE ? HEADER_SIZE : 8);
          for (let k = 0; k < times; k++) {
            const o = Math.min(off + k, pkt.bytes.length - 1);
            pkt.bytes[o] ^= 0xff;
          }
          if (d) d.statuses[index] |= 4;
          this.stats[si][ST.CORRUPT][t - 1]++;
          this._emit(seat, EVT.CORRUPT, t, { frameTick: a.tick, index, offset: off, times });
        } else if (a.type === 'duplicate') {
          pkt.extra.push(a.at2 ?? t);
          if (d) d.statuses[index] |= 8;
          this.stats[si][ST.DUPLICATE][t - 1]++;
          this._emit(seat, EVT.DUPLICATE, t, { frameTick: a.tick, index, at2: a.at2 ?? t });
        } else if (a.type === 'delay') {
          const old = pkt.deliverAt;
          pkt.deliverAt = a.to;
          if (d) d.statuses[index] |= 32;
          this.stats[si][ST.DELAYED][t - 1]++;
          this._emit(seat, EVT.DELAY, t, { frameTick: a.tick, index, from: old, to: a.to });
        }
      }
    }
    // 本 tick 动作跨席：cursor 在最后一席处理完后推进
    if (si === this.params.seats - 1) {
      while (this.actionCursor < actions.length && actions[this.actionCursor].at === t) this.actionCursor++;
    }
  }

  _saveCheckpoint() {
    this.checkpoints.push({
      tick: this.tick,
      world: this.world.checkpoint(),
      senders: this.senders.map(s => ({
        seat: s.seat, lastAcked: s.lastAcked, resyncPending: s.resyncPending,
        ring: s.ring.map(x => ({ tick: x.tick, snapshot: cloneSnapshot(x.snapshot) })),
      })),
      receivers: this.receivers.map(r => ({
        seat: r.seat, lastCommitted: r.lastCommitted,
        resyncRequested: r.resyncRequested, resyncActive: r._resyncActive,
        resyncReported: r._resyncReported,
        ring: r.ring.map(x => ({ tick: x.tick, snapshot: cloneSnapshot(x.snapshot) })),
        pending: Array.from(r.pending.values()).map(slot => ({
          tick: slot.tick, base: slot.base, total: slot.total, voided: slot.voided,
          abandoned: slot.abandoned,
          reason: slot.reason, assembled: slot.assembled,
          shards: Array.from(slot.shards.entries()).map(([i, b]) => [i, b.slice()]),
          ready: slot.readySnapshot ? cloneSnapshot(slot.readySnapshot) : null,
          isRecovery: slot.isRecovery || false,
        })),
      })),
      inFlight: this.inFlight.map(m => Array.from(m.entries()).map(([ft, fr]) => [ft, {
        base: fr.base,
        packets: fr.packets.map(p => ({ bytes: p.bytes.slice(), deliverAt: p.deliverAt, extra: p.extra.slice() })),
      }])),
      controls: this.controls.map(q => q.map(m => ({ ...m }))),
      ackHolds: this.ackHolds.map(q => q.slice()),
      actionCursor: this.actionCursor,
      lastEmittedCommit: this._lastEmittedCommit ? this._lastEmittedCommit.slice() : [0, 0],
      eventsLen: this.events.length,
    });
  }

  _restoreCheckpoint(cp) {
    const p = this.params;
    this.tick = cp.tick;
    this.world = this.customFrames
      ? ScriptedWorld.restore(cp.world, { frames: this.customFrames, seats: p.seats, totalTicks: this.customFrames.length, capacity: Math.max(...this.customFrames.map(f => f.entities.length), 1) })
      : GeneratedWorld.restore(cp.world, { kind: 'generated', seats: p.seats, capacity: p.capacity, totalTicks: p.totalTicks, seed: p.seed });
    this.senders = cp.senders.map(c => {
      const s = new SeatSender(c.seat);
      s.lastAcked = c.lastAcked; s.resyncPending = c.resyncPending; s.ring = c.ring;
      return s;
    });
    this.receivers = cp.receivers.map(c => {
      const r = new SeatReceiver(c.seat);
      r.lastCommitted = c.lastCommitted;
      r.resyncRequested = c.resyncRequested;
      r._resyncActive = c.resyncActive;
      r._resyncReported = c.resyncReported || false;
      r.ring = c.ring;
      r.pending = new Map(c.pending.map(slot => {
        const parsed = new Map();
        for (const [i, b] of slot.shards) {
          const p = parsePacket(b);
          if (p.ok) parsed.set(i, p.records);
        }
        return [slot.tick, {
          tick: slot.tick, base: slot.base, total: slot.total, voided: slot.voided,
          abandoned: slot.abandoned,
          reason: slot.reason, assembled: slot.assembled,
          shards: new Map(slot.shards.map(([i, b]) => [i, b])),
          parsed,
          readySnapshot: slot.ready,
          isRecovery: slot.isRecovery || false,
        }];
      }));
      return r;
    });
    this.inFlight = cp.inFlight.map(m => new Map(m.map(([ft, fr]) => [ft, {
      base: fr.base,
      packets: fr.packets.map(p => ({ bytes: p.bytes, deliverAt: p.deliverAt, extra: p.extra })),
    }])));
    this.controls = cp.controls.map(q => q.map(m => ({ ...m })));
    this.ackHolds = cp.ackHolds.map(q => q.slice());
    this.actionCursor = cp.actionCursor;
    this._lastEmittedCommit = cp.lastEmittedCommit.slice();
    this.events = this.events.filter(e => e.tick <= cp.tick).slice(-EVENT_CAP);
    for (let si = 0; si < p.seats; si++)
      for (let c = 0; c < ST.COLS; c++) this.stats[si][c].fill(0, cp.tick);
    for (let si = 0; si < p.seats; si++) this.descriptors[si].fill(null, cp.tick);
  }

  // 跳到指定 tick（从最近检查点确定性重放）
  seek(tick) {
    const target = Math.max(0, Math.min(tick, this.world.totalTicks));
    let cp = this.checkpoints[0];
    for (const c of this.checkpoints) if (c.tick <= target) cp = c;
    this._restoreCheckpoint(cp);
    while (this.tick < target) this.step();
  }

  runToEnd(onProgress) {
    const T = this.world.totalTicks;
    while (this.tick < T) {
      this.step();
      if (onProgress && this.tick % 500 === 0) onProgress(this.tick, T);
    }
    return this.commitHash();
  }

  // 提交序列指纹：按 (tick, 席顺序) 的已提交帧及其基线
  commitHash() {
    const p = this.params;
    let h = 0x811c9dc5;
    for (let t = 1; t <= this.world.totalTicks; t++) {
      for (let si = 0; si < p.seats; si++) {
        const d = this.descriptors[si][t - 1];
        if (d && d.committed) {
          const str = `${si + 1}:${t}:${d.base}|`;
          for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        }
      }
    }
    return h.toString(16).padStart(8, '0');
  }

  // 导出网络安排（含场景参数，重导可完整复现）
  exportSchedule() {
    return {
      format: 'spectator-snapshot-channel',
      version: VERSION,
      baseLatency: BASE_LATENCY,
      scenario: this.customFrames
        ? { kind: 'scripted', seats: this.params.seats, frames: this.customFrames }
        : { kind: 'generated', ...this.params },
      network: this.schedule.map(a => ({ ...a })),
    };
  }
}

function descOf(sim, si, frameTick) {
  return sim.descriptors[si][frameTick - 1] || null;
}
