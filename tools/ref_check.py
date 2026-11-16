#!/usr/bin/env python3
"""Reference implementation of the YUV420 layout/color rules, used to
validate the in-browser implementation against checks.json.

Run with isolated mode:
  python3 -I tools/ref_check.py <samples_dir>
"""
import json
import math
import os
import sys


def ceil_div(a, b):
    return -(-a // b)


def load_layout(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def validate(raw, cfg):
    width = cfg["width"]
    height = cfg["height"]
    frames = cfg["frames"]
    bits = cfg["bits"]
    frame_bytes = cfg["frame_bytes"]
    if len(raw) != frame_bytes * frames:
        raise ValueError(
            f"文件长度 {len(raw)} 不等于 frame_bytes({frame_bytes}) × frames({frames}) "
            f"= {frame_bytes * frames}（截断或冗余）"
        )
    if bits not in (8, 10):
        raise ValueError(f"不支持的位深 {bits}，仅支持 8 或 10")
    bytes_per_sample = 1 if bits == 8 else 2
    cw = ceil_div(width, 2)
    ch = ceil_div(height, 2)
    dims = {"Y": (width, height), "U": (cw, ch), "V": (cw, ch)}

    row_intervals = {"Y": [], "U": [], "V": []}
    for name in ("Y", "U", "V"):
        plane = cfg["planes"][name]
        p_off = plane["offset"]
        p_stride = plane["stride"]
        pw, ph = dims[name]
        line_bytes = pw * bytes_per_sample
        if p_stride < line_bytes:
            raise ValueError(
                f"{name} 平面 stride({p_stride}) 小于一行有效字节 {line_bytes}"
            )
        if p_off < 0:
            raise ValueError(f"{name} 平面 offset 为负")
        end = p_off + (ph - 1) * p_stride + line_bytes
        if end > frame_bytes:
            raise ValueError(
                f"{name} 平面有效范围 [{p_off}, {end}) 超出 frame_bytes={frame_bytes}"
            )
        for row in range(ph):
            start = p_off + row * p_stride
            row_intervals[name].append((start, start + line_bytes))

    names = ("Y", "U", "V")
    for i in range(3):
        for j in range(i + 1, 3):
            for s1, e1 in row_intervals[names[i]]:
                if any(
                    max(s1, s2) < min(e1, e2)
                    for s2, e2 in row_intervals[names[j]]
                ):
                    raise ValueError(
                        f"平面 {names[i]} 与 {names[j]} 的有效字节重叠"
                    )

    if bits == 10:
        # high 6 bits of every *valid* sample must be zero (padding bytes
        # in stride gaps are unconstrained)
        for name in ("Y", "U", "V"):
            plane = cfg["planes"][name]
            pw, ph = dims[name]
            for f in range(frames):
                for row in range(ph):
                    base = f * frame_bytes + plane["offset"] + row * plane["stride"]
                    for col in range(pw):
                        idx = base + col * 2
                        v = raw[idx] | (raw[idx + 1] << 8)
                        if v & 0xFC00:
                            raise ValueError(
                                f"{name} 平面第 {f} 帧 ({col},{row}) 处"
                                f"10 位数据高 6 位非零（值=0x{v:04x}）"
                            )


def read_sample(raw, frame_bytes, frame, offset, stride, col, row, bits):
    base = frame * frame_bytes + offset + row * stride
    if bits == 8:
        return raw[base + col]
    lo = raw[base + col * 2]
    hi = raw[base + col * 2 + 1]
    return lo | (hi << 8)


def sample_chroma(raw, cfg, frame, plane_name, x, y, siting):
    cw = ceil_div(cfg["width"], 2)
    ch = ceil_div(cfg["height"], 2)
    plane = cfg["planes"][plane_name]
    bits = cfg["bits"]
    # chroma sample center position in luma coordinate space
    if siting == "center":
        gx = (x - 0.5) / 2.0
    else:  # left
        gx = x / 2.0
    gy = (y - 0.5) / 2.0

    x0 = math.floor(gx)
    y0 = math.floor(gy)
    fx = gx - x0
    fy = gy - y0
    x1 = x0 + 1
    y1 = y0 + 1
    # clamp out-of-range coordinates before interpolation
    cx0 = min(max(x0, 0), cw - 1)
    cy0 = min(max(y0, 0), ch - 1)
    cx1 = min(max(x1, 0), cw - 1)
    cy1 = min(max(y1, 0), ch - 1)

    def at(c, r):
        return read_sample(
            raw, cfg["frame_bytes"], frame,
            plane["offset"], plane["stride"], c, r, bits,
        )

    v00 = at(cx0, cy0)
    v10 = at(cx1, cy0)
    v01 = at(cx0, cy1)
    v11 = at(cx1, cy1)
    top = v00 * (1 - fx) + v10 * fx
    bot = v01 * (1 - fx) + v11 * fx
    return top * (1 - fy) + bot * fy


MATRICES = {
    "601": (0.299, 0.114),
    "709": (0.2126, 0.0722),
}


def convert(raw, cfg, frame, x, y, matrix, rng, siting):
    bits = cfg["bits"]
    s = 1 << (bits - 8)
    m = (1 << bits) - 1
    yplane = cfg["planes"]["Y"]
    raw_y = read_sample(
        raw, cfg["frame_bytes"], frame,
        yplane["offset"], yplane["stride"], x, y, bits,
    )
    u = sample_chroma(raw, cfg, frame, "U", x, y, siting)
    v = sample_chroma(raw, cfg, frame, "V", x, y, siting)

    if rng == "limited":
        yn = (raw_y - 16 * s) / (219 * s)
        cb = (u - 128 * s) / (224 * s)
        cr = (v - 128 * s) / (224 * s)
    else:
        yn = raw_y / m
        cb = (u - 128 * s) / m
        cr = (v - 128 * s) / m

    kr, kb = MATRICES[matrix]
    kg = 1 - kr - kb
    r = yn + 2 * (1 - kr) * cr
    b = yn + 2 * (1 - kb) * cb
    g = (yn - kr * r - kb * b) / kg

    def quant(v):
        c = min(max(v, 0.0), 1.0)
        return math.floor(c * 255 + 0.5)

    return {
        "rawY": raw_y,
        "u": u,
        "v": v,
        "rgb_pre": (r, g, b),
        "rgb": (quant(r), quant(g), quant(b)),
    }


def main():
    samples = sys.argv[1]
    with open(os.path.join(samples, "checks.json"), "r", encoding="utf-8") as f:
        checks = json.load(f)
    failures = 0
    for c in checks:
        cfg = load_layout(os.path.join(samples, c["file"] + ".json"))
        with open(os.path.join(samples, c["file"] + ".raw"), "rb") as f:
            raw = f.read()
        validate(raw, cfg)
        out = convert(raw, cfg, c["frame"], c["x"], c["y"],
                      c["matrix"], c["range"], c["siting"])
        got = list(out["rgb"])
        exp = c["rgb"]
        diffs = [abs(a - b) for a, b in zip(got, exp)]
        if max(diffs) > 1:
            failures += 1
            print("FAIL", c, "got", got)
    print(f"{len(checks) - failures}/{len(checks)} checks within 1 code value")

    # negative cases
    with open(os.path.join(samples, "odd-10.json"), "r", encoding="utf-8") as f:
        cfg10 = json.load(f)
    neg = [
        ("invalid-high-bits.raw", cfg10),
        ("invalid-short.raw", cfg10),
        ("invalid-stride.json", None),
        ("invalid-overlap.json", None),
    ]
    for name, cfg in neg:
        path = os.path.join(samples, name)
        if name.endswith(".raw"):
            with open(path, "rb") as f:
                raw = f.read()
            try:
                validate(raw, cfg)
                print("NO ERROR RAISED for", name)
                failures += 1
            except ValueError as e:
                print("OK error:", name, "->", e)
        else:
            with open(path, "r", encoding="utf-8") as f:
                bad_cfg = json.load(f)
            with open(os.path.join(samples, "odd-10.raw"), "rb") as f:
                raw = f.read()
            try:
                validate(raw, bad_cfg)
                print("NO ERROR RAISED for", name)
                failures += 1
            except ValueError as e:
                print("OK error:", name, "->", e)

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
