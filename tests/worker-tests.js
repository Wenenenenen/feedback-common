'use strict';
/* Exercise the worker runtime (solver + worker.js) in isolation, with a fake
 * `self`, and confirm its wire results match the solver computed inline. */
const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, '..', 'solver.js'));
const { Session } = require(path.join(__dirname, '..', 'session.js'));
const sample = require('../samples/expedition-deck.json');

let failures = 0;
function ok(cond, name) {
  if (!cond) { failures++; console.error('FAIL ' + name); }
}

const workerSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'worker.js'), 'utf8');
const solverSource = fs.readFileSync(path.join(__dirname, '..', 'solver.js'), 'utf8');

// Build a sandbox: ExpeditionSolver from the same source, plus a fake self.
const vm = require('vm');
const messages = [];
const sandbox = {
  ExpeditionSolver: S,
  BigInt,
  JSON,
  String,
  Error,
  self: {
    onmessage: null,
    postMessage: msg => messages.push(msg)
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(workerSource, sandbox);

function send(msg) {
  sandbox.self.onmessage({ data: msg });
  return messages.length ? messages[messages.length - 1] : null;
}

function fromWire(w) { return S.frac(BigInt(w.n), BigInt(w.d)); }
function wire(w) { return { n: String(w.n), d: String(w.d) }; }

// init with the sample deck
let ready = send({ type: 'init', id: 'init1', deck: sample });
ok(ready && ready.type === 'ready', 'worker init replies ready');

// pre query matches the solver
const s = Session.fromDeckRaw(sample);
const query = s.valueQuery();
const out = send({ id: 'q1', kind: query.kind, state: query.state, held: query.held, roundStart: query.roundStart });
ok(out && out.type === 'values', 'worker replies values');
ok(S.fToString(fromWire(out.value)) === '14/15', 'worker pre value is 14/15, got ' + S.fToString(fromWire(out.value)));

// reveal, then decide query
s.reveal('camp');
const q2 = s.valueQuery();
const out2 = send({ id: 'q2', kind: q2.kind, state: q2.state, held: q2.held, roundStart: q2.roundStart });
const local2 = s.engine.preValue(s.roundStart);
ok(out2.roundStart && S.fToString(fromWire(out2.roundStart)) === S.fToString(local2),
  'worker round-start value matches local');

s.reveal('map');
const q3 = s.valueQuery();
const out3 = send({ id: 'q3', kind: q3.kind, state: q3.state, held: q3.held, roundStart: q3.roundStart });
const local3 = s.engine.takeOptions(s.state, s.held);
ok(out3.options && out3.options.length === 2, 'worker returns two take options');
out3.options.forEach((o, i) => {
  const lv = local3.options[i];
  ok(o.legal === lv.legal, 'option ' + i + ' legality matches');
  if (o.legal) {
    ok(S.fToString(fromWire(o.value)) === S.fToString(lv.value),
      'option ' + i + ' value matches (' + S.fToString(fromWire(o.value)) + ' vs ' + S.fToString(lv.value) + ')');
  }
});

// unknown card rejected by a second init with a bad deck
let err = send({ type: 'init', id: 'initBad', deck: { types: {} } });
ok(err && err.type === 'error', 'bad deck reports an error');

if (failures) { console.error(failures + ' worker failure(s)'); process.exit(1); }
console.log('worker tests passed');
