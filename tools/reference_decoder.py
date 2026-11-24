#!/usr/bin/env python3
"""CXR1 独立参考解码器（仅用 Python 标准库），用于与 JS 实现交叉验证。

用法：
  python3 -I reference_decoder.py <file.cxr> --dump-dir <dir> [--frames 0,3,7]

输出：
  <dir>/index.json   帧索引、合法性、断链/截断信息
  <dir>/f<idx>.rgba  指定有效帧的原始 RGBA8（无叠加、无重编码）
"""
import argparse
import json
import os
import struct
import sys
import zlib

NO_BASE = 0xFFFFFFFF


def parse(data: bytes):
    if len(data) < 8 or data[:4] != b"CXR1":
        raise ValueError("魔数不是 CXR1 或文件过短")
    width, height = struct.unpack_from("<HH", data, 4)
    frames = []
    off = 8
    chain_valid = False
    last_seq = -1
    anchor = -1
    truncated = None
    file_size = len(data)

    while off < file_size:
        start = off
        if file_size - start < 4:
            truncated = {"offset": start, "reason": "长度字段不完整（文件尾截断）"}
            break
        (L,) = struct.unpack_from("<I", data, start)
        if L < 4:
            truncated = {"offset": start, "reason": f"帧长度字段 L={L} 小于 4"}
            break
        if file_size - start < 4 + L:
            truncated = {
                "offset": start,
                "reason": f"声明长度 {L} 越过文件尾（剩余 {file_size - start - 4} 字节）",
            }
            break
        body_start = start + 8
        body_end = start + 4 + L
        (stored_crc,) = struct.unpack_from("<I", data, start + 4)
        body = data[body_start:body_end]
        entry = {
            "index": len(frames),
            "offset": start,
            "length": L,
            "seq": None,
            "base": None,
            "key": False,
            "moves": [],
            "dirty": [],
            "valid": False,
            "reason": None,
            "anchorIndex": -1,
        }
        frame_idx = len(frames)
        try:
            if len(body) < 13:
                raise ValueError("帧体不足 13 字节固定头")
            seq, base, key, nm, nd = struct.unpack_from("<IIBHH", body, 0)
            if key not in (0, 1):
                raise ValueError(f"key 字段非法：{key}")
            p = 13
            moves = []
            for _ in range(nm):
                sx, sy, mw, mh, dx, dy = struct.unpack_from("<6h", body, p)
                p += 12
                moves.append([sx, sy, mw, mh, dx, dy])
            dirty = []
            for _ in range(nd):
                x, y, dw, dh = struct.unpack_from("<4h", body, p)
                p += 8
                need = dw * dh * 4
                if len(body) - p < need:
                    raise ValueError("脏块像素数据越界")
                dirty.append([x, y, dw, dh, p + body_start])
                p += need
            if p != len(body):
                raise ValueError(f"帧体未恰好用完：消费 {p} / {len(body)}")
            if (zlib.crc32(body) & 0xFFFFFFFF) != stored_crc:
                raise ValueError("CRC32 校验失败")

            valid = False
            reason = None
            if key == 1:
                full = (
                    base == NO_BASE
                    and nm == 0
                    and nd == 1
                    and dirty[0][0] == 0
                    and dirty[0][1] == 0
                    and dirty[0][2] == width
                    and dirty[0][3] == height
                )
                if full:
                    valid = True
                else:
                    reason = "关键帧不满足满画布等约束"
            else:
                if not chain_valid:
                    reason = "差量帧出现在断链状态"
                elif base != (last_seq & 0xFFFFFFFF):
                    reason = f"base={base} 与上一成功帧 seq={last_seq} 不符"
                elif seq <= last_seq:
                    reason = f"成功帧 seq 未严格递增：{seq} <= {last_seq}"
                else:
                    valid = True

            if valid:
                if key == 1:
                    chain_valid = True
                    anchor = frame_idx
                last_seq = seq
            else:
                chain_valid = False
                anchor = -1

            entry.update(
                seq=seq,
                base=base,
                key=bool(key),
                moves=moves,
                dirty=[[x, y, w, h] for (x, y, w, h, _px) in dirty],
                valid=valid,
                reason=reason,
                anchorIndex=anchor if valid else -1,
            )
        except ValueError as exc:
            chain_valid = False
            anchor = -1
            entry["reason"] = str(exc)

        frames.append(entry)
        off = body_end

    return {
        "width": width,
        "height": height,
        "frames": frames,
        "truncated": truncated,
    }, data


