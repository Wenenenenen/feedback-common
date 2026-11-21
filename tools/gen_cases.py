#!/usr/bin/env python3
"""Generate synthetic tiled TIFFs plus the pixel values they encode.

Run with -I. Writes into the directory given as argv[1]. The expected values
are computed here by construction (not by a TIFF library), so the JS reader is
checked against an independent implementation of the layout rules.
"""
import json
import os
import struct
import sys
import zlib

TAG = {
    'newsubfile': 254, 'width': 256, 'length': 257, 'bits': 258,
    'compression': 259, 'photometric': 262, 'orientation': 274,
    'spp': 277, 'planar': 284, 'predictor': 317, 'tilewidth': 322,
    'tilelength': 323, 'tileoffsets': 324, 'tilecounts': 325,
    'subifds': 330,
}
TYPE_SHORT, TYPE_LONG, TYPE_LONG8 = 3, 4, 16


def build_tiff(path, *, big=False, little=True, width, height, spp, tile_w,
               tile_h, orientation=1, planar=1, compression=8, predictor=2,
               pixel_fn=None, missing=None, sub=None):
    """pixel_fn(x, y, c) -> uint16 for storage coordinates."""
    en = '<' if little else '>'
    missing = set(missing or ())
    across = (width + tile_w - 1) // tile_w
    down = (height + tile_h - 1) // tile_h
    planes = spp if planar == 2 else 1
    n_tiles = across * down * planes

    blobs = []
    offsets = [0] * n_tiles
    counts = [0] * n_tiles
    cursor = 16 if big else 8

    def tile_index(c, tr, tc):
        if planar == 2:
            return c * across * down + tr * across + tc
        return tr * across + tc

    for c in range(planes):
        for tr in range(down):
            for tc in range(across):
                idx = tile_index(c, tr, tc)
                if idx in missing:
                    offsets[idx] = 0
                    counts[idx] = 0
                    continue
                # full tile, edge tiles padded with 0
                raw = bytearray(tile_w * tile_h * (spp if planar == 1 else 1) * 2)
                chans = range(spp) if planar == 1 else [c]
                for ly in range(tile_h):
                    for lx in range(tile_w):
                        sx = tc * tile_w + lx
                        sy = tr * tile_h + ly
                        for ch in chans:
                            v = 0
                            if sx < width and sy < height:
                                v = pixel_fn(sx, sy, ch) & 0xffff
                            p = (ly * tile_w + lx)
                            if planar == 1:
                                p = p * spp + ch
                            struct.pack_into(en + 'H', raw, p * 2, v)
                if predictor == 2:
                    row_ch = spp if planar == 1 else 1
                    for ly in range(tile_h):
                        base = ly * tile_w * row_ch
                        for lx in range(tile_w - 1, 0, -1):
                            for ch in range(row_ch):
                                cur = base + lx * row_ch + ch
                                prev = base + (lx - 1) * row_ch + ch
                                cv = struct.unpack_from(en + 'H', raw, cur * 2)[0]
                                pv = struct.unpack_from(en + 'H', raw, prev * 2)[0]
                                struct.pack_into(en + 'H', raw, cur * 2, (cv - pv) & 0xffff)
                data = bytes(raw)
                if compression == 8:
                    data = zlib.compress(data, 6)
                offsets[idx] = cursor
                counts[idx] = len(data)
                blobs.append((cursor, data))
                cursor += len(data)

    # round up before IFD
    if cursor % 2:
        cursor += 1

    def write_ifd(size, entries, ifd_offset, extra_blobs):
        """entries: list of (tag, type, values). Returns (bytes, next offset slot)."""
        nonlocal cursor
        out = bytearray()
        if big:
            out += struct.pack(en + 'Q', len(entries))
            esz, cntfmt, valsz = 20, 'Q', 8
        else:
            out += struct.pack(en + 'H', len(entries))
            esz, cntfmt, valsz = 12, 'I', 4
        tail_len = (8 if big else 4)
        # place arrays after the table
        data_cursor = cursor + (8 if big else 2) + len(entries) * esz + tail_len
        arrays = bytearray()
        body = bytearray()
        fmt_for = {1: 'B', 3: 'H', 4: 'I', 16: 'Q'}
        for tag, typ, values in entries:
            f = fmt_for[typ]
            raw = struct.pack(en + f * len(values), *values)
            count = len(values)
            if len(raw) <= valsz:
                valfield = raw.ljust(valsz, b'\0')
            else:
                if data_cursor % 2:
                    arrays += b'\0'
                    data_cursor += 1
                valfield = struct.pack(en + ('Q' if big else 'I'), data_cursor)
                arrays += raw
                data_cursor += len(raw)
            if big:
                body += struct.pack(en + 'HHQ', tag, typ, count) + valfield
            else:
                body += struct.pack(en + 'HHI', tag, typ, count) + valfield
        out += body
        next_slot_pos = cursor + (8 if big else 2) + len(entries) * esz
        out += struct.pack(en + ('Q' if big else 'I'), 0)
        out += arrays
        return bytes(out), next_slot_pos, data_cursor

    sub_offset = None
    main_entries = [
        (TAG['width'], TYPE_LONG, [width]),
        (TAG['length'], TYPE_LONG, [height]),
        (TAG['bits'], TYPE_SHORT, [16] * spp),
        (TAG['compression'], TYPE_SHORT, [compression]),
        (TAG['photometric'], TYPE_SHORT, [2 if spp >= 3 else 1]),
        (TAG['orientation'], TYPE_SHORT, [orientation]),
        (TAG['spp'], TYPE_SHORT, [spp]),
        (TAG['planar'], TYPE_SHORT, [planar]),
        (TAG['predictor'], TYPE_SHORT, [predictor]),
        (TAG['tilewidth'], TYPE_LONG, [tile_w]),
        (TAG['tilelength'], TYPE_LONG, [tile_h]),
        (TAG['tileoffsets'], TYPE_LONG8 if big else TYPE_LONG, offsets),
        (TAG['tilecounts'], TYPE_LONG8 if big else TYPE_LONG, counts),
        (TAG['newsubfile'], TYPE_LONG, [0]),
    ]

    # optional SubIFD gets placed first (before main IFD)
    if sub is not None:
        sub_blobs = []
        sub_cursor = cursor
        # build sub tiles
        sub_offsets = []
        sub_counts = []
        sub_data = []
        s_across = (sub['width'] + sub['tile_w'] - 1) // sub['tile_w']
        s_down = (sub['height'] + sub['tile_h'] - 1) // sub['tile_h']
        planes_s = spp if sub.get('planar', planar) == 2 else 1
        it = sub_cursor
        for c in range(planes_s):
            for tr in range(s_down):
                for tc in range(s_across):
                    raw = bytearray(sub['tile_w'] * sub['tile_h'] * (spp if planes_s == 1 else 1) * 2)
                    chans = range(spp) if planes_s == 1 else [c]
                    for ly in range(sub['tile_h']):
                        for lx in range(sub['tile_w']):
                            sx = tc * sub['tile_w'] + lx
                            sy = tr * sub['tile_h'] + ly
                            for ch in chans:
                                v = sub['pixel_fn'](sx, sy, ch) if (sx < sub['width'] and sy < sub['height']) else 0
                                p = (ly * sub['tile_w'] + lx) * (spp if planes_s == 1 else 1) + (ch if planes_s == 1 else 0)
                                struct.pack_into(en + 'H', raw, p * 2, v & 0xffff)
                    data = zlib.compress(bytes(raw), 6) if sub.get('compression', 8) == 8 else bytes(raw)
                    sub_offsets.append(it)
                    sub_counts.append(len(data))
                    sub_data.append((it, data))
                    it += len(data)
        if it % 2:
            it += 1
        sub_entries = [
            (TAG['width'], TYPE_LONG, [sub['width']]),
            (TAG['length'], TYPE_LONG, [sub['height']]),
            (TAG['bits'], TYPE_SHORT, [16] * spp),
            (TAG['compression'], TYPE_SHORT, [sub.get('compression', 8)]),
            (TAG['photometric'], TYPE_SHORT, [2 if spp >= 3 else 1]),
            (TAG['orientation'], TYPE_SHORT, [sub.get('orientation', orientation)]),
            (TAG['spp'], TYPE_SHORT, [spp]),
            (TAG['planar'], TYPE_SHORT, [sub.get('planar', planar)]),
            (TAG['predictor'], TYPE_SHORT, [1]),
            (TAG['tilewidth'], TYPE_LONG, [sub['tile_w']]),
            (TAG['tilelength'], TYPE_LONG, [sub['tile_h']]),
            (TAG['tileoffsets'], TYPE_LONG8 if big else TYPE_LONG, sub_offsets),
            (TAG['tilecounts'], TYPE_LONG8 if big else TYPE_LONG, sub_counts),
            (TAG['newsubfile'], TYPE_LONG, [1]),
        ]
        sub_ifd = None  # computed later once we know where it lands
        sub_blobs = sub_data
        # We place: header(8/16) + tile blobs, then sub IFD, then main IFD.
        cursor = it
        sub_ifd_start = cursor
        built, _, end = write_ifd(it, sub_entries, sub_ifd_start, [])
        sub_offset = sub_ifd_start
        sub_ifd_bytes = built
        cursor = end
        if cursor % 2:
            cursor += 1
        main_entries.append((TAG['subifds'], TYPE_LONG8 if big else TYPE_LONG, [sub_offset]))
    else:
        sub_ifd_bytes = b''
        sub_blobs = []

    main_ifd_start = cursor
    main_bytes, _, _ = write_ifd(cursor, sorted(main_entries, key=lambda e: e[0]), main_ifd_start, [])

    out = bytearray()
    if big:
        out += b'II' if little else b'MM'
        out += struct.pack(en + 'HHH', 43, 8, 0) + struct.pack(en + 'Q', 0)
        assert len(out) == 16
    else:
        out += b'II' if little else b'MM'
        out += struct.pack(en + 'H', 42) + struct.pack(en + 'I', main_ifd_start)
        assert len(out) == 8
    if big:
        struct.pack_into(en + 'Q', out, 8, main_ifd_start)

    # place blobs at their recorded offsets
    for off, data in blobs + sub_blobs:
        if len(out) < off:
            out += b'\0' * (off - len(out))
        out[off:off + len(data)] = data
    if sub_ifd_bytes:
        if len(out) < sub_offset:
            out += b'\0' * (sub_offset - len(out))
        out[sub_offset:sub_offset + len(sub_ifd_bytes)] = sub_ifd_bytes
    if len(out) < main_ifd_start:
        out += b'\0' * (main_ifd_start - len(out))
    out += main_bytes

    with open(path, 'wb') as f:
        f.write(out)
    return {
        'width': width, 'height': height, 'spp': spp, 'orientation': orientation,
        'planar': planar, 'big': big, 'little': little,
        'compression': compression, 'predictor': predictor,
        'tile_w': tile_w, 'tile_h': tile_h, 'missing': sorted(missing),
        'sub_offset': sub_offset,
    }


