#!/usr/bin/env python3
"""极简静态服务器：把 src/ 作为站点根目录（离线、无依赖）。

用法：python3 -I scripts/serve.py [--port 8000] [--root src]
"""
import argparse
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.dont_write_bytecode = True


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.png': 'image/png',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--root', default='src')
    args = ap.parse_args()
    root = os.path.abspath(args.root)
    os.chdir(root)
    server = ThreadingHTTPServer(('0.0.0.0', args.port), Handler)
    print(f'Census-SGM 核对台: http://localhost:{args.port}/  (root={root})', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
