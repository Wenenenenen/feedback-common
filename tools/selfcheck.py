#!/usr/bin/env python3
"""Cross-check reference.py against the sample *-expected.json files."""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reference import analyze  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.normpath(os.path.join(HERE, "..", "samples", "extracted"))


def check(case):
    doc = json.load(open(os.path.join(SAMPLES, f"{case}.json")))
    expected_list = json.load(
        open(os.path.join(SAMPLES, f"{case}-expected.json")))
    ok = True
    for exp in expected_list:
        res = analyze(doc, exp["delay_ms"], exp["policy"])
        got_status = {v["id"]: v["status"] for v in result_verdicts(res)}
        got_slots = {(s["slot"]): (s["deadline_us"], s["source"])
                     for s in res["slots"]}
        sha = hashlib.sha256(res["pcm"]).hexdigest()

        status_match = got_status == exp["packets"]
        slot_match = all(
            got_slots[s["slot"]] == (s["deadline_us"], s["source"])
            for s in exp["slots"])
        sha_match = sha == exp["pcm_sha256"]
        length_ok = (len(res["pcm"]) ==
                     doc["total_packets"] * doc["frames_per_packet"]
                     * doc["channels"] * 2)
        print(f"{case:7s} delay={exp['delay_ms']:>2} policy={exp['policy']:12s} "
              f"status={'OK' if status_match else 'FAIL'} "
              f"slots={'OK' if slot_match else 'FAIL'} "
              f"length={'OK' if length_ok else 'FAIL'} "
              f"sha={'OK' if sha_match else 'FAIL'}")
        if not (status_match and slot_match and sha_match and length_ok):
            ok = False
            if not status_match:
                for pid, want in exp["packets"].items():
                    if got_status.get(pid) != want:
                        print("  status diff:", pid, "want", want,
                              "got", got_status.get(pid))
            if not sha_match:
                print("  want sha", exp["pcm_sha256"])
                print("  got  sha", sha)
    return ok


def result_verdicts(res):
    return res["verdicts"]


if __name__ == "__main__":
    all_ok = all([check("mono"), check("stereo")])
    sys.exit(0 if all_ok else 1)
