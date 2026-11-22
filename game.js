/* 点灯对决 —— 纯规则引擎（无 DOM，页面与测试共用）
 *
 * 模型要点：
 * - 出牌只进入待结算栈，效果一律在结算时生效（结算时复查目标）。
 * - 连续两次过牌弹出栈顶结算一张；栈未空则从对方继续响应。
 * - 待结算栈空时双方连续过牌 => 按分数结局。
 * - 每张有效出牌扣 1 点体力，整局不回复、失效不退。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LanternEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPE_INFO = {
    light:  { name: '点灯',   icon: '🏮', response: false, desc: '点亮一盏开放且未亮的灯，得 2 分' },
    move:   { name: '改目标', icon: '🔀', response: true,  desc: '改写一张未结算「点灯」的目标灯，新灯须开放且未亮' },
    close:  { name: '关灯',   icon: '🌑', response: true,  desc: '关闭一盏灯；已经记下的分不回退' },
    cancel: { name: '取消',   icon: '🚫', response: true,  desc: '移除一张未结算的「点灯」' },
  };

  const RULES_TEXT = [
    '手牌用卡号到牌种的映射表示。light点亮开放未亮的灯并得2分。move改写未结算light的目标，新灯须开放且未亮。close关闭指定灯，已记分不回退。cancel移除指定未结算light。响应牌只在有待结算牌时可打出，目标在结算时复查。',
    '动作数组依次为玩家、卡号或pass、目标。move的目标依次给待结算牌号及新灯。双方各有固定体力，每张有效出牌扣1，整局不回复。',
  ];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function other(p) { return p === 'A' ? 'B' : 'A'; }

  /** 由配置开新局。cfg: {active, lamps:[id...], energy:{A,B}, hands:{A:{card:type},B:{...}}} */
  function newGame(cfg) {
    return {
      turn: cfg.active,
      lamps: cfg.lamps.map(id => ({ id, lit: false, closed: false })),
      energy: { ...cfg.energy },
      score: { A: 0, B: 0 },
      hands: { A: { ...cfg.hands.A }, B: { ...cfg.hands.B } },
      pending: [],      // 栈：底 -> 顶，结算从顶部弹出 {card,type,player,target}
      passes: 0,        // 连续过牌数
      finished: false,
      resolution: [],   // 结算结果，如 "paint生效" / "redirect失效"
      actions: [],      // 已执行动作，导出用
      initial: clone(cfg),
    };
  }

  function lampOf(st, id) { return st.lamps.find(l => l.id === id) || null; }
  function pendingLight(st, cardId) {
    return st.pending.find(p => p.card === cardId && p.type === 'light') || null;
  }

  /** 出牌校验，返回 null 表示合法，否则返回中文错误原因。 */
  function playError(st, player, cardId, target) {
    if (st.finished) return '对局已结束';
    if (st.turn !== player) return `还没轮到 ${player} 操作`;
    const type = st.hands[player][cardId];
    if (!type) return `${player} 的手牌中没有 ${cardId}`;
    if (st.energy[player] < 1) return `${player} 体力不足`;
    const info = TYPE_INFO[type];
    if (!info) return `未知牌种 ${type}`;
    if (info.response && st.pending.length === 0) {
      return `「${info.name}」是响应牌，需要有待结算牌才能打出`;
    }
    if (type === 'light') {
      const l = lampOf(st, target);
      if (!l) return `目标灯 ${target} 不存在`;
      if (l.closed) return `灯 ${target} 已关闭`;
      if (l.lit) return `灯 ${target} 已经亮了`;
    } else if (type === 'move') {
      if (!Array.isArray(target) || target.length !== 2) return '改目标的目标须为 [待结算牌号, 新灯]';
      if (!pendingLight(st, target[0])) return `没有未结算的点灯牌 ${target[0]}`;
      const l = lampOf(st, target[1]);
      if (!l) return `新灯 ${target[1]} 不存在`;
      if (l.closed) return `新灯 ${target[1]} 已关闭`;
      if (l.lit) return `新灯 ${target[1]} 已经亮了`;
    } else if (type === 'close') {
      const l = lampOf(st, target);
      if (!l) return `目标灯 ${target} 不存在`;
      if (l.closed) return `灯 ${target} 已关闭`;
    } else if (type === 'cancel') {
      if (!pendingLight(st, target)) return `没有未结算的点灯牌 ${target}`;
    }
    return null;
  }

  /** 执行出牌。返回 null 成功，否则错误原因。 */
  function applyPlay(st, player, cardId, target) {
    const err = playError(st, player, cardId, target);
    if (err) return err;
    const type = st.hands[player][cardId];
    delete st.hands[player][cardId];
    st.energy[player] -= 1;
    st.pending.push({ card: cardId, type, player, target: clone(target) });
    st.actions.push([player, cardId, clone(target)]);
    st.passes = 0;
    st.turn = other(player);
    return null;
  }

  /** 执行过牌。返回 null 成功，否则错误原因。 */
  function applyPass(st, player) {
    if (st.finished) return '对局已结束';
    if (st.turn !== player) return `还没轮到 ${player} 操作`;
    st.actions.push([player, 'pass']);
    st.passes += 1;
    if (st.passes >= 2) {
      if (st.pending.length > 0) {
        resolveTop(st);
        st.passes = 0;
        st.turn = other(player); // 还有待结算牌：从当前回合的对方重新开始响应
      } else {
        st.finished = true;      // 空列表下双方连续过牌：按分数结局
      }
    } else {
      st.turn = other(player);
    }
    return null;
  }

  /** 执行一个动作（出牌或过牌），导入重放用。 */
  function applyAction(st, action) {
    const [player, card, target] = action;
    if (card === 'pass') return applyPass(st, player);
    return applyPlay(st, player, card, target);
  }

  /** 结算栈顶一张，效果在此刻生效并复查目标。返回 {card, ok, detail}。 */
  function resolveTop(st) {
    const c = st.pending.pop();
    let ok = false, detail = '';
    if (c.type === 'light') {
      const l = lampOf(st, c.target);
      if (l && !l.lit && !l.closed) {
        l.lit = true; st.score[c.player] += 2; ok = true;
        detail = `点亮 ${c.target}，${c.player} 得 2 分`;
      } else detail = `目标灯 ${c.target} 已不可点亮`;
    } else if (c.type === 'move') {
      const t = pendingLight(st, c.target[0]);
      const l = lampOf(st, c.target[1]);
      if (t && l && !l.lit && !l.closed) {
        t.target = c.target[1]; ok = true;
        detail = `${c.target[0]} 的目标改写为 ${c.target[1]}`;
      } else detail = '目标点灯牌或新灯已失效，不改写';
    } else if (c.type === 'close') {
      const l = lampOf(st, c.target);
      if (l && !l.closed) {
        l.closed = true; ok = true;
        detail = `关闭 ${c.target}（已记的分不回退）`;
      } else detail = `灯 ${c.target} 已是关闭状态`;
    } else if (c.type === 'cancel') {
      const i = st.pending.findIndex(p => p.card === c.target && p.type === 'light');
      if (i >= 0) {
        st.pending.splice(i, 1); ok = true;
        detail = `移除未结算的点灯牌 ${c.target}`;
      } else detail = `目标点灯牌 ${c.target} 已不在待结算中`;
    }
    st.resolution.push(c.card + (ok ? '生效' : '失效'));
    return { card: c.card, ok, detail };
  }

  /** 与 expected 核对，返回 [{label, ok, want, got}]。只核对 expected 里出现的字段。 */
  function compareExpected(st, exp) {
    const rows = [];
    const eqSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
    const lit = st.lamps.filter(l => l.lit).map(l => l.id);
    const closed = st.lamps.filter(l => l.closed).map(l => l.id);
    if (exp.resolution) rows.push({
      label: '结算顺序', ok: JSON.stringify(exp.resolution) === JSON.stringify(st.resolution),
      want: exp.resolution.join(' → ') || '（空）', got: st.resolution.join(' → ') || '（空）',
    });
    if (exp.lit) rows.push({
      label: '亮着的灯', ok: eqSet(exp.lit, lit),
      want: exp.lit.join(', ') || '（无）', got: lit.join(', ') || '（无）',
    });
    if (exp.closed) rows.push({
      label: '关闭的灯', ok: eqSet(exp.closed, closed),
      want: exp.closed.join(', ') || '（无）', got: closed.join(', ') || '（无）',
    });
    if (exp.score) rows.push({
      label: '比分', ok: exp.score.A === st.score.A && exp.score.B === st.score.B,
      want: `A:${exp.score.A} B:${exp.score.B}`, got: `A:${st.score.A} B:${st.score.B}`,
    });
    if (exp.energy) rows.push({
      label: '剩余体力', ok: exp.energy.A === st.energy.A && exp.energy.B === st.energy.B,
      want: `A:${exp.energy.A} B:${exp.energy.B}`, got: `A:${st.energy.A} B:${st.energy.B}`,
    });
    if (exp.finished !== undefined) rows.push({
      label: '对局结束', ok: exp.finished === st.finished,
      want: String(exp.finished), got: String(st.finished),
    });
    return rows;
  }

  /** 导出与样例同格式的记录。 */
  function exportRecord(st) {
    return {
      rules: RULES_TEXT.slice(),
      active: st.initial.active,
      lamps: st.initial.lamps.slice(),
      energy: { ...st.initial.energy },
      hands: clone(st.initial.hands),
      actions: clone(st.actions),
      expected: {
        resolution: st.resolution.slice(),
        lit: st.lamps.filter(l => l.lit).map(l => l.id),
        closed: st.lamps.filter(l => l.closed).map(l => l.id),
        score: { ...st.score },
        energy: { ...st.energy },
        finished: st.finished,
      },
    };
  }

  return { TYPE_INFO, RULES_TEXT, newGame, clone, other, lampOf, playError, applyPlay, applyPass, applyAction, resolveTop, compareExpected, exportRecord };
});
