#!/usr/bin/env python3
"""Detailed dump of fMP4 fields relevant to repacking.

Usage: python -I fmp4_inspect.py <file.mp4>
"""
import struct
import sys


class Reader:
    def __init__(self, buf, start=0, end=None):
        self.buf = buf
        self.pos = start
        self.end = len(buf) if end is None else end

    def u8(self):
        v = self.buf[self.pos]
        self.pos += 1
        return v

    def u16(self):
        (v,) = struct.unpack_from(">H", self.buf, self.pos)
        self.pos += 2
        return v

    def u24(self):
        x = self.buf
        p = self.pos
        self.pos += 3
        return (x[p] << 16) | (x[p + 1] << 8) | x[p + 2]

    def u32(self):
        (v,) = struct.unpack_from(">I", self.buf, self.pos)
        self.pos += 4
        return v

    def u64(self):
        (v,) = struct.unpack_from(">Q", self.buf, self.pos)
        self.pos += 8
        return v

    def i32(self):
        (v,) = struct.unpack_from(">i", self.buf, self.pos)
        self.pos += 4
        return v

    def take(self, n):
        v = self.buf[self.pos:self.pos + n]
        self.pos += n
        return v

    def sub(self, n):
        r = Reader(self.buf, self.pos, self.pos + n)
        self.pos += n
        return r

    def eof(self):
        return self.pos >= self.end


def child_boxes(r):
    out = []
    while not r.eof():
        start = r.pos
        hdr = r.take(8)
        size, btype = struct.unpack(">I4s", hdr)
        hlen = 8
        if size == 1:
            size = r.u64()
            hlen = 16
        elif size == 0:
            size = r.end - start
        body = r.sub(size - hlen)
        out.append((btype.decode("latin1"), body, start, size))
    return out


def full(r):
    ver = r.u8()
    flags = r.u24()
    return ver, flags


def main(path):
    with open(path, "rb") as fh:
        data = fh.read()
    top = child_boxes(Reader(data))
    tracks = {}

    for name, body, _, _ in top:
        if name != "moov":
            continue
        for n1, b1, _, _ in child_boxes(body):
            if n1 == "trak":
                tkhd_id = None
                mdhd = {}
                handler = None
                for n2, b2, _, _ in child_boxes(b1):
                    if n2 == "tkhd":
                        ver, _ = full(b2)
                        if ver == 1:
                            b2.u64(); b2.u64()
                        else:
                            b2.u32(); b2.u32()
                        tkhd_id = b2.u32()
                    elif n2 == "mdia":
                        for n3, b3, _, _ in child_boxes(b2):
                            if n3 == "mdhd":
                                ver, _ = full(b3)
                                if ver == 1:
                                    b3.u64(); b3.u64()
                                    ts = b3.u32()
                                    dur = b3.u64()
                                else:
                                    b3.u32(); b3.u32()
                                    ts = b3.u32()
                                    dur = b3.u32()
                                mdhd = {"timescale": ts, "duration": dur}
                            elif n3 == "hdlr":
                                full(b3)
                                b3.u32()
                                handler = b3.take(4).decode("latin1")
                tracks[tkhd_id] = {"mdhd": mdhd, "handler": handler}
            elif n1 == "mvex":
                for n2, b2, _, _ in child_boxes(b1):
                    if n2 == "trex":
                        ver, fl = full(b2)
                        tid = b2.u32()
                        tracks.setdefault(tid, {})["trex"] = dict(
                            desc=b2.u32(), duration=b2.u32(),
                            size=b2.u32(), flags=("0x%08x" % b2.u32()))

    print("== tracks ==")
    for tid, info in tracks.items():
        print(tid, info)

    frag_no = 0
    for name, body, fstart, fsize in top:
        if name != "moof":
            continue
        frag_no += 1
        print(f"\n== moof #{frag_no} @ {fstart} size {fsize} ==")
        for n1, b1, _, _ in child_boxes(body):
            if n1 == "mfhd":
                full(b1)
                print("  mfhd sequence=", b1.u32())
            elif n1 == "traf":
                tfhd = tfdt = None
                truns = []
                for n2, b2, _, _ in child_boxes(b1):
                    if n2 == "tfhd":
                        ver, flags = full(b2)
                        tid = b2.u32()
                        d = dict(ver=ver, flags=("0x%06x" % flags), track_id=tid)
                        if flags & 0x000001:
                            d["base_data_offset"] = b2.u64()
                        if flags & 0x000002:
                            d["sample_desc_idx"] = b2.u32()
                        if flags & 0x000008:
                            d["default_sample_duration"] = b2.u32()
                        if flags & 0x000010:
                            d["default_sample_size"] = b2.u32()
                        if flags & 0x000020:
                            d["default_sample_flags"] = b2.u32()
                        tfhd = d
                    elif n2 == "tfdt":
                        ver, _ = full(b2)
                        tfdt = b2.u64() if ver == 1 else b2.u32()
                    elif n2 == "trun":
                        ver, flags = full(b2)
                        count = b2.u32()
                        d = dict(ver=ver, flags=("0x%06x" % flags), count=count)
                        if flags & 0x000001:
                            d["data_offset"] = b2.i32()
                        if flags & 0x000004:
                            d["first_sample_flags"] = b2.u32()
                        samples = []
                        for _ in range(count):
                            e = {}
                            if flags & 0x000100:
                                e["duration"] = b2.u32()
                            if flags & 0x000200:
                                e["size"] = b2.u32()
                            if flags & 0x000400:
                                e["flags"] = ("0x%08x" % b2.u32())
                            if flags & 0x000800:
                                e["cts"] = b2.i32() if ver == 1 else b2.u32()
                            samples.append(e)
                        d["samples"] = samples
                        truns.append(d)
                print("  traf", tfhd, "tfdt=", tfdt)
                for tr in truns:
                    head = {k: v for k, v in tr.items() if k != "samples"}
                    print("   trun", head)
                    for i, e in enumerate(tr["samples"]):
                        print("     ", i, e)


if __name__ == "__main__":
    main(sys.argv[1])
