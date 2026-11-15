#!/usr/bin/env python3
"""本地静态服务：纯标准库、离线可用。

- 托管 src/web 下的页面与脚本。
- 启动时把 samples/ambisonic-cases.zip 解压到 samples/extracted/。
  压缩包内容视为不可信数据：只读提供，不执行，路径做白名单校验。
- /api/samples 返回样例清单与元数据（WAV 头解析，不加载音频）。
- /api/conventions 返回包内 conventions.json。
- /api/sample?path=... 以白名单方式提供解压后的样例文件。

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
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent.parent
WEB_ROOT = ROOT / "src" / "web"
SAMPLES_DIR = ROOT / "samples"
EXTRACT_DIR = SAMPLES_DIR / "extracted"
ZIP_PATH = SAMPLES_DIR / "ambisonic-cases.zip"

SAFE_NAME = re.compile(r"^[A-Za-z0-9_.\-]+$")
MAX_REQUEST_BODY = 1024 * 1024

# 样例案例：id -> 页面预置行为。文件本身从 zip 解压目录读取。
WAV_CASES = [
    {
        "id": "ambix48",
        "title": "AmbiX · 48 kHz / 24-bit（前向脉冲）",
        "description": "四声道前向正负脉冲串。旋转 yaw 时 X 与 Y 的成分直接互换，最易听出方向。",
        "path": "ambix-48000-24.wav",
        "preset": {"inputFormat": "ambix", "mode": "static", "yaw": 0, "pitch": 0, "roll": 0},
    },
    {
        "id": "ambix44",
        "title": "AmbiX · 44.1 kHz / 16-bit",
        "description": "同一前向脉冲串的 44.1 kHz / 16-bit 版本，用于核对采样率与位深路径。",
        "path": "ambix-44100-16.wav",
        "preset": {"inputFormat": "ambix", "mode": "static", "yaw": 0, "pitch": 0, "roll": 0},
    },
    {
        "id": "fuma48",
        "title": "FuMa · 48 kHz / 24-bit（同一信号）",
        "description": "同一前向脉冲串的 FuMa 版本：W 为 AmbiX 的 1/√2，通道序为 W X Y Z。",
        "path": "fuma-48000-24.wav",
        "preset": {"inputFormat": "fuma", "mode": "static", "yaw": 0, "pitch": 0, "roll": 0},
    },
    {
        "id": "reference",
        "title": "参考自动旋转（AmbiX + 关键帧）",
        "description": "载入 ambix-48000-24.wav 与 automation.json，并与 reference-automated-48000-24.wav 逐点核对。",
        "path": "ambix-48000-24.wav",
        "automation": "automation.json",
        "reference": "reference-automated-48000-24.wav",
        "preset": {"inputFormat": "ambix", "mode": "automation", "outputFormat": "ambix"},
    },
    {
        "id": "overload",
        "title": "溢出样例（yaw=45° 时 Y > 1）",
        "description": "常量声场 X=Y=0.8。主动旋转 yaw=45° 后 Y≈1.131，超出 [-1,1)，应阻止 PCM 导出。",
        "path": "overload-48000-24.wav",
        "preset": {"inputFormat": "ambix", "mode": "static", "yaw": 45, "pitch": 0, "roll": 0},
    },
]

JSON_CASES = [
    {
        "id": "automation",
        "title": "automation.json（有效）",
        "description": "6 个关键帧，覆盖端点保持、最短弧翻转与近零分量归一化。",
        "path": "automation.json",
    },
    {
        "id": "invalid-zero",
        "title": "invalid-zero.json（零四元数）",
        "description": "应被拒绝：四元数 [0,0,0,0]。",
        "path": "invalid-zero.json",
    },
    {
        "id": "invalid-duplicate",
        "title": "invalid-duplicate.json（重复帧）",
        "description": "应被拒绝：两个关键帧都在 frame 0。",
        "path": "invalid-duplicate.json",
    },
]


def ensure_samples() -> None:
    """解压样例包（只读、防穿越、只解正规文件）。"""
    if not ZIP_PATH.is_file():
        return
    if (EXTRACT_DIR / "conventions.json").is_file():
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
    """只解析 WAV 头，用于样例清单展示。损坏或非 PCM 时返回 None。"""
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
        while pos + 8 <= len(head):
            cid = head[pos : pos + 4]
            size = struct.unpack("<I", head[pos + 4 : pos + 8])[0]
            body = head[pos + 8 : pos + 8 + size]
            if cid == b"fmt ":
                fmt = body
            pos += 8 + size + (size & 1)
        if fmt is None or len(fmt) < 16:
            return None
        tag, channels, rate, _, align, bits = struct.unpack("<HHIIHH", fmt[:16])
        if tag == 0xFFFE and len(fmt) >= 40:
            tag = struct.unpack("<H", fmt[24:26])[0]
        if tag != 1:
            return None
        frames = (path.stat().st_size - 44) // align if path.stat().st_size > 44 else 0
        return {
            "sampleRate": rate,
            "channels": channels,
            "bitsPerSample": bits,
            "frames": frames,
        }
    except (OSError, struct.error):
        return None


def sample_manifest() -> dict:
    ensure_samples()
    wavs = []
    for case in WAV_CASES:
        path = EXTRACT_DIR / case["path"]
        if not path.is_file():
            continue
        entry = dict(case)
        meta = read_wav_meta(path)
        if meta:
            entry["meta"] = meta
        if case.get("automation") and not (EXTRACT_DIR / case["automation"]).is_file():
            continue
        if case.get("reference") and not (EXTRACT_DIR / case["reference"]).is_file():
            continue
        wavs.append(entry)

    jsons = []
    for case in JSON_CASES:
        if (EXTRACT_DIR / case["path"]).is_file():
            jsons.append(dict(case))

    return {
        "available": (EXTRACT_DIR / "conventions.json").is_file(),
        "wavs": wavs,
        "jsons": jsons,
    }


def read_conventions() -> dict | None:
    path = EXTRACT_DIR / "conventions.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "AmbisonicOrientationBench/1.0"

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

    def send_bytes(self, data: bytes, ctype: str, cache: str = "no-store") -> None:
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

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
        self.send_bytes(data, ctype)

    def safe_sample_path(self, rel: str) -> Path | None:
        if not rel:
            return None
        parts = Path(rel).parts
        if len(parts) > 3 or any(p in ("", ".", "..") for p in parts):
            return None
        if any(not SAFE_NAME.match(p) for p in parts):
            return None
        target = EXTRACT_DIR.joinpath(*parts)
        try:
            target.resolve().relative_to(EXTRACT_DIR.resolve())
        except ValueError:
            return None
        return target if target.is_file() else None

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path
        query = parse_qs(parsed.query)

        if route == "/api/samples":
            self.send_json(sample_manifest())
            return

        if route == "/api/conventions":
            data = read_conventions()
            if data is None:
                self.send_json({"error": "conventions.json 不可用"}, status=404)
            else:
                self.send_json(data)
            return

        if route == "/api/sample":
            rel = query.get("path", [""])[0]
            target = self.safe_sample_path(rel)
            if target is None:
                self.send_error(400, "Bad sample path")
                return
            self.send_file(target)
            return

        if route == "/":
            route = "/index.html"

        if not route.startswith("/"):
            self.send_error(400, "Bad path")
            return
        parts = Path(route.lstrip("/")).parts
        if any(p in ("", ".", "..") for p in parts) or any(p.startswith(".") for p in parts):
            self.send_error(400, "Bad path")
            return
        target = WEB_ROOT.joinpath(*parts)
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self.send_error(404, "Not Found")
            return
        self.send_file(target)

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.send_error(405, "Method Not Allowed")
            return
        route = parsed.path if parsed.path != "/" else "/index.html"
        parts = Path(route.lstrip("/")).parts
        if any(p in ("", ".", "..") for p in parts) or any(p.startswith(".") for p in parts):
            self.send_error(400, "Bad path")
            return
        target = WEB_ROOT.joinpath(*parts)
        if not target.is_file():
            self.send_error(404, "Not Found")
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()

    def do_POST(self) -> None:
        self.send_error(405, "Method Not Allowed")


def main() -> None:
    parser = argparse.ArgumentParser(description="Ambisonic orientation calibration local server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    ensure_samples()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Ambisonic orientation bench: http://localhost:{args.port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
