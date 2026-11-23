/* Worker runtime.  Prepended with the solver source, it keeps one Engine per
 * deck so the memoisation cache stays warm across requests, and answers value
 * queries without blocking the page. */
/* global ExpeditionSolver */
(function () {
  'use strict';
  var S = ExpeditionSolver;
  var engine = null;
  var deckKey = null;

  function wire(f) {
    if (!f) return null;
    return { n: String(f.n), d: String(f.d) };
  }

  function toFrac(w) {
    return { n: BigInt(w.n), d: BigInt(w.d) };
  }

  function compute(m) {
    if (m.kind === 'pre') {
      return {
        value: wire(engine.preValue(m.state)),
        roundStart: null,
        options: null
      };
    }
    if (m.kind === 'after') {
      return {
        value: wire(engine.afterRevealsValue(m.state, m.held)),
        roundStart: m.roundStart ? wire(engine.preValue(m.roundStart)) : null,
        options: null
      };
    }
    // decide
    var result = engine.takeOptions(m.state, m.held);
    var value = result.bestValue;
    return {
      value: wire(value),
      roundStart: m.roundStart ? wire(engine.preValue(m.roundStart)) : null,
      options: result.options.map(function (o, i) {
        return {
          index: o.index,
          legal: o.legal,
          reason: o.reason,
          recommended: i === result.bestIndex,
          value: o.legal ? wire(o.value) : null
        };
      })
    };
  }

  self.onmessage = function (ev) {
    var m = ev.data;
    try {
      if (m.type === 'init') {
        var key = JSON.stringify(m.deck);
        if (key !== deckKey) {
          engine = new S.Engine(S.normalizeDeck(m.deck));
          deckKey = key;
        }
        self.postMessage({ type: 'ready', id: m.id });
        return;
      }
      if (!engine) throw new Error('worker 尚未初始化');
      var out = compute(m);
      out.type = 'values';
      out.id = m.id;
      self.postMessage(out);
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: err.message || String(err) });
    }
  };
}());
