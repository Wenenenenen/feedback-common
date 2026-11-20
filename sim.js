/*
 * 虚拟纹理页驻留模拟器（纯函数，无 DOM 依赖，浏览器与 Node 通用）。
 *
 * 每帧处理顺序（与样例说明一致）：
 *   1. 计算当前窗口的理想页需求，取消不在需求中的未完成请求（立即释放并发槽）；
 *   2. 按页 ID 数值元组 (l,y,x) 顺序处理到期结果：
 *      - 代号不匹配（已取消/被取代）→ 记“忽略晚到”，不得污染新请求；
 *      - 该页首个实际到期且未取消的请求且 firstFailure → 记“失败”，最早下帧重试；
 *      - 否则入槽，缓存满则淘汰非根中 lastUsed 最小者（并列按 (l,y,x) 最小），记“完成”；
 *   3. 绘制：理想页未驻留时回退到最近的驻留祖先，以当前帧标记实际采样页的 lastUsed；
 *   4. 按 (l,y,x) 顺序向未驻留、未在途、非本帧失败的理想页发请求，直至并发槽满。
 *
 * 根页 0/0/0 预先驻留且不可淘汰。请求在发起帧 + latencyFrames 到期。
 * 跳转 / 改配置时从第 0 帧重放，结果完全确定。
 */
(function (root, factory) {
  const sim = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = sim;
  root.VPRLSim = sim;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const ROOT_ID = "0/0/0";

  // 页 ID 的数值排序键 (l, y, x)
  function pageKey(id) {
    const [l, x, y] = id.split("/").map(Number);
    return [l, y, x];
  }

  function cmpId(a, b) {
    const A = pageKey(a), B = pageKey(b);
    return A[0] - B[0] || A[1] - B[1] || A[2] - B[2];
  }

  function parentId(id) {
    const [l, x, y] = id.split("/").map(Number);
    return `${l - 1}/${x >> 1}/${y >> 1}`;
  }

  // 理想层：l = clamp(ceil(log2(max(W/(tile*du), H/(tile*dv)))), 0, maxLevel)
  function idealLevel(caseDef, du, dv) {
    const t = caseDef.tileSize;
    const r = Math.max(caseDef.width / (t * du), caseDef.height / (t * dv));
    const l = Math.ceil(Math.log2(r) - 1e-9);
    return Math.max(0, Math.min(caseDef.maxLevel, l));
  }

  // 当前窗口下，按输出像素中心求得的理想页集合（已按 (l,y,x) 排序）
  function idealPages(caseDef, win) {
    const [u0, v0, du, dv] = win;
    const l = idealLevel(caseDef, du, dv);
    const n = 1 << l;
    const need = new Set();
    for (let py = 0; py < caseDef.height; py++) {
      const v = v0 + ((py + 0.5) / caseDef.height) * dv;
      const y = Math.min(n - 1, Math.floor(v * n));
      for (let px = 0; px < caseDef.width; px++) {
        const u = u0 + ((px + 0.5) / caseDef.width) * du;
        const x = Math.min(n - 1, Math.floor(u * n));
        need.add(`${l}/${x}/${y}`);
      }
    }
    return { level: l, pages: [...need].sort(cmpId) };
  }

  /**
   * 从第 0 帧确定性重放整条轨迹。
   * @returns {{frames: Array, log: Array}} 每帧快照与扁平事件日志。
   * 事件: [帧, 类型, 页ID, 代号]；类型 ∈ 请求/取消/完成/失败/淘汰/忽略晚到（淘汰的代号为 null）。
   */
  function simulate(caseDef, frames, capacity, maxInflight) {
    const pageDef = new Map(caseDef.pages.map((p) => [p.id, p]));
    const resident = new Set([ROOT_ID]);
    const lastUsed = new Map([[ROOT_ID, 0]]);
    const inflight = new Map(); // id -> {token, due}
    const dueEvents = []; // {due, id, token}，取消后保留，靠代号识别
    let tokenCtr = 0;
    const failedOnce = new Set(); // 首个实际到期请求已失败的页
    const log = [];
    const out = [];

    for (let f = 0; f < frames.length; f++) {
      const win = frames[f];
      const events = [];
      const emit = (type, id, token) => {
        const e = [f, type, id, token];
        events.push(e);
        log.push(e);
      };

      const { level, pages: need } = idealPages(caseDef, win);
      const needSet = new Set(need);

      // 1. 取消不在需求中的在途请求，并发槽立即释放
      for (const id of [...inflight.keys()].sort(cmpId)) {
        if (!needSet.has(id)) {
          emit("取消", id, inflight.get(id).token);
          inflight.delete(id);
        }
      }

      // 2. 按 (l,y,x) 处理到期结果
      const dueNow = dueEvents.filter((e) => e.due === f).sort((a, b) => cmpId(a.id, b.id));
      for (let i = dueEvents.length - 1; i >= 0; i--) {
        if (dueEvents[i].due === f) dueEvents.splice(i, 1);
      }
      const failedThisFrame = new Set();
      for (const ev of dueNow) {
        const cur = inflight.get(ev.id);
        if (!cur || cur.token !== ev.token) {
          emit("忽略晚到", ev.id, ev.token); // 旧请求的晚到结果，不得入槽
          continue;
        }
        inflight.delete(ev.id);
        const def = pageDef.get(ev.id);
        if (def.firstFailure && !failedOnce.has(ev.id)) {
          failedOnce.add(ev.id);
          failedThisFrame.add(ev.id); // 最早下帧重试，本帧不再发
          emit("失败", ev.id, ev.token);
          continue;
        }
        while (resident.size >= capacity) {
          let victim = null;
          for (const id of resident) {
            if (id === ROOT_ID) continue;
            if (
              victim === null ||
              lastUsed.get(id) < lastUsed.get(victim) ||
              (lastUsed.get(id) === lastUsed.get(victim) && cmpId(id, victim) < 0)
            ) {
              victim = id;
            }
          }
          if (victim === null) break; // 容量 <= 1 的兜底，正常不会触发
          resident.delete(victim);
          lastUsed.delete(victim);
          emit("淘汰", victim, null);
        }
        resident.add(ev.id);
        lastUsed.set(ev.id, f);
        emit("完成", ev.id, ev.token);
      }

      // 3. 绘制：实际采样页 = 理想页或其最近的驻留祖先；标记 lastUsed
      const samples = {};
      for (const id of need) {
        let cur = id;
        while (!resident.has(cur)) cur = parentId(cur);
        samples[id] = cur;
        lastUsed.set(cur, f);
      }

      // 4. 按 (l,y,x) 向未驻留且未请求的理想页发请求，直至并发槽满
      for (const id of need) {
        if (inflight.size >= maxInflight) break;
        if (resident.has(id) || inflight.has(id) || failedThisFrame.has(id)) continue;
        const token = ++tokenCtr;
        const due = f + pageDef.get(id).latencyFrames;
        inflight.set(id, { token, due });
        dueEvents.push({ due, id, token });
        emit("请求", id, token);
      }

      out.push({
        frame: f,
        window: win.slice(),
        idealLevel: level,
        ideal: need,
        events,
        samples,
        resident: [...resident].sort(cmpId),
        lastUsed: Object.fromEntries(lastUsed),
        inflight: [...inflight.entries()]
          .map(([id, v]) => ({ id, token: v.token, due: v.due }))
          .sort((a, b) => cmpId(a.id, b.id)),
        failedOnce: [...failedOnce].sort(cmpId),
      });
    }
    return { frames: out, log };
  }

  return { ROOT_ID, pageKey, cmpId, parentId, idealLevel, idealPages, simulate };
});
