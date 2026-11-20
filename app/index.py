"""SQLite 倒排索引：库文件、音频指纹峰、配对哈希 -> 锚帧发布表。"""
from __future__ import annotations

import os
import sqlite3

import numpy as np

from .audio import SAMPLE_RATE, read_wav
from .fingerprint import HOP, Fingerprint, fingerprint

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    id          INTEGER PRIMARY KEY,
    file_id     TEXT NOT NULL UNIQUE,
    path        TEXT NOT NULL,
    n_samples   INTEGER NOT NULL,
    duration    REAL NOT NULL,
    n_peaks     INTEGER NOT NULL,
    n_pairs     INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS peaks (
    file_id TEXT NOT NULL,
    frame   INTEGER NOT NULL,
    bin     INTEGER NOT NULL,
    amp     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS postings (
    hash  INTEGER NOT NULL,
    ref_file_id TEXT NOT NULL,
    anchor_frame INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_postings_hash ON postings(hash);
CREATE INDEX IF NOT EXISTS idx_peaks_file ON peaks(file_id);
"""


def encode_hash(ab: int, tb: int, df: int) -> int:
    """三元组打包为 32 位整数（箱均 < 256，帧差 <= 24）。"""
    return (int(ab) << 12) | (int(tb) << 5) | int(df)


def decode_hash(h: int) -> tuple[int, int, int]:
    df = h & 0x1F
    tb = (h >> 5) & 0xFF
    ab = (h >> 12) & 0xFF
    return ab, tb, df


class Index:
    def __init__(self, db_path: str, wav_dir: str):
        self.db_path = db_path
        self.wav_dir = wav_dir
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        os.makedirs(wav_dir, exist_ok=True)
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        # 串行化写入，配合 ThreadingHTTPServer 跨线程复用
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # ---------- 库管理 ----------
    def list_files(self) -> list[sqlite3.Row]:
        return list(self.conn.execute(
            "SELECT * FROM files ORDER BY file_id"))

    def get_file(self, file_id: str) -> sqlite3.Row | None:
        return self.conn.execute(
            "SELECT * FROM files WHERE file_id = ?", (file_id,)).fetchone()

    def wav_path(self, file_id: str) -> str:
        return os.path.join(self.wav_dir, file_id + ".wav")

    def unique_file_id(self, original: str) -> str:
        """导入时生成库内唯一名称（基名去扩展名，重名追加 -2、-3…）。"""
        base = os.path.splitext(os.path.basename(original))[0] or "audio"
        candidate = base
        i = 2
        existing = {r["file_id"] for r in self.list_files()}
        while candidate in existing:
            candidate = f"{base}-{i}"
            i += 1
        return candidate

    def add_file(self, src_path: str, original_name: str,
                 sha256: str, fp: Fingerprint | None = None) -> str:
        x = read_wav(src_path)
        file_id = self.unique_file_id(original_name)
        dest = self.wav_path(file_id)
        with open(src_path, "rb") as fsrc, open(dest, "wb") as fdst:
            fdst.write(fsrc.read())
        if fp is None:
            fp = fingerprint(x)
        self._store_fingerprint(file_id, x, fp, sha256, dest)
        return file_id

    def _store_fingerprint(self, file_id: str, x: np.ndarray, fp: Fingerprint,
                           sha256: str, dest: str) -> None:
        cur = self.conn
        cur.execute(
            "INSERT INTO files(file_id, path, n_samples, duration, n_peaks, n_pairs, sha256)"
            " VALUES (?,?,?,?,?,?,?)",
            (file_id, dest, len(x), len(x) / SAMPLE_RATE,
             len(fp.peaks), len(fp.pairs), sha256),
        )
        cur.executemany(
            "INSERT INTO peaks(file_id, frame, bin, amp) VALUES (?,?,?,?)",
            [(file_id, f, b, a) for f, b, a in fp.peaks],
        )
        cur.executemany(
            "INSERT INTO postings(hash, ref_file_id, anchor_frame) VALUES (?,?,?)",
            [(encode_hash(ab, tb, df), file_id, af)
             for af, ab, tf, tb, (ab, tb, df) in fp.pairs],
        )
        cur.commit()

    def remove_file(self, file_id: str) -> bool:
        row = self.get_file(file_id)
        if row is None:
            return False
        self.conn.execute("DELETE FROM files WHERE file_id = ?", (file_id,))
        self.conn.execute("DELETE FROM peaks WHERE file_id = ?", (file_id,))
        self.conn.execute("DELETE FROM postings WHERE ref_file_id = ?", (file_id,))
        self.conn.commit()
        p = self.wav_path(file_id)
        if os.path.exists(p):
            os.remove(p)
        return True

    def rebuild(self, get_wav: list[tuple[str, str, str]] | None = None) -> list[str]:
        """清空并基于 wav_dir 内现存文件（或显式 (路径, 原名, sha256) 列表）重建。"""
        self.conn.executescript(
            "DELETE FROM postings; DELETE FROM peaks; DELETE FROM files;")
        self.conn.commit()
        imported: list[str] = []
        if get_wav is None:
            items = [(os.path.join(self.wav_dir, fn), fn, None)
                     for fn in sorted(os.listdir(self.wav_dir)) if fn.endswith(".wav")]
        else:
            items = get_wav
        for src, original, sha in items:
            x = read_wav(src)
            fp = fingerprint(x)
            file_id = self.unique_file_id(original)
            dest = self.wav_path(file_id)
            if os.path.abspath(src) != os.path.abspath(dest):
                with open(src, "rb") as fsrc, open(dest, "wb") as fdst:
                    fdst.write(fsrc.read())
            if sha is None:
                import hashlib
                sha = hashlib.sha256(open(dest, "rb").read()).hexdigest()
            self._store_fingerprint(file_id, x, fp, sha, dest)
            imported.append(file_id)
        return imported

    def peaks_for(self, file_id: str) -> list[tuple[int, int, float]]:
        rows = self.conn.execute(
            "SELECT frame, bin, amp FROM peaks WHERE file_id = ? ORDER BY frame, bin",
            (file_id,)).fetchall()
        return [(r["frame"], r["bin"], r["amp"]) for r in rows]

    def lookup_hash(self, h: int) -> list[sqlite3.Row]:
        return list(self.conn.execute(
            "SELECT ref_file_id, anchor_frame FROM postings WHERE hash = ? ORDER BY ref_file_id",
            (h,)).fetchall())

    def lookup_hashes_bulk(self, hashes: list[int]) -> dict[int, tuple[np.ndarray, np.ndarray]]:
        """一次取回多个哈希的发布表：{hash: (库文件序号数组, 参考锚帧数组)}。

        库文件序号对应 list_files() 的行序，由调用方映射回 file_id。
        """
        if not hashes:
            return {}
        fid_to_idx = {r["file_id"]: k for k, r in enumerate(self.list_files())}
        out: dict[int, tuple[np.ndarray, np.ndarray]] = {h: (np.empty(0, np.int64),
                                                              np.empty(0, np.int64))
                                                          for h in hashes}
        # SQLite 变量上限默认 999，分批处理
        for i in range(0, len(hashes), 900):
            chunk = hashes[i:i + 900]
            placeholders = ",".join("?" * len(chunk))
            rows = self.conn.execute(
                f"SELECT hash, ref_file_id, anchor_frame FROM postings "
                f"WHERE hash IN ({placeholders})", chunk).fetchall()
            grouped: dict[int, list[tuple[int, int]]] = {}
            for r in rows:
                grouped.setdefault(r["hash"], []).append(
                    (fid_to_idx[r["ref_file_id"]], r["anchor_frame"]))
            for h, items in grouped.items():
                arr = np.array(items, dtype=np.int64)
                out[h] = (arr[:, 0], arr[:, 1])
        return out
