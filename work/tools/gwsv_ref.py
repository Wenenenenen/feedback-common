#!/usr/bin/env python3
"""Reference GWSV parser + canonical v2 encoder (oracle for the JS port). Run: python3 -I"""
import json, zlib, struct, os, sys

class GWSVError(Exception):
    def __init__(self, msg, offset=None):
        super().__init__(msg)
        self.msg = msg
        self.offset = offset

class Reader:
    def __init__(self, b):
        self.b = b
        self.o = 0

    def need(self, n, what):
        if self.o + n > len(self.b):
            raise GWSVError(f"{what} 截断: 需要 {n} 字节 @offset {self.o}, 文件长 {len(self.b)}", self.o)

    def u8(self):
        self.need(1, "u8")
        v = self.b[self.o]
        self.o += 1
        return v

    def u16(self):
        self.need(2, "u16")
        v = struct.unpack_from("<H", self.b, self.o)[0]
        self.o += 2
        return v

    def u32(self):
        self.need(4, "u32")
        v = struct.unpack_from("<I", self.b, self.o)[0]
        self.o += 4
        return v

    def i16(self):
        self.need(2, "i16")
        v = struct.unpack_from("<h", self.b, self.o)[0]
        self.o += 2
        return v

    def take(self, n, what):
        self.need(n, what)
        v = self.b[self.o:self.o + n]
        self.o += n
        return v

def unpack_bits(packed, bits, n=512):
    out = [0] * n
    acc = 0
    ab = 0
    pos = 0
    mask = (1 << bits) - 1
    for i in range(n):
        while ab < bits:
            if pos >= len(packed):
                raise GWSVError("位打包数据不足", None)
            acc |= packed[pos] << ab
            pos += 1
            ab += 8
        out[i] = acc & mask
        acc >>= bits
        ab -= bits
    return out

def pack_bits(indices, bits):
    out = bytearray()
    acc = 0
    ab = 0
    mask = (1 << bits) - 1
    for v in indices:
        acc |= (v & mask) << ab
        ab += bits
        while ab >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            ab -= 8
    if ab:
        out.append(acc & 0xFF)
    return bytes(out)

def parse_save(b):
    """Returns (world, errors). Fatal structural error raises GWSVError."""
    errors = []
    r = Reader(b)
    if len(b) < 9:
        raise GWSVError("文件短于文件头(9字节)", 0)
    magic = r.take(4, "magic")
    if magic != b"GWSV":
        raise GWSVError(f"magic 错误: {magic!r}, 应为 GWSV", 0)
    version = r.u8()
    if version not in (1, 2):
        raise GWSVError(f"version 非法: {version} (仅支持 1/2)", 4)
    chunk_count = r.u16()
    entity_count = r.u16()
    if chunk_count > 128:
        raise GWSVError(f"chunkCount={chunk_count} 超过上限 128", 5)
    if entity_count > 256:
        raise GWSVError(f"entityCount={entity_count} 超过上限 256", 7)
    if len(b) > 8 * 1024 * 1024:
        raise GWSVError("文件超过 8MB 上限", 0)

    chunks = []
    seen_coords = set()
    for ci in range(chunk_count):
        head = r.o
        x = r.i16()
        y = r.i16()
        z = r.i16()
        plen = r.u32()
        pstart = r.o
        r.need(plen + 4, f"区块[{ci}]({x},{y},{z}) payload/CRC")
        payload = r.take(plen, "payload")
        crc_off = r.o - 4
        crc_stored = r.u32()
        crc_calc = zlib.crc32(payload) & 0xFFFFFFFF
        coord = (x, y, z)
        if coord in seen_coords:
            errors.append({"level": "error", "msg": f"区块坐标重复 {coord}", "offset": head})
        seen_coords.add(coord)
        voxels = None
        if crc_stored != crc_calc:
            errors.append({"level": "error",
                           "msg": f"区块({x},{y},{z}) CRC 校验失败: 存储 {crc_stored:#010x} ≠ 计算 {crc_calc:#010x}",
                           "offset": crc_off})
        else:
            try:
                if version == 1:
                    if plen != 1024:
                        raise GWSVError(f"v1 payload 长度应为 1024, 实际 {plen}", pstart)
                    voxels = list(struct.unpack_from("<512H", payload, 0))
                else:
                    pr = Reader(payload)
                    pc = pr.u16()
                    if not (1 <= pc <= 512):
                        raise GWSVError(f"paletteCount 非法: {pc}", pstart)
                    pal = []
                    for _ in range(pc):
                        pal.append(pr.u16())
                    if len(set(pal)) != len(pal):
                        raise GWSVError("调色板方块 ID 重复", pstart)
                    bits = pr.u8()
                    exp_bits = max(1, (pc - 1).bit_length())
                    if bits != exp_bits:
                        errors.append({"level": "error",
                                       "msg": f"区块({x},{y},{z}) bits={bits} 与规范值 {exp_bits} 不符",
                                       "offset": pstart + pr.o - 1})
                    exp_len = (512 * bits + 7) // 8
                    packed = payload[pr.o:]
                    if len(packed) != exp_len:
                        raise GWSVError(f"区块({x},{y},{z}) packed 长度 {len(packed)} ≠ 规范 {exp_len}", pstart + pr.o)
                    idxs = unpack_bits(packed, bits)
                    bad = [i for i, v in enumerate(idxs) if v >= pc]
                    if bad:
                        raise GWSVError(
                            f"区块({x},{y},{z}) 非法调色板索引 {len(bad)} 个 (≥{pc}), 首个 cell={bad[0]} 索引值={idxs[bad[0]]}",
                            pstart + pr.o)
                    voxels = [pal[i] for i in idxs]
            except GWSVError as e:
                errors.append({"level": "error", "msg": e.msg, "offset": e.offset})
        chunks.append({"coord": list(coord), "voxels": voxels,
                       "headOffset": head, "payloadOffset": pstart, "crcOffset": crc_off})

    entities = []
    seen_ids = set()
    for ei in range(entity_count):
        eo = r.o
        elen = r.u32()
        r.need(elen, f"实体[{ei}] JSON")
        raw = r.take(elen, "entity json")
        try:
            ent = json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise GWSVError(f"实体[{ei}] UTF-8/JSON 解析失败: {e}", eo + 4)
        ent["_offset"] = eo
        eid = ent.get("id")
        if not isinstance(eid, int) or isinstance(eid, bool) or eid <= 0:
            errors.append({"level": "error", "msg": f"实体 id 非法: {eid!r}", "offset": eo + 4})
        elif eid in seen_ids:
            errors.append({"level": "error", "msg": f"实体 id 重复: {eid}", "offset": eo + 4})
        else:
            seen_ids.add(eid)
        entities.append(ent)

    if r.o != len(b):
        raise GWSVError(f"尾随字节 {len(b) - r.o} 个 (规范不允许)", r.o)

    coord_set = set(tuple(c["coord"]) for c in chunks)
    for ent in entities:
        eid = ent.get("id")
        ch = ent.get("chunk")
        if not (isinstance(ch, list) and len(ch) == 3 and all(isinstance(v, int) and not isinstance(v, bool) for v in ch)):
            errors.append({"level": "error", "msg": f"实体 {eid} chunk 字段非法: {ch!r}", "offset": ent["_offset"]})
        elif tuple(ch) not in coord_set:
            errors.append({"level": "error", "msg": f"实体 {eid} 位于不存在的区块 {tuple(ch)}", "offset": ent["_offset"]})
        cell = ent.get("cell")
        if not (isinstance(cell, int) and not isinstance(cell, bool) and 0 <= cell <= 511):
            errors.append({"level": "error", "msg": f"实体 {eid} cell 越界: {cell!r}", "offset": ent["_offset"]})
        links = ent.get("links")
        if not isinstance(links, list) or not all(isinstance(v, int) and not isinstance(v, bool) for v in links):
            errors.append({"level": "error", "msg": f"实体 {eid} links 字段非法: {links!r}", "offset": ent["_offset"]})
            continue
        if len(links) != len(set(links)):
            errors.append({"level": "error", "msg": f"实体 {eid} links 存在重复目标", "offset": ent["_offset"]})
        for t in links:
            if t not in seen_ids:
                errors.append({"level": "error", "msg": f"实体 {eid} 悬空链接 → 实体 {t} (不存在)", "offset": ent["_offset"]})

    return {"version": version, "chunks": chunks, "entities": entities}, errors

