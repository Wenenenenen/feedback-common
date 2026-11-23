/* 轻量 DOM 桩冒烟测试：node tools/dom_smoke.js
 * 不依赖 jsdom，实现 app.js 实际用到的 DOM 子集。 */
'use strict';
const fs = require('fs');
const path = require('path');

const allEls = [];   // 全局元素登记，供 data 选择器查询

function makeEl(tag = 'div') {
  const el = {
    tag, children: [], attributes: {}, dataset: {}, style: {}, classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    _html: '', _text: '', hidden: false, disabled: false, value: '',
    _listeners: {},
    set innerHTML(v) {
      this._html = v;
      // 解析出带 data-* / id 的可点元素桩（提取每个标签的全部属性）
      this.children = [];
      const tagRe = /<(button|input|select|label|option|tr|div|span|p|a)([^>]*)>/g;
      let tm;
      while ((tm = tagRe.exec(v))) {
        const attrs = tm[2];
        const child = makeEl(tm[1]);
        let d;
        const dataRe = /data-([\w-]+)="([^"]*)"/g;
        while ((d = dataRe.exec(attrs))) child.dataset[camel(d[1])] = d[2];
        const idM = /\bid="([^"]*)"/.exec(attrs);
        if (idM) child.id = idM[1];
        const clsM = /\bclass="([^"]*)"/.exec(attrs);
        if (clsM) clsM[1].split(/\s+/).filter(Boolean).forEach(c => child.classList.add(c));
        this.children.push(child);
        allEls.push(child);
      }
    },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    setAttribute(k, v) { this.attributes[k] = v; if (k === 'aria-pressed') this._pressed = v; },
    removeAttribute(k) { delete this.attributes[k]; },
    getAttribute(k) { return this.attributes[k]; },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    click() { (this._listeners.click || []).forEach(f => f({ target: this })); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || makeEl(); },
    querySelectorAll(sel) {
      const out = [];
      const stack = [...this.children];
      while (stack.length) {
        const c = stack.shift();
        if (matches(c, sel)) out.push(c);
        for (const k of c.children) stack.push(k);
      }
      return out;
    },
    closest() { return this; },
    appendChild(c) { this.children.push(c); allEls.push(c); return c; },
    insertAdjacentHTML() {}, select() {}, remove() {}
  };
  return el;
}
function camel(s) { return s.replace(/-(\w)/g, (_, c) => c.toUpperCase()); }
function matches(el, sel) {
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('[')) {
    const inner = sel.slice(1, sel.indexOf(']')).replace(/^data-/, '');
    const key = camel(inner);
    return Object.prototype.hasOwnProperty.call(el.dataset, key);
  }
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  return true;
}

const ids = {};
let tabEls = null;
const documentStub = {
  body: makeEl('body'),
  documentElement: makeEl('html'),
  querySelector(sel) {
    const alias = sel.replace(/\s+(tbody|thead)$/, '');
    if (!ids[alias]) ids[alias] = makeEl();
    ids[sel] = ids[alias];   // 复合选择器与基础 id 共享同一稳定实例
    return ids[alias];
  },
  querySelectorAll(sel) {
    if (sel === '.tab') {
      if (!tabEls) tabEls = ['workbench', 'policy', 'editor'].map(t => {
        const e = makeEl(); e.dataset.tab = t; e.setAttribute('aria-selected', t === 'workbench');
        return e;
      });
      return tabEls;
    }
    if (sel.startsWith('[')) {
      const key = camel(sel.slice(1, sel.indexOf(']')).replace(/^data-/, ''));
      return allEls.filter(e => Object.prototype.hasOwnProperty.call(e.dataset, key));
    }
    return ids[sel] || (ids[sel] = [makeEl()]);
  },
  createElement: (t) => makeEl(t)
};
const storage = {};
global.window = {
  SharedSignalSolver: require('../assets/solver.js'),
  localStorage: { getItem: k => storage[k], setItem: (k, v) => { storage[k] = v; } }
};
global.document = documentStub;
Object.defineProperty(global, 'navigator', {
  value: { clipboard: { writeText: async () => {} } }, configurable: true
});
global.Blob = class { constructor(parts) { this.parts = parts; } };
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };

