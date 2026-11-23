/* Expedition draw-policy solver.
 *
 * Exact, optimal success probabilities for the "reveal up to two, keep one"
 * expedition game.  Every probability is a rational number backed by BigInt;
 * nothing here samples, approximates, or simulates.
 *
 * Model (matches samples/expedition-deck.json):
 *  - A round reveals min(2, cards remaining) cards, drawn one at a time: while
 *    the unknown multiset is non-empty cards come from it uniformly, and only
 *    once it is exhausted does drawing continue from the head of the public
 *    tail.  The player keeps exactly one revealed card; the other goes back to
 *    the tail (with at most two revealed, at most one goes back, so reveal
 *    order is moot).
 *  - A card can only be kept if its ticket cost does not take tickets below 0.
 *    If no revealed card can be kept the attempt fails.
 *  - Meeting the points and badge goal succeeds immediately.
 *  - Running out of cards or rounds without success is failure.
 *
 * The search below runs on a mutable state that it restores after every
 * branch, and memoises on a compact key of numbers only.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ExpeditionSolver = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Exact fractions                                                     */
  /* ------------------------------------------------------------------ */

  const ZERO = { n: 0n, d: 1n };
  const ONE = { n: 1n, d: 1n };

  function absBig(a) { return a < 0n ? -a : a; }

  function gcdBig(a, b) {
    a = absBig(a);
    b = absBig(b);
    while (b) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a || 1n;
  }

  function frac(n, d) {
    n = BigInt(n);
    d = d === undefined ? 1n : BigInt(d);
    if (d === 0n) throw new Error('division by zero');
    if (d < 0n) { n = -n; d = -d; }
    if (n === 0n) return ZERO;
    const g = gcdBig(n, d);
    return { n: n / g, d: d / g };
  }

  function fAdd(a, b) {
    if (a.n === 0n) return b;
    if (b.n === 0n) return a;
    if (a.d === b.d) return frac(a.n + b.n, a.d);
    return frac(a.n * b.d + b.n * a.d, a.d * b.d);
  }

  function fMul(a, b) {
    if (a.n === 0n || b.n === 0n) return ZERO;
    return frac(a.n * b.n, a.d * b.d);
  }

  function fMulInt(a, k) {
    if (k === 0 || a.n === 0n) return ZERO;
    return frac(a.n * BigInt(k), a.d);
  }

  function fCmp(a, b) {
    if (a.d === b.d) return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;
    const x = a.n * b.d;
    const y = b.n * a.d;
    return x < y ? -1 : x > y ? 1 : 0;
  }

  function fEquals(a, b) { return a.n === b.n && a.d === b.d; }

  function fToString(f) {
    return f.d === 1n ? String(f.n) : (String(f.n) + '/' + String(f.d));
  }

  /** Exact fraction followed by a rounded percentage, for display. */
  function fPercent(f) {
    if (f.n === 0n) return '0%';
    if (f.n === f.d) return '100%';
    const scaled = (f.n * 1000000n) / f.d; // 6 decimals of probability
    const pct = Number(scaled) / 10000;
    let s = pct.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return s + '%';
  }

  /* ------------------------------------------------------------------ */
  /* Deck parsing / validation                                           */
  /* ------------------------------------------------------------------ */

  function isInt(x) {
    return typeof x === 'number' && Number.isInteger(x);
  }

  function asInt(value, label, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (!isInt(value)) throw new Error(label + ' 必须是整数');
    return value;
  }

  function normalizeDeck(rawInput) {
    let raw = rawInput;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch (e) {
        throw new Error('JSON 解析失败：' + e.message);
      }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('牌组必须是一个 JSON 对象');
    }
    if (!raw.types || typeof raw.types !== 'object' || Array.isArray(raw.types)) {
      throw new Error('缺少 types 对象');
    }

    const names = Object.keys(raw.types);
    if (names.length === 0) throw new Error('types 至少要有一种牌');
    if (names.length > 8) throw new Error('最多支持 8 种牌，当前有 ' + names.length + ' 种');

    const badgeSet = new Set();
    const types = names.map((name, idx) => {
      const t = raw.types[name];
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        throw new Error('types.' + name + ' 必须是一个对象');
      }
      const points = asInt(t.points, 'types.' + name + '.points', 0);
      const tickets = asInt(t.tickets, 'types.' + name + '.tickets', 0);
      let badges = t.badges === undefined ? [] : t.badges;
      if (!Array.isArray(badges) || badges.some(b => typeof b !== 'string' || !b)) {
        throw new Error('types.' + name + '.badges 必须是字符串数组');
      }
      badges = Array.from(new Set(badges));
      badges.forEach(b => badgeSet.add(b));
      return { name, index: idx, points, tickets, badges };
    });

    const unknownRaw = raw.unknown === undefined ? {} : raw.unknown;
    if (!unknownRaw || typeof unknownRaw !== 'object' || Array.isArray(unknownRaw)) {
      throw new Error('unknown 必须是一个对象');
    }
    for (const key of Object.keys(unknownRaw)) {
      if (!names.includes(key)) throw new Error('unknown 中的牌 "' + key + '" 未在 types 中定义');
    }
    const unknown = names.map(name => {
      const c = unknownRaw[name] === undefined ? 0 : unknownRaw[name];
      if (!isInt(c) || c < 0) throw new Error('unknown.' + name + ' 必须是非负整数');
      if (c > 28) throw new Error('unknown.' + name + ' 最多 28 张');
      return c;
    });

    const tailRaw = raw.tail === undefined ? [] : raw.tail;
    if (!Array.isArray(tailRaw)) throw new Error('tail 必须是牌名数组');
    const tail = tailRaw.map((name, i) => {
      if (typeof name !== 'string') throw new Error('tail[' + i + '] 必须是牌名字符串');
      const idx = names.indexOf(name);
      if (idx < 0) throw new Error('tail[' + i + '] 的牌 "' + name + '" 未在 types 中定义');
      return idx;
    });

    const totalCards = unknown.reduce((a, b) => a + b, 0) + tail.length;
    if (totalCards > 28) throw new Error('最多支持 28 张牌，当前有 ' + totalCards + ' 张');
    if (totalCards === 0) throw new Error('unknown 与 tail 一共至少要有一张牌');

    const rounds = raw.rounds === undefined ? 1 : raw.rounds;
    if (!isInt(rounds) || rounds < 0) throw new Error('rounds 必须是非负整数');
    if (rounds > 6) throw new Error('最多支持 6 拍，当前 rounds=' + rounds);

    const startRaw = raw.start === undefined ? {} : raw.start;
    if (!startRaw || typeof startRaw !== 'object' || Array.isArray(startRaw)) {
      throw new Error('start 必须是一个对象');
    }
    const start = {
      points: asInt(startRaw.points, 'start.points', 0),
      tickets: asInt(startRaw.tickets, 'start.tickets', 0),
      badges: startRaw.badges === undefined ? [] : startRaw.badges
    };
    if (!Array.isArray(start.badges) || start.badges.some(b => typeof b !== 'string' || !b)) {
      throw new Error('start.badges 必须是字符串数组');
    }
    start.badges = Array.from(new Set(start.badges));
    start.badges.forEach(b => badgeSet.add(b));

    const goalRaw = raw.goal === undefined ? {} : raw.goal;
    if (!goalRaw || typeof goalRaw !== 'object' || Array.isArray(goalRaw)) {
      throw new Error('goal 必须是一个对象');
    }
    const goal = {
      points: asInt(goalRaw.points, 'goal.points', 0),
      badges: goalRaw.badges === undefined ? [] : goalRaw.badges
    };
    if (!Array.isArray(goal.badges) || goal.badges.some(b => typeof b !== 'string' || !b)) {
      throw new Error('goal.badges 必须是字符串数组');
    }
    goal.badges = Array.from(new Set(goal.badges));
    goal.badges.forEach(b => badgeSet.add(b));

    if (badgeSet.size > 30) throw new Error('最多支持 30 种徽章，当前有 ' + badgeSet.size + ' 种');

    const badgeNames = Array.from(badgeSet).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    const badgeIndex = new Map(badgeNames.map((b, i) => [b, i]));
    const maskOf = list => list.reduce((m, b) => m | (1 << badgeIndex.get(b)), 0);

    types.forEach(t => { t.badgeMask = maskOf(t.badges); });
    const goalMask = maskOf(goal.badges);
    const startMask = maskOf(start.badges);

    const maxTicketCost = types.reduce((m, t) => Math.max(m, Math.max(0, -t.tickets)), 0);
    const anyTicketCost = types.some(t => t.tickets < 0);
    const maxPoints = types.reduce((m, t) => Math.max(m, t.points), 0);
    const minPoints = types.reduce((m, t) => Math.min(m, t.points), 0);
    const maxTickets = types.reduce((m, t) => Math.max(m, t.tickets), 0);

    return {
      raw,
      names,
      types,
      unknown,
      tail,
      rounds,
      start: { points: start.points, tickets: start.tickets, badges: start.badges, badgeMask: startMask },
      goal: { points: goal.points, badges: goal.badges, badgeMask: goalMask },
      badgeNames,
      badgeIndex,
      totalCards,
      maxTicketCost,
      anyTicketCost,
      maxPoints,
      minPoints,
      maxTickets
    };
  }

  /* ------------------------------------------------------------------ */
  /* State helpers                                                       */
  /* ------------------------------------------------------------------ */

  function makeInitialState(deck) {
    return {
      points: deck.start.points,
      tickets: deck.start.tickets,
      badgeMask: deck.start.badgeMask,
      unknown: deck.unknown.slice(),
      tail: deck.tail.slice(),
      roundsLeft: deck.rounds
    };
  }

  function cloneState(s) {
    return {
      points: s.points,
      tickets: s.tickets,
      badgeMask: s.badgeMask,
      unknown: s.unknown.slice(),
      tail: s.tail.slice(),
      roundsLeft: s.roundsLeft
    };
  }

  function unknownTotal(unknown) {
    let n = 0;
    for (let i = 0; i < unknown.length; i++) n += unknown[i];
    return n;
  }

  function availableCount(state) {
    return unknownTotal(state.unknown) + state.tail.length;
  }

  /** Number of cards a round starting in this state reveals. */
  function revealCount(state) {
    return Math.min(2, availableCount(state));
  }

  /* ------------------------------------------------------------------ */
  /* Engine                                                              */
  /* ------------------------------------------------------------------ */

  const BASE_UNK = 32;      // 32^8 = 2^40, exact in a double
  const BASE_TAIL = 10;     // leading sentinel keeps lengths distinct

  class Engine {
    constructor(deck) {
      this.deck = deck;
      this.preCache = new Map();
      this.bestCache = new Map();
      this.work = 0;

      this.goalPoints = deck.goal.points;
      this.goalMask = deck.goal.badgeMask;
      this.typeCount = deck.types.length;

      // Tickets have no goal and are only spent by negative-ticket takes, so
      // within a state with r rounds left they only matter up to r * the
      // largest ticket cost; anything above that plays identically.
      this.maxTicketCost = deck.maxTicketCost;
      // Points are a threshold: when no card can reduce points, once at or
      // above the goal extra points can never change the outcome, so the key
      // may cap points at the goal.  With a negative-point card, points above
      // the goal still matter, so no cap applies.
      this.pointCap = deck.minPoints >= 0 ? deck.goal.points : Infinity;
    }

    isSuccess(state) {
      const deck = this.deck;
      return state.points >= deck.goal.points && (state.badgeMask & deck.goal.badgeMask) === deck.goal.badgeMask;
    }

    successOf(s) {
      return s.p >= this.goalPoints && (s.b & this.goalMask) === this.goalMask;
    }

    toInternal(state) {
      return {
        p: state.points,
        t: state.tickets,
        b: state.badgeMask,
        r: state.roundsLeft,
        unk: state.unknown.slice(),
        tail: state.tail.slice()
      };
    }

    encodeUnk(unk) {
      let code = 0;
      for (let i = this.typeCount - 1; i >= 0; i--) code = code * BASE_UNK + unk[i];
      return code;
    }

    encodeTail(tail, limit) {
      // Sentinel 1 keeps [a] and [0, a] apart.
      let code = 1;
      const n = Math.min(tail.length, limit);
      for (let i = 0; i < n; i++) code = code * BASE_TAIL + tail[i];
      return code;
    }

    /**
     * Cache key.  Equivalent states share a key:
     *  - points are capped at the goal (above it is success) and at what the
     *    remaining rounds could still reach,
     *  - badges outside the goal do not matter,
     *  - tickets are capped at what the remaining rounds could spend,
     *  - when the unknown pile cannot be exhausted before the rounds run out,
     *    the public tail is unreachable and omitted.
     */
    stateKey(s, unkTotal) {
      const p = s.p > this.pointCap ? this.pointCap : s.p;
      let t = s.t;
      if (this.maxTicketCost > 0) {
        const cap = s.r * this.maxTicketCost;
        if (t > cap) t = cap;
      } else {
        t = 0;
      }
      let key = p + '|' + t + '|' + (s.b & this.goalMask) + '|' + s.r + '|' + this.encodeUnk(s.unk);
      if (unkTotal < 2 * s.r) key += '|' + this.encodeTail(s.tail, 2 * s.r);
      return key;
    }

    /** Provably impossible from here? */
    cannotSucceed(s, unkTotal) {
      if (s.r <= 0) return true;
      const missingPoints = this.goalPoints - s.p;
      if (missingPoints > 0) {
        if (this.deck.maxPoints <= 0) return true;
        if (missingPoints > s.r * this.deck.maxPoints) return true;
      }
      const missingBadges = this.goalMask & ~s.b;
      if (missingBadges) {
        let reachable = s.b;
        for (let i = 0; i < this.typeCount; i++) {
          if (s.unk[i] > 0 || s.tail.indexOf(i) >= 0) reachable |= this.deck.types[i].badgeMask;
        }
        if ((missingBadges & ~reachable) !== 0) return true;
      }
      if (unkTotal + s.tail.length === 0) return true;
      return false;
    }

    /* ---------------- search ---------------- */

    /** Optimal success probability at the start of a round. */
    preValue(state) {
      return this.preSearch(this.toInternal(state));
    }

    preSearch(s) {
      if (this.successOf(s)) return ONE;
      if (s.r <= 0) return ZERO;
      let unkTotal = 0;
      for (let i = 0; i < this.typeCount; i++) unkTotal += s.unk[i];
      const avail = unkTotal + s.tail.length;
      if (avail === 0) return ZERO;
      if (this.cannotSucceed(s, unkTotal)) return ZERO;

      const key = this.stateKey(s, unkTotal);
      const hit = this.preCache.get(key);
      if (hit !== undefined) return hit;
      this.work++;

      let value;
      if (avail === 1) {
        value = this.roundWithOneCard(s, unkTotal);
      } else if (unkTotal >= 2) {
        value = this.roundFromUnknownPairs(s, unkTotal);
      } else if (unkTotal === 1) {
        value = this.roundFromOneUnknown(s);
      } else {
        value = this.roundFromTail(s);
      }
      this.preCache.set(key, value);
      return value;
    }

    roundWithOneCard(s, unkTotal) {
      let type;
      if (unkTotal > 0) {
        type = this.firstUnknown(s.unk);
        s.unk[type] -= 1;
      } else {
        type = s.tail.shift();
      }
      const value = this.takeOne(s, type);
      if (unkTotal > 0) s.unk[type] += 1;
      else s.tail.unshift(type);
      return value;
    }

    roundFromOneUnknown(s) {
      const i = this.firstUnknown(s.unk);
      const fromTail = s.tail.shift();
      s.unk[i] -= 1;
      const value = this.bestOfPair(s, i, fromTail);
      s.unk[i] += 1;
      s.tail.unshift(fromTail);
      return value;
    }

    roundFromTail(s) {
      const a = s.tail.shift();
      const b = s.tail.shift();
      const value = this.bestOfPair(s, a, b);
      s.tail.unshift(b);
      s.tail.unshift(a);
      return value;
    }

    roundFromUnknownPairs(s, unkTotal) {
      const denom = unkTotal * (unkTotal - 1);
      let value = ZERO;
      const n = this.typeCount;
      for (let i = 0; i < n; i++) {
        const ci = s.unk[i];
        if (ci === 0) continue;
        for (let j = i; j < n; j++) {
          const cj = s.unk[j];
          if (cj === 0) continue;
          let w, v;
          if (i === j) {
            if (ci < 2) continue;
            s.unk[i] -= 2;
            w = frac(ci * (ci - 1), denom);
            v = this.bestOfPair(s, i, i);
            s.unk[i] += 2;
          } else {
            s.unk[i] -= 1;
            s.unk[j] -= 1;
            w = frac(2 * ci * cj, denom);
            v = this.bestOfPair(s, i, j);
            s.unk[i] += 1;
            s.unk[j] += 1;
          }
          if (v.n === 0n) continue;
          value = fAdd(value, fMul(w, v));
          if (value.n === value.d) return ONE; // cannot exceed 1
        }
      }
      return value;
    }

    firstUnknown(unk) {
      for (let i = 0; i < this.typeCount; i++) if (unk[i] > 0) return i;
      return -1;
    }

    /** Best take value from two revealed cards; ties keep the earlier one. */
    bestOfPair(s, a, c) {
      const ta = this.deck.types[a];
      let best = null;
      // Each revealed physical card is distinct even when the types match, so
      // the card not kept goes back to the tail.
      if (s.t + ta.tickets >= 0) best = this.takeCard(s, a, c);
      const tc = this.deck.types[c];
      if (s.t + tc.tickets >= 0) {
        const v = this.takeCard(s, c, a);
        if (best === null || fCmp(v, best) > 0) best = v;
      }
      return best === null ? ZERO : best;
    }

    /** Value of keeping `card`; `other` (or null) goes back to the tail. */
    takeCard(s, card, other) {
      const ty = this.deck.types[card];
      const prevP = s.p, prevT = s.t, prevB = s.b;
      s.p += ty.points;
      s.t += ty.tickets;
      s.b |= ty.badgeMask;

      let value;
      if (this.successOf(s)) {
        value = ONE;
      } else {
        s.r -= 1;
        if (s.r <= 0) {
          value = ZERO;
        } else if (other === null) {
          value = this.preSearch(s);
        } else {
          s.tail.push(other);
          value = this.preSearch(s);
          s.tail.pop();
        }
        s.r += 1;
      }
      s.p = prevP;
      s.t = prevT;
      s.b = prevB;
      return value;
    }

    takeOne(s, card) {
      const ty = this.deck.types[card];
      if (s.t + ty.tickets < 0) return ZERO;
      return this.takeCard(s, card, null);
    }

    /* ---------------- public per-card values ---------------- */

    /** All takes from the revealed cards, with exact values and legality. */
    takeOptions(state, held) {
      const s = this.toInternal(state);
      const options = [];
      let bestIndex = -1;
      let bestValue = null;
      for (let i = 0; i < held.length; i++) {
        const t = this.deck.types[held[i]];
        const legal = s.t + t.tickets >= 0;
        let value = ZERO;
        if (legal) {
          const other = held.length > 1 ? held[i === 0 ? 1 : 0] : null;
          value = this.takeCard(s, held[i], other);
          if (bestValue === null || fCmp(value, bestValue) > 0) {
            bestValue = value;
            bestIndex = i;
          }
        }
        options.push({
          index: i,
          type: held[i],
          name: t.name,
          points: t.points,
          tickets: t.tickets,
          badges: t.badges.slice(),
          legal,
          reason: legal ? null : ('通行券不足：需要 ' + (-t.tickets) + ' 张，当前只有 ' + s.t + ' 张'),
          value
        });
      }
      return { options, bestIndex, bestValue: bestValue || ZERO };
    }

    /** Value of keeping held[index] (used by takeOptions and the UI). */
    takeValue(state, held, index) {
      const s = this.toInternal(state);
      const t = this.deck.types[held[index]];
      if (s.t + t.tickets < 0) return ZERO;
      const other = held.length > 1 ? held[index === 0 ? 1 : 0] : null;
      return this.takeCard(s, held[index], other);
    }

    /** Best take value from an already-revealed set. */
    bestTake(state, held) {
      if (held.length === 1) return { value: this.takeValue(state, held, 0) };
      const key = this.stateKey(this.toInternal(state), unknownTotal(state.unknown)) +
        '#' + Math.min(held[0], held[1]) + '.' + Math.max(held[0], held[1]);
      const hit = this.bestCache.get(key);
      if (hit !== undefined) return hit;
      const s = this.toInternal(state);
      const result = { value: this.bestOfPair(s, held[0], held[1]) };
      this.bestCache.set(key, result);
      return result;
    }

    /**
     * Expected value once `held` has been revealed and one more card is due
     * (used for the "after one reveal" readout).
     */
    afterRevealsValue(state, held) {
      if (this.isSuccess(state)) return ONE;
      if (state.roundsLeft <= 0) return ZERO;
      const support = this.nextRevealSupport(state);
      if (support.length === 0) return this.bestTake(state, held).value;

      const s = this.toInternal(state);
      const known = held[0];
      let value = ZERO;
      for (const r of support) {
        if (unknownTotal(state.unknown) > 0) {
          s.unk[r.type] -= 1;
          const v = this.bestOfPair(s, known, r.type);
          s.unk[r.type] += 1;
          value = fAdd(value, fMul(r.prob, v));
        } else {
          const card = s.tail.shift();
          const v = this.bestOfPair(s, known, card);
          s.tail.unshift(card);
          value = fAdd(value, fMul(r.prob, v));
        }
      }
      return value;
    }

    /* ---------------- helpers shared with the UI ---------------- */

    /** Cards that can be revealed next, with exact probabilities. */
    nextRevealSupport(state) {
      const total = unknownTotal(state.unknown);
      if (total > 0) {
        const out = [];
        for (let i = 0; i < state.unknown.length; i++) {
          const c = state.unknown[i];
          if (c > 0) {
            out.push({ type: i, name: this.deck.names[i], count: c, prob: frac(c, total) });
          }
        }
        return out;
      }
      if (state.tail.length > 0) {
        const t = state.tail[0];
        return [{ type: t, name: this.deck.names[t], count: 1, prob: ONE }];
      }
      return [];
    }

    /** Remove one revealed card from the unknown multiset or the tail head. */
    removeCard(state, type) {
      const next = cloneState(state);
      if (unknownTotal(state.unknown) > 0) {
        if (!(next.unknown[type] > 0)) throw new Error('该牌已不在未知牌堆中');
        next.unknown[type] -= 1;
      } else {
        if (next.tail.length === 0 || next.tail[0] !== type) {
          throw new Error('该牌不是当前应揭的公开队首');
        }
        next.tail.shift();
      }
      return next;
    }

    /** Apply a take, returning the state for the next round. */
    applyTake(state, held, index) {
      const t = this.deck.types[held[index]];
      if (state.tickets + t.tickets < 0) throw new Error('该拿法不合法：通行券会变成负数');
      const next = cloneState(state);
      next.points += t.points;
      next.tickets += t.tickets;
      next.badgeMask |= t.badgeMask;
      next.roundsLeft -= 1;
      const leftover = held.slice(0, index).concat(held.slice(index + 1));
      if (leftover.length) next.tail = next.tail.concat(leftover);
      return next;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Small shared utilities for the UI                                   */
  /* ------------------------------------------------------------------ */

  function describeState(deck, state) {
    return {
      points: state.points,
      tickets: state.tickets,
      badges: deck.badgeNames.filter(b => state.badgeMask & (1 << deck.badgeIndex.get(b))),
      roundsLeft: state.roundsLeft,
      unknown: deck.names.map((n, i) => ({ name: n, count: state.unknown[i] })).filter(x => x.count > 0),
      unknownCounts: state.unknown.slice(),
      tail: state.tail.map(t => deck.names[t]),
      available: availableCount(state)
    };
  }

  return {
    normalizeDeck,
    makeInitialState,
    cloneState,
    describeState,
    Engine,
    revealCount,
    availableCount,
    unknownTotal,
    ZERO,
    ONE,
    frac,
    fAdd,
    fMul,
    fMulInt,
    fCmp,
    fEquals,
    fToString,
    fPercent
  };
}));
