#!/usr/bin/env node
/*
 * 端到端回归：解压样例，用 search.json 的参数定位，
 * 对照 truth.json 检查位置 / 角度 / 尺度 / 镜像。
 * 运行：node tests/locate.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ML = require('../js/locator.js');

function extract() {
  const out = execFileSync('python3', ['-I', path.join(__dirname, 'samples.py'), path.join(__dirname, '..', 'samples', 'occluded-mark-cases.zip')], { encoding: 'utf8' }).trim();
  return out;
}

function readPgm(p) {
  return ML.parsePGM(fs.readFileSync(p));
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

async function main() {
  const dir = extract();
  let failures = 0;
  try {
    const mark = readPgm(path.join(dir, 'mark.pgm'));
    const scene = readPgm(path.join(dir, 'scene.pgm'));
    const empty = readPgm(path.join(dir, 'empty.pgm'));
    const search = JSON.parse(fs.readFileSync(path.join(dir, 'search.json'), 'utf8'));
    const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));

    const params = {
      anchor: search.anchor,
      minScale: search.minScale,
      maxScale: search.maxScale,
      scaleStep: search.scaleStep,
      angleStep: search.angleStep,
      minCoverage: search.minCoverage,
      edgeThreshold: 'auto',
      mirrorSearch: true,
    };

    const t0 = Date.now();
    const res = await ML.locate(mark, scene, params, { yieldFn: async () => {} });
    const elapsed = Date.now() - t0;
    console.log('统计:', res.stats, 'wall', elapsed, 'ms');
    console.log('结果:');
    for (const p of res.poses) {
      console.log(`  #${p.rank} (${p.x}, ${p.y}) 角度 ${p.angle}° 尺度 ${p.scale} 镜像 ${p.mirror} 覆盖 ${p.coverage} 均距 ${p.meanDistance}`);
    }

    if (res.poses.length !== truth.length) {
      console.error(`✗ 数量不符：期望 ${truth.length}，实际 ${res.poses.length}`);
      failures++;
    }

    for (const [tx, ty, ta, ts, tm] of truth) {
      let best = null, bestD = Infinity;
      for (const p of res.poses) {
        const d = Math.hypot(p.x - tx, p.y - ty);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (!best || bestD > 3) {
        console.error(`✗ 真值 (${tx}, ${ty}) 未匹配到 3px 内：最近 ${best ? bestD.toFixed(2) : '无'}`);
        failures++;
        continue;
      }
      const da = angleDiff(best.angle, ta);
      const ds = Math.abs(best.scale - ts);
      const ok = da <= 8 && ds <= 0.12 && best.mirror === tm;
      console.log(`${ok ? '✓' : '✗'} 真值 (${tx}, ${ty}, ${ta}°, ${ts}, 镜像=${tm}) → 距离 ${bestD.toFixed(2)}px 角度差 ${da.toFixed(2)}° 尺度差 ${ds.toFixed(3)} 镜像 ${best.mirror}`);
      if (!ok) failures++;
    }

    const resEmpty = await ML.locate(mark, empty, params, { yieldFn: async () => {} });
    if (resEmpty.poses.length !== 0) {
      console.error(`✗ 空场景不应有结果，实际 ${resEmpty.poses.length} 个`);
      failures++;
    } else {
      console.log('✓ 空场景无结果');
    }

    // 关掉镜像搜索后，镜像目标不应以镜像姿态出现
    const resNoMirror = await ML.locate(mark, scene, Object.assign({}, params, { mirrorSearch: false }), { yieldFn: async () => {} });
    if (resNoMirror.poses.some(p => p.mirror)) {
      console.error('✗ 关闭镜像搜索后仍出现镜像结果');
      failures++;
    } else {
      console.log('✓ 关闭镜像搜索时无镜像结果');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures) {
    console.error(`\n${failures} 项失败`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch(e => { console.error(e); process.exit(1); });
