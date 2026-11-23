#!/usr/bin/env python3
"""纯标准库静态服务器，带正确 MIME 与 no-cache 头。
用法：python3 -I src/server.py --port 8000 [--root web]
"""
from __future__ import annotations

import argparse
import http.server
import os
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--root", default=None,
                    help="静态根目录，默认仓库 web/")
    args = ap.parse_args()
    root = args.root or os.path.join(os.path.dirname(__file__), "..", "web")
    os.chdir(os.path.abspath(root))
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as httpd:
        print(f"深度区间合成台：http://127.0.0.1:{args.port}/", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
