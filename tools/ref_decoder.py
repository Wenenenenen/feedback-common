#!/usr/bin/env python3
"""Reference BC1/BC3 decoder per 格式说明.md, used only to validate the JS port."""
import struct
import sys


def expand565(v):
    r5 = (v >> 11) & 0x1F
    g6 = (v >> 5) & 0x3F
    b5 = v & 0x1F
    r = (r5 << 3) | (r5 >> 2)
    g = (g6 << 2) | (g6 >> 4)
    b = (b5 << 3) | (b5 >> 2)
    return r, g, b


def decode_color_block(block, force_four_color=False):
    c0 = struct.unpack_from('<H', block, 0)[0]
    c1 = struct.unpack_from('<H', block, 2)[0]
    bits = struct.unpack_from('<I', block, 4)[0]
    p0 = expand565(c0)
    p1 = expand565(c1)
    palette = [None] * 4
    if c0 > c1 or force_four_color:
        p2 = tuple((2 * a + b) // 3 for a, b in zip(p0, p1))
        p3 = tuple((a + 2 * b) // 3 for a, b in zip(p0, p1))
        palette = [(p0, 255), (p1, 255), (p2, 255), (p3, 255)]
    else:
        p2 = tuple((a + b) // 2 for a, b in zip(p0, p1))
        palette = [(p0, 255), (p1, 255), (p2, 255), ((0, 0, 0), 0)]
    out = []
    for i in range(16):
        idx = (bits >> (2 * i)) & 3
        rgb, a = palette[idx]
        out.append((rgb[0], rgb[1], rgb[2], a))
    return out


def decode_alpha_block(block):
    a0 = block[0]
    a1 = block[1]
    bits = block[2] | (block[3] << 8) | (block[4] << 16) | (block[5] << 24) | (block[6] << 32) | (block[7] << 40)
    table = [0] * 8
    table[0] = a0
    table[1] = a1
    if a0 > a1:
        for i in range(2, 8):
            table[i] = ((8 - i) * a0 + (i - 1) * a1) // 7
    else:
        for i in range(2, 6):
            table[i] = ((6 - i) * a0 + (i - 1) * a1) // 5
        table[6] = 0
        table[7] = 255
    out = []
    for i in range(16):
        idx = (bits >> (3 * i)) & 7
        out.append(table[idx])
    return out


def read_dds(path):
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:4] == b'DDS '
    height = struct.unpack_from('<I', data, 12)[0]
    width = struct.unpack_from('<I', data, 16)[0]
    fourcc = data[84:88]
    bw = (width + 3) // 4
    bh = (height + 3) // 4
    bs = 16 if fourcc == b'DXT5' else 8
    payload = data[128:]
    assert len(payload) == bw * bh * bs, (len(payload), bw * bh * bs)
    img = [[(0, 0, 0, 0)] * width for _ in range(height)]
    for by in range(bh):
        for bx in range(bw):
            off = (by * bw + bx) * bs
            block = payload[off:off + bs]
            if bs == 8:
                px = decode_color_block(block)
            else:
                alphas = decode_alpha_block(block)
                rgb = decode_color_block(block[8:], force_four_color=True)
                px = [(r, g, b, alphas[i]) for i, (r, g, b, _) in enumerate(rgb)]
            for i, (r, g, b, a) in enumerate(px):
                x = bx * 4 + i % 4
                y = by * 4 + i // 4
                if x < width and y < height:
                    img[y][x] = (r, g, b, a)
    return width, height, fourcc, img


def main():
    from PIL import Image
    dds_path, ref_png = sys.argv[1], sys.argv[2]
    w, h, fourcc, img = read_dds(dds_path)
    dec = Image.new('RGBA', (w, h))
    dec.putdata([px for row in img for px in row])
    ref = Image.open(ref_png).convert('RGBA')
    assert ref.size == (w, h)
    same = list(dec.getdata()) == list(ref.getdata())
    print(f'{dds_path} vs {ref_png}: {"BYTE-IDENTICAL" if same else "DIFFER"}')
    if not same:
        for y in range(h):
            for x in range(w):
                if dec.getpixel((x, y)) != ref.getpixel((x, y)):
                    print('first diff at', x, y, dec.getpixel((x, y)), ref.getpixel((x, y)))
                    return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
