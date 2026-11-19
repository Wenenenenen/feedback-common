#!/usr/bin/env python3
"""从 samples-extract 生成 JS 一致性测试向量。运行: python3 -I work/tools/gen_vectors.py"""
import base64
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from gwsv_ref import parse_save, encode_v2, semantic_key  # noqa: E402

ROOT = os.path.dirname(HERE)
SAMPLES = os.path.join(ROOT, "samples-extract")
OUT_DIR = os.path.join(ROOT, "test-vectors")
NAMES = ["world-v1.sav", "world-v2.sav", "stress.sav",
         "bad-crc.sav", "truncated.sav", "dangling.sav", "bad-index.sav"]


def main():
    vectors = []
    for name in NAMES:
        raw = open(os.path.join(SAMPLES, name), "rb").read()
        entry = {"name": name, "inputB64": base64.b64encode(raw).decode()}
        try:
            world, errors = parse_save(raw)
            entry["fatal"] = None
            entry["errors"] = errors
            entry["parsed"] = {
                "version": world["version"],
                "chunks": [{"coord": c["coord"], "voxels": c["voxels"],
                            "headOffset": c["headOffset"],
                            "payloadOffset": c["payloadOffset"],
                            "crcOffset": c["crcOffset"]} for c in world["chunks"]],
                "entities": [{"id": e["id"], "chunk": e["chunk"], "cell": e["cell"],
                              "links": e["links"], "offset": e["_offset"]}
                             for e in world["entities"]],
            }
            if not errors and all(c["voxels"] is not None for c in world["chunks"]):
                enc = encode_v2(world)
                entry["canonicalB64"] = base64.b64encode(enc).decode()
                entry["semantic"] = semantic_key(world)
        except Exception as ex:  # noqa: BLE001 - 致命结构错误也要记录进向量
            entry["fatal"] = {"msg": ex.msg, "offset": getattr(ex, "offset", None)}
        vectors.append(entry)

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "vectors.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(vectors, f, ensure_ascii=False)
    print(f"wrote {len(vectors)} vectors -> {out}")
    for v in vectors:
        print(f"  {v['name']:16s} fatal={bool(v['fatal'])} "
              f"errors={len(v.get('errors', []))} canonical={'canonicalB64' in v}")


if __name__ == "__main__":
    main()
