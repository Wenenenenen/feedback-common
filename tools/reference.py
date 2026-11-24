#!/usr/bin/env python3
"""片元四格组校验器的独立 Python 参考实现。

用法:
  python3 -I reference.py <package.json>            # 输出完整结果 JSON
  python3 -I reference.py --frame <package.json>    # 仅输出帧 (rgb/alpha)
输出 JSON 含 frame、每条纹理指令各车道的 lod 与采样值、舍弃标记。
"""
import argparse
import json
import math
import sys


def mod(n, m):
    return n - math.floor(n / m) * m


class RefError(Exception):
    pass


class Engine:
    OPS = {"常量", "加", "乘", "细横", "细纵", "粗横", "粗纵", "舍弃", "纹理"}

    def __init__(self, pkg):
        self.pkg = pkg
        self.validate()

    def validate(self):
        p = self.pkg
        for key in ("width", "height", "quads", "program", "out", "mips"):
            if key not in p:
                raise RefError(f"缺少字段 {key}")
        self.W, self.H = int(p["width"]), int(p["height"])
        if not (1 <= self.W <= 512 and 1 <= self.H <= 512):
            raise RefError("画面尺寸越界")
        if not isinstance(p["quads"], list) or not p["quads"]:
            raise RefError("quads 非法")
        for q, qd in enumerate(p["quads"]):
            if qd["x"] % 2 or qd["y"] % 2 or not (0 <= qd["x"] < self.W and 0 <= qd["y"] < self.H):
                raise RefError(f"quads[{q}] 原点须为画面内偶数坐标")
            if not (0 <= qd["mask"] <= 15):
                raise RefError(f"quads[{q}] mask 非法")
            for l, (lx, ly) in enumerate((
                (qd["x"], qd["y"]), (qd["x"] + 1, qd["y"]),
                (qd["x"], qd["y"] + 1), (qd["x"] + 1, qd["y"] + 1),
            )):
                inb = 0 <= lx < self.W and 0 <= ly < self.H
                if not inb and (qd["mask"] >> l) & 1:
                    raise RefError(f"quads[{q}] 第{l}格越界但置位")
        seen = set()
        for qd in p["quads"]:
            k = (qd["x"], qd["y"], qd["id"])
            if k in seen:
                raise RefError(f"位置+id 重复 {k}")
            seen.add(k)
        self.mips = []
        for i, m in enumerate(p["mips"]):
            if i > 0:
                pw, ph = self.mips[-1][0], self.mips[-1][1]
                exp = (max(1, pw // 2), max(1, ph // 2))
                if (m["width"], m["height"]) != exp:
                    raise RefError(f"mips[{i}] 尺寸应为 {exp}")
            if ("rgb" in m) == ("pixels" in m):
                raise RefError(f"mips[{i}] 须二选一提供 rgb/pixels")
            if "rgb" in m:
                self.mips.append((m["width"], m["height"], list(m["rgb"]), None))
            else:
                self.mips.append((m["width"], m["height"], None, [list(c) for c in m["pixels"]]))
        if self.mips[-1][0] != 1 or self.mips[-1][1] != 1:
            raise RefError("mips 链未到 1×1")
        for i, ins in enumerate(p["program"], 1):
            if ins[0] not in self.OPS:
                raise RefError(f"第{i}行未知操作码 {ins[0]}")
            if ins[0] == "纹理" and not (0 <= ins[4] <= 2):
                raise RefError(f"第{i}行通道编号非法")
        if len(p["out"]) != 3:
            raise RefError("out 须 3 个寄存器")

    def texel(self, layer_idx, x, y, ch):
        w, h, const_rgb, pixels = self.mips[layer_idx]
        if const_rgb is not None:
            return const_rgb[ch]
        return pixels[y * w + x][ch]

    def bilinear(self, layer_idx, u, v, ch):
        w, h, _, _ = self.mips[layer_idx]
        s, t = u * w - 0.5, v * h - 0.5
        i0, j0 = math.floor(s), math.floor(t)
        fx, fy = s - i0, t - j0
        x0, x1 = mod(i0, w), mod(i0 + 1, w)
        y0, y1 = mod(j0, h), mod(j0 + 1, h)
        return (
            self.texel(layer_idx, x0, y0, ch) * (1 - fx) * (1 - fy)
            + self.texel(layer_idx, x1, y0, ch) * fx * (1 - fy)
            + self.texel(layer_idx, x0, y1, ch) * (1 - fx) * fy
            + self.texel(layer_idx, x1, y1, ch) * fx * fy
        )

    def run(self):
        p = self.pkg
        N = len(p["quads"])
        lanes = 4 * N
        regs = {name: [0.0] * lanes for name in set(p["out"]) | {"u", "v"}}

        def ensure(name):
            if name not in regs:
                regs[name] = [0.0] * lanes

        for q, qd in enumerate(p["quads"]):
            for l in range(4):
                regs["u"][4 * q + l] = float(qd["uv"][l][0])
                regs["v"][4 * q + l] = float(qd["uv"][l][1])

        discard = [0] * lanes
        covered = [0] * lanes
        lane_pixel = [-1] * lanes
        for q, qd in enumerate(p["quads"]):
            pos = ((qd["x"], qd["y"]), (qd["x"] + 1, qd["y"]),
                   (qd["x"], qd["y"] + 1), (qd["x"] + 1, qd["y"] + 1))
            for l in range(4):
                if (qd["mask"] >> l) & 1:
                    g = 4 * q + l
                    covered[g] = 1
                    lane_pixel[g] = pos[l][1] * self.W + pos[l][0]

        tex_logs = []
        L = len(self.mips) - 1
        base_w, base_h = self.mips[0][0], self.mips[0][1]
        written = {"u", "v"}

        def operand(token, g):
            if isinstance(token, (int, float)):
                return float(token)
            if token not in written:
                raise RefError(f"读取未写入寄存器 {token}")
            return regs[token][g]

        for line, ins in enumerate(p["program"], 1):
            op = ins[0]
            if op == "常量":
                _, tgt, val = ins
                ensure(tgt)
                for g in range(lanes):
                    regs[tgt][g] = float(val)
                written.add(tgt)
            elif op in ("加", "乘"):
                _, tgt, a, b = ins
                ensure(tgt)
                for g in range(lanes):
                    av = operand(a, g)
                    bv = operand(b, g)
                    regs[tgt][g] = av + bv if op == "加" else av * bv
                written.add(tgt)
            elif op in ("细横", "细纵", "粗横", "粗纵"):
                _, tgt, src = ins
                ensure(tgt)
                S = regs[src]
                for q in range(N):
                    b = 4 * q
                    if op == "细横":
                        d0, d2 = S[b + 1] - S[b], S[b + 3] - S[b + 2]
                        regs[tgt][b], regs[tgt][b + 1] = d0, d0
                        regs[tgt][b + 2], regs[tgt][b + 3] = d2, d2
                    elif op == "细纵":
                        d0, d1 = S[b + 2] - S[b], S[b + 3] - S[b + 1]
                        regs[tgt][b], regs[tgt][b + 2] = d0, d0
                        regs[tgt][b + 1], regs[tgt][b + 3] = d1, d1
                    elif op == "粗横":
                        d = S[b + 1] - S[b]
                        for l in range(4):
                            regs[tgt][b + l] = d
                    else:
                        d = S[b + 2] - S[b]
                        for l in range(4):
                            regs[tgt][b + l] = d
                written.add(tgt)
            elif op == "舍弃":
                _, a, b = ins
                for g in range(lanes):
                    if operand(a, g) < operand(b, g):
                        discard[g] = 1
            else:  # 纹理
                _, tgt, uname, vname, ch = ins
                ensure(tgt)
                RU, RV = regs[uname], regs[vname]
                lod_out, res_out = [0.0] * lanes, [0.0] * lanes
                for q in range(N):
                    b = 4 * q
                    fdx = [RU[b + 1] - RU[b]] * 2 + [RU[b + 3] - RU[b + 2]] * 2
                    gdx = [RV[b + 1] - RV[b]] * 2 + [RV[b + 3] - RV[b + 2]] * 2
                    fdy = [RU[b + 2] - RU[b], RU[b + 3] - RU[b + 1],
                           RU[b + 2] - RU[b], RU[b + 3] - RU[b + 1]]
                    gdy = [RV[b + 2] - RV[b], RV[b + 3] - RV[b + 1],
                           RV[b + 2] - RV[b], RV[b + 3] - RV[b + 1]]
                    for l in range(4):
                        g = b + l
                        ax, ay = fdx[l] * base_w, gdx[l] * base_h
                        bx, by = fdy[l] * base_w, gdy[l] * base_h
                        rho = max(math.hypot(ax, ay), math.hypot(bx, by))
                        lod = 0.0 if rho == 0 else min(max(math.log2(rho), 0.0), float(L))
                        lod_out[g] = lod
                        u, v = RU[g], RV[g]
                        k = math.floor(lod)
                        if k >= L:
                            val = self.bilinear(L, u, v, ch)
                        else:
                            f = lod - k
                            val = (1 - f) * self.bilinear(k, u, v, ch) + f * self.bilinear(k + 1, u, v, ch)
                        regs[tgt][g] = val
                        res_out[g] = val
                written.add(tgt)
                tex_logs.append({"line": line, "lod": lod_out, "result": res_out})

        # 深度选择
        win = {}
        for g in range(lanes):
            if not covered[g] or discard[g]:
                continue
            px = lane_pixel[g]
            q, l = divmod(g, 4)
            z, ident = p["quads"][q]["z"][l], p["quads"][q]["id"]
            if px not in win or (z, ident, g) < (win[px][0], win[px][1], win[px][2]):
                win[px] = (z, ident, g)

        rgb = [0.0] * (self.W * self.H * 3)
        alpha = [0] * (self.W * self.H)
        win_lane = [-1] * (self.W * self.H)
        for px, (_, _, g) in win.items():
            win_lane[px] = g
            alpha[px] = 1
            for c, name in enumerate(p["out"]):
                rgb[3 * px + c] = regs[name][g]

        return {
            "frame": {"rgb": rgb, "alpha": alpha, "winLane": win_lane},
            "discard": discard,
            "covered": covered,
            "regs": regs,
            "texLogs": tex_logs,
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("package")
    ap.add_argument("--frame", action="store_true")
    args = ap.parse_args()
    with open(args.package, "r", encoding="utf-8") as f:
        pkg = json.load(f)
    eng = Engine(pkg)
    out = eng.run()
    if args.frame:
        out = {"frame": out["frame"]}
    else:
        out = {k: v for k, v in out.items() if k != "regs"}
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
