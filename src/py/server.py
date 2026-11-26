#!/usr/bin/env python3
"""移动声源双耳校音台 —— 本地静态服务（纯标准库、离线可用）。

- 托管 src/web 下的页面与脚本。
- 首次启动把 samples/moving-audio.zip 解压到 samples/extracted/。
  压缩包内容视为不可信数据：只读提供、不执行；解压时跳越穿越路径与非白名单名。
- /api/samples 返回样例清单与 WAV 头元数据。

用法：python3 -I src/py/server.py --port 8000
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import struct
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent.parent
WEB_ROOT = ROOT / "src" / "web"
SAMPLES_DIR = ROOT / "samples"
EXTRACT_DIR = SAMPLES_DIR / "extracted"
ZIP_PATH = SAMPLES_DIR / "moving-audio.zip"

SAFE_NAME = re.compile(r"^[A-Za-z0-9_.\-]+$")


def ensure_samples() -> None:
    if not ZIP_PATH.is_file():
        return
    if (EXTRACT_DIR / "scene.json").is_file():
        return
    EXTRACT_DIR.mkdir(parents=True, exist_ok=True)
    root = EXTRACT_DIR.resolve()
    with zipfile.ZipFile(ZIP_PATH) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            rel = Path(info.filename)
            if rel.is_absolute() or any(part in ("", ".", "..") for part in rel.parts):
                continue
            if any(not SAFE_NAME.match(part) for part in rel.parts):
                continue
            target = EXTRACT_DIR.joinpath(*rel.parts)
            try:
                target.resolve().relative_to(root)
            except ValueError:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as src, open(target, "wb") as dst:
                dst.write(src.read())


def read_wav_meta(path: Path) -> dict | None:
    try:
        with open(path, "rb") as fh:
            head = fh.read(12 + 8 + 4096)
    except OSError:
        return None
    try:
        if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
            return None
        pos = 12
        fmt = None
        data_len = None
        while pos + 8 <= len(head):
            cid = head[pos : pos + 4]
            size = struct.unpack("<I", head[pos + 4 : pos + 8])[0]
            if cid == b"fmt ":
                fmt = head[pos + 8 : pos + 8 + size]
            elif cid == b"data":
                data_len = size
                break
            pos += 8 + size + (size & 1)
        if fmt is None or len(fmt) < 16 or data_len is None:
            return None
        tag, channels, rate, _byte_rate, align, bits = struct.unpack("<HHIIHH", fmt[:16])
        if tag == 0xFFFE and len(fmt) >= 40:
            tag = struct.unpack("<H", fmt[24:26])[0]
        if tag != 1:
            return None
        return {
            "sampleRate": rate,
            "channels": channels,
            "bitsPerSample": bits,
            "frames": data_len // align if align else 0,
        }
    except (OSError, struct.error):
        return None


def sample_manifest() -> dict:
    ensure_samples()
    wavs = []
    for name in ("bell.wav",):
        path = EXTRACT_DIR / name
        if not path.is_file():
            continue
        meta = read_wav_meta(path)
        entry = {"name": name}
        if meta:
            entry.update(meta)
        wavs.append(entry)
    scene = None
    scene_path = EXTRACT_DIR / "scene.json"
    if scene_path.is_file():
        try:
            scene = json.loads(scene_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            scene = None
    return {
        "available": (EXTRACT_DIR / "scene.json").is_file(),
        "scene": scene,
        "wavs": wavs,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "MovingSourceBench/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print("%s - %s" % (self.address_string(), fmt % args))

    def send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path) -> None:
        try:
            data = path.read_bytes()
        except OSError:
            self.send_error(404, "Not Found")
            return
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if path.suffix == ".js":
            ctype = "text/javascript; charset=utf-8"
        elif path.suffix in (".html", ".css", ".json", ".svg"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def safe_web_path(self, route: str) -> Path | None:
        if route in ("", "/"):
            return WEB_ROOT / "index.html"
        rel = route.lstrip("/")
        parts = Path(rel).parts
        if not parts or any(p in ("", ".", "..") for p in parts):
            return None
        target = WEB_ROOT.joinpath(*parts)
        try:
            target.resolve().relative_to(WEB_ROOT.resolve())
        except ValueError:
            return None
        return target if target.is_file() else None

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path
        if route == "/api/samples":
            self.send_json(sample_manifest())
            return
        if route == "/api/scene":
            scene_path = EXTRACT_DIR / "scene.json"
            if not scene_path.is_file():
                self.send_error(404, "Not Found")
                return
            self.send_file(scene_path)
            return
        if route == "/api/wav":
            from urllib.parse import parse_qs

            q = parse_qs(parsed.query)
            name = (q.get("name") or [""])[0]
            if not SAFE_NAME.match(name):
                self.send_error(400, "Bad Request")
                return
            path = EXTRACT_DIR / name
            try:
                path.resolve().relative_to(EXTRACT_DIR.resolve())
            except ValueError:
                self.send_error(400, "Bad Request")
                return
            if not path.is_file():
                self.send_error(404, "Not Found")
                return
            self.send_file(path)
            return
        target = self.safe_web_path(route)
        if target is None:
            self.send_error(404, "Not Found")
            return
        self.send_file(target)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    ensure_samples()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"移动声源双耳校音台：http://{args.host}:{args.port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
