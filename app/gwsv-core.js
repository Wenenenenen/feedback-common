// gwsv-core.js — GWSV 二进制存档解析与规范化 v2 编码（无依赖，浏览器/Node 通用）
// 格式依据 samples 内说明.txt：小端；magic GWSV；version u8(1|2)；chunkCount u16；entityCount u16；
// 区块 = i16 x3 + u32 payloadLength + payload + u32 crc32(payload)；
// v1 payload = 512 个 u16；v2 payload = u16 paletteCount + palette(u16[]) + u8 bits + 位打包索引。

export const MAX_CHUNKS = 128;
export const MAX_ENTITIES = 256;
export const MAX_FILE = 8 * 1024 * 1024;
export const CELLS = 512; // 8*8*8，线性索引 = x + 8*y + 64*z

export class GWSVError extends Error {
  constructor(msg, offset = null) {
    super(msg);
    this.name = "GWSVError";
    this.offset = offset;
  }
}

// ---------- CRC32（与 zlib.crc32 一致，无符号） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- 小端 Reader ----------
class Reader {
  constructor(buf) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.o = 0;
    this.len = buf.byteLength;
  }
  need(n, what) {
    if (this.o + n > this.len) {
      throw new GWSVError(`${what} 截断: 需要 ${n} 字节 @offset ${this.o}, 文件长 ${this.len}`, this.o);
    }
  }
  u8() { this.need(1, "u8"); const v = this.dv.getUint8(this.o); this.o += 1; return v; }
  u16() { this.need(2, "u16"); const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32() { this.need(4, "u32"); const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i16() { this.need(2, "i16"); const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  take(n, what) {
    this.need(n, what);
    const v = new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.o, n);
    this.o += n;
    // 复制一份，避免调用方改动底层缓冲
    return new Uint8Array(v);
  }
}

// ---------- 位打包 ----------
export function unpackBits(packed, bits, n = CELLS) {
  const out = new Array(n);
  let acc = 0, ab = 0, pos = 0;
  const mask = (1 << bits) - 1;
  for (let i = 0; i < n; i++) {
    while (ab < bits) {
      if (pos >= packed.length) throw new GWSVError("位打包数据不足", null);
      acc |= packed[pos] << ab;
      pos++; ab += 8;
    }
    out[i] = acc & mask;
    acc >>= bits; ab -= bits;
  }
  return out;
}

export function packBits(indices, bits) {
  const out = [];
  let acc = 0, ab = 0;
  const mask = (1 << bits) - 1;
  for (const v0 of indices) {
    const v = v0 & mask;
    acc |= v << ab;
    ab += bits;
    while (ab >= 8) {
      out.push(acc & 0xff);
      acc >>= 8; ab -= 8;
    }
  }
  if (ab > 0) out.push(acc & 0xff);
  return Uint8Array.from(out);
}

// ---------- 解析 ----------
// 返回 { version, chunks:[{coord:[x,y,z], voxels:Uint16Array|null, headOffset, payloadOffset, crcOffset}],
//        entities:[{id, chunk, cell, links, offset}], errors:[{level,msg,offset}] }
// 致命结构错误抛 GWSVError；可定位的数据损坏收集进 errors（对应区块 voxels=null，不展示为正常世界）。
export function parseSave(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const errors = [];
  const r = new Reader(bytes);
  if (bytes.length < 9) throw new GWSVError("文件短于文件头(9字节)", 0);
  const magic = r.take(4, "magic");
  if (!(magic[0] === 0x47 && magic[1] === 0x57 && magic[2] === 0x53 && magic[3] === 0x56)) {
    throw new GWSVError(`magic 错误: ${bytesRepr(magic)} 应为 GWSV`, 0);
  }
  const version = r.u8();
  if (version !== 1 && version !== 2) throw new GWSVError(`version 非法: ${version} (仅支持 1/2)`, 4);
  const chunkCount = r.u16();
  const entityCount = r.u16();
  if (chunkCount > MAX_CHUNKS) throw new GWSVError(`chunkCount=${chunkCount} 超过上限 ${MAX_CHUNKS}`, 5);
  if (entityCount > MAX_ENTITIES) throw new GWSVError(`entityCount=${entityCount} 超过上限 ${MAX_ENTITIES}`, 7);
  if (bytes.length > MAX_FILE) throw new GWSVError("文件超过 8MB 上限", 0);

  const chunks = [];
  const seenCoords = new Set();
  for (let ci = 0; ci < chunkCount; ci++) {
    const head = r.o;
    const x = r.i16(), y = r.i16(), z = r.i16();
    const plen = r.u32();
    const pstart = r.o;
    r.need(plen + 4, `区块[${ci}](${x},${y},${z}) payload/CRC`);
    const payload = r.take(plen, "payload");
    const crcOffset = r.o - 4;
    const crcStored = r.u32();
    const crcCalc = crc32(payload);
    const coord = [x, y, z];
    const ckey = coord.join(",");
    if (seenCoords.has(ckey)) {
      errors.push({ level: "error", msg: `区块坐标重复 (${x},${y},${z})`, offset: head });
    }
    seenCoords.add(ckey);

    let voxels = null;
    if (crcStored !== crcCalc) {
      errors.push({
        level: "error",
        msg: `区块(${x},${y},${z}) CRC 校验失败: 存储 0x${hex32(crcStored)} ≠ 计算 0x${hex32(crcCalc)}`,
        offset: crcOffset,
      });
    } else {
      try {
        if (version === 1) {
          if (plen !== 1024) throw new GWSVError(`v1 payload 长度应为 1024, 实际 ${plen}`, pstart);
          voxels = new Uint16Array(CELLS);
          const pdv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          for (let i = 0; i < CELLS; i++) voxels[i] = pdv.getUint16(i * 2, true);
        } else {
          const pr = new Reader(payload);
          const pc = pr.u16();
          if (pc < 1 || pc > 512) throw new GWSVError(`paletteCount 非法: ${pc}`, pstart);
          const pal = new Array(pc);
          for (let k = 0; k < pc; k++) pal[k] = pr.u16();
          if (new Set(pal).size !== pal.length) throw new GWSVError("调色板方块 ID 重复", pstart);
          const bits = pr.u8();
          const expBits = Math.max(1, bitLen(pc - 1));
          if (bits !== expBits) {
            errors.push({
              level: "error",
              msg: `区块(${x},${y},${z}) bits=${bits} 与规范值 ${expBits} 不符`,
              offset: pstart + pr.o - 1,
            });
          }
          const expLen = Math.ceil((CELLS * bits) / 8);
          const packed = payload.slice(pr.o);
          if (packed.length !== expLen) {
            throw new GWSVError(`区块(${x},${y},${z}) packed 长度 ${packed.length} ≠ 规范 ${expLen}`, pstart + pr.o);
          }
          const idxs = unpackBits(packed, bits);
          const bad = [];
          for (let i = 0; i < idxs.length; i++) if (idxs[i] >= pc) bad.push(i);
          if (bad.length) {
            throw new GWSVError(
              `区块(${x},${y},${z}) 非法调色板索引 ${bad.length} 个 (≥${pc}), 首个 cell=${bad[0]} 索引值=${idxs[bad[0]]}`,
              pstart + pr.o
            );
          }
          voxels = new Uint16Array(CELLS);
          for (let i = 0; i < CELLS; i++) voxels[i] = pal[idxs[i]];
        }
      } catch (e) {
        if (e instanceof GWSVError) {
          errors.push({ level: "error", msg: e.message, offset: e.offset });
        } else throw e;
      }
    }
    chunks.push({ coord, voxels, headOffset: head, payloadOffset: pstart, crcOffset });
  }

  const entities = [];
  const seenIds = new Set();
  for (let ei = 0; ei < entityCount; ei++) {
    const eo = r.o;
    const elen = r.u32();
    r.need(elen, `实体[${ei}] JSON`);
    const raw = r.take(elen, "entity json");
    let ent;
    try {
      ent = JSON.parse(new TextDecoder("utf-8").decode(raw));
    } catch (e) {
      throw new GWSVError(`实体[${ei}] UTF-8/JSON 解析失败: ${e.message}`, eo + 4);
    }
    ent.offset = eo;
    const eid = ent.id;
    if (!Number.isInteger(eid) || eid <= 0) {
      errors.push({ level: "error", msg: `实体 id 非法: ${fmt(eid)}`, offset: eo + 4 });
    } else if (seenIds.has(eid)) {
      errors.push({ level: "error", msg: `实体 id 重复: ${eid}`, offset: eo + 4 });
    } else {
      seenIds.add(eid);
    }
    entities.push(ent);
  }
  if (r.o !== bytes.length) {
    throw new GWSVError(`尾随字节 ${bytes.length - r.o} 个 (规范不允许)`, r.o);
  }

  const coordSet = new Set(chunks.map((c) => c.coord.join(",")));
  for (const ent of entities) {
    const eid = ent.id;
    const ch = ent.chunk;
    const chOk = Array.isArray(ch) && ch.length === 3 && ch.every((v) => Number.isInteger(v));
    if (!chOk) {
      errors.push({ level: "error", msg: `实体 ${eid} chunk 字段非法: ${fmt(ch)}`, offset: ent.offset });
    } else if (!coordSet.has(ch.join(","))) {
      errors.push({ level: "error", msg: `实体 ${eid} 位于不存在的区块 (${ch.join(",")})`, offset: ent.offset });
    }
    const cell = ent.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell > 511) {
      errors.push({ level: "error", msg: `实体 ${eid} cell 越界: ${fmt(cell)}`, offset: ent.offset });
    }
    const links = ent.links;
    if (!Array.isArray(links) || !links.every((v) => Number.isInteger(v))) {
      errors.push({ level: "error", msg: `实体 ${eid} links 字段非法: ${fmt(links)}`, offset: ent.offset });
      continue;
    }
    if (new Set(links).size !== links.length) {
      errors.push({ level: "error", msg: `实体 ${eid} links 存在重复目标`, offset: ent.offset });
    }
    for (const t of links) {
      if (!seenIds.has(t)) {
        errors.push({ level: "error", msg: `实体 ${eid} 悬空链接 → 实体 ${t} (不存在)`, offset: ent.offset });
      }
    }
  }

  return { version, chunks, entities, errors };
}

