'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../synth-core.js');

test('quota project: 128 tracks, 60000 anchors, 30 s renders inside 18 s', { timeout: 40000 }, () => {
  const project = Core.generateQuotaProject();
  assert.equal(project.tracks.length, 128);
  assert.equal(project.tracks.reduce((n, t) => n + t.anchors.length, 0), 60000);

  const compileStart = performance.now();
  const compiled = Core.compileProject(project);
  const compileMs = performance.now() - compileStart;
  assert.equal(compiled.duration, Core.MAX_FRAMES);

  const renderStart = performance.now();
  const pcm = Core.renderPcm16(compiled);
  const renderMs = performance.now() - renderStart;
  const wav = Core.encodeWav(pcm);

  assert.equal(pcm.length, Core.MAX_FRAMES * 2);
  assert.equal(wav.length, 44 + Core.MAX_FRAMES * 4);
  assert.ok(renderMs < 18000, `Node render ${renderMs.toFixed(0)}ms exceeds 18000ms`);
  console.log(`quota compile=${compileMs.toFixed(0)}ms render=${renderMs.toFixed(0)}ms`);
});
