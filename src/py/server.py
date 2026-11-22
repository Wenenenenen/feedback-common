#!/usr/bin/env python3
"""关卡协程调试台本地服务（纯标准库，离线可用）。

职责：
  1. 托管 src/web 页面与脚本
  2. 列出 samples/ 下的样例与用例
  3. /api/reference 调用 lfv_ref.py 的独立 Python 实现，供与浏览器内 JS 解释器交叉核对

安全：只读静态目录；样例只作为数据处理，绝不执行；以 `python3 -I` 启动。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lfv_ref as ref  # noqa: E402

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
WEB_ROOT = os.path.join(REPO_ROOT, "src", "web")
SAMPLES_ROOT = os.path.abspath(os.path.join(REPO_ROOT, "samples"))
MAX_BODY = 32 * 1024 * 1024

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def _safe_join(root: str, rel: str) -> str | None:
    rel = rel.replace("\\", "/").lstrip("/")
    target = os.path.normpath(os.path.join(root, rel))
    if target != root and not target.startswith(root + os.sep):
        return None
    return target


def list_samples():
    items = []
    for sub in ("", "cases", "cases/invalid"):
        d = os.path.join(SAMPLES_ROOT, sub) if sub else SAMPLES_ROOT
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".json"):
                continue
            path = os.path.join(d, name)
            if not os.path.isfile(path):
                continue
            rel = os.path.relpath(path, SAMPLES_ROOT).replace(os.sep, "/")
            if rel == "expected.json":
                continue
            try:
                with open(path, encoding="utf-8") as fh:
                    obj = json.load(fh)
                title = obj.get("_title") or name
            except Exception:
                title = name
            items.append({"path": rel, "title": title, "group": sub or "samples"})
    return items


class Handler(BaseHTTPRequestHandler):
    server_version = "LevelFiberDebugger/1.0"

    def log_message(self, fmt, *args):  # 安静
        pass

    def _send(self, status, body: bytes, ctype: str):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/samples":
            self._json(HTTPStatus.OK, {"samples": list_samples()})
            return
        if path == "/api/ref-status":
            self._json(HTTPStatus.OK, {"available": True, "impl": "python"})
            return
        if path == "/samples" or path.startswith("/samples/"):
            rel = path[len("/samples/"):] if path.startswith("/samples/") else ""
            target = _safe_join(SAMPLES_ROOT, rel)
            if not target or not os.path.isfile(target):
                self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain; charset=utf-8")
                return
            with open(target, "rb") as fh:
                body = fh.read()
            self._send(HTTPStatus.OK, body, "application/json; charset=utf-8")
            return
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = _safe_join(WEB_ROOT, rel)
        if not target or not os.path.isfile(target):
            self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain; charset=utf-8")
            return
        with open(target, "rb") as fh:
            body = fh.read()
        ctype = CONTENT_TYPES.get(os.path.splitext(target)[1], "application/octet-stream")
        self._send(HTTPStatus.OK, body, ctype)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/reference":
            self._handle_reference()
            return
        self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain; charset=utf-8")

    def _handle_reference(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "请求体为空或过大"})
            return
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw.decode("utf-8"))
        except Exception:
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "请求体不是 JSON"})
            return
        program = req.get("program")
        limit = req.get("maxInstructions", 10**9)
        if not isinstance(program, dict):
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "缺少 program 对象"})
            return
        if not isinstance(limit, int) or limit < 0:
            limit = 10**9
        try:
            result = ref.run_case(program, limit)
            self._json(HTTPStatus.OK, {"ok": True, "result": result})
        except ref.ImportErrorLfv as exc:
            self._json(HTTPStatus.OK, {"ok": False, "importError": exc.to_dict()})
        except Exception as exc:  # pragma: no cover
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": str(exc)})


def main():
    ap = argparse.ArgumentParser(description="关卡协程调试台本地服务")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"关卡协程调试台： http://localhost:{args.port}/  （Ctrl+C 停止）", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
