'use strict';
/* 无浏览器环境下的 app.js 冒烟测试：用最小 DOM 桩驱动核心交互路径 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ---- 最小 DOM 桩 ----
const elements = new Map();
function makeEl(tag) {
  const el = {
    tagName: tag, children: [], style: {}, dataset: {}, attributes: {},
    _listeners: {}, value: '', textContent: '', innerHTML: '', hidden: false,
    className: '', width: 600, height: 180, files: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    prepend(c) { this.children.unshift(c); },
    querySelector(sel) {
      const key = sel.replace(/[\[\]"'.#]/g, '');
      return this.children.find((c) => c._sel === key) || makeEl('div');
    },
    querySelectorAll() { return this.children.filter((c) => c._vvoice !== undefined); },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    dispatch(ev, payload) { (this._listeners[ev] || []).forEach((fn) => fn(payload || { preventDefault() {}, target: this })); },
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    scrollIntoView() {}, remove() {}, click() {},
    getContext() {
      return { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {}, set strokeStyle(_) {}, set lineWidth(_) {}, fillStyle: '' };
    },
  };
  return el;
}
const ids = [
  'statusPill', 'alertHost', 'dropzone', 'fileInput', 'themeBtn', 'stChannels', 'stBpm', 'stSpeed', 'stOrder',
  'patternSelect', 'rowSelect', 'undoBtn', 'rowPath', 'edBpm', 'edSpeed', 'edBackTo', 'edBackN', 'edBreak',
  'voiceEditor', 'addVoiceBtn', 'applyBtn', 'resetRowBtn', 'tickJump', 'tickGoBtn', 'prevTickBtn', 'nextTickBtn',
  'tkAbs', 'tkLoc', 'tkRowTick', 'tkFrames', 'tkBpm', 'tkJump', 'eventList', 'tickTable',
  'waveCanvas', 'rangeStart', 'rangeEnd', 'playRangeBtn', 'playFullBtn', 'stopBtn', 'rangeInfo',
  'exportWavBtn', 'exportFullWavBtn', 'exportLogBtn', 'exportFullLogBtn', 'sampleTable',
];
for (const id of ids) elements.set(id, makeEl('div'));
const tableBodies = ['tickTable', 'sampleTable'];
for (const id of tableBodies) elements.get(id).querySelector = () => makeEl('tbody');

global.document = {
  getElementById: (id) => elements.get(id) || makeEl('div'),
  createElement: (tag) => makeEl(tag),
  documentElement: makeEl('html'),
  body: makeEl('body'),
  addEventListener() {},
};
global.getComputedStyle = () => ({ getPropertyValue: () => '#4fd6c8' });
global.window = global;
global.localStorage = { getItem: () => null, setItem() {}, };
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
// 保留 Node 原生 Blob（含 .stream()，供 DecompressionStream 解压）
if (typeof globalThis.Blob === 'undefined') globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;
global.AudioContext = class {
  constructor() { this.state = 'running'; this.destination = {}; }
  resume() {} createBuffer(ch, n) { return { getChannelData: () => new Float32Array(n) }; }
  createBufferSource() { return { connect() {}, start() {}, stop() {} }; }
};

// 载入引擎与 IO：Node 下走 module.exports，同时模拟浏览器全局挂载
const E = require('../src/engine.js');
const IO = require('../src/io.js');
globalThis.TrackerEngine = E;
globalThis.TrackerIO = IO;
assert.ok(E, 'TrackerEngine 挂载失败');

// 执行 app.js
const appCode = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
new Function(appCode)();

const el = (id) => elements.get(id);
(async () => {
  // 启动后应已渲染内置示例（启动文案会覆盖 pill，但检视面板应已填充）
  assert.ok(el('statusPill').textContent.includes('示例'), '启动未就绪: ' + el('statusPill').textContent);
  assert.strictEqual(Number(el('tkAbs').textContent), 0);
  assert.ok(/花样/.test(el('tkLoc').textContent), '检视面板未填充');

  // 逐 tick 前进
  el('nextTickBtn').dispatch('click');
  assert.strictEqual(Number(el('tkAbs').textContent), 1);
  el('prevTickBtn').dispatch('click');
  assert.strictEqual(Number(el('tkAbs').textContent), 0);

  // 编辑：把第 0 行 bpm 改成 200 并应用
  el('edBpm').value = '200';
  el('applyBtn').dispatch('click');
  assert.ok(el('undoBtn').disabled === false, '撤销栈应非空');
  assert.ok(/200/.test(el('tkBpm').textContent), 'bpm 未生效: ' + el('tkBpm').textContent);

  // 撤销
  el('undoBtn').dispatch('click');
  assert.ok(!/200/.test(el('tkBpm').textContent), '撤销后 bpm 应还原');

  // 非法编辑：bpm 越界，应拒绝且保留已生成版本
  const before = el('statusPill').textContent;
  el('edBpm').value = '9999';
  el('applyBtn').dispatch('click');
  const alertHtml = el('alertHost').children.map((c) => c.innerHTML).join(' ');
  assert.ok(/非法|bpm/.test(alertHtml), '非法编辑未提示: ' + alertHtml);
  assert.strictEqual(el('statusPill').textContent, before, '非法编辑后已生成版本应保留');

  // 区间
  el('rangeStart').value = '10';
  el('rangeEnd').value = '20';
  el('rangeStart').dispatch('input');
  assert.ok(/\[10,20\)/.test(el('rangeInfo').textContent), el('rangeInfo').textContent);

  // 试听不抛错
  el('playRangeBtn').dispatch('click');
  el('playFullBtn').dispatch('click');
  el('stopBtn').dispatch('click');

  // 导出不抛错
  el('exportWavBtn').dispatch('click');
  el('exportFullWavBtn').dispatch('click');
  el('exportLogBtn').dispatch('click');
  el('exportFullLogBtn').dispatch('click');

  // 载入真实 zip
  const zipBytes = fs.readFileSync(path.join(__dirname, '../samples/tracker-ticks.zip'));
  const file = { name: 'tracker-ticks.zip', arrayBuffer: async () => zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.length) };
  el('fileInput').files = [file];
  el('fileInput').dispatch('change');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(/tracker-ticks/.test(el('statusPill').textContent), 'zip 载入失败: ' + el('statusPill').textContent);

  console.log('app.js 冒烟测试全部通过');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
