/* Expedition session: the playable record on top of the solver.
 *
 * A session owns the deck, the current state, the cards revealed so far in the
 * current round, and an append-only action log.  Every action can be undone.
 * An exported record is {deck, actions}; re-importing replays the actions
 * through the same validation the buttons use, so an impossible reveal or an
 * illegal take can never be written.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./solver.js'));
  } else {
    root.ExpeditionSession = factory(root.ExpeditionSolver);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (S) {
  'use strict';

  const ACTIVE = 'active';

  class Session {
    constructor(deck) {
      this.deck = deck;
      this.engine = new S.Engine(deck);
      this.reset();
    }

    static fromDeckRaw(rawDeck) {
      return new Session(S.normalizeDeck(rawDeck));
    }

    static fromRecord(record) {
      if (!record || typeof record !== 'object') throw new Error('记录必须是一个 JSON 对象');
      if (!record.deck) throw new Error('记录缺少 deck 字段');
      if (!Array.isArray(record.actions)) throw new Error('记录缺少 actions 数组');

      const session = Session.fromDeckRaw(record.deck);
      record.actions.forEach((action, i) => {
        const where = '第 ' + (i + 1) + ' 条记录';
        if (!action || typeof action !== 'object') throw new Error(where + '格式错误');
        if (action.kind === 'reveal') {
          if (typeof action.card !== 'string') throw new Error(where + '缺少 card');
          try {
            session.reveal(action.card);
          } catch (e) {
            throw new Error(where + '：' + e.message);
          }
        } else if (action.kind === 'take') {
          if (!Number.isInteger(action.index)) throw new Error(where + '缺少整数 index');
          try {
            session.take(action.index);
          } catch (e) {
            throw new Error(where + '：' + e.message);
          }
        } else {
          throw new Error(where + '的 kind 必须是 reveal 或 take');
        }
      });
      return session;
    }

    reset() {
      this.state = S.makeInitialState(this.deck);
      this.held = [];
      this.actions = [];
      this.history = [];
      this.revealTarget = Math.min(2, S.availableCount(this.state));
      this.roundStart = S.cloneState(this.state);
    }

    isSuccess() {
      return this.engine.isSuccess(this.state);
    }

    /** pre → revealing → deciding → next round; or a terminal success / failure. */
    get phase() {
      if (this.isSuccess()) return 'success';
      if (this.state.roundsLeft <= 0) return 'failed';
      if (S.availableCount(this.state) === 0 && this.held.length === 0) return 'failed';
      if (this.held.length === 0) return 'pre';
      if (this.held.length < this.revealTarget) return 'revealing';
      return 'deciding';
    }

    /**
     * True when a completed round's revealed cards are all unplayable: the
     * attempt is lost.  While a card is still to be revealed this is false,
     * since that card could still be kept.
     */
    get stuck() {
      if (this.phase !== 'deciding') return false;
      return !this.held.some(t => this.state.tickets + this.deck.types[t].tickets >= 0);
    }

    /** Terminal state reached without meeting the goal. */
    get failed() {
      return this.phase === 'failed' || this.stuck;
    }

    /** Why the game ended, for display. */
    get endReason() {
      if (this.phase === 'success') return '达到分数与徽章目标，本局成功。';
      if (!this.failed) return null;
      if (this.stuck) return '本轮揭出的牌都拿不了（通行券不足），本局失败。';
      if (S.availableCount(this.state) === 0) return '牌堆已空且尚未达标，本局失败。';
      return '拍数耗尽且尚未达标，本局失败。';
    }

    /** Legal next cards to record, with their probabilities. */
    validReveals() {
      const phase = this.phase;
      if (phase !== 'pre' && phase !== 'revealing') return [];
      return this.engine.nextRevealSupport(this.state).map(r => ({
        type: r.type,
        name: r.name,
        count: r.count,
        prob: r.prob
      }));
    }

    /** Cards already revealed this round, in reveal order. */
    heldCards() {
      return this.held.map(t => ({
        type: t,
        name: this.deck.names[t],
        points: this.deck.types[t].points,
        tickets: this.deck.types[t].tickets,
        badges: this.deck.types[t].badges.slice()
      }));
    }

    pushHistory() {
      this.history.push({
        state: S.cloneState(this.state),
        held: this.held.slice(),
        revealTarget: this.revealTarget,
        roundStart: S.cloneState(this.roundStart),
        actionsLength: this.actions.length
      });
    }

    /**
     * Record a revealed card.  Only a card that really can come next is
     * accepted: any type still in the unknown pile, or the tail head once the
     * unknown pile is empty.
     */
    reveal(cardName) {
      if (typeof cardName !== 'string') throw new Error('揭牌必须是牌名');
      if (this.phase === 'success') throw new Error('本局已经成功，不能再揭牌');
      if (this.failed) throw new Error('本局已经失败，不能再揭牌');
      if (this.phase === 'deciding') throw new Error('本轮牌都已揭出，请先拿牌');
      const options = this.validReveals();
      const pick = options.find(o => o.name === cardName);
      if (!pick) {
        const pool = options.length
          ? options.map(o => o.name).join('、')
          : '（无）';
        throw new Error('不可能揭牌「' + cardName + '」，当前只能揭出：' + pool);
      }
      this.pushHistory();
      this.state = this.engine.removeCard(this.state, pick.type);
      this.held.push(pick.type);
      this.actions.push({ kind: 'reveal', card: cardName });
      return this;
    }

    /** Each revealed card with its exact success value, plus the recommended one. */
    takeOptions() {
      // Takes are only allowed once the round's reveals are complete, so no
      // values or buttons are exposed while another card is still due.
      if (this.phase !== 'deciding') return null;
      const result = this.engine.takeOptions(this.state, this.held);
      return result.options.map(o => ({
        index: o.index,
        name: o.name,
        points: o.points,
        tickets: o.tickets,
        badges: o.badges,
        legal: o.legal,
        reason: o.reason,
        value: o.value,
        recommended: o.index === result.bestIndex
      }));
    }

    /** Take held[index]; the other revealed card goes back to the tail. */
    take(index) {
      if (this.phase === 'success' || this.phase === 'failed') throw new Error('本局已经结束');
      if (this.phase !== 'deciding') throw new Error('还没揭完牌，不能拿牌');
      if (!Number.isInteger(index) || index < 0 || index >= this.held.length) {
        throw new Error('拿牌位置无效');
      }
      const t = this.deck.types[this.held[index]];
      if (this.state.tickets + t.tickets < 0) {
        throw new Error('不合法：拿「' + t.name + '」会让通行券变成负数');
      }
      this.pushHistory();
      const roundIndex = this.held[index];
      const takeName = this.deck.names[roundIndex];
      this.state.points += t.points;
      this.state.tickets += t.tickets;
      this.state.badgeMask |= t.badgeMask;
      this.state.roundsLeft -= 1;
      const leftover = this.held.slice(0, index).concat(this.held.slice(index + 1));
      if (leftover.length) this.state.tail = this.state.tail.concat(leftover);
      this.held = [];
      this.revealTarget = Math.min(2, S.availableCount(this.state));
      this.roundStart = S.cloneState(this.state);
      this.actions.push({ kind: 'take', index, card: takeName });
      return this;
    }

    undo() {
      const last = this.history.pop();
      if (!last) return false;
      this.state = last.state;
      this.held = last.held;
      this.revealTarget = last.revealTarget;
      this.roundStart = last.roundStart;
      this.actions.length = last.actionsLength;
      return true;
    }

    exportRecord() {
      return {
        format: 'expedition-draw-record',
        version: 1,
        deck: this.deck.raw,
        actions: this.actions.map(a => (a.kind === 'reveal'
          ? { kind: 'reveal', card: a.card }
          : { kind: 'take', index: a.index, card: a.card }))
      };
    }

    /** Human-readable rounds, derived by replaying the action log. */
    logEntries() {
      const rounds = [];
      let replay = new Session(this.deck);
      let current = null;

      for (const a of this.actions) {
        if (a.kind === 'reveal') {
          if (!current) current = { reveals: [], take: null };
          replay.reveal(a.card);
          current.reveals.push(a.card);
        } else {
          if (!current) current = { reveals: [], take: null };
          const card = replay.heldCards()[a.index];
          current.take = card ? card.name : null;
          replay.take(a.index);
          rounds.push(current);
          current = null;
        }
      }
      if (current) rounds.push(current);
      return rounds.map((r, i) => ({
        round: i + 1,
        reveals: r.reveals,
        take: r.take,
        pending: r.take === null
      }));
    }

    /** Exact success probability of the optimal policy from the current position. */
    currentValue() {
      const phase = this.phase;
      if (phase === 'success') return S.ONE;
      if (this.failed) return S.ZERO;
      if (phase === 'pre') return this.engine.preValue(this.state);
      if (phase === 'revealing') return this.engine.afterRevealsValue(this.state, this.held);
      return this.engine.bestTake(this.state, this.held).value;
    }

    /**
     * A cheap description of the position that needs no probability work.
     * `takes` carries legality and reasons but no values; values arrive from
     * the solver separately (they can take seconds on a large deck).
     */
    position() {
      const phase = this.phase;
      let takes = null;
      if (phase === 'deciding') {
        takes = this.held.map((t, i) => {
          const ty = this.deck.types[t];
          const legal = this.state.tickets + ty.tickets >= 0;
          return {
            index: i,
            name: ty.name,
            points: ty.points,
            tickets: ty.tickets,
            badges: ty.badges.slice(),
            legal,
            reason: legal ? null : ('通行券不足：需要 ' + (-ty.tickets) + ' 张，当前只有 ' + this.state.tickets + ' 张')
          };
        });
      }
      return {
        phase,
        failed: this.failed,
        stuck: this.stuck,
        endReason: this.endReason,
        state: S.describeState(this.deck, this.state),
        roundStart: S.describeState(this.deck, this.roundStart),
        held: this.heldCards(),
        revealTarget: this.revealTarget,
        reveals: this.validReveals(),
        takes,
        actions: this.actions.length,
        canUndo: this.history.length > 0,
        log: this.logEntries()
      };
    }

    /**
     * What the solver must evaluate for this position, or null when there is
     * nothing left to compute (success, or a game that ended without cards).
     * A stuck round still returns a query so its revealed cards can be listed
     * with their values; every take in it is illegal and worth 0.
     */
    valueQuery() {
      const phase = this.phase;
      if (phase === 'success') return null;
      if (phase === 'failed') return null;
      const roundStart = phase === 'pre' ? null : this.roundStart;
      if (phase === 'pre') {
        return { kind: 'pre', state: this.state, held: [], roundStart: null };
      }
      if (phase === 'revealing') {
        return { kind: 'after', state: this.state, held: this.held.slice(), roundStart };
      }
      return { kind: 'decide', state: this.state, held: this.held.slice(), roundStart };
    }

    snapshot() {
      const position = this.position();
      const query = this.valueQuery();
      let value;
      let options = null;
      let roundStartValue = null;
      if (query) {
        value = this.currentValue();
        if (query.roundStart) roundStartValue = this.engine.preValue(query.roundStart);
        if (query.kind === 'decide') {
          const result = this.engine.takeOptions(this.state, this.held);
          options = result.options.map(o => ({
            index: o.index,
            legal: o.legal,
            reason: o.reason,
            recommended: o.index === result.bestIndex,
            value: o.legal ? o.value : null
          }));
        }
      } else {
        value = this.phase === 'success' ? S.ONE : S.ZERO;
      }
      return Object.assign({}, position, {
        value,
        roundStartValue,
        options
      });
    }
  }

  return { Session, ACTIVE };
}));
