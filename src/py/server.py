# 本地服务：纯标准库静态托管 + 样例 API。
# 样例 zip 自动解压到独立目录（不可信数据，只读、不执行），
# 路径经过白名单校验，防止目录穿越。
#
# 用法：python3 -I src/py/server.py --port 8000

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent.parent
WEB_ROOT = ROOT / "src" / "web"
SAMPLES_DIR = ROOT / "samples"
EXTRACT_DIR = SAMPLES_DIR / "extracted"
ZIP_PATH = SAMPLES_DIR / "matrix-room.zip"

SAFE_NAME = re.compile(r"^[A-Za-z0-9_.\-]+$")
MAX_REQUEST_BODY = 1024 * 1024


def ensure_samples() -> None:
    if ZIP_PATH.is_file() and not (EXTRACT_DIR / "cases.json").is_file():
        EXTRACT_DIR.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(ZIP_PATH) as archive:
            for info in archive.infolist():
                name = Path(info.filename)
                if name.is_absolute() or ".." in name.parts:
                    continue
                if info.is_dir():
                    continue
                target = EXTRACT_DIR / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as src, open(target, "wb") as dst:
                    dst.write(src.read())


def sample_manifest() -> list[dict]:
    """读取 cases.json 与样例目录，生成页面下拉所需的元数据。"""
    ensure_samples()
    cases_path = EXTRACT_DIR / "cases.json"
    cases = {}
    if cases_path.is_file():
        try:
            cases = json.loads(cases_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cases = {}

    manifest = []
    if not EXTRACT_DIR.is_dir():
        return manifest

    known = {
        "sparse": {
            "title": "Sparse 精确样例",
            "description": "四条稀疏 IR 与双声道干声；所有路由均非零，可逐点核对。",
        },
        "clip": {
            "title": "Clip 超限样例",
            "description": "短促高电平，湿声比例为 1 时输出峰值 3.375，用于核对超限统计。",
        },
        "long": {
            "title": "Long 长尾样例（60s 干声 + 4s IR）",
            "description": "干声 60 秒、IR 各 4 秒，输出约 64 秒；用于核对进度、取消与长度。",
        },
        "rate441": {
            "title": "44.1 kHz 样例",
            "description": "全部文件为 44.1 kHz，检验采样率一致性通过。",
        },
        "zero": {
            "title": "Zero 零 IR 样例",
            "description": "四条 IR 全为零，干声为静音；输出仍按固定长度保留尾段。",
        },
    }

    for case_dir in sorted(EXTRACT_DIR.iterdir()):
        if not case_dir.is_dir():
            continue
        files = {}
        dry = case_dir / "dry.wav"
        if dry.is_file():
            files["dry"] = f"{case_dir.name}/dry.wav"
        else:
            # zero/ 依赖静音干声，缺失干声按零输入是合法场景
            silence = EXTRACT_DIR / "silence.wav"
            if case_dir.name == "zero" and silence.is_file():
                files["dry"] = "silence.wav"
        for route in ("LL", "LR", "RL", "RR"):
            path = case_dir / f"{route}.wav"
            if path.is_file():
                files[route] = f"{case_dir.name}/{route}.wav"
        if not files:
            continue
        meta = known.get(case_dir.name, {"title": case_dir.name, "description": ""})
        entry = {
            "id": case_dir.name,
            "title": meta["title"],
            "description": meta["description"],
            "files": files,
        }
        if case_dir.name in cases and isinstance(cases[case_dir.name], dict):
            entry["case"] = cases[case_dir.name]
        manifest.append(entry)

    return manifest


class Handler(BaseHTTPRequestHandler):
    server_version = "MatrixRoomConvolver/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print("%s - %s" % (self.address_string(), fmt % args))

    def send_json(self, payload, status=200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path, content_type: str | None = None, cache="no-store") -> None:
        try:
            data = path.read_bytes()
        except OSError:
            self.send_error(404, "Not Found")
            return
        ctype = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if path.suffix == ".js":
            ctype = "text/javascript; charset=utf-8"
        elif path.suffix in (".html", ".css"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path
        query = parse_qs(parsed.query)

        if route == "/api/samples":
            self.send_json(sample_manifest())
            return

        if route == "/api/sample":
            rel = query.get("path", [""])[0]
            parts = Path(rel).parts
            if (
                not rel
                or len(parts) > 3
                or any(p in ("", ".", "..") for p in parts)
                or any(not SAFE_NAME.match(p) for p in parts)
            ):
                self.send_error(400, "Bad sample path")
                return
            target = EXTRACT_DIR.joinpath(*parts)
            if not target.is_file():
                self.send_error(404, "Not Found")
                return
            self.send_file(target)
            return

        if route == "/":
            route = "/index.html"

        if not route.startswith("/"):
            self.send_error(400, "Bad path")
            return
        safe_rel = route.lstrip("/")
        parts = Path(safe_rel).parts
        if ".." in parts or any(p.startswith(".") for p in parts):
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
        route = parsed.path
        if route == "/":
            route = "/index.html"
        safe_rel = route.lstrip("/")
        parts = Path(safe_rel).parts
        if ".." in parts or any(p.startswith(".") for p in parts):
            self.send_error(400, "Bad path")
            return
        target = WEB_ROOT.joinpath(*parts)
        if not target.is_file():
            self.send_error(404, "Not Found")
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()

    def do_POST(self) -> None:
        self.send_error(405, "Method Not Allowed")


def main() -> None:
    parser = argparse.ArgumentParser(description="Matrix room convolver local server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    ensure_samples()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Matrix room convolver: http://localhost:{args.port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