def decode_frame(meta, data, target):
    W, H = meta["width"], meta["height"]
    entries = meta["frames"]
    e = entries[target]
    if not e["valid"]:
        raise ValueError(f"帧 {target} 不可重建：{e['reason']}")
    anchor = e["anchorIndex"]
    if anchor < 0:
        raise ValueError("缺少关键帧锚点")

    def blit(dst, x, y, w, h, px_off):
        if w == 0 or h == 0:
            return
        xl, yl = max(0, x), max(0, y)
        xr, yr = min(W, x + w), min(H, y + h)
        if xr <= xl or yr <= yl:
            return
        span = xr - xl
        for row in range(yl, yr):
            s = px_off + ((row - y) * w + (xl - x)) * 4
            d = (row * W + xl) * 4
            dst[d:d + span * 4] = data[s:s + span * 4]

    # 锚点关键帧
    ke = entries[anchor]
    prev = bytearray(W * H * 4)
    kx, ky, kw, kh = struct.unpack_from("<4h", data, ke["offset"] + 8 + 13)
    # 关键帧脏块头位于固定头之后；像素偏移需重新定位
    kpx_off = ke["offset"] + 8 + 13 + 8
    blit(prev, kx, ky, kw, kh, kpx_off)

    for i in range(anchor + 1, target + 1):
        cur = bytearray(prev)
        fi = entries[i]
        body_start = fi["offset"] + 8
        p = body_start + 13
        for _sx, _sy, _mw, _mh, _dx, _dy in fi["moves"]:
            sx, sy, mw, mh, dx, dy = struct.unpack_from("<6h", data, p)
            p += 12
            xl = max(0, sx, dx)
            xr = min(W, sx + mw, dx + mw)
            yl = max(0, sy, dy)
            yr = min(H, sy + mh, dy + mh)
            if xr <= xl or yr <= yl:
                continue
            span = xr - xl
            for row in range(yl, yr):
                srow = sy + (row - dy)
                s = (srow * W + sx + (xl - dx)) * 4
                d = (row * W + xl) * 4
                cur[d:d + span * 4] = prev[s:s + span * 4]
        for _d in fi["dirty"]:
            x, y, dw, dh = struct.unpack_from("<4h", data, p)
            p += 8
            blit(cur, x, y, dw, dh, p)
            p += dw * dh * 4
        prev = cur
    return bytes(prev)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--dump-dir", required=True)
    ap.add_argument("--frames", default="")
    args = ap.parse_args()
    with open(args.file, "rb") as fh:
        data = fh.read()
    meta, data = parse(data)
    os.makedirs(args.dump_dir, exist_ok=True)
    with open(os.path.join(args.dump_dir, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)
    if args.frames:
        wanted = [int(x) for x in args.frames.split(",") if x != ""]
    else:
        wanted = [e["index"] for e in meta["frames"] if e["valid"]]
    for idx in wanted:
        rgba = decode_frame(meta, data, idx)
        with open(os.path.join(args.dump_dir, f"f{idx}.rgba"), "wb") as fh:
            fh.write(rgba)
    print(json.dumps({
        "frames": len(meta["frames"]),
        "valid": sum(1 for e in meta["frames"] if e["valid"]),
        "truncated": meta["truncated"],
        "dumped": wanted,
    }, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
