"""HTTP adapter: a small threaded server around :class:`pma.storage.Store`.

Routes
------
``POST /tickets``          join a party (``requestKey``, ``id``, ``members``)
``POST /cancel``           cancel a ticket (``requestKey``, ``ticketId``)
``POST /tick``             advance the logical clock and match (``requestKey``, ``now``)
``GET  /state``            clock, tickets, rooms, counts
``GET  /requests/{key}``   a permanently retained write result
``GET  /requests``         recent request log (``?limit=``)
``GET  /debug/candidates`` ordered legal rooms + rejection reasons (``?offset=&limit=&now=``)
``POST /admin/reset``      clear the database (``requestKey``) — debug/e2e only
``GET  /health``           liveness
``GET  /`` and ``/static/*``  the debug web page

The server is deliberately small; all invariants live in the storage layer so
that a future adapter cannot bypass them.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

from . import storage
from .errors import ApiError

MAX_BODY_BYTES = 1_000_000
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

#: Static files are served from a fixed map, never by joining user input.
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/static/app.js": "app.js",
    "/static/styles.css": "styles.css",
}


def _content_type(path: str) -> str:
    guessed, _ = mimetypes.guess_type(path)
    if guessed:
        return guessed
    if path.endswith(".js"):
        return "text/javascript; charset=utf-8"
    if path.endswith(".css"):
        return "text/css; charset=utf-8"
    return "application/octet-stream"


class App:
    """Route table + handler bodies, independent of the socket server."""

    def __init__(self, store: storage.Store) -> None:
        self.store = store
        self._reset_lock = threading.Lock()

    # -- dispatch -------------------------------------------------------------

    def handle(
        self, method: str, raw_path: str, body: bytes
    ) -> tuple[int, dict | bytes, str]:
        split = urlsplit(raw_path)
        path = unquote(split.path)
        query = parse_qs(split.query)

        try:
            if path in STATIC_FILES and method in ("GET", "HEAD"):
                return self._static(STATIC_FILES[path])

            if path == "/health" and method == "GET":
                return 200, {"status": "ok", "clock": self.store.clock()}, "application/json"

            if path == "/state" and method == "GET":
                return 200, self.store.get_state(), "application/json"

            if path == "/requests" and method == "GET":
                limit = _int_param(query, "limit", 50)
                return 200, {"requests": self.store.list_requests(limit)}, "application/json"

            if path.startswith("/requests/"):
                key = path[len("/requests/") :]
                if not key:
                    raise ApiError(404, "not_found", "缺少 requestKey")
                return 200, self.store.get_request(key), "application/json"

            if path == "/debug/candidates" and method == "GET":
                offset = _int_param(query, "offset", 0)
                limit = _int_param(query, "limit", 50)
                limit = max(1, min(limit, 200))
                now = (
                    _int_param(query, "now", self.store.clock())
                    if "now" in query
                    else None
                )
                return 200, self.store.debug_candidates(offset, limit, now), "application/json"

            if path == "/tickets" and method == "POST":
                status, payload, _ = self.store.join(_json_object(body))
                return status, payload, "application/json"

            if path == "/cancel" and method == "POST":
                status, payload, _ = self.store.cancel(_json_object(body))
                return status, payload, "application/json"

            if path == "/tick" and method == "POST":
                status, payload, _ = self.store.tick(_json_object(body))
                return status, payload, "application/json"

            if path == "/admin/reset" and method == "POST":
                payload = _json_object(body, allow_empty=True)
                return 200, self._reset(payload), "application/json"

            raise ApiError(404, "not_found", f"未知路由 {method} {path}")

        except ApiError as error:
            return error.status, error.to_payload(), "application/json"
        except Exception as error:  # pragma: no cover - safety net
            import traceback

            traceback.print_exc(file=sys.stderr)
            return (
                500,
                {
                    "error": {
                        "code": "internal_error",
                        "message": f"服务器内部错误: {error}",
                    }
                },
                "application/json",
            )

    # -- helpers --------------------------------------------------------------

    def _static(self, name: str) -> tuple[int, bytes, str]:
        full = os.path.join(WEB_DIR, name)
        try:
            with open(full, "rb") as handle:
                data = handle.read()
        except FileNotFoundError:
            raise ApiError(404, "not_found", f"缺少静态文件 {name}")
        return 200, data, _content_type(name)

    def _reset(self, payload: dict) -> dict:
        # Reset bypasses the request log on purpose: it wipes it too.
        with self._reset_lock:
            with self.store._write() as conn:
                for table in ("room_members", "rooms", "ticket_members", "tickets", "requests"):
                    conn.execute(f"DELETE FROM {table}")
                conn.execute("UPDATE meta SET value = '0' WHERE key = 'clock'")
                conn.execute("UPDATE meta SET value = '0' WHERE key = 'request_seq'")
                conn.execute("UPDATE meta SET value = '0' WHERE key = 'ticket_seq'")
                conn.execute("UPDATE meta SET value = '0' WHERE key = 'room_seq'")
        return {"reset": True, "at": payload.get("at")}


def _int_param(query: dict[str, list[str]], name: str, default: int) -> int:
    raw_values = query.get(name)
    if not raw_values:
        return default
    raw = raw_values[0]
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ApiError(400, "invalid_request", f"查询参数 {name} 必须是整数")


def _json_object(body: bytes, allow_empty: bool = False) -> dict:
    if not body:
        if allow_empty:
            return {}
        raise ApiError(400, "invalid_request", "请求正文必须是 JSON 对象")
    if len(body) > MAX_BODY_BYTES:
        raise ApiError(413, "payload_too_large", "请求正文过大")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ApiError(400, "invalid_json", f"请求正文不是合法 JSON: {error}")
    if not isinstance(payload, dict):
        raise ApiError(400, "invalid_request", "请求正文必须是 JSON 对象")
    return payload


class Handler(BaseHTTPRequestHandler):
    server_version = "PartyMatch/1.0"
    protocol_version = "HTTP/1.1"

    app: App  # injected by serve()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_HEAD(self) -> None:  # noqa: N802
        self._dispatch("HEAD", send_body=False)

    def _dispatch(self, method: str, send_body: bool = True) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length > 0 else b""

        status, payload, content_type = self.app.handle(method, self.path, body)

        if isinstance(payload, (dict, list)):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        else:
            data = payload

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if send_body and method != "HEAD":
            self.wfile.write(data)

    def log_message(self, fmt: str, *args: Any) -> None:
        if os.environ.get("PMA_QUIET") == "1":
            return
        sys.stderr.write(
            "%s - %s\n" % (self.address_string(), fmt % args)
        )


def make_server(host: str, port: int, store: storage.Store) -> ThreadingHTTPServer:
    app = App(store)
    handler = type("BoundHandler", (Handler,), {"app": app})
    server = type(
        "PartyMatchServer",
        (ThreadingHTTPServer,),
        # The stdlib default backlog is 5, which resets connections once a
        # burst of concurrent clients arrives.
        {"request_queue_size": 256},
    )((host, port), handler)
    server.daemon_threads = True
    return server


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="三对三组队匹配服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", default="data/matches.db")
    args = parser.parse_args(argv)

    store = storage.Store(args.db)
    server = make_server(args.host, args.port, store)
    print(f"party-match-allocator listening on http://{args.host}:{args.port}")
    print(f"database: {os.path.abspath(args.db)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
