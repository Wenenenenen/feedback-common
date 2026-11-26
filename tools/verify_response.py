#!/usr/bin/env python3
"""Verify the JS impulse response and WAV bytes against a from-spec Python calc.

Re-derives every rule in format.txt independently and compares float32 payloads.
Run: python3 -I tools/verify_response.py
"""
import json
import math
import struct
import subprocess
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reference import build, blockage, sequences, NAMES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FS, N, C, DIV = 48000, 96000, 343000, 4096


def python_response(room):
    size = room['size']
    walls = room['walls']
    boxes = [{'min': b['min'], 'max': b['max']} for b in room['boxes']]
    out = [0.0] * N
    for S in room['sources'][:1]:
        for R in room['receivers'][:1]:
            for seq in sequences(room['order']):
                built = build(S, R, size, seq)
                if built is None:
                    continue
                verts, length = built
                if blockage(verts, boxes) is not None:
                    continue
                h = [1]
                for w in seq:
                    g = walls[w]
                    nh = [0] * (len(h) + len(g) - 1)
                    for i, a in enumerate(h):
                        for k, b in enumerate(g):
                            nh[i + k] += a * b
                    h = nh
                div = DIV ** len(seq)
                atten = max(1.0, length / 1000.0)
                d = length * FS / C
                base = math.floor(d)
                frac = d - base
                for k, hk in enumerate(h):
                    coef = hk / div / atten
                    f0, f1 = base + k, base + k + 1
                    if 0 <= f0 < N:
                        out[f0] += coef * (1 - frac)
                    if 0 <= f1 < N:
                        out[f1] += coef * frac
    return out


def main():
    room = json.loads((ROOT / 'samples' / 'extracted' / 'room.json').read_text())
    expected = python_response(room)

    # JS WAV output
    p = subprocess.run(['node', str(ROOT / 'tools' / 'wav_dump.js')],
                       input=json.dumps(room).encode(), capture_output=True, check=True)
    wav = p.stdout
    assert wav[:4] == b'RIFF' and wav[8:12] == b'WAVE', 'RIFF/WAVE magic'
    assert wav[12:16] == b'fmt ' and struct.unpack('<I', wav[16:20])[0] == 16
    fmt, ch, sr = struct.unpack('<HHI', wav[20:28])
    assert (fmt, ch, sr) == (3, 1, 48000), (fmt, ch, sr)
    br, ba, bits = struct.unpack('<IHH', wav[28:36])
    assert (br, ba, bits) == (48000 * 4, 4, 32)
    assert wav[36:40] == b'data'
    data_bytes = struct.unpack('<I', wav[40:44])[0]
    assert data_bytes == N * 4 and len(wav) == 44 + data_bytes
    got = list(struct.unpack('<%df' % N, wav[44:]))

    max_abs = max(abs(x) for x in got)
    diff = max(abs(a - b) for a, b in zip(got, expected))
    rel = diff / max_abs
    print(f'frames={N} max|x|={max_abs:.6g} maxAbsDiff={diff:.3g} rel={rel:.3g}')
    assert rel < 1e-6, 'response diverges from from-spec reference'

    # frame placement sanity: earliest arrival = shortest REACHABLE path
    # (the sample's direct path is blocked by the cabinet)
    nz = [i for i, x in enumerate(got) if x != 0.0]
    size = room['size']
    boxes = [{'min': b['min'], 'max': b['max']} for b in room['boxes']]
    reach_len = []
    for seq in sequences(room['order']):
        built = build(room['sources'][0], room['receivers'][0], size, seq)
        if built and blockage(built[0], boxes) is None:
            reach_len.append(built[1])
    d0 = min(reach_len) * FS / C
    assert nz[0] == math.floor(d0), (nz[0], math.floor(d0))

    # signed taps on the same frame must be summed: build a room whose only
    # reachable path has tap signs landing on a shared frame pair
    signed = json.loads(json.dumps(room))
    signed['walls'][5] = [-4096, 4096, 0]  # z1: -1, +1 taps
    p2 = subprocess.run(['node', str(ROOT / 'tools' / 'wav_dump.js')],
                        input=json.dumps(signed).encode(), capture_output=True, check=True)
    g2 = list(struct.unpack('<%df' % N, p2.stdout[44:]))
    e2 = python_response(signed)
    d2 = max(abs(a - b) for a, b in zip(g2, e2))
    assert d2 / max(max(abs(x) for x in e2), 1e-12) < 1e-6
    print('signed-tap summation matches; WAV header and float32 payload verified')
    print('RESPONSE + WAV VERIFIED')


if __name__ == '__main__':
    main()
