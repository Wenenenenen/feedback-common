#!/usr/bin/env python3 -I
"""独立第三方复核：读取浏览器导出的 NNF / 快照 / 参数，用 stdlib 重算误差与合法性。"""
import json, struct, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from inspect_samples import read_png

base = os.path.join(os.path.dirname(__file__), '..', 'test-output', 'downloads')
samples = os.path.join(os.path.dirname(__file__), '..', '_samples_extracted')

params = json.load(open(os.path.join(base, 'inpaint-params.json'), encoding='utf-8'))
W, H = params['width'], params['height']
P = params['parameters']['patchSize']
r = (P - 1) // 2

# 原图（供体源）与掩膜
_, _, _, _, _, orig = read_png(os.path.join(samples, 'small-hole.png'))
_, _, _, _, mch, maskraw = read_png(os.path.join(samples, 'small-hole-mask.png'))
mask = [255 if maskraw[i] >= 128 else 0 for i in range(W * H)]
# 目标快照
_, _, _, _, _, snap = read_png(os.path.join(base, 'target-snapshot.png'))

nnf = open(os.path.join(base, 'nnf-int32le.bin'), 'rb').read()
assert len(nnf) == W * H * 8, len(nnf)

illegal = 0
ssum = cnt = 0
max_mse = 0.0
for i in range(W * H):
    sx, sy = struct.unpack_from('<ii', nnf, i * 8)
    if mask[i] != 255:
        assert sx == -1 and sy == -1, f'非掩膜位应为(-1,-1), 得到({sx},{sy})'
        continue
    # 合法性：整个源 patch 在界内且全为已知
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            x, y = sx + dx, sy + dy
            assert 0 <= x < W and 0 <= y < W and 0 <= y < H
            if mask[y * W + x] == 255:
                illegal += 1
    # 重算 MSE（目标越界偏移忽略）
    tx, ty = i % W, i // W
    ps = pc = 0
    for dy in range(-r, r + 1):
        tyy = ty + dy
        if not (0 <= tyy < H):
            continue
        for dx in range(-r, r + 1):
            txx = tx + dx
            if not (0 <= txx < W):
                continue
            for c in range(3):
                d = snap[(tyy * W + txx) * 3 + c] - orig[((sy + dy) * W + (sx + dx)) * 3 + c]
                ps += d * d
                pc += 1
    mse = ps / pc / (255 * 255)
    ssum += mse
    cnt += 1
    max_mse = max(max_mse, mse)

mean = ssum / cnt
print(f'复核目标像素: {cnt}')
print(f'非法供体 patch: {illegal}')
print(f'平均归一化 MSE: {mean:.3e}')
print(f'最大单 patch MSE: {max_mse:.3e}')
print(f'JSON 记录 meanMse: {params["verification"]["meanMse"]:.3e}')
assert illegal == 0
assert abs(mean - params['verification']['meanMse']) < 1e-12
assert abs(max_mse - params['verification']['maxMse']) < 1e-12
# 验收：周期纹理小缺口 MAE <= 8（这里用最终修补图对真值）
_, _, _, _, _, truth = read_png(os.path.join(samples, 'small-hole-truth.png'))
_, _, _, _, _, out = read_png(os.path.join(base, 'inpainted.png'))
mae_sum = mae_cnt = 0
for i in range(W * H):
    if mask[i] == 255:
        for c in range(3):
            mae_sum += abs(out[i * 3 + c] - truth[i * 3 + c])
            mae_cnt += 1
print(f'掩膜内 MAE（灰度级）: {mae_sum / mae_cnt:.3f}（上限 8）')
assert mae_sum / mae_cnt <= 8
print('INDEPENDENT VERIFICATION PASSED')