// 载入 app.js
const appSrc = fs.readFileSync(path.join(__dirname, '../assets/app.js'), 'utf8');
new Function('window', 'document', 'navigator', 'Blob', 'URL', appSrc)(
  global.window, global.document, global.navigator, global.Blob, global.URL);
const q = (sel) => documentStub.querySelector(sel);
let pass = 0;
function check(name, cond, extra) {
  if (!cond) { console.error('FAIL:', name, extra || ''); process.exitCode = 1; }
  else { pass++; console.log('ok -', name); }
}

// 启动后工作台渲染了样例结论
check('启动渲染可保证结论', q('#verdict-slot').innerHTML.includes('可保证过关'));
check('显示最坏 2 拍', q('#verdict-slot').innerHTML.includes('最坏 2 拍'));
check('候选状态芯片含 #1 #2', q('#wb-belief').innerHTML.includes('#1') && q('#wb-belief').innerHTML.includes('#2'));
check('动作表渲染三个动作', (q('#wb-actions tbody').innerHTML.match(/act-name/g) || []).length === 3);
check('动作 1 标记为最优选择', q('#wb-actions tbody').innerHTML.includes('最优选择'));

// 选择动作 1 → 观察面板出现两个提示分支
const actionTbody = q('#wb-actions tbody');
const actionRows = actionTbody.querySelectorAll('[data-ai]');
check('动作表渲染行元素', actionRows.length === 3, 'got ' + actionRows.length);
const pickBtn = actionTbody.querySelectorAll('[data-pick]').find(b => b.dataset.pick === '0');
check('存在动作选择按钮', !!pickBtn);
pickBtn.click();
check('选动作后出现观察分支', q('#wb-obs').innerHTML.includes('左灯') && q('#wb-obs').innerHTML.includes('右灯'));

// 点“左灯”分支 → 候选集变成 {3}，剩余 2 拍
const leftBtn = q('#wb-obs').querySelectorAll('[data-branch]').find(b => b.dataset.branch === '左灯');
leftBtn.click();
check('单步后候选集为状态 3', q('#wb-belief').innerHTML.includes('#3'));
check('单步后剩余 2 拍', q('#wb-beat-label').textContent.includes('剩余 2 拍'));check('新节点最优动作是确认左侧(动作2)', q('#wb-actions').innerHTML.includes('确认左侧'));

// 回退
q('#wb-back').click();
check('回退后候选集恢复 {1,2}', q('#wb-belief').innerHTML.includes('#1') && q('#wb-belief').innerHTML.includes('#2'));

// 切到策略页 → 树与重放器
const policyTab = documentStub.querySelectorAll('.tab').find(t => t.dataset.tab === 'policy');
policyTab.click();
check('策略树含动作名', q('#policy-tree').innerHTML.includes('一起试灯'));
check('重放器渲染', q('#replay').innerHTML.includes('本拍动作'));

// 导出 JSON 含可重放树
const S0 = global.window.SharedSignalSolver;
const sampleRaw = JSON.parse(fs.readFileSync(path.join(__dirname, '../samples/shared-signal.json'), 'utf8'));
const exported = S0.exportPolicy(S0.buildModel(sampleRaw).model);
check('导出 solvable=true 且有树', exported.solvable && exported.tree && exported.tree.action === 1);
check('导出树按观察分支', exported.tree.branches.some(b => b.hint === '左灯'));

// 无解模型的反例路径
const S = S0;
const unsolvable = {
  horizon: 1,
  states: [{ id: 1, hint: 'a' }, { id: 2, hint: 'g', goal: true }],
  actions: [{ id: 1, name: 'x' }], initial: [1], transitions: [[1, 1, [1]]]
};
const { model: um } = S.buildModel(unsolvable);
const trace = S.counterTrace(um, um.initialMask, 1, 0);
check('无解反例给出致命提示', trace.ok && trace.steps[0].hint === 'a' && trace.endReason.includes('时限'));

// 视角切换
documentStub.body.dataset.role = 'player';
q('#role-player').click();
check('玩家视角已切换', documentStub.body.dataset.role === 'player');

console.log(`\n${pass} 项 DOM 冒烟检查通过`);
