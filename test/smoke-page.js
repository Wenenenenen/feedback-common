'use strict';

/* 最小 DOM 桩冒烟：验证自动载入、求解、全局检查接口和撤销栈初始化。 */

const path = require('path');
const Core = require(path.join(__dirname, '..', 'radiosity-core.js'));

function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    setTransform() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
}

function makeEl(id) {
  return {
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    hidden: false,
    dataset: {},
    children: [],
    style: {},
    addEventListener() {},
    click() {},
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0 }; },
    getContext() { return makeCtx(); },
  };
}

const ids = [
  'versionPill', 'statusPill', 'btnUndo', 'btnExport', 'btnImport', 'btnSample',
  'btnRing', 'fileInput', 'errPanel', 'errTitle', 'errList', 'solveInfo', 'patchInfo',
  'patchCard', 'rawCard', 'corrCard', 'rawEdges', 'corrEdges', 'addTarget', 'addF',
  'btnAddEdge', 'stageHint',
];
const els = {};
for (const id of ids) els[id] = makeEl(id);
els.stage = makeEl('stage');
els.stage.clientWidth = 800;
els.stage.clientHeight = 600;

const aside = makeEl('aside');

global.window = {
  RadiosityCore: Core,
  devicePixelRatio: 1,
  addEventListener() {},
};
global.document = {
  querySelector(selector) {
    if (selector === 'aside') return aside;
    return els[selector.slice(1)] || null;
  },
  createElement: () => makeEl('a'),
  body: { appendChild() {} },
  addEventListener() {},
  documentElement: {},
};
global.getComputedStyle = () => ({ getPropertyValue: () => '#888888' });
global.HTMLInputElement = class HTMLInputElement {};
global.HTMLTextAreaElement = class HTMLTextAreaElement {};
global.HTMLSelectElement = class HTMLSelectElement {};
global.Blob = class Blob {
  constructor(parts) { this.parts = parts; }
};
global.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };
global.fetch = () => Promise.reject(new Error('no fetch in smoke test'));

require(path.join(__dirname, '..', 'app.js'));
const app = window.RadiosityDesk;

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitSolve() {
  for (let k = 0; k < 2000; k++) {
    if (!app.solving && app.solvedVersion === app.version) return;
    await sleep(5);
  }
  throw new Error('求解超时');
}

(async () => {
  await waitSolve();
  check('启动后自动载入内置样例', app.patches.length === 2 && app.links.length === 2);
  check('内置样例已求解', Boolean(app.L) && app.solvedVersion === app.version);
  check('导出按钮已启用', els.btnExport.disabled === false);
  check('导出载荷版本一致且精度达标', (() => {
    const payload = app.buildExportPayload();
    return payload && payload.version === app.version &&
      payload.stats.errorBound <= Core.EXPORT_TOL &&
      payload.patches.every((p) => p.L.every(Number.isFinite));
  })());

  const bad = {
    patches: [
      { area: 1, rho: [.5, .5, .5], E: [0, 0, 0] },
      { area: 1, rho: [.5, .5, .5], E: [0, 0, 0] },
    ],
    links: [[0, 1, .5], [0, 0, .2], [0, 1, .3]],
  };
  const beforeVersion = app.version;
  const beforeL = app.L;
  const imported = app.importData(bad, 'bad');
  check('非法导入返回 false', imported === false);
  check('非法导入版本和结果不变', app.version === beforeVersion && app.L === beforeL);
  check('错误包含第 2、3 行',
    app.errors.some((e) => e.includes('第 2 行')) &&
    app.errors.some((e) => e.includes('第 3 行')));

  check('导入产生撤销快照', app.undoStack.length >= 1);

  console.log(failures === 0 ? '\n冒烟通过' : `\n${failures} 项失败`);
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error('SMOKE ERROR', error);
  process.exit(1);
});
