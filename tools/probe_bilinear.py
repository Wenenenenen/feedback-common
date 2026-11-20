#!/usr/bin/env python3
"""Python 侧双线性探针，与 probe_bilinear.mjs 输出逐值对拍。"""
import json
import sys

sys.path.insert(0, "/home/wendy/jianzhi/feedback-tasks/lobe-cubemap-baker/tools")
from reference_bake import CubeEnv  # noqa: E402

env_path, dirs_path, js_path = sys.argv[1:4]
data = json.load(open(env_path, "r", encoding="utf-8"))
env = CubeEnv(data["size"], data["faces"])
dirs = json.load(open(dirs_path, "r", encoding="utf-8"))
js = json.load(open(js_path, "r", encoding="utf-8"))
worst = 0.0
worst_item = None
for idx, d in enumerate(dirs):
    py_val = env.sample_bilinear_dir(d)
    js_val = js[idx]
    for k in range(3):
        e = abs(py_val[k] - js_val[k])
        if e > worst:
            worst, worst_item = e, (idx, d, py_val, js_val)
print("双线性对拍 2000 方向, 最大差", worst)
if worst_item:
    print("最坏项", json.dumps(worst_item))
# 再对拍选面/uv
from reference_bake import dir_to_face_uv  # noqa: E402
face_worst = 0.0
for d in dirs:
    _, u, v = dir_to_face_uv(d)
    face_worst = max(face_worst, abs(u), abs(v))
print("选面后 |u|,|v| 最大", face_worst)
