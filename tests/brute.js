// brute.js — 暴力枚举参考实现(仅用于小规模对拍)
import { normalize } from './gen.js';

export function bruteSolve(raw, locks = new Map()) {
  const inst = normalize(raw);
  const budget = Math.min(12, inst.changes);
  const layers = [];
  for (let k = 0; k < inst.cues.length; k++) {
    const cue = inst.cues[k];
    const lockId = locks.has(k) ? locks.get(k) : null;
    const cands = cue.candidates.filter(
      (c) =>
        (lockId === null || c.id === lockId) &&
        c.dst >= cue.slot[0] &&
        c.dst + c.len <= cue.slot[1]
    );
    if (cands.length === 0) return { ok: false, failedCue: k };
    layers.push(cands);
  }

  let best = null; // { total, switches, ids }

  const walk = (k, prev, switches, total, ids) => {
    if (switches > budget) return;
    if (k === layers.length) {
      if (
        best === null ||
        total < best.total ||
        (total === best.total &&
          (switches < best.switches ||
            (switches === best.switches && lexLess(ids, best.ids))))
      ) {
        best = { total, switches, ids: ids.slice() };
      }
      return;
    }
    for (const c of layers[k]) {
      if (prev) {
        if (c.dst < prev.dst + prev.len + inst.gap) continue;
        if (c.take === prev.take && c.src < prev.src + prev.len) continue;
      }
      const diff = prev && c.take !== prev.take ? 1 : 0;
      ids.push(c.id);
      walk(
        k + 1,
        c,
        switches + diff,
        total + c.cost + diff * inst.switchCost,
        ids
      );
      ids.pop();
    }
  };

  walk(0, null, 0, 0, []);
  if (best === null) {
    // 找到第一个不存在合法前缀的句子
    return { ok: false, failedCue: firstDeadCue(inst, layers, budget) };
  }
  return { ok: true, ...best };
}

function firstDeadCue(inst, layers, budget) {
  let front = layers[0].map((c) => ({ c, switches: 0 }));
  if (front.length === 0) return 0;
  for (let k = 1; k < layers.length; k++) {
    const next = [];
    for (const st of front) {
      for (const c of layers[k]) {
        if (c.dst < st.c.dst + st.c.len + inst.gap) continue;
        if (c.take === st.c.take && c.src < st.c.src + st.c.len) continue;
        const sw = st.switches + (c.take !== st.c.take ? 1 : 0);
        if (sw <= budget) next.push({ c, switches: sw });
      }
    }
    if (next.length === 0) return k;
    front = next;
  }
  return -1;
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}
