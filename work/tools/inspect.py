#!/usr/bin/env python3
"""Inspect GWSV save files (diagnostic tool; run with python3 -I)."""
import sys, json, zlib, struct, os

class ParseError(Exception):
    def __init__(self, msg, offset=None):
        super().__init__(msg)
        self.msg = msg
        self.offset = offset

def u8(b, o):
    if o + 1 > len(b): raise ParseError("u8 越界", o)
    return b[o], o + 1

def u16(b, o):
    if o + 2 > len(b): raise ParseError("u16 越界", o)
    return struct.unpack_from("<H", b, o)[0], o + 2

def u32(b, o):
    if o + 4 > len(b): raise ParseError("u32 越界", o)
    return struct.unpack_from("<I", b, o)[0], o + 4

def i16(b, o):
    if o + 2 > len(b): raise ParseError("i16 越界", o)
    return struct.unpack_from("<h", b, o)[0], o + 2

def unpack_bits(packed, bits, n=512):
    out = [0] * n
    acc = 0; accbits = 0; pos = 0; mask = (1 << bits) - 1
    for i in range(n):
        while accbits < bits:
            if pos >= len(packed): raise ParseError("位打包数据不足", None)
            acc |= packed[pos] << accbits
            pos += 1; accbits += 8
        out[i] = acc & mask
        acc >>= bits; accbits -= bits
    return out

def pack_bits(indices, bits):
    out = bytearray()
    acc = 0; accbits = 0; mask = (1 << bits) - 1
    for v in indices:
        acc |= (v & mask) << accbits
        accbits += bits
        while accbits >= 8:
            out.append(acc & 0xFF); acc >>= 8; accbits -= 8
    if accbits: out.append(acc & 0xFF)
    return bytes(out)

def parse(path):
    b = open(path, "rb").read()
    print(f"=== {os.path.basename(path)}  size={len(b)} ===")
    o = 0
    if len(b) < 8: raise ParseError("文件短于文件头(8字节)", 0)
    magic = b[0:4]
    if magic != b"GWSV": raise ParseError(f"magic 错误: {magic!r}", 0)
    version, o = u8(b, 4)
    if version not in (1, 2): raise ParseError(f"version 非法: {version}", 4)
    chunk_count, o = u16(b, 5)
    entity_count, o = u16(b, 7)
    print(f"version={version} chunks={chunk_count} entities={entity_count}")
    if chunk_count > 128: raise ParseError("chunkCount>128", 5)
    if entity_count > 256: raise ParseError("entityCount>256", 7)
    if len(b) > 8 * 1024 * 1024: raise ParseError("文件超过 8MB", 0)

    chunks = []
    for ci in range(chunk_count):
        head = o
        x, o = i16(b, o); y, o = i16(b, o); z, o = i16(b, o)
        plen, o = u32(b, o)
        payload_start = o
        if o + plen + 4 > len(b):
            raise ParseError(f"区块({x},{y},{z}) payload/crc 截断: 需要到 {o+plen+4}, 文件长 {len(b)}", o)
        payload = b[o:o+plen]
        crc_stored, o2 = u32(b, o + plen)
        crc_calc = zlib.crc32(payload) & 0xFFFFFFFF
        crc_ok = crc_stored == crc_calc
        print(f" chunk[{ci}] coord=({x},{y},{z}) headOff={head} payloadOff={payload_start} len={plen} crcOff={o+plen} crc={crc_stored:#010x} calc={crc_calc:#010x} {'OK' if crc_ok else 'MISMATCH'}")
        voxels = None; palette = None; bits = None
        if crc_ok:
            try:
                if version == 1:
                    if plen != 1024: raise ParseError(f"v1 payload 长度应为1024, 实际{plen}", payload_start)
                    voxels = list(struct.unpack_from("<512H", payload, 0))
                else:
                    p = 0
                    palette_count, p = u16(payload, p)
                    if not (1 <= palette_count <= 512):
                        raise ParseError(f"paletteCount 非法: {palette_count}", payload_start + p - 2)
                    palette = []
                    for k in range(palette_count):
                        vid, p = u16(payload, p); palette.append(vid)
                    if len(set(palette)) != len(palette):
                        raise ParseError("调色板 ID 重复", payload_start)
                    bits, p = u8(payload, p)
                    expect_bits = max(1, (palette_count - 1).bit_length())
                    if bits != expect_bits:
                        raise ParseError(f"bits={bits} 与规范值 {expect_bits} 不符", payload_start + p - 1)
                    expect_len = (512 * bits + 7) // 8
                    packed = payload[p:]
                    if len(packed) != expect_len:
                        raise ParseError(f"packed 长度 {len(packed)} != 规范 {expect_len}", payload_start + p)
                    idxs = unpack_bits(packed, bits)
                    bad = [i for i, v in enumerate(idxs) if v >= palette_count]
                    if bad:
                        raise ParseError(f"非法调色板索引 {len(bad)} 个, 首个位置 cell={bad[0]}", payload_start + p)
                    voxels = [palette[i] for i in idxs]
            except ParseError as e:
                print(f"   PAYLOAD ERROR: {e.msg}" + (f" @offset {e.offset}" if e.offset is not None else ""))
        chunks.append({"coord": (x, y, z), "voxels": voxels, "crc_ok": crc_ok})
        o = o2 + 0
        o = o2

    coords = [c["coord"] for c in chunks]
    if len(set(coords)) != len(coords):
        print(" DUPLICATE CHUNK COORDS")
    coord_set = set(coords)

    entities = []
    for ei in range(entity_count):
        eo = o
        elen, o = u32(b, o)
        if o + elen > len(b):
            raise ParseError(f"实体[{ei}] JSON 截断: 偏移 {eo}, 需 {o+elen}, 文件长 {len(b)}", eo)
        raw = b[o:o+elen]; o += elen
        try:
            ent = json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise ParseError(f"实体[{ei}] JSON 解析失败: {e}", eo + 4)
        ent["_off"] = eo
        entities.append(ent)
        print(f" entity[{ei}] off={eo} len={elen} -> {ent}")
    if o != len(b):
        print(f" TRAILING BYTES: {len(b)-o} 字节, 起始 offset {o}")

    ids = [e["id"] for e in entities]
    if len(set(ids)) != len(ids): print(" DUPLICATE ENTITY IDS")
    id_set = set(ids)
    for e in entities:
        if not (isinstance(e["id"], int) and e["id"] > 0):
            print(f" ENTITY id 非法: {e['id']}")
        if tuple(e["chunk"]) not in coord_set:
            print(f" ENTITY {e['id']} 引用不存在区块 {e['chunk']}")
        if not (0 <= e["cell"] <= 511):
            print(f" ENTITY {e['id']} cell 越界 {e['cell']}")
        if len(e["links"]) != len(set(e["links"])):
            print(f" ENTITY {e['id']} links 重复")
        for t in e["links"]:
            if t not in id_set:
                print(f" ENTITY {e['id']} 悬空链接 -> {t}")
    return chunks, entities

if __name__ == "__main__":
    for p in sys.argv[1:]:
        try:
            parse(p)
        except ParseError as e:
            print(f" FATAL: {e.msg}" + (f" @offset {e.offset}" if e.offset is not None else ""))
        print()