def canonical_payload(voxels):
    used = sorted(set(voxels))
    idx_of = {v: i for i, v in enumerate(used)}
    indices = [idx_of[v] for v in voxels]
    bits = max(1, (len(used) - 1).bit_length())
    packed = pack_bits(indices, bits)
    assert len(packed) == (512 * bits + 7) // 8
    out = bytearray()
    out += struct.pack("<H", len(used))
    for v in used:
        out += struct.pack("<H", v)
    out.append(bits)
    out += packed
    return bytes(out)

def encode_v2(world):
    chunks = sorted(world["chunks"], key=lambda c: tuple(c["coord"]))
    ents = sorted(world["entities"], key=lambda e: e["id"])
    out = bytearray(b"GWSV")
    out.append(2)
    out += struct.pack("<HH", len(chunks), len(ents))
    for c in chunks:
        x, y, z = c["coord"]
        payload = canonical_payload(c["voxels"])
        out += struct.pack("<hhhI", x, y, z, len(payload))
        out += payload
        out += struct.pack("<I", zlib.crc32(payload) & 0xFFFFFFFF)
    for e in ents:
        doc = {"cell": e["cell"], "chunk": list(e["chunk"]), "id": e["id"], "links": list(e["links"])}
        s = json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        out += struct.pack("<I", len(s))
        out += s
    return bytes(out)

def semantic_key(world):
    return {
        "chunks": [{"coord": c["coord"], "voxels": c["voxels"]}
                   for c in sorted(world["chunks"], key=lambda c: tuple(c["coord"]))],
        "entities": sorted(
            [{"cell": e["cell"], "chunk": list(e["chunk"]), "id": e["id"], "links": list(e["links"])}
             for e in world["entities"]], key=lambda e: e["id"]),
    }

if __name__ == "__main__":
    for path in sys.argv[1:]:
        b = open(path, "rb").read()
        try:
            world, errors = parse_save(b)
        except GWSVError as ex:
            print(f"{os.path.basename(path)}: FATAL {ex.msg}" + (f" @offset {ex.offset}" if ex.offset is not None else ""))
            continue
        fatal_voxels = [c for c in world["chunks"] if c["voxels"] is None]
        print(f"{os.path.basename(path)}: {len(errors)} errors, {len(fatal_voxels)} unreadable chunks")
        for e in errors:
            print("  -", e["msg"], f"@offset {e['offset']}" if e["offset"] is not None else "")
        if not errors and not fatal_voxels:
            enc = encode_v2(world)
            w2, e2 = parse_save(enc)
            assert not e2, e2
            k1, k2 = semantic_key(world), semantic_key(w2)
            print("  roundtrip semantic identical:", k1 == k2, "| encoded size:", len(enc))
            enc2 = encode_v2(w2)
            print("  canonical idempotent (bytes equal):", enc == enc2)
