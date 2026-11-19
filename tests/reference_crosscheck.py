#!/usr/bin/env python3
"""
reference_crosscheck.py — 用 numpy 的 FFT 作为独立参照，
对样例 PNG 验证 dsp.js 导出的流水线结果（通过 node 桥接生成 JSON）。

安全：使用 -I 运行，样例路径由命令行参数传入。
用法：
  python3 -I tests/reference_crosscheck.py <samples_dir>
  （内部会调用 node 生成 JS 侧结果到临时 JSON）
"""
import json
import math
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

TOL_ABS = 1e-8


def next_pow2(n):
    if n <= 1:
        return 1
    return 1 << (n - 1).bit_length()


def srgb_to_lin(c):
    v = c / 255.0
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def reflect101_pad(a, W, H):
    h, w = a.shape
    out = np.zeros((H, W), dtype=np.float64)

    def idx(i, n):
        if n == 1:
            return 0
        period = 2 * (n - 1)
        m = i % period
        return m if m < n else period - m

    ys = np.array([idx(y, h) for y in range(H)])
    xs = np.array([idx(x, w) for x in range(W)])
    return a[np.ix_(ys, xs)]


def wrap_delta(a, b, N):
    d = (a - b) % N
    return np.where(d > N / 2, d - N, d)


def build_filter(W, H, notches):
    Hf = np.ones((H, W), dtype=np.float64)
    seen = set()
    centers = []
    for nt in notches:
        u, v = nt['u'] % W, nt['v'] % H
        for cu, cv in ((u, v), ((-u) % W, (-v) % H)):
            if (cu, cv) not in seen:
                seen.add((cu, cv))
                centers.append((cu, cv, nt['sigma'], nt['strength']))
    uu, vv = np.meshgrid(np.arange(W), np.arange(H))
    for cu, cv, sigma, strength in centers:
        du = wrap_delta(uu, cu, W)
        dv = wrap_delta(vv, cv, H)
        d2 = du ** 2 + dv ** 2
        Hf *= 1 - strength * np.exp(-d2 / (2 * sigma ** 2))
    Hf[0, 0] = 1.0
    return Hf, centers


def run_reference(img_path, mode, notches):
    im = Image.open(img_path).convert('RGB')
    arr = np.asarray(im, dtype=np.float64)
    h, w, _ = arr.shape
    W, H = next_pow2(w), next_pow2(h)
    lin = srgb_to_lin(arr)
    padded = np.zeros((H, W, 3))
    for ch in range(3):
        if mode == 'zero':
            padded[:h, :w, ch] = lin[:, :, ch]
        else:
            padded[:, :, ch] = reflect101_pad(lin[:, :, ch], W, H)

    Hf, centers = build_filter(W, H, notches)
    out_lin = np.zeros((h, w, 3))
    max_imag = 0.0
    before_means, after_means = [], []
    notch_before, notch_after = [], []
    spectra = []
    for ch in range(3):
        spec = np.fft.fft2(padded[:, :, ch])  # numpy: 前向不归一化、逆向除 N
        spectra.append(spec)
        filt = spec * Hf
        inv = np.fft.ifft2(filt)
        max_imag = max(max_imag, float(np.abs(inv.imag[:h, :w]).max()))
        out_lin[:, :, ch] = inv.real[:h, :w]
        before_means.append(float(lin[:, :, ch].mean()))
        after_means.append(float(inv.real[:h, :w].mean()))
    for cu, cv, sigma, strength in centers:
        notch_before.append(float(np.abs(spectra[0][cv, cu])))
        notch_after.append(float(np.abs(spectra[0][cv, cu] * Hf[cv, cu])))
    return {
        'width': w, 'height': h, 'W': W, 'H': H,
        'maxImag': max_imag,
        'beforeMeans': before_means, 'afterMeans': after_means,
        'notchBefore': notch_before, 'notchAfter': notch_after,
        'outLin': out_lin,
    }


def main():
    samples = sys.argv[1]
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    bridge = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'js_bridge.js')

    cases = [
        ('stripe.png', 'reflect101', [{'u': 16, 'v': 0, 'sigma': 0.6, 'strength': 1}]),
        ('nyquist.png', 'reflect101', [{'u': 64, 'v': 0, 'sigma': 0.6, 'strength': 1}]),
        ('odd.png', 'zero', []),
        ('odd.png', 'reflect101', [{'u': 7, 'v': 5, 'sigma': 1.2, 'strength': 0.8}]),
    ]
    failures = 0
    for name, mode, notches in cases:
        img_path = os.path.join(samples, name)
        with tempfile.TemporaryDirectory() as td:
            js_out = os.path.join(td, 'js.json')
            subprocess.run(
                ['node', bridge, img_path, mode, json.dumps(notches), js_out],
                check=True, cwd=repo,
            )
            with open(js_out) as f:
                js = json.load(f)
        ref = run_reference(img_path, mode, notches)

        print(f'== {name} / {mode} / {len(notches)} 组陷波 ==')
        ok = (js['W'] == ref['W'] and js['H'] == ref['H'])
        print(f"  填充尺寸 JS=({js['W']}x{js['H']}) ref=({ref['W']}x{ref['H']})  {'OK' if ok else 'FAIL'}")
        failures += not ok

        e1 = abs(js['maxImag'] - ref['maxImag'])
        ok = e1 < TOL_ABS
        print(f"  最大虚部  JS={js['maxImag']:.3e} ref={ref['maxImag']:.3e} err={e1:.2e}  {'OK' if ok else 'FAIL'}")
        failures += not ok

        e2 = max(abs(a - b) for a, b in zip(js['beforeMeans'], ref['beforeMeans']))
        e3 = max(abs(a - b) for a, b in zip(js['afterMeans'], ref['afterMeans']))
        ok = e2 < TOL_ABS and e3 < TOL_ABS
        print(f"  均值误差  before={e2:.2e} after={e3:.2e}  {'OK' if ok else 'FAIL'}")
        failures += not ok

        e4 = max((abs(a - b) for a, b in zip(js['notchBefore'], ref['notchBefore'])), default=0.0)
        e5 = max((abs(a - b) for a, b in zip(js['notchAfter'], ref['notchAfter'])), default=0.0)
        ok = e4 < TOL_ABS and e5 < TOL_ABS
        print(f"  陷波幅值误差  before={e4:.2e} after={e5:.2e}  {'OK' if ok else 'FAIL'}")
        failures += not ok

        # 逐像素线性输出
        js_lin = np.array(js['outLin'], dtype=np.float64).reshape(ref['outLin'].shape)
        e6 = float(np.abs(js_lin - ref['outLin']).max())
        ok = e6 < TOL_ABS
        print(f"  逆变换逐像素最大误差 = {e6:.2e}  {'OK' if ok else 'FAIL'}")
        failures += not ok

    print()
    if failures:
        print(f'{failures} 项对照失败')
        sys.exit(1)
    print('全部与 numpy 参照一致（容差 %g）' % TOL_ABS)


if __name__ == '__main__':
    main()
