"""用样例包验证指纹与投票是否符合 truth.json。运行: python3 -I tests/validate_samples.py"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.audio import read_wav
from app.fingerprint import fingerprint
from app.index import Index
from app.matcher import match

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "samples", "extracted")
DB = "/tmp/constellation_test/index.db"
WAV_DIR = "/tmp/constellation_test/wav"
os.makedirs("/tmp/constellation_test", exist_ok=True)
import shutil
if os.path.exists("/tmp/constellation_test"):
    shutil.rmtree("/tmp/constellation_test")

index = Index(DB, WAV_DIR)
for name in ["a.wav", "b.wav", "duplicate.wav"]:
    src = os.path.join(BASE, "library", name)
    index.add_file(src, name, sha256="test")

truth = json.load(open(os.path.join(BASE, "truth.json")))
print("truth:", truth)

for qname, expect_match in [("query.wav", True), ("silence.wav", False),
                            ("query-unrelated.wav", False)]:
    x = read_wav(os.path.join(BASE, qname))
    fp = fingerprint(x)
    print(f"\n=== {qname}: frames={fp.n_frames} peaks={len(fp.peaks)} "
          f"pairs={len(fp.pairs)} global_max={fp.global_max:.4e} silent={fp.silent}")
    results, records = match(fp, index)
    for r in results:
        mark = "可靠" if r.reliable else "不可靠"
        print(f"  {r.file_id:12s} d={r.offset_frame:6d} off_samples={r.offset_samples:7d} "
              f"votes={r.votes:4d} score={r.score:.3f} [{mark}]")
    reliable = [r for r in results if r.reliable]
    if expect_match:
        got = sorted(r.file_id for r in reliable)
        want = sorted(os.path.splitext(os.path.basename(p))[0] for p in truth["sources"])
        assert got == want, f"命中来源不符: {got} != {want}"
        for r in reliable:
            assert r.offset_samples == truth["offset_samples"], \
                f"{r.file_id} 偏移 {r.offset_samples} != {truth['offset_samples']}"
        print("  OK: 来源与偏移均符合 truth.json")
    else:
        assert not reliable, f"{qname} 不应有可靠匹配，却命中了 {[r.file_id for r in reliable]}"
        print("  OK: 无可靠匹配")

# 重复库内容校验: a 与 duplicate 应产生完全相同的配对数
fa = fingerprint(read_wav(os.path.join(BASE, "library", "a.wav")))
fd = fingerprint(read_wav(os.path.join(BASE, "library", "duplicate.wav")))
assert fa.n_pairs == fd.n_pairs and fa.peaks == fd.peaks
print("\nOK: duplicate.wav 与 a.wav 指纹完全一致，重复来源可同时列出")
index.close()
print("\n全部验证通过 ✔")
