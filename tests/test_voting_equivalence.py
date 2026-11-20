"""向量化投票与 说明.md 朴素定义的对拍测试，以及端到端边界用例。

运行: python3 tests/test_voting_equivalence.py
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.matcher import VOTE_TOLERANCE, _vote_for_reference


def naive_vote(events):
    """说明.md 的逐中心集合定义（参考实现，刻意保持最朴素写法）。"""
    centers = sorted({d for _, d in events})
    voters = {}
    for c in centers:
        s = set()
        for qi, d in events:
            if c - VOTE_TOLERANCE <= d <= c + VOTE_TOLERANCE:
                s.add(qi)  # 每个配对最多计 1 票
        voters[c] = s
    best_d = min(voters, key=lambda d: (-len(voters[d]), d))
    return best_d, voters


def test_equivalence():
    rng = np.random.default_rng(0)
    for case in range(400):
        n = rng.integers(1, 400)
        # 制造一个集中在某偏移附近的主簇 + 随机噪声，模拟真实投票
        true_d = int(rng.integers(-30, 300))
        q_ids = list(range(int(n)))
        d_vals = []
        for qi in q_ids:
            if rng.random() < 0.7:
                d_vals.append(true_d + int(rng.integers(-2, 3)))
            else:
                d_vals.append(int(rng.integers(-50, 350)))
        # 故意制造重复 (同配对同偏移) 与配对多偏移
        q_arr = np.array(q_ids + q_ids[:10], dtype=np.int64)
        d_arr = np.array(d_vals + d_vals[:10], dtype=np.int64)

        centers, counts, uniq_c, uniq_p = _vote_for_reference(q_arr, d_arr, len(q_ids))
        events = list(zip(q_arr.tolist(), d_arr.tolist()))
        best_naive, voters_naive = naive_vote(events)

        # 每个中心票数逐一比对
        for k, c in enumerate(centers.tolist()):
            assert int(counts[k]) == len(voters_naive[c]), (case, c, counts[k], len(voters_naive[c]))
        # 最佳中心：票数最多、d 最小
        best_pos = int(np.lexsort((centers, -counts))[0])
        assert int(centers[best_pos]) == best_naive, case
        # 最佳中心的配对集合一致
        got_set = set(uniq_p[uniq_c == best_pos].tolist())
        assert got_set == voters_naive[best_naive], case
    print("对拍 400 组随机事件：向量化与朴素定义完全等价 ✔")


def test_tie_breaking():
    # 两个中心票数相同 -> 取 d 较小者
    q = np.array([0, 1, 2, 3], dtype=np.int64)
    d = np.array([10, 10, 20, 20], dtype=np.int64)
    centers, counts, _, _ = _vote_for_reference(q, d, 4)
    best = int(centers[int(np.lexsort((centers, -counts))[0])])
    assert best == 10, best
    print("平票取较小 d ✔")

    # 容差 [d-1,d+1]：d=9,10,11 应并入中心 10 的票
    q2 = np.array([0, 1, 2], dtype=np.int64)
    d2 = np.array([9, 10, 11], dtype=np.int64)
    centers2, counts2, _, _ = _vote_for_reference(q2, d2, 3)
    assert dict(zip(centers2.tolist(), counts2.tolist())) == {9: 2, 10: 3, 11: 2}
    print("±1 容差投票正确 ✔")


def test_spectrogram_spec():
    """用合成信号核对 STFT/峰选择的关键约定。"""
    from app.fingerprint import (BIN_HI, BIN_LO, HOP, NFFT, THRESHOLD_DB,
                                 extract_peaks, stft)
    sr = 16000
    t = np.arange(sr) / sr
    # 单频正弦 + 静音前缀
    freq = 1000.0
    x = np.concatenate([np.zeros(1000), 0.5 * np.sin(2 * np.pi * freq * t[:-1000])])
    spec, n_frames = stft(x)
    assert n_frames == 1 + (len(x) - NFFT) // HOP
    peaks, gmax = extract_peaks(spec)
    assert peaks, "正弦信号应产生峰"
    # 峰箱应落在 1000Hz 对应箱附近 (bin = f*N/sr = 32)
    expected_bin = round(freq * NFFT / sr)
    bins_used = {b for _, b, _ in peaks}
    assert any(abs(b - expected_bin) <= 1 for b in bins_used), (expected_bin, bins_used)
    assert all(BIN_LO <= b <= BIN_HI for _, b, _ in peaks)
    # 阈值 = 全局最大 -40dB
    thr = gmax * 10 ** (THRESHOLD_DB / 20)
    assert all(a >= thr for _, _, a in peaks)
    print("STFT/峰选择约定（完整窗口、箱范围、-40dB 阈值）正确 ✔")


def test_silence_and_minmax():
    from app.audio import AudioFormatError, check_duration
    from app.fingerprint import fingerprint
    sr = 16000
    silence = np.zeros(sr)  # 1s 全零
    fp = fingerprint(silence)
    assert fp.silent and fp.n_pairs == 0 and fp.global_max < 1e-5
    print("全静音 -> 无峰无配对 ✔")

    for bad_len in [int(0.2 * sr), int(8.5 * sr)]:
        try:
            check_duration(np.zeros(bad_len), "query")
            raise AssertionError("应拒绝越界长度")
        except AudioFormatError:
            pass
    check_duration(np.zeros(int(0.25 * sr)), "query")
    check_duration(np.zeros(int(8 * sr)), "query")
    print("查询长度边界 0.25~8s 校验正确 ✔")


if __name__ == "__main__":
    test_equivalence()
    test_tie_breaking()
    test_spectrogram_spec()
    test_silence_and_minmax()
    print("\n全部测试通过 ✔")