def display_map(orientation, W, H, dx, dy):
    if orientation == 1:
        return dx, dy
    if orientation == 3:
        return W - 1 - dx, H - 1 - dy
    if orientation == 6:
        return dy, H - 1 - dx
    if orientation == 8:
        return W - 1 - dy, dx
    raise ValueError(orientation)


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    cases = []
    # deterministic pixel generator
    def px(sx, sy, c):
        return (sx * 977 + sy * 131 + c * 7919) & 0xffff

    matrix = [
        # name, big, little, spp, tw, th, orient, planar, comp, pred
        ('le_classic_gray_orient1_deflate', False, True, 1, 16, 16, 1, 1, 8, 2),
        ('be_classic_rgb_orient1_raw', False, False, 3, 16, 8, 1, 1, 1, 1),
        ('le_big_gray_orient6_planar', True, True, 1, 16, 16, 6, 2, 8, 2),
        ('be_big_rgb_orient8_planar', True, False, 3, 16, 16, 8, 2, 8, 2),
        ('le_classic_rgb_orient3_chunky', False, True, 3, 12, 10, 3, 1, 8, 2),
        ('le_big_rgb_orient6_chunky', True, True, 3, 16, 16, 6, 1, 8, 2),
        ('le_classic_gray_edge_tiles', False, True, 1, 16, 16, 1, 1, 1, 1),
        ('be_classic_rgb_planar_raw', False, False, 3, 8, 8, 1, 2, 1, 1),
        ('le_big_rgb_orient8_chunky', True, True, 3, 16, 16, 8, 1, 8, 2),
        ('le_classic_rgb_orient3_planar', False, True, 3, 16, 16, 3, 2, 8, 2),
    ]
    for name, big, little, spp, tw, th, orient, planar, comp, pred in matrix:
        W, H = 37, 23  # odd sizes to exercise edge tiles
        info = build_tiff(os.path.join(outdir, name + '.tif'), big=big, little=little,
                          width=W, height=H, spp=spp, tile_w=tw, tile_h=th,
                          orientation=orient, planar=planar, compression=comp,
                          predictor=pred, pixel_fn=px)
        info['name'] = name
        # expected values for a set of display pixels and a ROI
        DW, DH = (H, W) if orient in (6, 8) else (W, H)
        samples = []
        for (dx, dy) in [(0, 0), (1, 0), (DW - 1, DH - 1), (DW // 2, DH // 2), (5, 7)]:
            sx, sy = display_map(orient, W, H, dx, dy)
            vals = [px(sx, sy, c) for c in range(spp)]
            samples.append({'display': [dx, dy], 'storage': [sx, sy], 'values': vals})
        info['samples'] = samples
        cases.append(info)

    # oriented dimensions
    for info in cases:
        if info['orientation'] in (6, 8):
            info['displaySize'] = [info['height'], info['width']]
        else:
            info['displaySize'] = [info['width'], info['height']]

    # case with a missing tile in one channel only (planar RGB)
    W, H = 37, 23
    name = 'le_classic_rgb_planar_missing_channel'
    info = build_tiff(os.path.join(outdir, name + '.tif'), big=False, little=True,
                      width=W, height=H, spp=3, tile_w=16, tile_h=16,
                      orientation=1, planar=2, compression=8, predictor=2,
                      pixel_fn=px, missing=[7])
    info['name'] = name
    info['displaySize'] = [W, H]
    # tile 5 = channel 1, tile row 0, col 1 => x 16..31, y 0..15
    info['missingRect'] = [16, 0, 16, 16]
    # planar index = channel*across*down + tileRow*across + tileCol
    # channel 1, row 0, col 1 with across=3, down=2 => 7
    info['missingIndex'] = 7
    info['samples'] = [
        {'display': [20, 5], 'storage': [20, 5],
         'values': [px(20, 5, 0), None, px(20, 5, 2)], 'mask': 0},
        {'display': [2, 5], 'storage': [2, 5], 'values': [px(2, 5, c) for c in range(3)],
         'mask': 1},
    ]
    cases.append(info)

    # corrupt tile: point one offset+count at garbage
    name = 'le_classic_gray_corrupt'
    info = build_tiff(os.path.join(outdir, name + '.tif'), big=False, little=True,
                      width=32, height=32, spp=1, tile_w=16, tile_h=16,
                      orientation=1, planar=1, compression=8, predictor=2, pixel_fn=px)
    info['name'] = name
    info['displaySize'] = [32, 32]
    cases.append(info)

    # out-of-bounds offset tile
    name = 'le_classic_gray_oob'
    info = build_tiff(os.path.join(outdir, name + '.tif'), big=False, little=True,
                      width=32, height=32, spp=1, tile_w=16, tile_h=16,
                      orientation=1, planar=1, compression=8, predictor=2, pixel_fn=px)
    info['name'] = name
    info['displaySize'] = [32, 32]
    cases.append(info)

    # with subIFD overview
    name = 'be_big_rgb_orient6_subifd'
    info = build_tiff(os.path.join(outdir, name + '.tif'), big=True, little=False,
                      width=W, height=H, spp=3, tile_w=16, tile_h=16,
                      orientation=6, planar=2, compression=8, predictor=2,
                      pixel_fn=px,
                      sub={'width': 18, 'height': 11, 'tile_w': 16, 'tile_h': 16,
                           'pixel_fn': lambda sx, sy, c: (sx * 37 + sy * 11 + c * 101) & 0xffff})
    info['name'] = name
    info['displaySize'] = [H, W]
    info['subDisplaySize'] = [11, 18]
    info['samples'] = []
    for dx, dy in [(0, 0), (1, 0), (H - 1, W - 1), (5, 7)]:
        sx, sy = display_map(6, W, H, dx, dy)
        info['samples'].append({'display': [dx, dy], 'storage': [sx, sy],
                                'values': [px(sx, sy, c) for c in range(3)]})
    info['subSamples'] = []
    for dx, dy in [(0, 0), (5, 3)]:
        sx, sy = display_map(6, 18, 11, dx, dy)
        info['subSamples'].append({'display': [dx, dy], 'storage': [sx, sy],
                                   'values': [((sx * 37 + sy * 11 + c * 101) & 0xffff) for c in range(3)]})
    cases.append(info)

    with open(os.path.join(outdir, 'cases.json'), 'w') as f:
        json.dump(cases, f, indent=1)
    print('wrote', len(cases), 'cases to', outdir)


if __name__ == '__main__':
    main(sys.argv[1])
