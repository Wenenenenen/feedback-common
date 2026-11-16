#!/usr/bin/env python3
"""Local server for the stereo depth forge.

Serves the static page in app/ and, read-only, the samples unpacked from
samples/stereo-depth-forge-cases.zip.  Standard library only; the page itself
has no third-party runtime dependency and loads nothing from the network.

Usage:
    python3 server.py [--host HOST] [--port PORT]

The only thing written to disk is the one-time sample extraction into
samples/extracted/ (skipped when that directory already has files).
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import posixpath
import zipfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
SAMPLES_DIR = ROOT / "samples" / "extracted"
SAMPLES_ZIP = ROOT / "samples" / "stereo-depth-forge-cases.zip"

CASE_SUFFIXES = {".json", ".png", ".f32", ".bin", ".txt"}

MIME_OVERRIDES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".f32": "application/octet-stream",
    ".bin": "application/octet-stream",
}


def ensure_samples(dest: Path = SAMPLES_DIR) -> None:
    """Unpack the sample archive once, refusing entries outside dest."""
    if dest.is_dir() and any(dest.iterdir()):
        return
    if not SAMPLES_ZIP.is_file():
        return
    try:
        dest.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(SAMPLES_ZIP) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                name = Path(info.filename).name
                if not name or name.startswith("."):
                    continue
                target = (dest / name).resolve()
                try:
                    target.relative_to(dest.resolve())
                except ValueError:
                    continue
                if target.exists():
                    continue
                with zf.open(info) as src, target.open("wb") as out:
                    out.write(src.read())
        print(f"  samples:      extracted {SAMPLES_ZIP.name} -> {dest}", flush=True)
    except (OSError, zipfile.BadZipFile) as exc:  # pragma: no cover - best effort
        print(f"  samples:      could not extract {SAMPLES_ZIP.name}: {exc}", flush=True)


def safe_join(base: Path, request_path: str) -> Path | None:
    decoded = unquote(request_path)
    if "\x00" in decoded:
        return None
    normalized = posixpath.normpath("/" + decoded).lstrip("/")
    candidate = (base / normalized).resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError:
        return None
    return candidate


class Handler(BaseHTTPRequestHandler):
    server_version = "StereoDepthForge/1.0"
    samples_dir: Path = SAMPLES_DIR

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        try:
            size = path.stat().st_size
            fh = path.open("rb")
        except OSError:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        mime = MIME_OVERRIDES.get(path.suffix.lower())
        if mime is None:
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            while True:
                chunk = fh.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            fh.close()

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        path = urlparse(self.path).path

        if path in ("/", "/index.html"):
            target = safe_join(APP_DIR, "index.html")
            if target is None or not target.is_file():
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "index.html missing"})
                return
            self._send_file(target)
            return

        if path == "/api/cases":
            self._send_cases()
            return

        if path.startswith("/api/case/"):
            name = unquote(path[len("/api/case/"):])
            if "/" in name or "\\" in name:  # flat case directory, names only
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "case file not found"})
                return
            target = safe_join(self.samples_dir, name)
            if target is None or not target.is_file() or target.suffix.lower() not in CASE_SUFFIXES:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "case file not found"})
                return
            self._send_file(target)
            return

        if path.startswith("/api/"):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})
            return

        target = safe_join(APP_DIR, path.lstrip("/"))
        if target is None or not target.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        self._send_file(target)

    def _send_cases(self) -> None:
        """List case JSONs with a quick sanity flag.

        A case whose declared depth byte count disagrees with the file on disk
        is still listed (so the rejection path can be demonstrated) but marked
        and sorted last.
        """
        cases = []
        try:
            names = sorted(p.name for p in self.samples_dir.iterdir() if p.suffix.lower() == ".json")
        except OSError:
            names = []
        for name in names:
            if name in ("expected.json", "oracle.json"):
                continue
            path = self.samples_dir / name
            try:
                meta = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, UnicodeDecodeError):
                continue
            if not isinstance(meta, dict) or "width" not in meta or "height" not in meta:
                continue
            entry = {
                "json": name,
                "name": name[:-5],
                "size": [meta.get("width"), meta.get("height")],
            }
            depth_name = meta.get("depth")
            if isinstance(depth_name, str):
                try:
                    expected = int(meta["width"]) * int(meta["height"]) * 4
                    actual = (self.samples_dir / Path(depth_name).name).stat().st_size
                    entry["depthBytes"] = actual
                    entry["expectedDepthBytes"] = expected
                    entry["valid"] = actual == expected
                    if actual != expected:
                        entry["note"] = (
                            f"深度文件 {actual} 字节，需要 {expected} 字节（缺少 {expected - actual}）"
                        )
                except (OSError, TypeError, ValueError):
                    entry["valid"] = False
                    entry["note"] = "深度文件不可读"
            cases.append(entry)
        cases.sort(key=lambda c: (not c.get("valid", False), -sum(c.get("size") or [0, 0]), c["name"]))
        self._send_json(HTTPStatus.OK, {"cases": cases})

    def log_message(self, fmt: str, *args) -> None:  # keep the console readable
        print(f"  {self.address_string()} {fmt % args}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Stereo depth forge local server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    ensure_samples()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Stereo Depth Forge  http://localhost:{args.port}/", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
