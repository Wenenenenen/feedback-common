'use strict';
/* Session-level tests: validation, record export/re-import, undo, and
 * consistency between the session value and the raw solver. */
const path = require('path');
const S = require(path.join(__dirname, '..', 'solver.js'));
const { Session } = require(path.join(__dirname, '..', 'session.js'));
const sample = require('../samples/expedition-deck.json');

let failures = 0;
function ok(cond, name) {
  if (!cond) { failures++; console.error('FAIL ' + name); }
}
function throws(fn, name, needle) {
  try {
    fn();
    failures++;
    console.error('FAIL ' + name + ': did not throw');
  } catch (e) {
    if (needle && !String(e.message).includes(needle)) {
      failures++;
      console.error('FAIL ' + name + ': wrong message: ' + e.message);
    }
  }
}

/* --- sample deck: value agrees with the solver, and the log is sane --- */
{
  const s = Session.fromDeckRaw(sample);
  const v = s.currentValue();
  ok(S.fToString(v) === '14/15', 'sample value is 14/15, got ' + S.fToString(v));
  ok(s.phase === 'pre', 'sample starts pre, got ' + s.phase);

  // Impossible reveal rejected.
  throws(() => s.reveal('nope'), 'unknown card name rejected', '不可能揭牌');
  // Reveal a real card.
  s.reveal('map');
  ok(s.phase === 'revealing', 'one reveal -> revealing');
  // Taking before both revealed must be rejected.
  throws(() => s.take(0), 'take before two reveals rejected', '还没揭完牌');
  // The second reveal cannot be "map" if map count went to 1? sample has map:2 -> still possible.
  const opts = s.validReveals().map(o => o.name);
  ok(opts.includes('camp'), 'camp still reachable after one map');
  s.reveal('camp');
  ok(s.phase === 'deciding', 'two reveals -> deciding');
  const takes = s.takeOptions();
  ok(takes.length === 2, 'two take options');
  ok(takes.filter(t => t.recommended).length === 1, 'exactly one recommended');
  // Both legal here (tickets start at 0, map 0 and camp +1).
  ok(takes.every(t => t.legal), 'both legal for map+camp');
  const before = s.actions.length;
  s.undo();
  ok(s.actions.length === before - 1, 'undo drops last action');
  ok(s.phase === 'revealing', 'undo returns to revealing');
  s.reveal('camp');
  ok(s.phase === 'deciding', 're-reveal returns to deciding');
}

/* --- ticket legality: seal needs 1 ticket, start 0, so seal alone is illegal --- */
{
  const raw = JSON.parse(JSON.stringify(sample));
  raw.unknown = { map: 0, camp: 0, seal: 2 };
  raw.tail = [];
  const s = Session.fromDeckRaw(raw);
  s.reveal('seal');
  s.reveal('seal');
  const takes = s.takeOptions();
  ok(takes && takes.every(t => !t.legal), 'two seals illegal at 0 tickets');
  ok(s.failed && s.stuck, 'no legal take -> stuck, got ' + s.phase);
  throws(() => s.take(0), 'illegal take rejected', '通行券');
  ok(s.snapshot().value.n === 0n, 'failed value is 0');
}

/* --- take returns the other card to the tail in reveal order --- */
{
  const s = Session.fromDeckRaw(sample);
  // Reveal the two unknown cards but choose which order by hand.
  // Map is worth 1 point and has the route badge; target is points 2 + seal badge,
  // so the only winning line is seal + a ticket from camp.
  s.reveal('camp');
  s.reveal('map');
  const takes = s.takeOptions();
  // Keep camp: the map must be appended to the tail.
  const campIdx = takes.findIndex(t => t.name === 'camp');
  s.take(campIdx);
  ok(s.state.tickets === 1, 'camp grants a ticket');
  ok(s.state.tail[s.state.tail.length - 1] === s.deck.names.indexOf('map'), 'map returned to tail end');
}

/* --- export / import round-trip, including mid-round --- */
{
  const s = Session.fromDeckRaw(sample);
  s.reveal('map');
  s.reveal('camp');
  s.take(1); // keep camp, map back to tail
  s.reveal('camp'); // camp count was 2 -> still 1 left, then tail head is map? no: unknown first
  const record = s.exportRecord();
  const clone = Session.fromRecord(JSON.parse(JSON.stringify(record)));
  ok(S.fToString(clone.currentValue()) === S.fToString(s.currentValue()), 're-import keeps value');
  ok(clone.phase === s.phase, 're-import keeps phase');
  ok(JSON.stringify(clone.state.unknown) === JSON.stringify(s.state.unknown), 're-import keeps unknown');
  ok(JSON.stringify(clone.state.tail) === JSON.stringify(s.state.tail), 're-import keeps tail');
  ok(JSON.stringify(clone.held) === JSON.stringify(s.held), 're-import keeps held');
  ok(clone.actions.length === s.actions.length, 're-import keeps action count');
}

/* --- tampered record rejected: reveal of a card not available --- */
{
  const record = Session.fromDeckRaw(sample).exportRecord();
  record.actions = [{ kind: 'reveal', card: 'nope' }];
  throws(() => Session.fromRecord(record), 'tampered reveal rejected', '不可能揭牌');
  record.actions = [{ kind: 'reveal', card: 'map' }, { kind: 'take', index: 0 }];
  throws(() => Session.fromRecord(record), 'take before decide rejected', '还没揭完牌');
  const twoSeals = JSON.parse(JSON.stringify(sample));
  twoSeals.unknown = { map: 0, camp: 0, seal: 2 };
  twoSeals.tail = [];
  const rec2 = Session.fromDeckRaw(twoSeals).exportRecord();
  rec2.actions = [{ kind: 'reveal', card: 'seal' }, { kind: 'reveal', card: 'seal' }, { kind: 'take', index: 0 }];
  throws(() => Session.fromRecord(rec2), 'illegal take in record rejected', '通行券');
}

/* --- log entries group reveals with their take --- */
{
  const s = Session.fromDeckRaw(sample);
  s.reveal('camp'); s.reveal('map'); s.take(0);
  const entries = s.logEntries();
  ok(entries.length === 1, 'one completed round logged');
  ok(entries[0].reveals.length === 2, 'two reveals logged');
  ok(entries[0].take === 'camp', 'take logged as camp, got ' + entries[0].take);
}

/* --- undo all the way back --- */
{
  const s = Session.fromDeckRaw(sample);
  const start = S.fToString(s.currentValue());
  s.reveal('camp'); s.reveal('map'); s.take(0); s.reveal('seal');
  while (s.undo());
  ok(s.actions.length === 0, 'undo empties actions');
  ok(S.fToString(s.currentValue()) === start, 'undo restores start value');
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('session tests passed');
