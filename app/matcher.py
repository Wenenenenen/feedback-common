"""时间偏移投票匹配（投票与可靠性判定严格遵循 说明.md）。"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .fingerprint import HOP, Fingerprint
from .index import Index, decode_hash, encode_hash

MIN_VOTES = 12
MIN_SCORE = 0.25
VOTE_TOLERANCE = 1  # 偏移落在 [d-1, d+1]


@dataclass
class PairVote:
    """查询配对 i 的完整可解释记录。"""
    pair_index: int
    anchor_frame: int
    anchor_bin: int
    target_frame: int
    target_bin: int
    delta_frame: int
    hash: int
    postings: list[tuple[str, int]]          # (库文件, 参考锚帧)
    contributions: list[tuple[str, int]] = field(default_factory=list)
    # 该配对在最终每个库的最佳中心下贡献: (库文件, 偏移 d)


@dataclass
class MatchResult:
    file_id: str
    offset_frame: int                        # 最佳中心 d（帧）
    offset_samples: int                      # d * 128
    offset_seconds: float
    votes: int
    score: float
    reliable: bool
    query_total_pairs: int
    pair_vote_ids: list[int]                 # 投到最佳中心的不同查询配对下标
    candidates: list[tuple[int, int, float]] # 前若干候选 (d, 票数, score) 供调试


def _vote_for_reference(
    q_ids: np.ndarray, d_vals: np.ndarray, n_total_pairs: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """向量化投票：对每个出现过的候选中心 c，统计原始偏移落在 [c-1,c+1] 的不同配对数。

    组装全部 (中心编号, 查询配对) 覆盖对后编码为一维整数去重、bincount 计票，
    与逐中心集合定义完全等价。返回 (中心数组, 票数数组, 去重后的中心编号, 去重后的配对下标)。
    """
    centers = np.unique(d_vals)
    order = np.argsort(d_vals, kind="stable")
    d_sorted = d_vals[order]
    q_sorted = q_ids[order]
    lo = np.searchsorted(d_sorted, centers - VOTE_TOLERANCE, side="left")
    hi = np.searchsorted(d_sorted, centers + VOTE_TOLERANCE, side="right")

    seg_len = hi - lo
    center_idx = np.repeat(np.arange(len(centers)), seg_len)
    cum_before = np.concatenate(([0], np.cumsum(seg_len)[:-1]))
    within = np.arange(len(center_idx)) - np.repeat(cum_before, seg_len)
    pair_ids = q_sorted[lo[center_idx] + within]

    # 编码为一维整数后去重（避免二维 np.unique 的高开销）
    n_pairs_hint = max(1, n_total_pairs)
    encoded = center_idx * n_pairs_hint + pair_ids
    uniq_encoded = np.unique(encoded)
    uniq_center = uniq_encoded // n_pairs_hint
    uniq_pair = uniq_encoded - uniq_center * n_pairs_hint
    counts = np.bincount(uniq_center, minlength=len(centers))
    return centers, counts, uniq_center, uniq_pair


def match(fp_query: Fingerprint, index: Index) -> tuple[list[MatchResult], list[PairVote]]:
    """对索引内全部参考逐条投票；返回排序后的全部结果与配对级解释记录。"""
    total_pairs = len(fp_query.pairs)
    pair_records: list[PairVote] = []

    all_hashes = [encode_hash(hab, htb, hdf)
                  for _, _, _, _, (hab, htb, hdf) in fp_query.pairs]
    lib_rows = index.list_files()
    idx_to_fid = [r["file_id"] for r in lib_rows]
    bulk = index.lookup_hashes_bulk(all_hashes)  # hash -> (文件序号数组, 锚帧数组)

    # 先建配对解释记录（发布表字符串视图，供 /api/explain）
    for qi, (af, ab, tf, tb, (hab, htb, hdf)) in enumerate(fp_query.pairs):
        f_idx, rafs = bulk[all_hashes[qi]]
        postings = [(idx_to_fid[int(k)], int(v)) for k, v in zip(f_idx, rafs)]
        pair_records.append(PairVote(
            pair_index=qi, anchor_frame=af, anchor_bin=ab,
            target_frame=tf, target_bin=htb, delta_frame=hdf,
            hash=all_hashes[qi], postings=postings,
        ))

    # 批量拼出全部命中事件: (查询配对下标, 偏移 d, 库文件序号)
    ev_q: list[np.ndarray] = []
    ev_d: list[np.ndarray] = []
    ev_f: list[np.ndarray] = []
    anchor_frames = np.array([p[0] for p in fp_query.pairs], dtype=np.int64)
    for qi, h in enumerate(all_hashes):
        f_idx, rafs = bulk[h]
        if f_idx.size == 0:
            continue
        ev_q.append(np.full(f_idx.size, qi, dtype=np.int64))
        ev_d.append(rafs - anchor_frames[qi])
        ev_f.append(f_idx)

    results: list[MatchResult] = []
    if ev_q:
        all_q = np.concatenate(ev_q)
        all_d = np.concatenate(ev_d)
        all_f = np.concatenate(ev_f)
    else:
        all_q = np.zeros(0, dtype=np.int64)
        all_d = np.zeros(0, dtype=np.int64)
        all_f = np.zeros(0, dtype=np.int64)

    for k, row in enumerate(lib_rows):
        file_id = row["file_id"]
        sel = np.where(all_f == k)[0]
        if sel.size == 0:
            results.append(MatchResult(
                file_id=file_id, offset_frame=0, offset_samples=0, offset_seconds=0.0,
                votes=0, score=0.0, reliable=False, query_total_pairs=total_pairs,
                pair_vote_ids=[], candidates=[]))
            continue
        ref_q = all_q[sel]
        ref_d = all_d[sel]
        centers, counts, uniq_center, uniq_pair = _vote_for_reference(
            ref_q, ref_d, total_pairs)
        # 最佳中心：票数最多、d 最小
        best_pos = int(np.lexsort((centers, -counts))[0])
        best_d = int(centers[best_pos])
        mask = uniq_center == best_pos
        best_pair_ids = uniq_pair[mask]
        best_set = set(best_pair_ids.tolist())
        votes = int(counts[best_pos])
        score = votes / total_pairs if total_pairs else 0.0
        reliable = votes >= MIN_VOTES and score >= MIN_SCORE
        top10 = np.lexsort((centers, -counts))[:10]
        candidate_list = [
            (int(centers[p]), int(counts[p]),
             int(counts[p]) / total_pairs if total_pairs else 0.0)
            for p in top10]
        results.append(MatchResult(
            file_id=file_id,
            offset_frame=best_d,
            offset_samples=best_d * HOP,
            offset_seconds=best_d * HOP / 16000.0,
            votes=votes,
            score=score,
            reliable=reliable,
            query_total_pairs=total_pairs,
            pair_vote_ids=sorted(best_set),
            candidates=candidate_list,
        ))
        if reliable:
            # 最佳中心 [d-1,d+1] 内的事件，供配对级解释（同配对在该参考下只记一次）
            tol_mask = np.abs(ref_d - best_d) <= VOTE_TOLERANCE
            tol_q = ref_q[tol_mask]
            tol_d = ref_d[tol_mask]
            order_t = np.argsort(tol_q, kind="stable")
            sq, sd = tol_q[order_t], tol_d[order_t]
            uniq_q, first_idx = np.unique(sq, return_index=True)
            for qv, dv in zip(uniq_q.tolist(), sd[first_idx].tolist()):
                pair_records[int(qv)].contributions.append((file_id, int(dv)))

    # 结果按 score 降序、票数降序、文件标识升序
    results.sort(key=lambda r: (-r.score, -r.votes, r.file_id))
    return results, pair_records


def explain_pair(record: PairVote) -> dict:
    """单条配对为何投到某个时间：哈希、发布表命中、每条命中的偏移计算。"""
    ab, tb, df = decode_hash(record.hash)
    return {
        "pair_index": record.pair_index,
        "query_anchor": {"frame": record.anchor_frame, "bin": record.anchor_bin,
                         "time_seconds": record.anchor_frame * HOP / 16000.0},
        "query_target": {"frame": record.target_frame, "bin": record.target_bin,
                         "time_seconds": record.target_frame * HOP / 16000.0},
        "delta_frames": record.delta_frame,
        "hash": record.hash,
        "hash_tuple": [ab, tb, df],
        "postings": [
            {"file_id": fid, "ref_anchor_frame": raf,
             "ref_anchor_seconds": raf * HOP / 16000.0,
             "offset_d": raf - record.anchor_frame,
             "offset_samples": (raf - record.anchor_frame) * HOP}
            for fid, raf in record.postings
        ],
        "final_contributions": [
            {"file_id": fid, "raw_offset_d": d}
            for fid, d in record.contributions
        ],
    }
