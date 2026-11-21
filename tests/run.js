#!/usr/bin/env node
/* Run every codec test: cross-check, corruption, sample assertions. */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const tests = ['crosscheck.js', 'corruption.js', 'samples.js'];
let failed = 0;
for (const t of tests) {
  console.log('\n=== ' + t + ' ===');
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} test file(s) FAILED` : '\nall tests passed');
process.exit(failed ? 1 : 0);
