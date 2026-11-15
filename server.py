#!/usr/bin/env python3
"""Local server for the voxel ray workbench.

Serves the static page in app/ and, read-only, the sample cases unpacked from
samples/volume-ray-cases.zip.  Standard library only; the page itself has no
third-party runtime dependencies and loads nothing from the network.

Usage:
    python3 server.py [--host HOST] [--port PORT] [--samples DIR]

Nothing is ever written outside the one-time sample extraction into
samples/extracted/ (skipped when that directory already has files).
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
SAMPLES_DIR = ROOT / "samples" / "extracted"
SAMPLES_ZIP = ROOT / "samples" / "volume-ray-cases.zip"

# Files that make up a loaded case; .json describes .raw.
CASE_SUFFIXES = {".raw", ".json"}

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
    ".raw": "application/octet-stream",
}


def ensure_samples(dest: Path = SAMPLES_DIR) -> None:
    """Unpack the sample archive once, refusing anything outside dest."""
    if dest.is_dir() and any(dest.iterdir()):
        return
    if not SAMPLES_ZIP.is_file():
        return
    try:
        import zipfile

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
    server_version = "VoxelRayWorkbench/1.0"
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
        # The page is local-only; never sniff rendered content.
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
        """List case JSONs, each with the size of the RAW it points at.

        Cases whose declared byte count does not match the RAW are kept in the
        list but sorted to the end and flagged, so the valid samples come
        first and the deliberately broken fixture stays available for the
        error-handling demonstration.
        """
        entries = []
        try:
            names = sorted(p.name for p in self.samples_dir.iterdir() if p.suffix.lower() == ".json")
        except OSError:
            names = []
        for name in names:
            if name == "oracle.json":
                continue
            path = self.samples_dir / name
            try:
                meta = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, UnicodeDecodeError):
                continue
            if not isinstance(meta, dict) or "dimensions" not in meta:
                continue
            raw_name = meta.get("raw")
            raw_size = None
            invalid = None
            if isinstance(raw_name, str):
                try:
                    raw_size = (self.samples_dir / Path(raw_name).name).stat().st_size
                except OSError:
                    raw_size = None
                # Mirror core.validateMeta's length rule, folded to one line.
                dims = meta.get("dimensions")
                vtype = meta.get("voxelType")
                if (
                    raw_size is not None
                    and isinstance(dims, list) and len(dims) == 3
                    and vtype in ("u8", "uint8", "u16", "uint16")
                    and all(isinstance(d, int) and not isinstance(d, bool) for d in dims)
                ):
                    per = 2 if str(vtype).lower() in ("u16", "uint16") else 1
                    expected = dims[0] * dims[1] * dims[2] * per
                    if expected != raw_size:
                        invalid = (
                            f"RAW 长度不符：需要 {expected} 字节，实际 {raw_size} 字节"
                            f"（{'多' if raw_size > expected else '少'} {abs(raw_size - expected)} 字节）"
                        )
            entries.append({
                "name": name,
                "meta": meta,
                "rawName": raw_name,
                "rawSize": raw_size,
                "invalid": invalid,
                "url": "/api/case/" + name,
                "rawUrl": "/api/case/" + Path(str(raw_name)).name if raw_name else None,
            })
        entries.sort(key=lambda e: (bool(e["invalid"]), e["name"]))
        self._send_json(HTTPStatus.OK, {"samples": entries})

    def log_message(self, fmt: str, *args) -> None:  # one quiet line per request
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Voxel ray workbench server")
    parser.add_argument("--host", default=os.environ.get("WORKBENCH_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WORKBENCH_PORT", "8000")))
    parser.add_argument("--samples", default=str(SAMPLES_DIR), help="directory of sample cases")
    args = parser.parse_args(argv)

    Handler.samples_dir = Path(args.samples).resolve()
    if Handler.samples_dir == SAMPLES_DIR.resolve():
        ensure_samples(Handler.samples_dir)

    if not (APP_DIR / "index.html").is_file():
        print(f"error: missing {APP_DIR / 'index.html'}", file=sys.stderr)
        return 2

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    host_display = "localhost" if args.host in ("0.0.0.0", "127.0.0.1", "::") else args.host
    print(f"Voxel ray workbench: http://{host_display}:{args.port}/  (Ctrl+C to stop)", flush=True)
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
