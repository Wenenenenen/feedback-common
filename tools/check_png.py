"""Decode the encoder test PNGs (incl. 16-bit) and verify exact samples."""
import json
import struct
import sys
import zlib

sys.path.insert(0, "/home/wendy/jianzhi/feedback-tasks/masked-rl-deconvolver/tools")
TMP = "/home/wendy/jianzhi/feedback-tasks/masked-rl-deconvolver/tools/tmp_enc"


def decode(path):
    data = open(path, "rb").read()
    pos = 8
    idat = b""
    texts = []
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if ctype == b"IHDR":
            w, h, bd, ct = struct.unpack(">IIBB", chunk[:10])
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"tEXt":
            texts.append(chunk.split(b"\x00"))
        elif ctype == b"IEND":
            break
        pos += 12 + length
    ch = {0: 1, 2: 3}[ct]
    raw = zlib.decompress(idat)
    bps = bd // 8
    stride = w * ch * bps
    samples = []
    i = 0
    for _ in range(h):
        ft = raw[i]
        assert ft == 0, "encoder writes filter-0 only"
        i += 1
        row = raw[i:i + stride]
        i += stride
        if bd == 8:
            samples.extend(row)
        else:
            for k in range(0, stride, 2):
                samples.append(struct.unpack(">H", row[k:k + 2])[0])
    return w, h, ch, bd, samples, texts


failures = 0


def check(cond, name):
    global failures
    print(("PASS" if cond else "FAIL") + " " + name)
    if not cond:
        failures += 1


exp = json.load(open(TMP + "/expected.json"))
w, h, ch, bd, samples, texts = decode(TMP + "/gray16.png")
check((w, h, ch, bd) == (5, 3, 1, 16), "gray16 header")
check(samples == exp["gray16"], "gray16 exact samples after roundtrip")
check(any(t[0] == b"Quantization" for t in texts), "gray16 carries tEXt metadata")

w, h, ch, bd, samples, texts = decode(TMP + "/rgb8.png")
check((w, h, ch, bd) == (5, 3, 3, 8), "rgb8 header")
check(samples == exp["rgb8"], "rgb8 exact samples after roundtrip")

# Cross-check: re-decode one of the provided 8-bit inputs untouched via same path
sys.path.insert(0, "/home/wendy/jianzhi/feedback-tasks/masked-rl-deconvolver/tools")
from png_io import read_png
w2, h2, c2, raw2 = read_png(
    "/home/wendy/jianzhi/feedback-tasks/masked-rl-deconvolver/_untrusted/cases/medium-rgb.png")
check((w2, h2, c2) == (96, 80, 3) and len(raw2) == 96 * 80 * 3, "input RGB still decodes")

print("\nPYTHON PNG CHECKS PASSED" if failures == 0 else f"\n{failures} FAILURE(S)")
sys.exit(1 if failures else 0)
