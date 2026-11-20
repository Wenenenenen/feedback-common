#!/usr/bin/env python3
"""G53 参考编码器（独立按 README 规范实现，仅用于交叉验证 JS 版本）。

用法：python3 -I g53_reference.py <raw_u8> <w> <h> <levels> <out.g53>
输出同时写 <out>.u8 拷贝，方便测试对照。
"""
import struct
import sys
import zlib


def forward_1d(src):
    n = len(src)
    if n <= 1:
        return src[:]
    ne = (n + 1) // 2
    no = n // 2
    d = [0] * no
    s = [0] * ne
    for i in range(no):
        j = min(i + 1, ne - 1)  # n=2 时回退到 e_i 自身
        d[i] = src[2 * i + 1] - (src[2 * i] + src[2 * j]) // 2
    for i in range(ne):
        dl = d[max(i - 1, 0)]
        dr = d[min(i, no - 1)]
        s[i] = src[2 * i] + (dl + dr + 2) // 4
    return s + d


def inverse_1d(coeff):
    n = len(coeff)
    if n <= 1:
        return coeff[:]
    ne = (n + 1) // 2
    no = n // 2
    s = coeff[:ne]
    d = coeff[ne:]
    e = [0] * ne
    o = [0] * no
    for i in range(ne):
        dl = d[max(i - 1, 0)]
        dr = d[min(i, no - 1)]
        e[i] = s[i] - (dl + dr + 2) // 4
    for i in range(no):
        j = min(i + 1, ne - 1)
        o[i] = d[i] + (e[i] + e[j]) // 2
    out = [0] * n
    for i in range(no):
        out[2 * i] = e[i]
        out[2 * i + 1] = o[i]
    if ne > no:
        out[-1] = e[-1]
    return out


def forward_2d_region(a, W, w, h):
    """全尺寸列表 a（行步长 W）上就地变换左上 w×h 区域。"""
    tmp = [0] * max(w, h)
    for y in range(h):
        base = y * W
        tmp[:w] = a[base:base + w]
        t = forward_1d(tmp[:w])
        a[base:base + w] = t
    for x in range(w):
        for y in range(h):
            tmp[y] = a[y * W + x]
        t = forward_1d(tmp[:h])
        for y in range(h):
            a[y * W + x] = t[y]


def inverse_2d_region(a, W, w, h):
    tmp = [0] * max(w, h)
    for x in range(w):
        for y in range(h):
            tmp[y] = a[y * W + x]
        t = inverse_1d(tmp[:h])
        for y in range(h):
            a[y * W + x] = t[y]
    for y in range(h):
        base = y * W
        tmp[:w] = a[base:base + w]
        t = inverse_1d(tmp[:w])
        a[base:base + w] = t


def forward_2d(a, w, h):
    out = a[:]
    forward_2d_region(out, w, w, h)
    return out


def inverse_2d(coeff, w, h):
    out = coeff[:]
    inverse_2d_region(out, w, w, h)
    return out


def max_levels(w, h):
    l = 0
    while w > 1 or h > 1:
        w = (w + 1) // 2
        h = (h + 1) // 2
        l += 1
    return l


def decompose(pix, w, h, levels):
    assert levels <= max_levels(w, h)
    coeff = [p - 128 for p in pix]
    cw, ch = w, h
    dims = [(cw, ch)]
    for _ in range(levels):
        forward_2d_region(coeff, w, cw, ch)
        cw, ch = (cw + 1) // 2, (ch + 1) // 2
        dims.append((cw, ch))
    return coeff, dims


def reconstruct(coeff, w, h, levels, dims):
    cur = coeff[:]
    for l in range(levels, 0, -1):
        cw, ch = dims[l - 1]
        inverse_2d_region(cur, w, cw, ch)
    return [v + 128 for v in cur]


def highest_bit(values):
    m = max(abs(v) for v in values)
    return 255 if m == 0 else m.bit_length() - 1


class BitWriter:
    def __init__(self):
        self.bytes = bytearray()
        self.cur = 0
        self.nbits = 0

    def write(self, b):
        self.cur = ((self.cur << 1) | (b & 1)) & 0xff
        self.nbits += 1
        if self.nbits == 8:
            self.bytes.append(self.cur)
            self.cur = 0
            self.nbits = 0

    def finish(self):
        if self.nbits:
            self.bytes.append((self.cur << (8 - self.nbits)) & 0xff)
        return bytes(self.bytes)


def encode_bitplane(coeff, bit):
    bw = BitWriter()
    nxt = 1 << (bit + 1)
    for v in coeff:
        av = abs(v)
        mag = (av >> bit) & 1
        bw.write(mag)
        if mag and av < nxt:
            bw.write(1 if v < 0 else 0)
    return bw.finish()


def encode_stream(pix, w, h, levels):
    coeff, dims = decompose(pix, w, h, levels)
    hb = highest_bit(coeff)
    out = bytearray(struct.pack('<4sIIBB', b'G53A', w, h, levels, hb))
    if hb != 255:
        for bit in range(hb, -1, -1):
            raw = encode_bitplane(coeff, bit)
            comp = zlib.compress(raw)
            out += struct.pack('<BIII', bit, len(raw), len(comp),
                               zlib.crc32(raw) & 0xffffffff)
            out += comp
    return bytes(out), coeff, dims, hb


def main():
    raw_path, w, h, levels, out_path = sys.argv[1], int(sys.argv[2]), \
        int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    with open(raw_path, 'rb') as f:
        pix = list(f.read())
    assert len(pix) == w * h
    stream, coeff, dims, hb = encode_stream(pix, w, h, levels)
    with open(out_path, 'wb') as f:
        f.write(stream)
    # 自检：解码还原
    assert struct.unpack('<4s', stream[:4])[0] == b'G53A'
    back = decode_full(stream)
    assert back == pix, 'Python 参考自检失败'
    print(f'wrote {out_path}: {len(stream)} bytes, highbit={hb}, '
          f'levels={levels}, roundtrip OK')


def decode_full(stream):
    magic, w, h, levels, hb = struct.unpack('<4sIIBB', stream[:14])
    assert magic == b'G53A'
    n = w * h
    mag = [0] * n
    sign = [0] * n
    known = [0] * n
    pos = 14
    if hb == 255:
        assert pos == len(stream)
    else:
        for bit in range(hb, -1, -1):
            b, raw_len, comp_len, crc = struct.unpack(
                '<BIII', stream[pos:pos + 13])
            pos += 13
            assert b == bit
            raw = zlib.decompress(stream[pos:pos + comp_len])
            pos += comp_len
            assert len(raw) == raw_len
            assert (zlib.crc32(raw) & 0xffffffff) == crc
            bp = 0

            def rbit():
                nonlocal bp
                byte = raw[bp >> 3]
                r = (byte >> (7 - (bp & 7))) & 1
                bp += 1
                return r

            mask = 1 << bit
            for i in range(n):
                mb = rbit()
                if mb:
                    mag[i] += mask  # 无符号幅值，符号单独存
                    if not known[i]:
                        known[i] = 1
                        sign[i] = rbit()
            assert bp <= len(raw) * 8
            # 补齐位必须为 0
            used = bp
            for k in range(used, len(raw) * 8):
                assert ((raw[k >> 3] >> (7 - (k & 7))) & 1) == 0
    partial = [-m if s else m for m, s in zip(mag, sign)]
    dims = [(w, h)]
    cw, ch = w, h
    for _ in range(levels):
        cw, ch = (cw + 1) // 2, (ch + 1) // 2
        dims.append((cw, ch))
    return reconstruct(partial, w, h, levels, dims)


if __name__ == '__main__':
    main()
