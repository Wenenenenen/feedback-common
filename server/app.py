"""双面去透印本地 Web 服务（仅监听 127.0.0.1，零第三方依赖）。

接口：
  GET  /                 静态前端（web/）
  POST /api/solve        multipart 上传 front/back/掩膜/kernels，返回作业与渲染图层
  GET  /api/export      导出 front_pgm / back_pgm / fit_json
  GET  /api/health       健康检查

运行：.venv/bin/python -I -m server.app
"""
from __future__ import annotations

import base64
import json
import os
import sys
import threading
import time
import secrets
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import solver
from server.kernels import KernelError, load_kernels
from server.pgm import PgmError, load_density, load_mask, write_p5

MAX_SIDE = 384
MAX_BODY = 64 * 1024 * 1024
JOB_TTL_SECONDS = 3600
MAX_JOBS = 16

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")
_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}


class UploadError(ValueError):
    pass


# ---------------------------------------------------------------- multipart 解析

def parse_multipart(body: bytes, content_type: str) -> dict[str, bytes]:
    """极简 multipart/form-data 解析，返回 {字段名: 文件字节}（仅取文件部分）。"""
    if "boundary=" not in content_type:
        raise UploadError("缺少 multipart boundary")
    boundary = content_type.split("boundary=", 1)[1].strip().strip('"')
    delim = b"--" + boundary.encode("ascii")
    parts: dict[str, bytes] = {}
    fields: dict[str, str] = {}
    for chunk in body.split(delim):
        if not chunk or chunk in (b"--", b"--\r\n", b"\r\n"):
            continue
        if chunk.startswith(b"--"):
            break
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]
        header_blob, _, payload = chunk.partition(b"\r\n\r\n")
        if not _:
            continue
        headers = {}
        for line in header_blob.split(b"\r\n"):
            if b":" in line:
                k, v = line.split(b":", 1)
                headers[k.decode("latin1").lower().strip()] = v.decode("latin1").strip()
        disp = headers.get("content-disposition", "")
        name = None
        filename = None
        for token in disp.split(";"):
            token = token.strip()
            if token.startswith("name="):
                name = token[5:].strip('"')
            elif token.startswith("filename="):
                filename = token[9:].strip('"')
        if name is None:
            continue
        if filename is not None:
            parts[name] = payload
        else:
            fields[name] = payload.decode("utf-8", errors="replace")
    return {"files": parts, "fields": fields}  # type: ignore[return-value]


# ---------------------------------------------------------------- 作业管理

@dataclass
class Job:
    created: float
    shape: tuple[int, int]
    X: np.ndarray
    Y: np.ndarray
    A: np.ndarray
    B_native: np.ndarray
    mf: np.ndarray
    mb_native: np.ndarray
    kernels_raw: dict
    result: solver.SolveResult
    layers: dict          # base64 float32 渲染图层
    residual_f: np.ndarray
    residual_b_native: np.ndarray
    bleed_f: np.ndarray
    bleed_b_native: np.ndarray


_JOBS: dict[str, Job] = {}
_JOBS_LOCK = threading.Lock()


def _put_job(job: Job) -> str:
    with _JOBS_LOCK:
        now = time.time()
        expired = [k for k, j in _JOBS.items() if now - j.created > JOB_TTL_SECONDS]
        for k in expired:
            del _JOBS[k]
        if len(_JOBS) >= MAX_JOBS:
            oldest = min(_JOBS, key=lambda k: _JOBS[k].created)
            del _JOBS[oldest]
        jid = secrets.token_hex(12)
        _JOBS[jid] = job
    return jid


def get_job(jid: str) -> Job | None:
    with _JOBS_LOCK:
        job = _JOBS.get(jid)
        if job is not None and time.time() - job.created <= JOB_TTL_SECONDS:
            return job
    return None


def _b64_layer(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype=np.float32).tobytes()).decode("ascii")


def _build_layers(job: Job) -> dict:
    """正面图层按正面坐标；背面图层恢复原始朝向（左右镜像回去）。"""
    r = job.result
    X, Y = r.X, r.Y
    Y_native = Y[:, ::-1]
    X_view = X
    bleed_f = job.bleed_f
    bleed_b_native = job.bleed_b_native
    r_f = job.residual_f
    r_b_native = job.residual_b_native
    return {
        # 正面（正面坐标）
        "front_observed": _b64_layer(job.A),
        "front_estimate": _b64_layer(X_view),
        "front_bleed": _b64_layer(bleed_f),
        "front_residual": _b64_layer(r_f),
        "front_mask": _b64_layer(job.mf),
        # 背面（原始朝向）
        "back_observed": _b64_layer(job.B_native),
        "back_estimate": _b64_layer(Y_native),
        "back_bleed": _b64_layer(bleed_b_native),
        "back_residual": _b64_layer(r_b_native),
        "back_mask": _b64_layer(job.mb_native),
    }


