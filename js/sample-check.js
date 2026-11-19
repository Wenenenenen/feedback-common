// 浏览器内的样例校验：与 tests/engine.test.cjs 使用同一套包内黄金值。
// 只调用引擎的纯函数，不触碰页面状态。
(function (root) {
  'use strict';

  var E = root.RallyEngine;
  var S = root.RallySamples;

  function expectedChecks(list) {
    // list: [{label, ok, detail}]
    var pass = 0;
    list.forEach(function (c) {
      if (c.ok) pass += 1;
    });
    return { ok: pass === list.length, pass: pass, total: list.length, checks: list };
  }

  function run(engine) {
    var E2 = engine || E;
    var out = [];
    var add = function (label, ok, detail) {
      out.push({ label: label, ok: !!ok, detail: detail || '' });
    };

    // ---- segment-cases ----
    var seg = E2.runSegmentCases(S.segmentCases);
    add('segment-cases 全部通过', seg.ok, seg.results ? seg.results.filter(function (r) { return r.ok; }).length + '/' + seg.results.length : '');

    // 一步跨多门按 (t, 门序号)
    var gates = E2.prepareGates(S.segmentCases.gates);
    var cs = E2.gateCrossings({ x: -1, y: 0 }, { x: 3, y: 0 }, gates);
    add(
      '一步跨两门按 t 排序',
      cs.length === 2 && cs[0].gate === 0 && cs[1].gate === 1 && Math.abs(cs[0].t - 0.25) < 1e-12 && Math.abs(cs[1].t - 0.75) < 1e-12,
      cs.map(function (c) { return c.gate + '@' + c.t.toFixed(3); }).join(' ')
    );

    // 起点恰在门上不产生跨门
    var onGate = E2.gateCrossings({ x: 0, y: 0 }, { x: 1, y: 0 }, gates);
    add('起点恰在门上不产生跨门', onGate.length === 0, String(onGate.length));

    // 端点计入，端点外不计
    var atEnd = E2.gateCrossings({ x: -1, y: 2 }, { x: 1, y: 2 }, gates);
    var outEnd = E2.gateCrossings({ x: -1, y: 3 }, { x: 1, y: 3 }, gates);
    add('门端点计入、端点外不计', atEnd.length === 1 && outEnd.length === 0, atEnd.length + ' / ' + outEnd.length);

    // ---- straight-reference ----
    var sr = E2.runStraightReference(S.straightReference);
    add(
      'straight-reference 积分一致（误差 ≤ 1e-9）',
      sr.ok,
      sr.diffs ? 'Δx=' + sr.diffs.x.toExponential(1) + ' Δv=' + sr.diffs.v.toExponential(1) : (sr.errors || []).join(';')
    );

    // ---- race.json ----
    var raceReplay = Object.assign({}, S.race, { ticks: 10000 });
    var rr = E2.simulateReplay(raceReplay);
    add('race.json 起步时刻 = 步内交点', rr.ok && rr.start && Math.abs(rr.start.time - 1.903912571046392) < 1e-9,
      rr.start ? rr.start.time.toFixed(9) : '未起步');
    add('race.json 正向非期望门记 outOfOrder', rr.ok && rr.violationCounts.outOfOrder === 1 && rr.violationCounts.reverse === 0,
      'outOfOrder=' + (rr.ok ? rr.violationCounts.outOfOrder : '?') + ' reverse=' + (rr.ok ? rr.violationCounts.reverse : '?'));
    add('race.json 未收圈', rr.ok && rr.laps.length === 0, rr.ok ? rr.laps.length + ' 圈' : '');
    add('race.json 到达 10000 步上限', rr.ok && rr.ticks === 10000 && rr.doneReason === 'tick-limit', rr.doneReason);

    // ---- 回放确定性 ----
    var again = E2.simulateReplay(raceReplay);
    add('同一回放两次校验和一致', rr.ok && again.checksum === rr.checksum, rr.checksum + ' / ' + again.checksum);

    // ---- 输入校验 ----
    var badFirst = E2.validateInputs([{ tick: 1, throttle: 0, steer: 0, brake: false }]);
    var dupTick = E2.validateInputs([
      { tick: 0, throttle: 0, steer: 0, brake: false },
      { tick: 0, throttle: 1, steer: 0, brake: false },
    ]);
    add('首项必须 tick 0', badFirst.length > 0);
    add('tick 必须严格递增', dupTick.length > 0);

    var result = expectedChecks(out);
    result.summary = out.map(function (c) {
      return (c.ok ? '✓ ' : '✗ ') + c.label + (c.detail ? ' — ' + c.detail : '');
    }).join('\n');
    return result;
  }

  root.RallySampleCheck = { run: run };
})(typeof globalThis !== 'undefined' ? globalThis : this);
