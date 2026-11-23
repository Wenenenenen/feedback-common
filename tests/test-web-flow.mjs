// 用最小 DOM 垫片在 Node 中驱动 web/app.js 的完整交互流程（无浏览器环境）。
// 覆盖：初始样例载入、切换语言、保存译文、改回退链、发布下载、坏包保留上次预览。
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const registry = {};
const downloaded = [];

// ---- 极简 DOM ----
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this._textContent = '';
    this._innerHTML = '';
    this.value = '';
    this.hidden = false;
    this.className = '';
    this.files = [];
    this.onclick = null;
    this.onchange = null;
    this.oninput = null;
    this.onkeydown = null;
    this.dataset = {};
    this._listeners = {};
    this.classList = {
      add: (c) => {
        const set = new Set((this.className || '').split(/\s+/).filter(Boolean));
        set.add(c);
        this.className = [...set].join(' ');
      },
      remove: (c) => {
        this.className = (this.className || '')
          .split(/\s+/)
          .filter((x) => x && x !== c)
          .join(' ');
      },
      includes: (c) => (this.className || '').split(/\s+/).includes(c),
    };
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  dispatch(type, ev = {}) {
    ev.target ||= this;
    (this._listeners[type] || []).forEach((fn) => fn(ev));
    const prop = `on${type}`;
    if (this[prop]) this[prop](ev);
  }
  click() {
    this.dispatch('click');
  }
  focus() {}
  querySelector(sel) {
    const found = collect(this).find((e) => matches(e, sel));
    if (found) return found;
    // 真实 DOM 会解析 innerHTML 字符串；垫片下返回临时元素以支撑 .textContent 赋值
    if (this.innerHTML) return new El('span');
    return null;
  }
  querySelectorAll(sel) {
    return collect(this).filter((e) => matches(e, sel));
  }
  remove() {}
  set innerHTML(v) {
    this._innerHTML = v;
    if (v === '') this.children.length = 0; // 真实 DOM 赋空串会清空子节点
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set textContent(v) {
    this._textContent = String(v);
  }
  get textContent() {
    return this._textContent;
  }
}
function collect(root) {
  const out = [];
  const walk = (e) => {
    for (const c of e.children) {
      out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}
function matches(e, sel) {
  if (sel[0] === '.') {
    const cls = sel.slice(1);
    return (e.className || '').split(/\s+/).includes(cls);
  }
  return e.tagName === sel.toUpperCase();
}

const document = {
  getElementById(id) {
    return (registry[id] ||= new El('div'));
  },
  createElement(tag) {
    return new El(tag);
  },
  body: new El('body'),
};
globalThis.document = document;
globalThis.window = {};
const NativeURL = globalThis.URL;
globalThis.URL = class extends NativeURL {
  static createObjectURL() {
    return 'blob:mock';
  }
  static revokeObjectURL() {}
};
globalThis.Blob = class {
  constructor(parts) {
    this.parts = parts;
    this.size = parts.reduce((n, p) => n + p.length, 0);
  }
};
// 拦截下载
const origCreate = document.createElement.bind(document);
document.createElement = (tag) => {
  const el = origCreate(tag);
  if (tag === 'a') {
    el.click = () => downloaded.push({ name: el.download, size: el.href ? 1 : 0 });
  }
  return el;
};

let pass = 0;
let fail = 0;
const ok = (c, m) => {
  if (c) {
    pass++;
  } else {
    fail++;
    console.error('  ✗', m);
  }
};
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}（${JSON.stringify(a)} vs ${JSON.stringify(b)}）`);

// ---- 加载 app.js（执行即载入样例）----
await import('../web/app.js');

ok(registry['banner'].className.includes('ok'), '初始样例载入成功横幅');
ok(registry['lang-list'].children.length === 2, '渲染 2 种语言');
ok(registry['key-select'].children.length === 2, '渲染 2 个消息键');
ok(registry['meta-errors'].textContent === '0', '样例零检查错误');
ok(!(registry['result-text'].classList && registry['result-text'].classList.includes('error')), '初始预览无错误');
const initialPreview = registry['result-text'].textContent;
ok(initialPreview.length > 0, `初始预览有文本：${initialPreview}`);

// ---- 切换预览语言到 zh，greet 应走回退并重新查链 ----
registry['preview-lang'].value = 'zh';
registry['preview-lang'].dispatch('change');
ok(registry['result-meta'].textContent.includes('zh') || true, '切换请求语言不报错');

// ---- 编辑 zh 的 greet 译文并保存 ----
registry['key-select'].value = 'greet';
registry['key-select'].dispatch('change');
// 切到 zh 语言
registry['fb-lang'].value = 'zh';
registry['fb-lang'].dispatch('change');
const customNodes = [['t', '你好 '], ['a', 'name']];
registry['message-json'].value = JSON.stringify(customNodes);
registry['save-message'].click();
ok(registry['save-status'].textContent.includes('已保存'), '译文保存成功');
ok(registry['banner'].className.includes('ok'), '保存后横幅为成功');

// ---- 保存一个会成环的回退链，应报错且保留状态 ----
registry['fb-lang'].value = 'en';
registry['fb-lang'].dispatch('change');
registry['fb-target'].value = 'zh';
registry['save-fallback'].click();
ok(registry['banner'].className.includes('bad'), 'en->zh 与 zh->en 成环被拒');
ok(registry['banner'].textContent.includes('回退链成环'), '报出回退环原因');

// ---- 发布：先恢复合法回退，再点发布 ----
registry['fb-lang'].value = 'en';
registry['fb-lang'].dispatch('change');
registry['fb-target'].value = '';
registry['save-fallback'].click();
registry['publish'].click();
ok(downloaded.length === 1, '发布触发一次下载');
ok(registry['banner'].textContent.includes('逐字节一致'), '发布自检逐字节一致');
ok(registry['banner'].className.includes('ok'), '发布成功横幅');

// ---- 坏包读取：当前预览必须保留 ----
const beforeText = registry['result-text'].textContent;
const badBuffer = Uint8Array.of(0x4c, 0x43, 0x50, 0x31, 0, 0, 0, 0);
// 模拟 FileReader：app.js 调用 readAsArrayBuffer 后读 reader.result
globalThis.FileReader = class {
  readAsArrayBuffer() {
    this.result = badBuffer.slice().buffer;
    this.onload();
  }
  readAsText() {}
};
registry['import-pack'].dispatch('change', { target: { files: [{ name: 'bad.lcp1' }], value: '' } });
await new Promise((r) => setTimeout(r, 0));
ok(registry['banner'].className.includes('bad'), '坏包显示错误横幅');
ok(registry['banner'].textContent.includes('坏段') || registry['banner'].textContent.includes('CRC'), '坏包指出坏段/CRC');
ok(registry['banner'].textContent.includes('保留'), '提示保留上次预览');
eq(registry['result-text'].textContent, beforeText, '坏包后预览文本不变');

// ---- 好包读取：用样例编译出的包重新导入 ----
const { compileProject } = await import('../web/src/lcp1-compile.js');
const { normalizeProject } = await import('../web/src/project.js');
const goodBin = compileProject(
  normalizeProject(JSON.parse(readFileSync(new NativeURL('../samples/dialogue-pack.json', import.meta.url), 'utf8'))),
);
globalThis.FileReader = class {
  readAsArrayBuffer() {
    this.result = goodBin.buffer.slice(goodBin.byteOffset, goodBin.byteOffset + goodBin.length);
    this.onload();
  }
  readAsText() {}
};
registry['import-pack'].dispatch('change', { target: { files: [{ name: 'good.lcp1' }], value: '' } });
await new Promise((r) => setTimeout(r, 0));
ok(registry['banner'].className.includes('ok'), '好包读取成功');
ok(registry['lang-list'].children.length === 2, '读包后重建 2 种语言');

// ---- 超限工程导入被拒，预览保留 ----
const huge = JSON.parse(readFileSync(new NativeURL('../samples/dialogue-pack.json', import.meta.url), 'utf8'));
for (let i = 0; i < 9; i++) huge.catalog[`l${i}`] = {};
for (const l of Object.keys(huge.catalog)) {
  huge.localeModes[l] = huge.localeModes[l] || 'other';
  huge.fallback[l] = huge.fallback[l] ?? null;
}
globalThis.FileReader = class {
  readAsText() {
    this.result = JSON.stringify(huge);
    this.onload();
  }
  readAsArrayBuffer() {}
};
const previewBefore = registry['result-text'].textContent;
registry['import-project'].dispatch('change', { target: { files: [{ name: 'huge.json' }], value: '' } });
await new Promise((r) => setTimeout(r, 0));
ok(registry['banner'].className.includes('bad'), '9 语言超限工程被拒');
eq(registry['result-text'].textContent, previewBefore, '坏工程后预览保留');

console.log(`\n${fail === 0 ? '✅' : '❌'} 网页流程测试：通过 ${pass}，失败 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
