/*
 * engine.js — 实际执行像素操作，并模拟槽位复用，产出逐步回放记录
 *
 * 像素规则：
 *   const — 常量写入
 *   add   — 逐通道饱和加法（每通道 min(255, a+b)）
 *   box2  — 2×2 盒式缩小，输出 ceil(w/2)×ceil(h/2)；
 *           奇数边的边界块只平均真实存在的像素，四舍五入（half up）
 * 槽位规则：
 *   同 (宽,高,通道数) 类别的槽可复用；版本寿命不重叠时归还进空闲池。
 *   导出/固定版本占用到整帧结束。
 */
(function (root) {
  const Tfs = (root.Tfs = root.Tfs || {});

  Tfs.classKey = (v) => `${v.w}×${v.h}·${v.format}`;

  Tfs.simulate = function (model, order, pinnedRefs) {
    const retained = new Set(model.exportRefs);
    (pinnedRefs || []).forEach((r) => retained.add(r));

    const pixels = new Map();      // ref -> Uint8Array
    const slotOf = new Map();      // ref -> slotId
    const freePool = new Map();    // classKey -> [slotId]
    const slots = new Map();       // slotId -> {id, classKey, ref|null}
    const slotIntervals = new Map(); // slotId -> [{ref, from, to}]
    let slotSeq = 0;
    let liveBytes = 0, peak = 0;
    const steps = [];
    const executed = new Set();

    const acquire = (v, stepNo) => {
      const key = Tfs.classKey(v);
      let pool = freePool.get(key);
      if (!pool) freePool.set(key, (pool = []));
      let id = pool.pop();
      if (id === undefined) {
        id = `S${++slotSeq}`;
        slots.set(id, { id, classKey: key, ref: null });
        slotIntervals.set(id, []);
      }
      const s = slots.get(id);
      s.ref = v.ref;
      slotOf.set(v.ref, id);
      slotIntervals.get(id).push({ ref: v.ref, from: stepNo, to: null });
      return id;
    };

    const release = (v, stepNo) => {
      const id = slotOf.get(v.ref);
      if (id === undefined) return null;
      slotOf.delete(v.ref);
      const s = slots.get(id);
      s.ref = null;
      freePool.get(s.classKey).push(id);
      const iv = slotIntervals.get(id);
      iv[iv.length - 1].to = stepNo;
      liveBytes -= v.bytes;
      return { ref: v.ref, slotId: id, bytes: v.bytes };
    };

    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const pass = model.passes[i];
      const out = model.versionMap.get(pass.out);
      const stepNo = k + 1;

      // 合法性：输入必须已产出
      for (const ref of pass.read || []) {
        if (!executed.has(model.versionMap.get(ref).producerIndex)) {
          return {
            ok: false,
            reason: 'illegal-order',
            passIndex: i,
            passId: pass.id,
            missingRef: ref,
            message: `通道 ${pass.id} 在第 ${stepNo} 步读取 ${ref}，但其生产者尚未执行`,
          };
        }
      }

      const beforeBytes = liveBytes;
      const readSlots = (pass.read || []).map((ref) => ({ ref, slotId: slotOf.get(ref) }));

      // 执行像素操作（先算数据，再分配槽；期间输入与输出同时存活）
      const data = Tfs.runOp(model, pass, pixels);
      const outSlot = acquire(out, stepNo);
      pixels.set(out.ref, data);
      liveBytes += out.bytes;
      const duringBytes = liveBytes;
      peak = Math.max(peak, duringBytes);

      const released = [];
      // 通道结束：最后读者已完成的版本归还（输出无读者且未保留时也在此释放）
      executed.add(i);
      const doneMask = maskOf(executed);
      for (const v of model.versions) {
        if (!slotOf.has(v.ref)) continue;
        if (retained.has(v.ref)) continue;
        const remaining = v.lastReaderMask & ~doneMask;
        if (remaining === 0) {
          const r = release(v, stepNo);
          if (r) released.push(r);
        }
      }

      steps.push({
        index: stepNo,
        passIndex: i,
        passId: pass.id,
        op: pass.op,
        outRef: out.ref,
        outSlot,
        readSlots,
        released,
        beforeBytes,
        duringBytes,
        afterBytes: liveBytes,
        peakBytes: peak,
        liveRefs: [...slotOf.keys()],
        slotSnapshot: snapshotSlots(slots),
      });
    }

    // 整帧结束：释放保留版本
    const frameEnd = [];
    for (const v of model.versions) {
      if (slotOf.has(v.ref)) {
        const r = release(v, order.length + 1);
        if (r) frameEnd.push(r);
      }
    }

    return {
      ok: true,
      steps,
      frameEnd,
      pixels,
      slots: [...slots.values()],
      slotIntervals,
      peakBytes: peak,
      totalBytes: model.versions.reduce((s, v) => s + v.bytes, 0),
    };
  };

  function maskOf(setObj) {
    let m = 0;
    for (const i of setObj) m |= 1 << i;
    return m;
  }

  function snapshotSlots(slots) {
    return [...slots.values()].map((s) => ({ id: s.id, classKey: s.classKey, ref: s.ref }));
  }

  // ---- 像素操作 ----
  Tfs.runOp = function (model, pass, pixels) {
    const out = model.versionMap.get(pass.out);
    const n = out.w * out.h * out.channels;

    if (pass.op === 'const') {
      return Uint8Array.from(pass.values);
    }

    if (pass.op === 'add') {
      const a = pixels.get(pass.read[0]);
      const b = pixels.get(pass.read[1]);
      const dst = new Uint8Array(n);
      for (let p = 0; p < n; p++) {
        const s = a[p] + b[p];
        dst[p] = s > 255 ? 255 : s;
      }
      return dst;
    }

    if (pass.op === 'box2') {
      const srcRef = pass.read[0];
      const src = model.versionMap.get(srcRef);
      const a = pixels.get(srcRef);
      const dst = new Uint8Array(n);
      const ch = out.channels;
      for (let y = 0; y < out.h; y++) {
        for (let x = 0; x < out.w; x++) {
          const sx = x * 2, sy = y * 2;
          for (let c = 0; c < ch; c++) {
            let sum = 0, count = 0;
            for (let dy = 0; dy < 2; dy++) {
              for (let dx = 0; dx < 2; dx++) {
                const px = sx + dx, py = sy + dy;
                if (px < src.w && py < src.h) {
                  sum += a[(py * src.w + px) * ch + c];
                  count++;
                }
              }
            }
            dst[(y * out.w + x) * ch + c] = Math.floor(sum / count + 0.5); // 四舍五入
          }
        }
      }
      return dst;
    }

    throw new Error(`不支持的操作 ${pass.op}`);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.Tfs;
