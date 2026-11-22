/*
 * test/exporter.test.mjs — 导出内容的结构与正确性（node test/exporter.test.mjs）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { solveSequence, diagnoseFrame } from '../js/solver.js';
import { buildFrameSVG, buildPlacementJSON } from '../js/exporter.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(readFileSync(join(here, '..', 'samples', 'depth-label-cases.json'), 'utf8'));
const seq = solveSequence(sample);

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log('  ✓', name);
};

test('SVG 是合法 XML 骨架且尺寸等于 画布×缩放', () => {
  const svg = buildFrameSVG(sample, seq[0], {
    scale: 8,
    showHidden: true,
    conflicts: diagnoseFrame(seq[0].ctx),
  });
  assert.ok(svg.startsWith('<svg xmlns='));
  assert.ok(svg.includes('width="256" height="128"'));
  assert.ok(svg.endsWith('</svg>'));
  // 显示的标签 A、B 各有一个框（rect 元素中出现两次标签色描边）
  assert.equal((svg.match(/stroke="#38bdf8"/g) || []).length, 2);
  // C 被深度遮挡 → 隐藏锚点红点
  assert.ok(svg.includes('fill="#ef4444"'));
});

test('SVG 对文本做 XML 转义', () => {
  const evil = structuredClone(sample);
  evil.labels[0].text = '<x>&"\'';
  const s = solveSequence(evil);
  const svg = buildFrameSVG(evil, s[0], {});
  assert.ok(svg.includes('&lt;x&gt;&amp;&quot;&#39;'));
});

test('关闭深度/隐藏项时 SVG 不含对应图元', () => {
  const svg = buildFrameSVG(sample, seq[0], { showDepth: false, showHidden: false });
  assert.ok(!svg.includes('fill="#ef4444"'));
});

test('落位 JSON 覆盖全部帧且与求解结果一致', () => {
  const json = JSON.parse(buildPlacementJSON(sample, seq, {}));
  assert.equal(json.frames.length, 3);
  assert.deepEqual(
    json.frames.map((f) => f.labels.map((l) => (l.visible ? l.choice : -1))),
    seq.map((r) => r.assign)
  );
  const f0 = json.frames[0];
  const c = f0.labels.find((l) => l.id === 'C');
  assert.equal(c.visible, false);
  assert.equal(c.reason, 'depth');
  const a = f0.labels.find((l) => l.id === 'A');
  assert.equal(a.visible, true);
  assert.equal(a.choice, 1);
  assert.ok(a.rect.w === 4 && a.rect.h === 2);
  assert.ok(a.anchor.x === 16 && a.anchor.y === 8);
});

test('JSON 中求解隐藏与锚点隐藏原因可区分', () => {
  // 构造两个同位置冲突标签，必有一个被求解隐藏
  const data = structuredClone(sample);
  data.labels = [
    { id: 'X', text: 'X', position: [0, 0, 2], weight: 9, size: [4, 2], choices: [[0, -1, 0]] },
    { id: 'Y', text: 'Y', position: [0, 0, 2], weight: 1, size: [4, 2], choices: [[0, -1, 0]] },
  ];
  const s = solveSequence(data);
  const json = JSON.parse(buildPlacementJSON(data, s, {}));
  const y = json.frames[0].labels.find((l) => l.id === 'Y');
  assert.equal(y.visible, false);
  assert.equal(y.reason, 'suppressed-by-solver');
});

console.log(`\n全部 ${passed} 项导出测试通过`);
