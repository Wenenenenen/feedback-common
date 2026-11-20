"""HTTP 服务：库管理、查询、投票解释、试听区间、报告导出（仅标准库 + numpy）。"""
from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.parse
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

from .audio import (MAX_LIBRARY_FILES, MAX_UPLOAD_BYTES, AudioFormatError,
                    SAMPLE_RATE, check_duration, read_wav)
from .fingerprint import HOP, NFFT, fingerprint
from .index import Index, decode_hash
from .matcher import MIN_SCORE, MIN_VOTES, explain_pair, match
from .multipart import parse_multipart

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(ROOT, "app", "static")
DATA_DIR = os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA_DIR, "index.db")
WAV_DIR = os.path.join(DATA_DIR, "library")
QUERY_DIR = os.path.join(DATA_DIR, "queries")

# 最近查询缓存: query_id -> {"wav": 路径, "records": PairVote 列表, "fp_meta": ...}
QUERY_CACHE: dict[str, dict] = {}
QUERY_CACHE_MAX = 20


def _spectrogram_payload(fp) -> dict:
    """下采样后的频谱矩阵（log 幅值）+ 峰 + 配对连线，供前端绘制星座图。"""
    spec = fp.spectrogram
    if spec.size:
        log_spec = np.log1p(spec)
        # 时间维最多 256 列、频率维最多 128 行下采样，控制传输体积
        nf, nb = log_spec.shape
        t_step = max(1, nf // 256)
        b_step = max(1, nb // 128)
        grid = log_spec[::t_step, ::b_step]
        matrix = np.round(grid, 3).tolist()
    else:
        matrix = []
        t_step = b_step = 1
    peaks = [{"frame": f, "bin": b, "amp": round(a, 4),
              "t": round(f * HOP / SAMPLE_RATE, 4),
              "freq": round(b * SAMPLE_RATE / NFFT, 1)} for f, b, a in fp.peaks]
    lines = [{"af": af, "ab": ab, "tf": tf, "tb": tb,
              "at": round(af * HOP / SAMPLE_RATE, 4),
              "tt": round(tf * HOP / SAMPLE_RATE, 4),
              "afreq": round(ab * SAMPLE_RATE / NFFT, 1),
              "tfreq": round(tb * SAMPLE_RATE / NFFT, 1)}
             for af, ab, tf, tb, _ in fp.pairs]
    return {
        "matrix": matrix,
        "t_step": t_step,
        "b_step": b_step,
        "n_frames": fp.n_frames,
        "n_bins": spec.shape[1] if spec.ndim == 2 else NFFT // 2 + 1,
        "duration_frames": fp.n_frames,
        "peaks": peaks,
        "lines": lines,
        "hop": HOP,
        "sample_rate": SAMPLE_RATE,
        "nfft": NFFT,
        "global_max": fp.global_max,
        "silent": fp.silent,
    }


def _match_payload(r) -> dict:
    return {
        "file_id": r.file_id,
        "offset_frame": r.offset_frame,
        "offset_samples": r.offset_samples,
        "offset_seconds": round(r.offset_seconds, 4),
        "votes": r.votes,
        "score": round(r.score, 4),
        "match_percent": round(r.score * 100, 1),
        "reliable": r.reliable,
        "query_total_pairs": r.query_total_pairs,
        "pair_vote_ids": r.pair_vote_ids,
        "candidates": [{"d": d, "votes": v, "score": round(s, 4)}
                       for d, v, s in r.candidates],
    }


def _save_query_wav(x: np.ndarray, query_id: str) -> str:
    os.makedirs(QUERY_DIR, exist_ok=True)
    p = os.path.join(QUERY_DIR, query_id + ".wav")
    pcm = np.clip(x, -1.0, 1.0)
    pcm = (pcm * 32767.0).round().astype("<i2").tobytes()
    with wave.open(p, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return p


class Handler(BaseHTTPRequestHandler):
    server_version = "ConstellationAudioFinder/1.0"

    def log_message(self, fmt, *args):  # 安静一点
        pass

    # ---------- 基础工具 ----------
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, msg, status=400):
        self._json({"error": msg}, status)

    def _wav_file(self, path, name):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except FileNotFoundError:
            return self._error("文件不存在", 404)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Disposition",
                         f'inline; filename="{urllib.parse.quote(name)}.wav"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length", 0))
        if n > MAX_UPLOAD_BYTES * 3:  # multipart 开销余量
            raise AudioFormatError("上传数据超过大小限制")
        return self.rfile.read(n) if n else b""

    def log_error(self, fmt, *args):
        pass

    # ---------- 路由 ----------
    def do_GET(self):
        try:
            self._route_get()
        except (ConnectionError, BrokenPipeError, ConnectionResetError):
            pass  # 客户端提前断开，无需响应

    def _route_get(self):
        parsed = urllib.parse.urlparse(self.path)
        path, qs = parsed.path, urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/" or path == "/index.html":
                return self._static("index.html")
            if path.startswith("/static/"):
                return self._static(path[len("/static/"):])
            if path == "/api/library":
                return self._list_library()
            if path == "/api/audio":
                return self._serve_audio(qs)
            if path == "/api/constellation":
                return self._constellation(qs)
            if path == "/api/explain":
                return self._explain(qs)
            if path == "/api/report":
                return self._report(qs)
            self._error("未找到", 404)
        except AudioFormatError as e:
            self._error(str(e), 400)
        except Exception as e:  # noqa: BLE001
            self._error(f"服务器错误: {e}", 500)

    def do_POST(self):
        try:
            self._route_post()
        except (ConnectionError, BrokenPipeError, ConnectionResetError):
            pass  # 客户端提前断开，无需响应

    def _route_post(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/library/add":
                return self._add_library()
            if path == "/api/library/remove":
                return self._remove_library()
            if path == "/api/rebuild":
                return self._rebuild()
            if path == "/api/query":
                return self._query()
            self._error("未找到", 404)
        except AudioFormatError as e:
            self._error(str(e), 400)
        except Exception as e:  # noqa: BLE001
            self._error(f"服务器错误: {e}", 500)

    # ---------- 静态 ----------
    def _static(self, name: str):
        # 防目录穿越
        name = os.path.normpath(name).lstrip("/\\")
        p = os.path.join(STATIC_DIR, name)
        if not os.path.abspath(p).startswith(os.path.abspath(STATIC_DIR)) or not os.path.isfile(p):
            return self._error("未找到", 404)
        ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}.get(
                 os.path.splitext(p)[1], "application/octet-stream")
        with open(p, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---------- 库管理 ----------
    def _index(self) -> Index:
        return Handler.index

    def _list_library(self):
        rows = self._index().list_files()
        self._json({"files": [dict(r) for r in rows],
                    "max_files": MAX_LIBRARY_FILES,
                    "thresholds": {"min_votes": MIN_VOTES, "min_score": MIN_SCORE}})

    def _add_library(self):
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            return self._error("需要 multipart/form-data 上传", 400)
        form = parse_multipart(self._body(), ctype)
        if "file" not in form:
            return self._error("缺少 file 字段", 400)
        part = form["file"]
        original = part["filename"] or "audio.wav"
        if not original.lower().endswith(".wav"):
            return self._error("仅支持 .wav 文件", 400)
        if len(self._index().list_files()) >= MAX_LIBRARY_FILES:
            return self._error(f"素材库最多 {MAX_LIBRARY_FILES} 条", 400)
        tmp = os.path.join(DATA_DIR, "_upload_" + str(os.getpid()) + ".wav")
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(tmp, "wb") as f:
            f.write(part["data"])
        try:
            x = read_wav(tmp)
            check_duration(x, "reference")
            sha = hashlib.sha256(part["data"]).hexdigest()
            file_id = self._index().add_file(tmp, original, sha)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        self._json({"ok": True, "file_id": file_id})

    def _remove_library(self):
        try:
            req = json.loads(self._body() or b"{}")
        except json.JSONDecodeError:
            return self._error("请求体不是合法 JSON", 400)
        file_id = req.get("file_id", "")
        if not isinstance(file_id, str) or not file_id:
            return self._error("缺少 file_id", 400)
        if not self._index().remove_file(file_id):
            return self._error("库中不存在该文件", 404)
        self._json({"ok": True})

    def _rebuild(self):
        idx = self._index()
        # 以 wav_dir 内现存文件为准重建（替换文件后调用）
        imported = idx.rebuild()
        self._json({"ok": True, "imported": imported,
                    "files": [dict(r) for r in idx.list_files()]})

    # ---------- 查询 ----------
    def _query(self):
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            return self._error("需要 multipart/form-data 上传", 400)
        form = parse_multipart(self._body(), ctype)
        if "file" not in form:
            return self._error("缺少 file 字段", 400)
        part = form["file"]
        original = part["filename"] or "query.wav"
        tmp = os.path.join(DATA_DIR, "_query_" + str(os.getpid()) + ".wav")
        with open(tmp, "wb") as f:
            f.write(part["data"])
        try:
            x = read_wav(tmp)
            check_duration(x, "query")
            fp = fingerprint(x)
            results, records = match(fp, self._index())
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)

        query_id = hashlib.sha1(
            part["data"] + str(time.time_ns()).encode()).hexdigest()[:16]
        wav_path = _save_query_wav(x, query_id)
        QUERY_CACHE[query_id] = {"wav": wav_path, "records": records,
                                 "original": original}
        while len(QUERY_CACHE) > QUERY_CACHE_MAX:
            old, oldv = next(iter(QUERY_CACHE.items()))
            QUERY_CACHE.pop(old)
            try:
                os.remove(oldv["wav"])
            except OSError:
                pass

        reliable = [_match_payload(r) for r in results if r.reliable]
        all_rows = [_match_payload(r) for r in results]
        payload = {
            "query_id": query_id,
            "original_name": original,
            "n_samples": len(x),
            "duration_seconds": round(len(x) / SAMPLE_RATE, 4),
            "n_peaks": len(fp.peaks),
            "n_pairs": len(fp.pairs),
            "silent": fp.silent,
            "global_max": fp.global_max,
            "constellation": _spectrogram_payload(fp),
            "results": all_rows,
            "reliable_matches": reliable,
            "has_reliable_match": bool(reliable),
            "thresholds": {"min_votes": MIN_VOTES, "min_score": MIN_SCORE},
        }
        self._json(payload)

    # ---------- 解释 ----------
    def _explain(self, qs):
        query_id = qs.get("query_id", [""])[0]
        pair_index = qs.get("pair", [""])[0]
        cache = QUERY_CACHE.get(query_id)
        if cache is None:
            return self._error("查询已过期，请重新检索", 404)
        try:
            i = int(pair_index)
            record = cache["records"][i]
        except (ValueError, IndexError):
            return self._error("配对下标无效", 400)
        self._json(explain_pair(record))

    # ---------- 试听 ----------
    def _serve_audio(self, qs):
        kind = qs.get("kind", ["query"])[0]
        if kind == "query":
            query_id = qs.get("query_id", [""])[0]
            cache = QUERY_CACHE.get(query_id)
            if cache is None:
                return self._error("查询已过期", 404)
            return self._wav_file(cache["wav"], "query")
        file_id = qs.get("file_id", [""])[0]
        row = self._index().get_file(file_id)
        if row is None:
            return self._error("库中不存在该文件", 404)
        return self._wav_file(row["path"], file_id)

    # ---------- 库文件星座图 ----------
    def _constellation(self, qs):
        file_id = qs.get("file_id", [""])[0]
        row = self._index().get_file(file_id)
        if row is None:
            return self._error("库中不存在该文件", 404)
        x = read_wav(row["path"])
        fp = fingerprint(x)
        self._json({"file_id": file_id, "constellation": _spectrogram_payload(fp)})

    # ---------- 报告 ----------
    def _report(self, qs):
        query_id = qs.get("query_id", [""])[0]
        fmt = qs.get("format", ["json"])[0]
        cache = QUERY_CACHE.get(query_id)
        if cache is None:
            return self._error("查询已过期，请重新检索", 404)
        # 重新计算以保证报告自包含
        x = read_wav(cache["wav"])
        fp = fingerprint(x)
        results, _ = match(fp, self._index())
        meta = {
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "query_file": cache["original"],
            "query_duration_seconds": round(len(x) / SAMPLE_RATE, 4),
            "query_n_peaks": len(fp.peaks),
            "query_n_pairs": len(fp.pairs),
            "query_silent": fp.silent,
            "library": [dict(r) for r in self._index().list_files()],
            "thresholds": {"min_votes": MIN_VOTES, "min_score": MIN_SCORE},
            "results": [_match_payload(r) for r in results],
            "reliable_matches": [r.file_id for r in results if r.reliable],
        }
        if fmt == "markdown":
            body = self._report_markdown(meta).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Content-Disposition",
                             'attachment; filename="audio-match-report.md"')
        else:
            body = json.dumps(meta, ensure_ascii=False, indent=2).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Disposition",
                             'attachment; filename="audio-match-report.json"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _report_markdown(meta: dict) -> str:
        lines = [
            "# 短音频来源检索报告", "",
            f"- 生成时间：{meta['generated_at']}",
            f"- 查询文件：{meta['query_file']}",
            f"- 查询时长：{meta['query_duration_seconds']} 秒",
            f"- 查询频谱峰：{meta['query_n_peaks']} 个；配对指纹：{meta['query_n_pairs']} 条",
            f"- 静音判定：{'是（无有效峰）' if meta['query_silent'] else '否'}",
            f"- 可靠门槛：票数 ≥ {meta['thresholds']['min_votes']} 且 "
            f"匹配比例 ≥ {meta['thresholds']['min_score']}", "",
            "## 素材库", "",
        ]
        for f in meta["library"]:
            lines.append(
                f"- `{f['file_id']}`：{f['duration']:.3f}s，{f['n_peaks']} 峰，"
                f"{f['n_pairs']} 配对，sha256 `{f['sha256'][:16]}…`")
        lines += ["", "## 检索结果", ""]
        if not meta["reliable_matches"]:
            lines += ["**无可靠匹配。**", ""]
        lines.append("| 来源 | 可靠 | 起点(样本) | 起点(秒) | 支持票数 | 匹配比例 |")
        lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
        for r in meta["results"]:
            lines.append(
                f"| `{r['file_id']}` | {'✔' if r['reliable'] else '—'} | "
                f"{r['offset_samples']} | {r['offset_seconds']:.4f} | "
                f"{r['votes']}/{r['query_total_pairs']} | {r['match_percent']}% |")
        lines.append("")
        lines.append("> 偏移含义：查询时刻 0 映射到来源样本位置 d×128，不自动去除查询开头静音。")
        return "\n".join(lines) + "\n"


def make_server(host: str = "127.0.0.1", port: int = 8000) -> ThreadingHTTPServer:
    os.makedirs(DATA_DIR, exist_ok=True)
    Handler.index = Index(DB_PATH, WAV_DIR)
    httpd = ThreadingHTTPServer((host, port), Handler)
    return httpd


def main():
    import argparse
    ap = argparse.ArgumentParser(description="星座图短音频来源检索网页")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    httpd = make_server(args.host, args.port)
    print(f"服务已启动: http://{args.host}:{args.port}  (Ctrl+C 停止)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        Handler.index.close()


if __name__ == "__main__":
    main()
