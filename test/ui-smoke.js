/* test/ui-smoke.js — 用极简 DOM 桩冒烟测试 app.js 的接线：node test/ui-smoke.js */
'use strict';
require('../sim.js'); // 设置 globalThis.InkSim

const ctxStub = {
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  putImageData() {}, drawImage() {}, clearRect() {}, strokeRect() {},
  imageSmoothingEnabled: false, strokeStyle: '', lineWidth: 1,
};
function makeEl(id) {
  return {
    id, _handlers: {}, textContent: '', innerHTML: '', value: '',
    disabled: false, max: '', dataset: {}, files: [], width: 640, height: 640,
    onclick: null,
    addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
    click() {
      (this._handlers.click || []).forEach(f => f({ target: this }));
      if (this.onclick) this.onclick({ target: this });
    },
    querySelectorAll() { return []; },
    getContext() { return ctxStub; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 640 }; },
    toBlob(fn) { fn(new Blob([])); },
  };
}
const els = new Map();
global.window = globalThis;
global.document = {
  getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
  createElement() { return makeEl('anon-' + Math.random()); },
  addEventListener() {},
};
global.fetch = () => Promise.reject(new Error('no net'));
global.prompt = () => '256,256,256,256';
global.alert = msg => { throw new Error('alert: ' + msg); };
global.FileReader = class {
  readAsText(f) { this.result = f._text; setTimeout(() => this.onload(), 0); }
};
if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:stub';
URL.revokeObjectURL = () => {};

require('../app.js');
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.error('FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

(async () => {
  $('speed').value = '15';
  $('loadSample').click();
  await sleep(20);
  check('载入示例', $('status').textContent.includes('已载入'), $('status').textContent);
  check('默认总步数600', $('totalSteps').value == 600, $('totalSteps').value);

  $('next').click(); await sleep(50);
  $('next').click(); await sleep(50);
  check('单步到帧2', $('frameInput').value == 2, String($('frameInput').value));
  check('总质量守恒显示', $('status').textContent.includes('总质量 36'), $('status').textContent);

  // 画布点选格0
  $('view')._handlers.click.forEach(f => f({ clientX: 3, clientY: 3 }));
  check('选中格0明细', $('cellInfo').innerHTML.includes('格 #0'));
  check('分配表渲染', $('cellInfo').innerHTML.includes('合并分配'));

  // 在指定步加墙 → 撤销 → 重做（示例自带 1 条事件）
  check('示例自带事件1条', $('eventList').innerHTML.includes('共 1 条'), $('eventList').innerHTML.slice(0, 60));
  $('opWall').click(); await sleep(50);
  check('加墙后事件2条', $('eventList').innerHTML.includes('共 2 条'));
  check('撤销按钮可用', !$('undo').disabled);
  $('undo').click(); await sleep(50);
  check('撤销后事件1条', $('eventList').innerHTML.includes('共 1 条'));
  $('redo').click(); await sleep(50);
  check('重做后事件2条', $('eventList').innerHTML.includes('共 2 条'));

  // 设置流向（prompt 桩返回合法值）
  $('opFlow').click(); await sleep(50);
  check('流向事件生效', $('eventList').innerHTML.includes('共 3 条'));

  // 跳帧与校验
  $('frameInput').value = '2';
  $('jump').click(); await sleep(50);
  check('跳帧到2', $('frameInput').value == 2);
  $('verifyBtn').click(); await sleep(100);
  check('帧校验通过', $('status').textContent.includes('校验通过'), $('status').textContent);

  // 播放一瞬后暂停
  $('play').click(); await sleep(150);
  $('play').click();
  check('播放推进了帧', Number($('frameInput').value) >= 2, String($('frameInput').value));

  // 导出不抛异常
  $('exportJson').click();
  $('exportPng').click();
  check('导出无异常', true);

  // 非法文件：指出行号并保留当前结果
  const frameBefore = $('frameInput').value;
  $('file').files = [{ name: 'bad.json', _text: '{"width":3,"height":2,"wrap":[true,false],"events":[{"step":0,"i":99,"wall":true},{"step":0,"i":1,"w":[600,600,0,0]}]}' }];
  $('file')._handlers.change.forEach(f => f({ target: $('file') }));
  await sleep(20);
  check('非法事件报行号', $('errors').textContent.includes('行 1') && $('errors').textContent.includes('行 2'), $('errors').textContent);
  check('非法文件提示保留结果', $('status').textContent.includes('保留当前结果'), $('status').textContent);
  check('当前帧未被破坏', $('frameInput').value === frameBefore, String($('frameInput').value));

  console.log(failures ? '\n共 ' + failures + ' 项失败' : '\nUI 冒烟全部通过');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('冒烟测试异常：', e); process.exit(1); });
