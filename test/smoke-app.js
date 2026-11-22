/*
 * test/smoke-app.js — 用最小 DOM 桩在 Node 中跑一遍 app.js 的主要路径
 * (加载场景 -> recompute -> 各视图 draw -> 点击像素 -> 检查器 -> 导出),
 * 捕获引用错误/类型错误。不验证像素内容(那由 test/validate.js 保证)。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------- 最小 DOM 桩 ----------
const ctx2d = new Proxy({}, {
  get: (t, k) => (k === 'canvas' ? {} : () => {}),
  set: () => true,
});
function makeCanvas() {
  return {
    width: 0, height: 0, style: {},
    getContext: () => ctx2d,
    toBlob: cb => cb(new Blob(['x'])),
    addEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
}
const elements = {};
function el(id) {
  if (!elements[id]) {
    elements[id] = Object.assign(id === 'view' ? makeCanvas() : {}, {
      id, value: '0', textContent: '', innerHTML: '', className: '',
      style: {}, checked: false, files: [],
      addEventListener: (ev, fn) => { (elements[id]._ev ||= {})[ev] = fn; },
      click: () => {},
    });
  }
  return elements[id];
}
const radio = { value: 'shaded', addEventListener: () => {} };
const sandbox = {
  console,
  document: {
    getElementById: el,
    querySelectorAll: sel => (sel.includes('view') ? [radio] : []),
    querySelector: () => radio,
    createElement: tag => (tag === 'canvas' ? makeCanvas() : { click: () => {}, style: {} }),
  },
  ImageData: class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } },
  Blob: class { constructor(parts) { this.parts = parts; } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  fetch: () => Promise.reject(new Error('no fetch')), // 走内置兜底场景
  FileReader: class {},
  alert: () => {},
  setTimeout: (fn) => fn(),
  module: undefined,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const Z = require(path.join(__dirname, '..', 'zfail-core.js'));
sandbox.ZFail = Z;

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
vm.runInContext(appSrc, sandbox, { filename: 'app.js' });

(async () => {
// fetch 拒绝 -> catch -> setScene(EMBEDDED) 走微任务,先让出事件循环
await new Promise(r => setImmediate(r));
const st = vm.runInContext('state', sandbox);
if (!st.result) throw new Error('recompute 未执行');
console.log(`recompute OK: ${st.result.W}x${st.result.H}, 体积三角形 ${st.result.vols.length}, 不一致 ${st.mismatches.length}`);
if (st.mismatches.length !== 0) throw new Error('内置场景应无不一致像素');

// 切换四种视图 + 叠加线框
vm.runInContext(`
  document.querySelectorAll('input[name=view]')[0].value = 'depth';
  state.zoom = 4;
`, sandbox);
for (const mode of ['shaded', 'depth', 'stencil', 'diff', 'wire']) {
  vm.runInContext(`
    document.querySelector = () => ({ value: '${mode}' });
    document.getElementById('overlayWire').checked = true;
    draw();
  `, sandbox);
}
console.log('draw OK: 5 种视图 + 叠加线框');

// 点击像素 -> 检查器
vm.runInContext(`
  state.sel = { x: 24, y: 24 };
  draw();
  updateInspector();
`, sandbox);
const insp = elements['iContribs'].innerHTML;
if (!insp.includes('table')) throw new Error('检查器未生成贡献表');
console.log('inspector OK: 像素 (24,24) 贡献表已生成');

// 点击无接收面区域(默认场景全屏接收,改用角外点击模拟越界由点击处理器兜底)
vm.runInContext(`state.sel = { x: 0, y: 0 }; updateInspector();`, sandbox);
console.log('inspector OK: 角像素');

// 导出路径
vm.runInContext(`exportStencilCSV(); exportPNG('diff','d.png'); exportPNG('stencil','s.png');`, sandbox);
console.log('export OK');

// 不一致跳转(无不一致时应为 no-op)
vm.runInContext(`document.getElementById('jumpBad')._ev.click();`, sandbox);
console.log('jumpBad OK');

console.log('\nsmoke 全部通过');
})().catch(e => { console.error(e); process.exit(1); });
