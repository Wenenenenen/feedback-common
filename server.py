#!/usr/bin/env python3
"""Local section workbench server.

Serves the static page in app/ and the sample fixtures, and nothing else.
Standard library only: no third-party packages, no network access at runtime.
Bind defaults to 0.0.0.0 so a browser on Windows can reach it from WSL2 via
localhost (WSL2 localhost forwarding); no Docker, no external services.

Usage:
    python3 server.py [--host HOST] [--port PORT] [--samples DIR]

The server never writes uploads: STL parsing happens in the browser. The only
file it may create is the one-time sample extraction from
samples/section-cases.zip when samples/extracted/ is absent.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import posixpath
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
DEFAULT_SAMPLES = ROOT / "samples" / "extracted"
SAMPLE_ZIP = ROOT / "samples" / "section-cases.zip"


def ensure_samples(dest: Path = DEFAULT_SAMPLES) -> None:
    """Unpack the sample archive once, if the extracted directory is missing.

    Uses only the standard library. Entries are validated so nothing can be
    written outside dest. Failures are non-fatal: the workbench works without
    samples (files can be dropped in directly).
    """
    if dest.is_dir() and any(dest.glob("*.stl")):
        return
    if not SAMPLE_ZIP.is_file():
        return
    try:
        import zipfile

        dest.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(SAMPLE_ZIP) as zf:
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
        print(f"  samples:      extracted {SAMPLE_ZIP.name} -> {dest}", flush=True)
    except (OSError, zipfile.BadZipFile) as exc:  # pragma: no cover - best effort
        print(f"  samples:      could not extract {SAMPLE_ZIP.name}: {exc}", flush=True)

MIME_OVERRIDES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".stl": "model/stl",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}


def safe_join(base: Path, request_path: str) -> Path | None:
    """Resolve request_path under base, refusing traversal and symlink escapes."""
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
    server_version = "SectionWorkbench/1.0"
    samples_dir: Path = DEFAULT_SAMPLES

    # ----- helpers -----------------------------------------------------
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, cache: str = "no-cache") -> None:
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
        self.send_header("Cache-Control", cache)
        # The page is local-only; no third-party resources are ever loaded.
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

    # ----- routes ------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            target = safe_join(APP_DIR, "index.html")
            if target is None or not target.is_file():
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "index.html missing"})
                return
            self._send_file(target)
            return

        if path == "/api/samples":
            self._send_samples()
            return

        if path.startswith("/api/sample/"):
            name = unquote(path[len("/api/sample/"):])
            target = safe_join(self.samples_dir, name)
            if target is None or not target.is_file() or target.suffix.lower() != ".stl":
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "sample not found"})
                return
            self._send_file(target)
            return

        if path.startswith("/samples/"):
            name = unquote(path[len("/samples/"):])
            target = safe_join(self.samples_dir, name)
            if target is None or not target.is_file():
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "sample not found"})
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

    def _send_samples(self) -> None:
        entries = []
        expected = {}
        expected_path = self.samples_dir / "expected.json"
        try:
            with expected_path.open("r", encoding="utf-8") as fh:
                for row in json.load(fh):
                    expected.setdefault(row["file"], []).append(
                        {
                            "n": row["n"],
                            "d": row["d"],
                            "loops": row["loops"],
                            "holes": row["holes"],
                            "area_mm2": row["area_mm2"],
                            "perimeter_mm": row["perimeter_mm"],
                        }
                    )
        except (OSError, ValueError, KeyError, TypeError):
            # Fixtures are optional; the workbench works without them.
            pass
        try:
            names = sorted(p.name for p in self.samples_dir.iterdir() if p.suffix.lower() == ".stl")
        except OSError:
            names = []
        for name in names:
            try:
                size = (self.samples_dir / name).stat().st_size
            except OSError:
                continue
            entries.append(
                {
                    "name": name,
                    "size": size,
                    "url": "/api/sample/" + name,
                    "expected": expected.get(name, []),
                }
            )
        self._send_json(HTTPStatus.OK, {"samples": entries})

    def log_message(self, fmt: str, *args) -> None:  # quieter, one line
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Mesh section workbench server")
    parser.add_argument("--host", default=os.environ.get("WORKBENCH_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WORKBENCH_PORT", "8000")))
    parser.add_argument("--samples", default=str(DEFAULT_SAMPLES), help="directory of sample STL files")
    args = parser.parse_args(argv)

    Handler.samples_dir = Path(args.samples).resolve()
    if Handler.samples_dir == DEFAULT_SAMPLES.resolve():
        ensure_samples(Handler.samples_dir)

    if not (APP_DIR / "index.html").is_file():
        print(f"error: missing {APP_DIR / 'index.html'}", file=sys.stderr)
        return 2

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    host_display = "localhost" if args.host in ("0.0.0.0", "127.0.0.1", "::") else args.host
    print(f"Section workbench: http://{host_display}:{args.port}/  (Ctrl+C to stop)", flush=True)
    print(f"  app dir:     {APP_DIR}", flush=True)
    print(f"  samples dir: {Handler.samples_dir}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
