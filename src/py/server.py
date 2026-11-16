#!/usr/bin/env python3
"""本地静态服务：纯标准库、离线可用。

- 托管 src/web 下的页面与脚本。
- 启动时把 samples/irradiance-sh-baker-cases.zip 解压到 samples/extracted/。
  压缩包内容视为不可信数据：只读提供、不执行，路径做白名单校验。
- /api/samples     样例清单（含说明与尺寸探测）
- /api/expected    包内 expected.json（参考值）
- /api/sample?path=...  以白名单方式提供解压后的样例文件

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
ZIP_PATH = SAMPLES_DIR / "irradiance-sh-baker-cases.zip"

SAFE_NAME = re.compile(r"^[A-Za-z0-9_.\-]+$")

# 样例案例：id -> 页面展示的用途。文件从 zip 解压目录读取。
CASES = [
    {
        "id": "constant-le",
        "title": "常量环境 · 小端 + 底行优先",
        "path": "constant-le.pfm",
        "description": "全图 L = (1, 2, 0.5)。"
                       "C₀ = 4π·Y00·L；辐照度系数 E₀ = π·C₀；E(n) 恒为 π·L。",
        "note": "验证小端、尺度 −1、底行优先与常量项。",
    },
    {
        "id": "constant-be-scale2",
        "title": "常量环境 · 大端 + 尺度 2",
        "path": "constant-be-scale2.pfm",
        "description": "同一环境的另一份存储：大端、尺度 +2，样本 0.5 读成 1.0。"
                       "结果应与小端样例完全一致。",
        "note": "验证字节序按尺度符号判定，读出样本乘 |尺度|。",
    },
    {
        "id": "linear",
        "title": "线性梯度 · 方向与旋转",
        "path": "linear.pfm",
        "description": "L = (1 + 0.6x + 0.2y)·(1, 2, 0.5)。"
                       "E(n) = π·C·(1 + (2/3)(0.6·nx + 0.2·ny))；"
                       "绕 y 旋转 +90° 后亮部转向 −z。",
        "note": "验证 l=1 方向、余弦卷积与旋转符号。",
    },
    {
        "id": "polar",
        "title": "极区亮斑 · 逆问题",
        "path": "polar.pfm",
        "description": "顶部（y 正方向）亮环 L=8，其余 0.1。"
                       "直接按像素平均会把极区算得过重；立体角加权后 C₀ 明显更低。",
        "note": "验证每行立体角与“直接平均 vs 立体角加权”的差异。",
    },
    {
        "id": "nan",
        "title": "非有限值（应拒绝）",
        "path": "nan.pfm",
        "description": "与 linear 相同，但含 1 个 NaN。应报出位置，且不覆盖已有结果。",
        "note": "验证非有限值检测。",
    },
    {
        "id": "truncated",
        "title": "截断数据（应拒绝）",
        "path": "truncated.pfm",
        "description": "linear 的文件尾部缺 6 字节。应报出缺少的字节数。",
        "note": "验证截断检测。",
    },
]

JSON_CASES = [
    {
        "id": "expected",
        "title": "expected.json（包内参考值）",
        "path": "expected.json",
        "description": "常量样例的 RGB、辐照度、线性公式、旋转 90° 亮度方向与总立体角。",
    },
    {
        "id": "notes",
        "title": "说明.txt（包内约定）",
        "path": "说明.txt",
        "description": "PFM 头、坐标、基顺序、卷积因子与旋转约定。",
    },
]


def ensure_samples() -> None:
    """解压样例包（只读、防穿越、只解正规文件）。"""
    if not ZIP_PATH.is_file():
        return
    if (EXTRACT_DIR / "expected.json").is_file() and (EXTRACT_DIR / "linear.pfm").is_file():
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


def probe_pfm(path: Path) -> dict | None:
    """只读头部，给出尺寸/尺度/字节序与数据完整性，供样例清单显示。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(3)
            rest = fh.read(256)
        size = path.stat().st_size
        if head != b"PF\n":
            return None
        lines = rest.split(b"\n", 2)
        if len(lines) < 3:
            return None
        dims, scale_raw, _ = lines
        width, height = (int(x) for x in dims.split())
        scale = float(scale_raw)
        cursor = 3 + len(dims) + 1 + len(scale_raw) + 1
        need = width * height * 3 * 4
        have = size - cursor
        return {
            "width": width,
            "height": height,
            "scale": scale,
            "endian": "little" if scale < 0 else "big",
            "bytes": size,
            "dataBytes": max(0, have),
            "neededBytes": need,
            "truncated": have < need,
        }
    except (OSError, ValueError, struct.error):
        return None


def read_expected() -> dict | None:
    path = EXTRACT_DIR / "expected.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def sample_manifest() -> dict:
    ensure_samples()
    cases = []
    for case in CASES:
        path = EXTRACT_DIR / case["path"]
        if not path.is_file():
            continue
        entry = dict(case)
        meta = probe_pfm(path)
        if meta:
            entry["meta"] = meta
        cases.append(entry)
    jsons = [dict(c) for c in JSON_CASES if (EXTRACT_DIR / c["path"]).is_file()]
    return {
        "available": (EXTRACT_DIR / "linear.pfm").is_file(),
        "cases": cases,
        "jsons": jsons,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "IrradianceSHBaker/1.0"

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

        if route == "/api/expected":
            ensure_samples()
            data = read_expected()
            if data is None:
                self.send_json({"error": "expected.json 不可用"}, status=404)
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
    parser = argparse.ArgumentParser(description="Irradiance SH baker local server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    ensure_samples()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Irradiance SH baker: http://localhost:{args.port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
