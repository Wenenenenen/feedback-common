#!/usr/bin/env python3
"""Smoke-test a running service with the bundled requests.json transcript.

    python3 tools/smoke_http.py http://127.0.0.1:8765 samples/party-match-allocator-cases.zip

The transcript is replayed in order with its own requestKeys, then replayed a
second time to prove that idempotent retries return the original results.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_requests(archive_path: str) -> list[dict]:
    target = tempfile.mkdtemp(prefix="pma-smoke-")
    with zipfile.ZipFile(archive_path) as archive:
        with archive.open("requests.json") as source:
            data = json.loads(source.read().decode("utf-8"))
    return data


def call(base: str, method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        base + path, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def main(argv: list[str]) -> int:
    base = argv[1] if len(argv) > 1 else "http://127.0.0.1:8765"
    archive = argv[2] if len(argv) > 2 else os.path.join(
        ROOT, "samples", "party-match-allocator-cases.zip"
    )
    transcript = load_requests(archive)

    call(base, "POST", "/admin/reset", {})
    first: list[tuple[int, dict]] = []
    for step in transcript:
        status, body = call(base, step["method"], step["path"], step.get("body"))
        print(f"{step['method']:4} {step['path']:8} -> {status}")
        first.append((status, body))

    print("-- replay with the same requestKeys --")
    ok = True
    for step, (original_status, original_body) in zip(transcript, first):
        status, body = call(base, step["method"], step["path"], step.get("body"))
        same = status == original_status and body == original_body
        key = step["body"]["requestKey"]
        print(f"{key:12} -> {status} {'same' if same else 'DIFFERENT'}")
        ok = ok and same

    state_status, state = call(base, "GET", "/state")
    print(f"\n/state {state_status}: clock={state['clock']} rooms={len(state['rooms'])}")
    return 0 if ok and state_status == 200 else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