# ---------------------------------------------------------------- 求解流程

def handle_solve(parts: dict[str, bytes], fields: dict[str, str]) -> dict:
    for required in ("front", "back", "kernels"):
        if required not in parts:
            raise UploadError(f"缺少必需文件字段：{required}")
    try:
        A = load_density(parts["front"])
        B_native = load_density(parts["back"])
    except PgmError as exc:
        raise UploadError(f"观测图解析失败：{exc}") from exc
    if A.shape != B_native.shape:
        raise UploadError(f"两面尺寸不一致：正面 {A.shape} vs 背面 {B_native.shape}")
    h, w = A.shape
    if max(h, w) > MAX_SIDE:
        raise UploadError(f"单边最大 {MAX_SIDE} 像素，收到 {max(h, w)}")
    if not (np.all(np.isfinite(A)) and np.all(np.isfinite(B_native))):
        raise UploadError("观测图含非有限值")

    mf = np.ones((h, w), dtype=np.float64)
    mb_native = np.ones((h, w), dtype=np.float64)
    if "mask_front" in parts:
        try:
            mf = load_mask(parts["mask_front"], (h, w))
        except PgmError as exc:
            raise UploadError(f"正面掩膜解析失败：{exc}") from exc
    if "mask_back" in parts:
        try:
            mb_native = load_mask(parts["mask_back"], (h, w))
        except PgmError as exc:
            raise UploadError(f"背面掩膜解析失败：{exc}") from exc

    try:
        kf, kb = load_kernels(parts["kernels"])
        kernels_raw = json.loads(parts["kernels"].decode("utf-8"))
    except (KernelError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UploadError(f"散射核解析失败：{exc}") from exc

    # 仅左右镜像背面观测及其掩膜到正面坐标
    B = np.ascontiguousarray(B_native[:, ::-1])
    mb = np.ascontiguousarray(mb_native[:, ::-1])

    problem = solver.Problem(A=A, B=B, mf=mf, mb=mb, kf=kf, kb=kb)
    cross_check = fields.get("cross_check", "").lower() in ("1", "true", "on", "yes")
    t0 = time.perf_counter()
    result = solver.solve(problem, cross_check=cross_check)
    elapsed = time.perf_counter() - t0

    r1, r2, bleed_f, bleed_b = solver.residuals(problem, result.X, result.Y)
    # 背面产物恢复原始朝向
    residual_b_native = np.ascontiguousarray(r2[:, ::-1])
    bleed_b_native = np.ascontiguousarray(bleed_b[:, ::-1])

    job = Job(
        created=time.time(), shape=(h, w),
        X=result.X, Y=result.Y,
        A=A, B_native=B_native, mf=mf, mb_native=mb_native,
        kernels_raw=kernels_raw, result=result, layers={},
        residual_f=r1, residual_b_native=residual_b_native,
        bleed_f=bleed_f, bleed_b_native=bleed_b_native,
    )
    job.layers = _build_layers(job)
    jid = _put_job(job)

    diagnostics = {
        "objective": result.objective,
        "optimality_inf": result.opt_inf,
        "tolerance": solver.TOL_OPT,
        "meets_tolerance": bool(result.opt_inf <= solver.TOL_OPT),
        "outer_iterations": result.outer_iters,
        "method": result.method,
        "lsq_objective_lower_bound": result.lsq_objective,
        "lsq_max_bound_violation": result.lsq_max_violation,
        "objective_above_lower_bound": bool(result.objective + 1e-10 >= result.lsq_objective),
        "cross_check_objective": _finite_or_none(result.lbfgs_objective),
        "cross_check_optimality_inf": _finite_or_none(result.lbfgs_opt_inf),
        "cross_check_match": result.objective_match,
        "cross_check_enabled": cross_check,
        "elapsed_seconds": elapsed,
        "regularization": solver.REG,
        "variables": 2 * h * w,
    }
    return {
        "job_id": jid,
        "height": h,
        "width": w,
        "max_side_limit": MAX_SIDE,
        "diagnostics": diagnostics,
        "kernels": kernels_raw,
        "layers": job.layers,
    }


def handle_export(job: Job, kind: str) -> tuple[bytes, str, str]:
    if kind == "front_pgm":
        return write_p5(job.X), "image/x-portable-graymap", "front-corrected.pgm"
    if kind == "back_pgm":
        # 背面恢复原朝向
        return write_p5(job.Y[:, ::-1]), "image/x-portable-graymap", "back-corrected.pgm"
    if kind == "fit_json":
        r = job.result
        payload = {
            "schema": "duplex-bleed-fit/v1",
            "coordinate_system": "front coordinates; back side mirrored left-right",
            "shape": [job.shape[0], job.shape[1]],
            "model": {
                "front_residual": "X + K_front·Y − A",
                "back_residual": "Y + K_back·X − B",
                "objective": "Σ Mf·r1² + Σ Mb·r2² + (1/64)·Σ(X²+Y²)",
                "bounds": "X,Y ∈ [0,1]",
                "residual_convention": "prediction − observation",
                "regularization": solver.REG,
            },
            "kernels": job.kernels_raw,
            "diagnostics": {
                "objective": r.objective,
                "optimality_inf": r.opt_inf,
                "outer_iterations": r.outer_iters,
                "method": r.method,
                "lsq_objective_lower_bound": r.lsq_objective,
                "lsq_max_bound_violation": r.lsq_max_violation,
                "cross_check_objective": _finite_or_none(r.lbfgs_objective),
                "cross_check_match": r.objective_match,
            },
            # 核心产物：正面坐标下未量化的 X、Y 拟合数值
            "X": r.X.tolist(),
            "Y": r.Y.tolist(),
            "bleed_front_KfY_front_coords": job.bleed_f.tolist(),
            "bleed_back_KbX_front_coords": np.ascontiguousarray(job.bleed_b_native[:, ::-1]).tolist(),
            "residual_front_front_coords": _json_with_nan(job.residual_f),
            "residual_back_front_coords": _json_with_nan(np.ascontiguousarray(job.residual_b_native[:, ::-1])),
            "mask_front": job.mf.tolist(),
            "mask_back_front_coords": np.ascontiguousarray(job.mb_native[:, ::-1]).tolist(),
        }
        return (json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"),
                "application/json", "fit-values.json")
    raise UploadError(f"未知导出类型：{kind}")


def _finite_or_none(v):
    """JSON 不允许 NaN/Infinity，统一转成 None。"""
    return float(v) if np.isfinite(v) else None


def _json_with_nan(a: np.ndarray):
    """缺测（nan）转成 null，保证严格 JSON。"""
    return [
        [None if not np.isfinite(v) else float(v) for v in row]
        for row in a.tolist()
    ]


# ---------------------------------------------------------------- HTTP 处理

class Handler(BaseHTTPRequestHandler):
    server_version = "DuplexBleed/1.0"

    def _send_json(self, obj, status=HTTPStatus.OK):
        data = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_error_json(self, status: int, message: str):
        self._send_json({"error": message}, status)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._send_json({"status": "ok"})
            return
        if parsed.path == "/api/export":
            qs = parse_qs(parsed.query)
            jid = qs.get("job", [""])[0]
            kind = qs.get("kind", [""])[0]
            job = get_job(jid)
            if job is None:
                self._send_error_json(HTTPStatus.NOT_FOUND, "作业不存在或已过期")
                return
            try:
                data, ctype, filename = handle_export(job, kind)
            except UploadError as exc:
                self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        # 静态文件
        if parsed.path in ("/", "/index.html"):
            rel = "index.html"
        else:
            rel = parsed.path.lstrip("/")
        target = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not target.startswith(STATIC_DIR + os.sep) or not os.path.isfile(target):
            self._send_error_json(HTTPStatus.NOT_FOUND, "资源不存在")
            return
        ext = os.path.splitext(target)[1].lower()
        with open(target, "rb") as f:
            data = f.read()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", _CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if urlparse(self.path).path != "/api/solve":
            self._send_error_json(HTTPStatus.NOT_FOUND, "接口不存在")
            return
        ctype = self.headers.get("Content-Type", "")
        if not ctype.startswith("multipart/form-data"):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "需要 multipart/form-data")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "Content-Length 非法")
            return
        if length <= 0 or length > MAX_BODY:
            self._send_error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                                  f"请求体需在 1..{MAX_BODY // 1024 // 1024}MB 之间")
            return
        body = self.rfile.read(length)
        try:
            parsed = parse_multipart(body, ctype)
            response = handle_solve(parsed["files"], parsed["fields"])
        except (UploadError, PgmError, KernelError) as exc:
            self._send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
            return
        except MemoryError:
            self._send_error_json(HTTPStatus.INSUFFICIENT_STORAGE, "内存不足")
            return
        self._send_json(response)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main():
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"双面去透印服务已启动：http://{host}:{port}/ （Ctrl+C 退出）", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出。")


if __name__ == "__main__":
    main()
