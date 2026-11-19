"""Test helpers: a running server on a random port + a tiny HTTP client."""

from __future__ import annotations

import http.client
import json
import os
import socket
import sys
import tempfile
import threading
from dataclasses import dataclass
from typing import Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from pma import server as server_module  # noqa: E402
from pma.storage import Store  # noqa: E402


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@dataclass
class Response:
    status: int
    body: Any

    def __getitem__(self, key: str) -> Any:
        return self.body[key]


class Client:
    def __init__(self, port: int, host: str = "127.0.0.1") -> None:
        self.port = port
        self.host = host

    def request(self, method: str, path: str, body: Any = None) -> Response:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=30)
        try:
            payload = None
            headers = {"Content-Type": "application/json"}
            if body is not None:
                payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            conn.request(method, path, body=payload, headers=headers)
            response = conn.getresponse()
            raw = response.read()
            content_type = response.getheader("Content-Type", "")
            if "application/json" in content_type and raw:
                parsed = json.loads(raw.decode("utf-8"))
            else:
                parsed = raw
            return Response(response.status, parsed)
        finally:
            conn.close()

    def get(self, path: str) -> Response:
        return self.request("GET", path)

    def post(self, path: str, body: Any) -> Response:
        return self.request("POST", path, body)


class RunningServer:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self.store = Store(db_path)
        self.port = free_port()
        self.server = server_module.make_server("127.0.0.1", self.port, self.store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.client = Client(self.port)

    def __enter__(self) -> "RunningServer":
        self.thread.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def temp_db() -> tuple[str, tempfile.TemporaryDirectory]:
    directory = tempfile.TemporaryDirectory()
    return os.path.join(directory.name, "matches.db"), directory


def member(member_id: str, skill: int, ping: dict[str, int] | None = None) -> dict:
    return {"id": member_id, "skill": skill, "ping": ping or {"r1": 20, "r2": 30}}


def party(prefix: str, size: int, skill: int, ping: dict[str, int] | None = None) -> list[dict]:
    return [member(f"{prefix}_{index}", skill, ping) for index in range(size)]


def ticket(ticket_id: str, members: list[dict]) -> dict:
    return {"id": ticket_id, "members": members}