// ---------- 规范化编码 ----------
export function canonicalPayload(voxels) {
  const used = [...new Set(voxels)].sort((a, b) => a - b);
  const idxOf = new Map(used.map((v, i) => [v, i]));
  const indices = new Array(voxels.length);
  for (let i = 0; i < voxels.length; i++) indices[i] = idxOf.get(voxels[i]);
  const bits = Math.max(1, bitLen(used.length - 1));
  const packed = packBits(indices, bits);
  const total = 2 + used.length * 2 + 1 + packed.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint16(o, used.length, true); o += 2;
  for (const v of used) { dv.setUint16(o, v, true); o += 2; }
  dv.setUint8(o, bits); o += 1;
  out.set(packed, o);
  return out;
}

// world: { chunks:[{coord:[x,y,z], voxels:Array|Uint16Array}], entities:[{id,chunk,cell,links}] }
export function encodeV2(world) {
  const chunks = [...world.chunks].sort((a, b) => cmpCoord(a.coord, b.coord));
  const ents = [...world.entities].sort((a, b) => a.id - b.id);
  const parts = [];
  const head = new Uint8Array(9);
  head.set([0x47, 0x57, 0x53, 0x56, 2], 0);
  new DataView(head.buffer).setUint16(5, chunks.length, true);
  new DataView(head.buffer).setUint16(7, ents.length, true);
  parts.push(head);

  for (const c of chunks) {
    const [x, y, z] = c.coord;
    const payload = canonicalPayload(c.voxels);
    const hb = new Uint8Array(10);
    const dv = new DataView(hb.buffer);
    dv.setInt16(0, x, true); dv.setInt16(2, y, true); dv.setInt16(4, z, true);
    dv.setUint32(6, payload.length, true);
    parts.push(hb, payload);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(payload), true);
    parts.push(crc);
  }
  for (const e of ents) {
    const doc = { cell: e.cell, chunk: e.chunk, id: e.id, links: e.links };
    const s = new TextEncoder().encode(canonicalJson(doc));
    const lb = new Uint8Array(4);
    new DataView(lb.buffer).setUint32(0, s.length, true);
    parts.push(lb, s);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// 实体 JSON：键按字母排序、无多余空格（与 Python json.dumps(sort_keys, separators=(',',':')) 对齐）
export function canonicalJson(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

// ---------- 语义比较 ----------
export function semanticKey(world) {
  return JSON.stringify({
    chunks: [...world.chunks]
      .sort((a, b) => cmpCoord(a.coord, b.coord))
      .map((c) => ({ coord: c.coord, voxels: Array.from(c.voxels) })),
    entities: [...world.entities]
      .map((e) => ({ cell: e.cell, chunk: e.chunk, id: e.id, links: e.links }))
      .sort((a, b) => a.id - b.id),
  });
}

// ---------- helpers ----------
function bitLen(n) { return n === 0 ? 0 : Math.floor(Math.log2(n)) + 1; }
function cmpCoord(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }
function hex32(v) { return v.toString(16).padStart(8, "0"); }
function fmt(v) { return JSON.stringify(v); }
// 模拟 Python bytes 的 repr（b'...'），用于 magic 错误消息与参考实现逐字对齐
function bytesRepr(u8) {
  let s = "b'";
  for (const byte of u8) {
    if (byte === 0x5c) s += "\\\\";
    else if (byte === 0x27) s += "\\'";
    else if (byte === 0x09) s += "\\t";
    else if (byte === 0x0a) s += "\\n";
    else if (byte === 0x0d) s += "\\r";
    else if (byte >= 0x20 && byte < 0x7f) s += String.fromCharCode(byte);
    else s += "\\x" + byte.toString(16).padStart(2, "0");
  }
  return s + "'";
}
