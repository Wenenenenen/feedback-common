const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Cookfest = require('../js/cookfest.js');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'cookfest-plan.json'), 'utf8'));

function problem(overrides = {}) {
  return {
    deadline: 6,
    stations: [{ id: 1, closed: [] }, { id: 2, closed: [] }],
    stock: { grain: 2 },
    tools: { tool: 1 },
    jobs: [
      {
        id: 1, after: [],
        modes: [{ id: 1, station: 1, ticks: 1, fee: 1, use: { grain: 1 }, yield: {}, hold: {} }]
      },
      {
        id: 2, after: [],
        modes: [{ id: 1, station: 2, ticks: 1, fee: 1, use: { grain: 1 }, yield: {}, hold: {} }]
      }
    ],
    locks: {},
    ...overrides
  };
}

test('sample finds earliest chain schedule at tick boundaries', () => {
  const r = Cookfest.solvePlan(sample);
  assert.equal(r.status, 'optimal');
  assert.equal(r.makespan, 4);
  assert.equal(r.cost, 3);
  assert.deepEqual(r.signature, [0, 1, 2, 1]);
  assert.equal(r.verification.valid, true);
});

test('two simultaneous starts cannot spend one shared ingredient twice', () => {
  const raw = problem({ stock: { grain: 1 } });
  const r = Cookfest.solvePlan(raw);
  assert.equal(r.feasible, false);
  assert.equal(r.status, 'unsolvable');

  const p = Cookfest.normalizeProblem(raw).problem;
  const v = Cookfest.verifyPlan(p, [
    { jobId: 1, modeId: 1, start: 0, end: 1 },
    { jobId: 2, modeId: 1, start: 0, end: 1 }
  ]);
  assert.equal(v.valid, false);
  assert.match(v.errors.join('\n'), /配料透支|汇总扣料/);
  assert.equal(v.startChecks.every((c) => c.checks.materials === false), true);
});

test('completion output is inbound before same-tick starts can consume it', () => {
  const raw = problem({
    deadline: 3,
    stock: { grain: 1 },
    jobs: [
      {
        id: 1, after: [],
        modes: [{ id: 1, station: 1, ticks: 1, fee: 0, use: { grain: 1 }, yield: { dough: 1 } }]
      },
      {
        id: 2, after: [1],
        modes: [{ id: 1, station: 2, ticks: 1, fee: 0, use: { dough: 1 }, yield: {} }]
      }
    ]
  });
  const r = Cookfest.solvePlan(raw);
  assert.equal(r.feasible, true);
  assert.deepEqual(r.assignments.map((a) => [a.jobId, a.start, a.end]), [[1, 0, 1], [2, 1, 2]]);

  const ledgerTick1 = r.ledger.find((x) => x.tick === 1);
  assert.equal(ledgerTick1.outputs.dough, 1);
  assert.equal(ledgerTick1.stockAfterOutput.dough, 1);
  assert.equal(ledgerTick1.demand.dough, 1);
  assert.equal(ledgerTick1.ok, true);
});

test('station and tool intervals are half-open and release at end tick', () => {
  const raw = problem({
    deadline: 2,
    stock: { grain: 4 },
    jobs: [
      { id: 1, after: [], modes: [{ id: 1, station: 1, ticks: 1, fee: 0, use: {}, hold: { tool: 1 } }] },
      { id: 2, after: [], modes: [{ id: 1, station: 1, ticks: 1, fee: 0, use: {}, hold: { tool: 1 } }] }
    ]
  });
  const r = Cookfest.solvePlan(raw);
  assert.equal(r.feasible, true);
  assert.deepEqual(r.assignments.map((a) => a.start).sort(), [0, 1]);
  assert.equal(r.verification.valid, true);
});

test('closed station interval rejects overlap but permits boundary starts', () => {
  const raw = problem({
    deadline: 3,
    stock: {},
    stations: [{ id: 1, closed: [[1, 2]] }, { id: 2, closed: [] }],
    jobs: [
      { id: 1, after: [], modes: [{ id: 1, station: 1, ticks: 1, fee: 0, use: {} }] }
    ]
  });
  const r = Cookfest.solvePlan(raw);
  assert.equal(r.feasible, true);
  assert.ok([0, 2].includes(r.assignments[0].start));

  const p = Cookfest.normalizeProblem(raw).problem;
  const bad = Cookfest.verifyPlan(p, [{ jobId: 1, modeId: 1, start: 1, end: 2 }]);
  assert.equal(bad.valid, false);
  assert.equal(bad.startChecks[0].checks.stationOpen, false);
});

test('locks force a start and impossible locked start is unsolvable', () => {
  const locked = Cookfest.solvePlan({ ...sample, locks: { 1: 2 } });
  assert.equal(locked.feasible, true);
  assert.equal(locked.assignments.find((a) => a.jobId === 1).start, 2);
  assert.equal(locked.makespan, 6);

  const impossible = Cookfest.solvePlan({ ...sample, locks: { 1: 3 } });
  assert.equal(impossible.feasible, false);
});

test('minimum cost is chosen at the earliest makespan', () => {
  const raw = problem({
    deadline: 2,
    stock: {},
    jobs: [
      {
        id: 1, after: [],
        modes: [
          { id: 1, station: 1, ticks: 1, fee: 5, use: {} },
          { id: 2, station: 1, ticks: 1, fee: 1, use: {} }
        ]
      },
      { id: 2, after: [], modes: [{ id: 1, station: 2, ticks: 1, fee: 2, use: {} }] }
    ]
  });
  const r = Cookfest.solvePlan(raw);
  assert.equal(r.makespan, 1);
  assert.equal(r.cost, 3);
  assert.equal(r.assignments.find((a) => a.jobId === 1).modeId, 2);
});

test('tie-break is lexicographic by job id across start and mode', () => {
  const raw = problem({
    deadline: 2,
    stock: {},
    jobs: [
      {
        id: 1, after: [],
        modes: [
          { id: 1, station: 1, ticks: 1, fee: 0, use: {} },
          { id: 2, station: 2, ticks: 1, fee: 0, use: {} }
        ]
      },
      { id: 2, after: [], modes: [{ id: 1, station: 2, ticks: 1, fee: 0, use: {} }] }
    ]
  });
  const r = Cookfest.solvePlan(raw);
  assert.equal(r.makespan, 1);
  assert.equal(r.cost, 0);
  assert.deepEqual(r.signature, [0, 1, 0, 1]);
});

test('export package reimports and verifies every start', () => {
  const r = Cookfest.solvePlan(sample);
  const pkg = Cookfest.makeExport(Cookfest.normalizeProblem(sample).problem, r);
  const text = JSON.stringify(pkg);
  const parsed = Cookfest.parseImportText(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verification.valid, true);
  assert.equal(parsed.verification.checkedStarts, 2);

  pkg.schedule[1].start = 0; // job 2 starts before dough exists and before predecessor ends
  const tampered = Cookfest.parseImportText(JSON.stringify(pkg));
  assert.equal(tampered.verification.valid, false);
  assert.ok(tampered.verification.errors.join('\n').includes('前置') ||
    tampered.verification.errors.join('\n').includes('配料'));
});

test('rejects inputs beyond documented capacities', () => {
  const raw = structuredClone(sample);
  raw.jobs = Array.from({ length: 17 }, (_, i) => ({ id: i + 1, modes: sample.jobs[0].modes }));
  const n = Cookfest.normalizeProblem(raw);
  assert.equal(n.ok, false);
  assert.match(n.errors.join('\n'), /最多 16/);
});
