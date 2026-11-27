import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { acceptanceCase } from './case.mjs';

const require = createRequire(import.meta.url);
const PM = require('../src/core.js');

const pf = (e) => e.path + '：' + e.message;

function check(over, expectPath) {
  const v = PM.validateProject(acceptanceCase(over));
  assert.equal(v.ok, false, `expected failure for ${expectPath}`);
  assert.ok(v.errors.some((e) => e.path === expectPath || e.path.startsWith(expectPath)),
    `expected path ${expectPath}, got ${v.errors.map(pf).join(' | ')}`);
}

test('size / dtype / range violations name the exact field', () => {
  check({ W: 3 }, 'W');
  check({ H: 512 }, 'H');
  check({ W: 12 }, 'W');
  check({ dx: 0.05 }, 'dx');
  check({ dy: 150 }, 'dy');
  check({ waves: [] }, 'waves');
  check({ waves: [{ lambda: 0.5, cycles: 1 }, { lambda: 0.5, cycles: 1 }, { lambda: 0.5, cycles: 1 }] }, 'waves');
  check({ waves: [{ lambda: 0.05, cycles: 1 }, { lambda: 0.5, cycles: 1 }] }, 'waves[0].lambda');
  check({ waves: [{ lambda: 0.5, cycles: 0 }, { lambda: 0.5, cycles: 1 }] }, 'waves[0].cycles');
  check({ waves: [{ lambda: 0.5, cycles: 4.5 }, { lambda: 0.5, cycles: 1 }] }, 'waves[0].cycles');
  check({ amp: [0, 1, 2] }, 'amp');
  check({ p0: acceptanceCase().p0.map((v, i) => (i === 5 ? 1.5 : v)) }, 'p0[5]');
  check({ amp: acceptanceCase().amp.map((v, i) => (i === 3 ? NaN : v)) }, 'amp[3]');
  check({ locks: [[7, 1, 256]] }, 'locks[0][2]');
  check({ locks: [[7, 1, 1.5]] }, 'locks[0][2]');
  check({ locks: [[7, 1, 3], [7, 1, 4]] }, 'locks[1]');
  check({ locks: [[8, 1, 3]] }, 'locks[0][0]');
  check({ planes: [] }, 'planes');
  check({ planes: Array.from({ length: 7 }, () => acceptanceCase().planes[0]) }, 'planes');
  check({ planes: [{ ...acceptanceCase().planes[0], wave: 2 }, acceptanceCase().planes[1], acceptanceCase().planes[2]] }, 'planes[0].wave');
  check({ planes: [{ ...acceptanceCase().planes[0], z: -1 }, acceptanceCase().planes[1], acceptanceCase().planes[2]] }, 'planes[0].z');
  check({ planes: [{ ...acceptanceCase().planes[0], z: 10001 }, acceptanceCase().planes[1], acceptanceCase().planes[2]] }, 'planes[0].z');
  const p0 = acceptanceCase().planes[0];
  check({ planes: [{ ...p0, target: p0.target.map((v, i) => (i === 0 ? 17 : v)) }, acceptanceCase().planes[1], acceptanceCase().planes[2]] }, 'planes[0].target[0]');
  check({ planes: [{ ...p0, weight: p0.weight.map((v, i) => (i === 2 ? 2 : v)) }, acceptanceCase().planes[1], acceptanceCase().planes[2]] }, 'planes[0].weight[2]');
  check({ eta: 0 }, 'eta');
  check({ eta: 1.5 }, 'eta');
  check({ steps: 0 }, 'steps');
  check({ steps: 121 }, 'steps');
  check({ steps: 2.5 }, 'steps');
  check({ spec: 5 }, 'spec');
  check({ amp: 'nope' }, 'amp');
});

test('structurally invalid roots are rejected, not thrown', () => {
  for (const root of [null, [], 42, 'x', undefined]) {
    const v = PM.validateProject(root);
    assert.equal(v.ok, false);
    assert.equal(v.errors[0].path, '(root)');
  }
});

test('all-zero weights and 1x plane are legal', () => {
  const proj = acceptanceCase();
  proj.planes.forEach((p) => p.weight.fill(0));
  proj.planes = [proj.planes[0]];
  const v = PM.validateProject(proj);
  assert.equal(v.ok, true);
  const r = PM.createProject(proj);
  assert.ok(r.ok);
  const s = PM.createSession(r.engine); s.init();
  assert.equal(s.loss, 0);
  const out = s.step();
  assert.equal(out.stepSize, 0);
  assert.equal(out.round, 1);
});

test('validation keeps the previous valid project (no partial state)', () => {
  // 载入一个有效项目，再喂一个坏项目：坏项目必须原样返回错误，不改动任何已建引擎
  const good = PM.createProject(acceptanceCase());
  assert.ok(good.ok);
  const bad = PM.createProject(acceptanceCase({ W: 6 }));
  assert.equal(bad.ok, false);
  assert.ok(Array.isArray(bad.errors) && bad.errors.length > 0);
  assert.equal(good.engine.W, 8, 'previous engine untouched');
});
