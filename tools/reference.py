#!/usr/bin/env python3
"""RPA1 参考实现（用于交叉校验 JS 编码器 / 解码器）。

刻意从零按 samples/格式.txt 编写，不复用 JS 代码。
"""
import struct, sys, zlib, math

FPB = 1024


def read_wav(path):
    data = open(path, 'rb').read()
    assert data[:4] == b'RIFF' and data[8:12] == b'WAVE'
    pos = 12
    fmt = None
    data_chunk = None
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        size = struct.unpack('<I', data[pos + 4:pos + 8])[0]
        body = pos + 8
        if cid == b'fmt ':
            fmt = struct.unpack('<HHIIHH', data[body:body + 16])
        elif cid == b'data':
            data_chunk = (body, size)
        pos = body + size + (size & 1)
    assert fmt is not None and data_chunk is not None
    afmt, ch, rate, byte_rate, align, bits = fmt
    assert afmt == 1
    off, size = data_chunk
    frames = size // align
    bps = bits // 8
    chans = [[] for _ in range(ch)]
    for i in range(frames):
        base = off + i * align
        for c in range(ch):
            b = data[base + c * bps: base + c * bps + bps]
            if bits == 16:
                v = struct.unpack('<h', b)[0]
            else:
                v = int.from_bytes(b, 'little', signed=True)
            chans[c].append(v)
    return dict(rate=rate, ch=ch, bits=bits, frames=frames, chans=chans)


def pick(chans, start, n, bits):
    """穷举每路 (order, k) 的位成本；返回 [(order,k)] 的最优组合。
    注意：本参考实现按「每路独立最小」选取，用于校验 JS 单路选参；
    模式级同长决胜由调用方在 modes 之间比较。"""
    if bits == 16:
        lo, hi = -32768, 32767
    else:
        lo, hi = -8388608, 8388607
    results = []
    for order in range(3):
        us = []
        prev = prev2 = 0
        for i in range(n):
            v = chans[start + i]
            if order == 0:
                pred = 0
            elif order == 1:
                pred = prev
            else:
                pred = 2 * prev - prev2
            r = v - pred
            prev2, prev = prev, v
            u = 2 * r if r >= 0 else -2 * r - 1
            us.append(u)
        for k in range(16):
            cost = 0
            for u in us:
                q = u >> k
                if q < 31:
                    cost += q + 1 + k
                else:
                    cost += 31 + 28
            results.append((cost, order, k))
    results.sort(key=lambda t: (t[0], t[1], t[2]))
    return results[0]


class BW:
    def __init__(self):
        self.bits = []
    def put(self, value, n):
        for i in range(n - 1, -1, -1):
            self.bits.append((value >> i) & 1)
    def zeros(self, n):
        self.bits.extend([0] * n)
    def bytes(self):
        out = bytearray()
        for i in range(0, len(self.bits), 8):
            chunk = self.bits[i:i + 8]
            while len(chunk) < 8:
                chunk.append(0)
            v = 0
            for b in chunk:
                v = (v << 1) | b
            out.append(v)
        return bytes(out)


def encode_block(chans, start, n, bits, stereo):
    best = None
    modes = [0, 1] if stereo else [0]
    for mode in modes:
        if not stereo:
            work = [(chans[0], start)]
        elif mode == 0:
            work = [(chans[0], start), (chans[1], start)]
        else:
            L, R = chans[0], chans[1]
            mid = [math.floor((L[start + i] + R[start + i]) / 2) for i in range(n)]
            side = [R[start + i] - L[start + i] for i in range(n)]
            work = [(mid, 0), (side, 0)]
        picks = [pick(w, s, n, bits) for (w, s) in work]
        total = sum(p[0] for p in picks)
        key = (total, mode, picks[0][1], picks[0][2])
        if len(picks) == 2:
            key += (picks[1][1], picks[1][2])
        if best is None or key < best[0]:
            best = (key, mode, picks, [w[s:s + n] for (w, s) in work])
    _, mode, picks, work = best
    bw = BW()
    for (cost, order, k), w in zip(picks, work):
        prev = prev2 = 0
        for i in range(n):
            v = w[i]
            if order == 0:
                pred = 0
            elif order == 1:
                pred = prev
            else:
                pred = 2 * prev - prev2
            r = v - pred
            prev2, prev = prev, v
            u = 2 * r if r >= 0 else -2 * r - 1
            q = u >> k
            if q < 31:
                bw.zeros(q)
                bw.put(1, 1)
                if k:
                    bw.put(u & ((1 << k) - 1), k)
            else:
                bw.zeros(31)
                bw.put(u, 28)
    hdr = bytes([mode]) + bytes(b for (c, o, k) in picks for b in (o, k))
    return hdr + bw.bytes(), mode, picks


def encode(rate, ch, bits, chans):
    total = len(chans[0])
    nblocks = (total + FPB - 1) // FPB
    stereo = ch == 2
    blocks = []
    for b in range(nblocks):
        start = b * FPB
        n = min(FPB, total - start)
        data, mode, picks = encode_block(chans, start, n, bits, stereo)
        blocks.append(data)
    header = b'RPA1' + struct.pack('<I', rate) + bytes([ch, bits]) + struct.pack('<II', total, nblocks)
    dir_end = len(header) + nblocks * 12
    off = dir_end
    entries = []
    for data in blocks:
        entries.append((off, len(data), zlib.crc32(data) & 0xffffffff))
        off += len(data)
    out = bytearray(header)
    for e in entries:
        out += struct.pack('<III', *e)
    for data in blocks:
        out += data
    assert len(out) == off
    return bytes(out)


def main():
    src = sys.argv[1]
    dst = sys.argv[2]
    w = read_wav(src)
    data = encode(w['rate'], w['ch'], w['bits'], w['chans'])
    open(dst, 'wb').write(data)
    print('wrote', dst, len(data), 'bytes')


if __name__ == '__main__':
    main()
