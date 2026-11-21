/*
 * 四键节奏校谱台 · 判定逻辑
 *
 * 时间换算全程使用整数（BigInt）分子：精确时间 = num / ppq 微秒。
 * 判定前不做任何取整，1 微秒以内的差别也能分清。
 * 浏览器（window.BeatJudge）与 Node（module.exports）通用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BeatJudge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PERFECT_US = 30000; // 精准窗口 ±30ms（边界计入）
  const GOOD_US = 80000;    // 良好窗口 ±80ms（边界计入）

  /* 时间轴：拍刻 -> 精确微秒（num / ppq） */
  function buildTimeline(chart) {
    const ppq = chart.ppq;
    const PPQ = BigInt(ppq);
    const tempo = (chart.tempo || []).slice().sort((a, b) => a[0] - b[0]);
    if (!tempo.length || tempo[0][0] !== 0) tempo.unshift([0, 500000]);
    const stops = (chart.stops || []).slice().sort((a, b) => a[0] - b[0]);

    // 停拍前缀和（微秒）
    const stopPrefix = [0n];
    for (let i = 0; i < stops.length; i++) {
      stopPrefix.push(stopPrefix[i] + BigInt(Math.trunc(stops[i][1])));
    }

    function tickToNum(tick) {
      let num = 0n;
      // 变速：按 tempo 分段累计 刻数 × 每拍微秒
      for (let i = 0; i < tempo.length; i++) {
        const start = tempo[i][0];
        if (tick <= start) break;
        const end = i + 1 < tempo.length ? tempo[i + 1][0] : Infinity;
        num += BigInt(Math.min(tick, end) - start) * BigInt(tempo[i][1]);
      }
      // 停拍：加到同刻音符之前（stop.tick <= 目标刻 即计入）
      let lo = 0, hi = stops.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (stops[mid][0] <= tick) lo = mid + 1; else hi = mid;
      }
      return num + stopPrefix[lo] * PPQ;
    }
    return { ppq, PPQ, tempo, stops, tickToNum };
  }

  function numToUs(num, ppq) { return Number(num) / ppq; }

  /* 预处理谱面：音符目标时间、节拍点、停拍区间（供判定与绘制共用） */
  function prepare(chart) {
    const tl = buildTimeline(chart);
    const ppq = tl.ppq;
    const notes = (chart.notes || []).map((n, i) => {
      const endTick = n[3] != null ? n[3] : null;
      const headNum = tl.tickToNum(n[2]);
      const tailNum = endTick != null ? tl.tickToNum(endTick) : null;
      return {
        id: n[0], lane: n[1], tick: n[2], endTick, order: i,
        hold: endTick != null,
        headNum, tailNum,
        headUs: numToUs(headNum, ppq),
        tailUs: tailNum != null ? numToUs(tailNum, ppq) : null,
      };
    });
    const maxTick = notes.reduce((m, n) => Math.max(m, n.endTick != null ? n.endTick : n.tick), 0);
    const beatCount = Math.ceil(maxTick / ppq) + 2;
    const beatsUs = [];
    for (let b = 0; b <= beatCount; b++) beatsUs.push(numToUs(tl.tickToNum(b * ppq), ppq));
    const stopsUs = tl.stops.map(s => ({
      tick: s[0], durUs: s[1], startUs: numToUs(tl.tickToNum(s[0]), ppq),
    }));
    const endUs = Math.max(
      beatsUs.length ? beatsUs[beatsUs.length - 1] : 0,
      notes.reduce((m, n) => Math.max(m, n.tailUs != null ? n.tailUs : n.headUs), 0)
    );
    return { ppq, notes, beatsUs, stopsUs, endUs, timeline: tl };
  }

  /*
   * 判定。
   * inputs: [[歌曲微秒(校准前), 轨道, "down"|"up"], ...]
   * nowUs:  可选。传入时只结算到该时刻（用于试玩中的实时判定），
   *         窗口未到的音符结果为「待判定」；省略则结算到底。
   */
  function judge(chart, inputs, nowUs) {
    const ppq = chart.ppq;
    const tl = buildTimeline(chart);
    const PPQ = tl.PPQ;
    const offset = BigInt(Math.trunc(chart.offsetUs || 0));
    const W = BigInt(GOOD_US) * PPQ;    // ±80ms（分子单位）
    const P = BigInt(PERFECT_US) * PPQ; // ±30ms（分子单位）
    const nowNum = nowUs == null ? null : BigInt(Math.trunc(nowUs)) * PPQ;

    const notes = (chart.notes || []).map((n, i) => {
      const endTick = n[3] != null ? n[3] : null;
      return {
        id: n[0], lane: n[1], tick: n[2], endTick, order: i,
        hold: endTick != null,
        headNum: tl.tickToNum(n[2]),
        tailNum: endTick != null ? tl.tickToNum(endTick) : null,
      };
    });

    // 输入时间先减去校准值，再转成分子单位
    const events = (inputs || [])
      .map((r, i) => ({
        num: (BigInt(Math.trunc(r[0])) - offset) * PPQ,
        lane: r[1], action: r[2], order: i,
      }))
      .sort((a, b) => (a.num < b.num ? -1 : a.num > b.num ? 1 : a.order - b.order));

    const state = notes.map(() => ({
      judged: false, holding: false,
      headJudge: null, headErrNum: null, relErrNum: null,
      result: null, detail: null,
    }));
    const byLane = [[], [], [], []];
    notes.forEach((n, i) => { if (n.lane >= 0 && n.lane < 4) byLane[n.lane].push(i); });
    const activeHolds = [[], [], [], []]; // 每轨进行中的长键（音符下标）

    function abs(x) { return x < 0n ? -x : x; }

    // 结算所有截止时间严格早于 T 的音符（边界计入，故用 < 不用 <=）
    function sweep(T) {
      for (let i = 0; i < notes.length; i++) {
        const st = state[i];
        if (st.result) continue;
        const n = notes[i];
        if (st.holding) {
          if (n.tailNum + W < T) {
            st.holding = false;
            st.result = '断键';
            st.detail = '过窗未松开';
            const arr = activeHolds[n.lane];
            const k = arr.indexOf(i);
            if (k >= 0) arr.splice(k, 1);
          }
        } else if (!st.judged) {
          if (n.headNum + W < T) {
            st.judged = true;
            st.result = '错过';
          }
        }
      }
    }

    function onDown(T, lane) {
      // 同轨候选：未判定且 |误差| <= 80ms；挑最近，同距取较早目标，再按谱面顺序
      let best = -1, bestAbs = null;
      for (const i of byLane[lane]) {
        if (state[i].judged) continue;
        const n = notes[i];
        const ad = abs(T - n.headNum);
        if (ad > W) continue;
        if (best < 0 || ad < bestAbs ||
            (ad === bestAbs && (n.headNum < notes[best].headNum ||
              (n.headNum === notes[best].headNum && n.order < notes[best].order)))) {
          best = i; bestAbs = ad;
        }
      }
      if (best < 0) return; // 空挥，不消耗任何音符
      const n = notes[best], st = state[best];
      const err = T - n.headNum;
      st.judged = true;
      st.headErrNum = err;
      st.headJudge = abs(err) <= P ? '精准' : '良好';
      if (n.hold) {
        st.holding = true;
        activeHolds[lane].push(best);
      } else {
        st.result = st.headJudge;
      }
    }

    function onUp(T, lane) {
      const arr = activeHolds[lane];
      if (!arr.length) return; // 该轨没有进行中的长键
      // 松开头部最早开始的长键
      let k = 0;
      for (let j = 1; j < arr.length; j++) {
        if (notes[arr[j]].headNum < notes[arr[k]].headNum) k = j;
      }
      const i = arr.splice(k, 1)[0];
      const n = notes[i], st = state[i];
      st.holding = false;
      st.relErrNum = T - n.tailNum;
      // sweep 已保证 T <= 尾点 + 80ms；早于 尾点 - 80ms 即提前松开
      if (T < n.tailNum - W) {
        st.result = '断键';
        st.detail = '提前松开';
      } else {
        st.result = '完成';
      }
    }

    for (const ev of events) {
      if (nowNum != null && ev.num > nowNum) break; // 实时模式：未来的输入尚未发生
      sweep(ev.num);
      if (ev.lane < 0 || ev.lane > 3) continue;
      if (ev.action === 'down') onDown(ev.num, ev.lane);
      else if (ev.action === 'up') onUp(ev.num, ev.lane);
    }

    if (nowNum != null) {
      sweep(nowNum);
    } else {
      // 结算到底：未击中的错过，未松开的长键断键
      for (let i = 0; i < notes.length; i++) {
        const st = state[i];
        if (st.result) continue;
        if (st.holding) { st.holding = false; st.result = '断键'; st.detail = '过窗未松开'; }
        else if (!st.judged) { st.judged = true; st.result = '错过'; }
      }
    }

    const out = notes.map((n, i) => {
      const st = state[i];
      return {
        id: n.id, lane: n.lane, order: n.order, tick: n.tick, endTick: n.endTick, hold: n.hold,
        headUs: numToUs(n.headNum, ppq),
        tailUs: n.tailNum != null ? numToUs(n.tailNum, ppq) : null,
        headErrUs: st.headErrNum != null ? numToUs(st.headErrNum, ppq) : null,
        relErrUs: st.relErrNum != null ? numToUs(st.relErrNum, ppq) : null,
        headJudge: st.headJudge,
        result: st.result || '待判定',
        detail: st.detail,
      };
    });
    const summary = {};
    for (const r of out) summary[r.result] = (summary[r.result] || 0) + 1;
    return { notes: out, summary };
  }

  return { PERFECT_US, GOOD_US, buildTimeline, prepare, judge };
});
