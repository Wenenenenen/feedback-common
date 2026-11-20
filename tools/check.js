#!/usr/bin/env node
/* Run the extractor over a sample directory and compare against expected.json. */
'use strict';

const fs = require('fs');
const path = require('path');
const BHE = require(path.join(__dirname, '..', 'src', 'core.js'));

const dir = process.argv[2] || path.join(__dirname, '..', 'samples');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'expected.json');

let expected = null;
const ep = path.join(dir, 'expected.json');
if (fs.existsSync(ep)) expected = JSON.parse(fs.readFileSync(ep, 'utf8'));

let failures = 0;

function approx(a, b, tol) {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}

for (const f of files) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const name = f.replace(/\.json$/, '');
  const val = BHE.validateInput(raw);
  if (!val.ok) {
    console.log(name.padEnd(24), 'INVALID', val.errors.map((e) => e.code + '@' + e.field).join(', '));
    continue;
  }
  const model = BHE.extract(val.data, BHE.DEFAULT_LAMBDA);
  const c = BHE.expectedCounts(model);
  let line = name.padEnd(24) + JSON.stringify(c);
  const exp = expected && expected[name];
  if (exp) {
    const keys = ['vertices', 'triangles', 'boundary_crossings', 'boundary_edges', 'nonmanifold_edges'];
    const bad = keys.filter((k) => exp[k] != null && exp[k] !== c[k]);
    if (bad.length) {
      failures++;
      line += '  MISMATCH ' + bad.map((k) => k + ' exp=' + exp[k] + ' got=' + c[k]).join(' ');
    } else {
      line += '  ok';
    }
    if (exp.cell) {
      const v = model.vertices[0];
      const same = v.cell.every((x, i) => x === exp.cell[i]);
      let posOk = true;
      if (exp.position) posOk = v.position.every((x, i) => approx(x, exp.position[i], 1e-9));
      let objOk = true;
      if (exp.objective != null) objOk = approx(v.objective, exp.objective, 1e-9);
      let actOk = true;
      if (exp.active_axes) actOk = v.activeAxes.every((x, i) => x === exp.active_axes[i]);
      if (!same || !posOk || !objOk || !actOk) {
        failures++;
        line += '  SENTINEL-FAIL' + (same ? '' : ' cell') + (posOk ? '' : ' pos') + (objOk ? '' : ' obj') + (actOk ? '' : ' active');
      } else {
        line += '  sentinel ok';
      }
    }
    if (exp.naive_clamp_objective != null) {
      // Show that a naive clamp is measurably worse.
      const v = model.vertices[0];
      line += ' (naive-clamp obj ' + exp.naive_clamp_objective.toFixed(6) + ' vs ' + v.objective.toFixed(6) + ')';
    }
    if (exp.position && !exp.cell) {
      const v = model.vertices[0];
      const posOk = v.position.every((x, i) => approx(x, exp.position[i], 1e-9));
      const objOk = exp.objective == null || approx(v.objective, exp.objective, 1e-9);
      if (!posOk || !objOk) {
        failures++;
        line += '  SENTINEL-FAIL pos=' + JSON.stringify(v.position);
      } else line += '  sentinel ok';
    }
  }
  console.log(line);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
