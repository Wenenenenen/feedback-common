/*
 * scheduler.js — 最小存活字节峰值的合法执行顺序（精确解）
 *
 * 两阶段：
 *   阶段1 子集 DP 求最小峰值 B*
 *       peak[mask] = 从空集执行到 mask 的最小可能峰值
 *       执行通道 i 期间字节 = liveAfter(mask) + 输出字节
 *       （输入仍存活 + 输出已分配；同通道读写都占空间）
 *   阶段2 在预算 B* 下求字典序最小的通道 ID 序列
 *       反向可行性 DP：feasible[mask] 是否存在一条不超预算的完成路径
 *       再从空集起逐位贪心：选 ID 最小、预算内、且仍可完成的就绪通道
 *       （单状态 DP 无法直接兼顾字典序：字典序更小的前缀可能暂时峰值更高，
 *        但最终峰值相同，所以必须用“可行性 + 贪心”两阶段）
 *
 * 版本 v 在集合 mask 之后仍存活，当且仅当：
 *   生产者 ∈ mask，且（被保留，或仍有读者 ∉ mask）
 */
(function (root) {
  const Tfs = (root.Tfs = root.Tfs || {});

  Tfs.schedule = function (model, pinnedRefs) {
    const n = model.passes.length;
    const size = 1 << n;
    const pinned = new Set(pinnedRefs || []);

    const retained = model.versions.map(
      (v) => model.exportRefs.has(v.ref) || pinned.has(v.ref)
    );
    const outVersion = model.passes.map((p) =>
      model.versions.indexOf(model.versionMap.get(p.out))
    );

    // liveAfter[mask]：执行完 mask 集合后仍存活的字节数（只取决于集合，与顺序无关）
    const liveAfter = new Int32Array(size);
    for (let mask = 1; mask < size; mask++) {
      let bytes = 0;
      for (let vi = 0; vi < model.versions.length; vi++) {
        const v = model.versions[vi];
        if (!(mask & (1 << v.producerIndex))) continue;
        if (retained[vi] || (v.lastReaderMask & ~mask) !== 0) bytes += v.bytes;
      }
      liveAfter[mask] = bytes;
    }

    const during = (mask, i) => liveAfter[mask] + model.versions[outVersion[i]].bytes;
    const ready = (mask, i) =>
      !(mask & (1 << i)) && (model.depsMask[i] & mask) === model.depsMask[i];

    // ---- 阶段1：最小峰值 ----
    const peak = new Int32Array(size).fill(-1);
    peak[0] = 0;
    for (let mask = 0; mask < size; mask++) {
      if (peak[mask] < 0) continue;
      for (let i = 0; i < n; i++) {
        if (!ready(mask, i)) continue;
        const nm = mask | (1 << i);
        const cand = Math.max(peak[mask], during(mask, i));
        if (peak[nm] < 0 || cand < peak[nm]) peak[nm] = cand;
      }
    }
    const budget = peak[size - 1];

    // ---- 阶段2：预算内反向可行性 ----
    const feasible = new Uint8Array(size);
    feasible[size - 1] = 1;
    for (let mask = size - 2; mask >= 0; mask--) {
      for (let i = 0; i < n; i++) {
        if (!ready(mask, i)) continue;
        if (during(mask, i) > budget) continue;
        if (feasible[mask | (1 << i)]) { feasible[mask] = 1; break; }
      }
    }

    // ---- 贪心：每一步选 ID 最小且可完成的就绪通道 ----
    const indexed = model.passes.map((p, i) => ({ id: p.id, i })).sort(
      (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const order = [];
    let mask = 0;
    while (mask !== size - 1) {
      let pick = -1;
      for (const { i } of indexed) {
        if (!ready(mask, i)) continue;
        if (during(mask, i) > budget) continue;
        if (feasible[mask | (1 << i)]) { pick = i; break; }
      }
      if (pick < 0) throw new Error('调度内部错误：可行性 DP 与贪心不一致');
      order.push(pick);
      mask |= 1 << pick;
    }

    return {
      order,
      orderIds: order.map((i) => model.passes[i].id),
      peakBytes: budget,
      retainedRefs: model.versions.filter((_, vi) => retained[vi]).map((v) => v.ref),
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.Tfs;
