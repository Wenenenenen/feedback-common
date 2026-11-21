#!/usr/bin/env python3
"""Tiny static server for the inspector (opening index.html directly also works).

    python3 -I tools/serve.py [port]

Run with -I so a planted module in the working directory cannot shadow imports.
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print('serving %s at http://127.0.0.1:%d/' % (ROOT, port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
