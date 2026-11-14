#!/usr/bin/env python3
"""Alpha 层检查台本地 HTTP 服务（纯标准库，离线可用）。

职责：
  1. 托管 src/web 静态页面（JS 光栅器在浏览器 Worker 中运行）
  2. 提供样例场景列表/读取
  3. /api/render 用本文件目录下 alpha_render.py 的独立 Python 实现做多进程分带
     渲染，供与 JS 结果交叉核对（进程池上限 4，符合 4 核预算）
  4. /api/check 对照 expected.json 校验

安全：仅绑定回环/局域网地址、只读静态目录、路径不允许越界、
样例数据只读且绝不作为代码执行；本服务以 `python3 -I` 启动。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, quote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import alpha_render as ar  # noqa: E402

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WEB_ROOT = os.path.join(REPO_ROOT, "src", "web")
SAMPLES_DIR = os.path.abspath(os.path.join(REPO_ROOT, "samples", "extracted"))
MAX_WORKERS = 4
MAX_BODY = 64 * 1024 * 1024  # 64 MiB 场景上限

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def _band_worker(args):
    scene, size, camera, y0, y1 = args
    return ar.render_band(scene, size, camera, y0, y1)


def render_python(scene_obj, size, camera_override=None):
    """多进程分带渲染，返回与 JS 端结构对应的 dict。"""
    scene = ar.validate_scene(scene_obj)
    camera = ar.validate_camera_override(camera_override or scene["camera"], scene["camera"])
    if not isinstance(size, int) or not (64 <= size <= 1024):
        raise ar.ValidationError("size 必须是 64..1024 的整数")

    workers = min(MAX_WORKERS, os.cpu_count() or 1)
    band_rows = (size + workers - 1) // workers
    tasks = []
    for i in range(workers):
        y0 = min(size, i * band_rows)
        y1 = min(size, (i + 1) * band_rows)
        if y0 < y1:
            tasks.append((scene, size, camera, y0, y1))

    with concurrent.futures.ProcessPoolExecutor(max_workers=len(tasks)) as pool:
        bands = list(pool.map(_band_worker, tasks))

    n = size * size
    linear = [0.0] * (n * 3)
    rgb8 = bytearray(n * 3)
    frag_start = [0] * (n + 1)
    frag_id, frag_depth, frag_rgba, frag_comp = [], [], [], []
    out_off = 0
    for bd in bands:
        bn = bd["width"] * (bd["y1"] - bd["y0"])
        for i in range(bn):
            gp = bd["y0"] * bd["width"] + i
            linear[gp * 3:gp * 3 + 3] = bd["linear"][i * 3:i * 3 + 3]
            rgb8[gp * 3:gp * 3 + 3] = bd["rgb8"][i * 3:i * 3 + 3]
            s0, s1 = bd["frag_start"][i], bd["frag_start"][i + 1]
            frag_start[gp] = out_off
            for slot in range(s0, s1):
                frag_id.append(bd["frag_id"][slot])
                frag_depth.append(bd["frag_depth"][slot])
                frag_rgba.extend(bd["frag_rgba"][slot * 4:slot * 4 + 4])
                frag_comp.extend(bd["frag_comp"][slot * 3:slot * 3 + 3])
            out_off += s1 - s0
    frag_start[n] = out_off
    return {
        "size": size,
        "linear_rgb": linear,
        "rgb8": list(bytes(rgb8)),
        "frag_start": frag_start,
        "frag_id": frag_id,
        "frag_depth": frag_depth,
        "frag_rgba": frag_rgba,
        "frag_comp": frag_comp,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "AlphaInspector/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # -- 工具 -------------------------------------------------------------
    def _send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status, message):
        self._send_json({"error": message}, status)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > MAX_BODY:
            raise ar.ValidationError("请求体为空或超过 64MiB 上限")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ar.ValidationError(f"请求体不是合法 JSON: {e}")

    # -- GET --------------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            return self._serve_static("index.html")
        if path == "/api/samples":
            try:
                # invalid-duplicate.json 是拒绝用例，不作为可加载样例
                names = sorted(
                    f for f in os.listdir(SAMPLES_DIR)
                    if f.endswith(".json") and f not in ("expected.json", "invalid-duplicate.json")
                )
            except OSError as e:
                return self._send_error_json(HTTPStatus.NOT_FOUND, f"样例目录不可用: {e}")
            return self._send_json(names)
        if path.startswith("/api/sample/"):
            name = path[len("/api/sample/"):]
            return self._serve_sample(name)
        if path == "/api/expected":
            return self._serve_sample("expected.json", raw=True)
        if path.startswith("/"):
            return self._serve_static(path.lstrip("/"))
        self._send_error_json(HTTPStatus.NOT_FOUND, "未知路径")

    def _serve_sample(self, name, raw=False):
        # 仅允许单层文件名，禁止任何路径分隔或越界
        if not name or "/" in name or "\\" in name or ".." in name or not name.endswith(".json"):
            return self._send_error_json(HTTPStatus.BAD_REQUEST, "非法样例名")
        full = os.path.normpath(os.path.join(SAMPLES_DIR, name))
        if os.path.dirname(full) != SAMPLES_DIR or not os.path.isfile(full):
            return self._send_error_json(HTTPStatus.NOT_FOUND, "样例不存在")
        try:
            with open(full, "r", encoding="utf-8") as f:
                text = f.read()
        except OSError as e:
            return self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
        if raw:
            body = text.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            try:
                self._send_json(json.loads(text))
            except json.JSONDecodeError as e:
                self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"样例损坏: {e}")

    def _serve_static(self, rel):
        full = os.path.normpath(os.path.join(WEB_ROOT, rel))
        if not full.startswith(WEB_ROOT + os.sep) and full != WEB_ROOT:
            return self._send_error_json(HTTPStatus.FORBIDDEN, "路径越界")
        if not os.path.isfile(full):
            return self._send_error_json(HTTPStatus.NOT_FOUND, f"{rel} 不存在")
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError as e:
            return self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # 离线本地工具：允许缓存但不依赖任何外部源
        self.end_headers()
        self.wfile.write(body)

    # -- POST -------------------------------------------------------------
    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/render":
            return self._handle_render()
        if parsed.path == "/api/check":
            return self._handle_check()
        self._send_error_json(HTTPStatus.NOT_FOUND, "未知接口")

    def _handle_render(self):
        try:
            payload = self._read_json_body()
            scene_obj = payload.get("scene")
            size = payload.get("size", 512)
            camera = payload.get("camera")
            if not isinstance(size, int):
                raise ar.ValidationError("size 必须为整数")
            result = render_python(scene_obj, size, camera)
        except ar.ValidationError as e:
            return self._send_error_json(HTTPStatus.BAD_REQUEST, str(e))
        except (concurrent.futures.process.BrokenProcessPool, MemoryError) as e:
            return self._send_error_json(HTTPStatus.SERVICE_UNAVAILABLE, f"渲染进程失败: {e}")
        self._send_json({"ok": True, **result})

    def _handle_check(self):
        try:
            payload = self._read_json_body()
            scene_obj = payload.get("scene")
            size = payload.get("size")
            camera = payload.get("camera")
            fb = ar.render_frame(scene_obj, size, camera)
            expected_path = os.path.join(SAMPLES_DIR, "expected.json")
            with open(expected_path, "r", encoding="utf-8") as f:
                expected = json.load(f)
            name = payload.get("expected_key")
            entries = expected.get(name) if name else None
            if entries is None:
                return self._send_error_json(HTTPStatus.BAD_REQUEST, "expected_key 不存在于 expected.json")
            failures = ar.check_entries(fb, entries)
        except ar.ValidationError as e:
            return self._send_error_json(HTTPStatus.BAD_REQUEST, str(e))
        self._send_json({"ok": not failures, "failures": failures, "checked": len(entries)})


def main():
    ap = argparse.ArgumentParser(description="Alpha 层检查台本地服务")
    ap.add_argument("--host", default="0.0.0.0", help="绑定地址（默认 0.0.0.0，Windows 浏览器经 localhost 访问）")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url_host = "localhost" if args.host in ("0.0.0.0", "127.0.0.1") else args.host
    print(f"Alpha 层检查台服务已启动: http://{url_host}:{args.port}/")
    print(f"静态目录: {WEB_ROOT}")
    print(f"样例目录: {SAMPLES_DIR}（只读）")
    print("按 Ctrl+C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n停止。")
        httpd.server_close()


if __name__ == "__main__":
    main()
