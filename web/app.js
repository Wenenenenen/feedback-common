// LCP1 工作台前端逻辑。全部能力来自 ../src 自研模块，无第三方依赖。
import { normalizeProject, checkProject, validateProject, utf8SortedKeys } from './src/project.js';
import { expandMessage } from './src/resolver.js';
import { compileProject } from './src/lcp1-compile.js';
import { readPack } from './src/lcp1-read.js';
import { LcpError } from './src/errors.js';

const SAMPLE = {
  signatures: { count: { n: 'i' }, greet: { n: 'i', name: 's' } },
  localeModes: { en: 'one', zh: 'other' },
  fallback: { en: null, zh: 'en' },
  catalog: {
    en: {
      count: [['p', 'n', { one: [['t', 'one lamp']], other: [['a', 'n'], ['t', ' lamps']] }]],
      greet: [['t', 'Found '], ['r', 'count', { n: 'n' }], ['t', ' for '], ['a', 'name']],
    },
    zh: { count: [['a', 'n'], ['t', '盏灯']] },
  },
};

const state = {
  raw: null,            // 可编辑的工程 JSON 外形（catalog 里是节点数组）
  project: null,        // normalizeProject 的结果
  errors: [],
  activeLang: null,
  activeKey: null,
  previewLang: null,
  previewKey: null,
  lastGoodPack: null,   // 最近一次成功发布/读取的包（坏包时保留它的预览）
  lastGoodProject: null,
};

const $ = (id) => document.getElementById(id);
const banner = $('banner');

function showBanner(kind, text) {
  banner.className = `banner ${kind}`;
  banner.textContent = text;
  banner.hidden = false;
}
function clearBanner() {
  banner.hidden = true;
  banner.textContent = '';
}

// ---------- 工程装载 ----------
function loadRaw(raw, sourceLabel) {
  try {
    const { project, errors } = validateProject(raw);
    state.raw = raw;
    state.project = project;
    state.errors = errors;
    state.activeLang = project.languages[0];
    const keys = utf8SortedKeys(project.signatures);
    state.activeKey = keys[0];
    state.previewLang = state.activeLang;
    state.previewKey = state.activeKey;
    state.lastGoodProject = project;
    clearBanner();
    renderAll();
    showBanner('ok', `已载入${sourceLabel}：${project.languages.length} 种语言，检查发现 ${errors.length} 个问题`);
  } catch (e) {
    showBanner('bad', `工程无法载入（${e.segment ?? '结构'}）：${e.message}\n上次预览保留不变。`);
  }
}

function readFileAs(file, kind) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    if (kind === 'json') reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

$('import-project').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const text = await readFileAs(file, 'json');
    const raw = JSON.parse(text);
    loadRaw(raw, `工程 ${file.name}`);
  } catch (e) {
    showBanner('bad', `JSON 解析失败：${e.message}\n上次预览保留不变。`);
  } finally {
    ev.target.value = '';
  }
});

$('import-pack').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const buf = new Uint8Array(await readFileAs(file, 'pack'));
    const project = readPack(buf); // 坏包会抛带坏段的 LcpError
    // 读包成功：用重建出的工程作为新的可编辑工程
    const raw = {
      signatures: project.signatures,
      localeModes: project.localeModes,
      fallback: project.fallback,
      catalog: project.catalog,
    };
    state.raw = raw;
    state.project = project;
    state.errors = checkProject(project);
    state.activeLang = project.languages[0];
    state.activeKey = utf8SortedKeys(project.signatures)[0];
    state.previewLang = state.activeLang;
    state.previewKey = state.activeKey;
    state.lastGoodPack = buf;
    state.lastGoodProject = project;
    renderAll();
    showBanner('ok', `读包成功 ${file.name}：${buf.length} 字节，重建工程与发布检查一致（${state.errors.length} 个问题）`);
  } catch (e) {
    const seg = e instanceof LcpError && e.segment ? e.segment : '未知段';
    showBanner('bad', `坏包，坏段：${seg}\n${e.message}\n已保留上次预览，不替换当前工程。`);
  } finally {
    ev.target.value = '';
  }
});

// ---------- 渲染 ----------
function renderAll() {
  renderLangList();
  renderMeta();
  renderKeySelect();
  renderEditor();
  renderFallbackEditor();
  renderPreviewControls();
  renderParamsForm();
  runPreview();
  renderCheckList();
}

function renderLangList() {
  const ul = $('lang-list');
  ul.innerHTML = '';
  for (const lang of state.project.languages) {
    const li = document.createElement('li');
    li.className = 'lang-item' + (lang === state.activeLang ? ' active' : '');
    const chain = [];
    let cur = state.project.fallback[lang];
    let guard = 0;
    while (cur !== null && guard++ < 16) {
      chain.push(cur);
      cur = state.project.fallback[cur];
    }
    li.innerHTML = `
      <span class="code"></span>
      <span class="chain"></span>
      <span class="mode"></span>`;
    li.querySelector('.code').textContent = lang;
    li.querySelector('.chain').textContent = chain.length ? `→ ${chain.join(' → ')}` : '链尾';
    li.querySelector('.mode').textContent = state.project.localeModes[lang];
    li.addEventListener('click', () => {
      state.activeLang = lang;
      state.previewLang = lang;
      renderAll();
    });
    ul.appendChild(li);
  }
}

function renderMeta() {
  const total = state.project.languages.reduce(
    (n, l) => n + Object.keys(state.project.catalog[l]).length,
    0,
  );
  $('meta-langs').textContent = state.project.languages.length;
  $('meta-messages').textContent = total;
  $('meta-errors').textContent = state.errors.length;
}

function renderKeySelect() {
  const keys = utf8SortedKeys(state.project.signatures);
  if (!keys.includes(state.activeKey)) state.activeKey = keys[0];
  const sel = $('key-select');
  sel.innerHTML = '';
  for (const k of keys) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    sel.appendChild(opt);
  }
  sel.value = state.activeKey;
  sel.onchange = () => {
    state.activeKey = sel.value;
    state.previewKey = sel.value;
    renderEditor();
    renderPreviewControls();
    renderParamsForm();
    runPreview();
  };
  $('delete-key').onclick = () => {
    if (state.activeLang && state.activeKey in state.raw.catalog[state.activeLang]) {
      delete state.raw.catalog[state.activeLang][state.activeKey];
      revalidate();
    }
  };
}

function renderEditor() {
  const sig = state.project.signatures[state.activeKey] || {};
  const sigText = Object.entries(sig)
    .map(([p, t]) => `${p}: ${t === 'i' ? 'int32' : 'string'}`)
    .join('  ·  ');
  $('sig-line').textContent = `签名 ${state.activeKey}（${sigText || '无参数'}）`;
  const nodes = state.raw.catalog[state.activeLang]?.[state.activeKey];
  $('message-json').value = nodes ? JSON.stringify(nodes, null, 2) : '';
  $('save-status').textContent = '';
}

$('save-message').addEventListener('click', () => {
  const text = $('message-json').value.trim();
  if (!text) {
    showBanner('warn', '译文为空：若要删除该语言下的这条消息，请用“删除该语言译文”。');
    return;
  }
  let nodes;
  try {
    nodes = JSON.parse(text);
  } catch (e) {
    showBanner('bad', `节点 JSON 语法错误：${e.message}`);
    return;
  }
  state.raw.catalog[state.activeLang] ??= {};
  state.raw.catalog[state.activeLang][state.activeKey] = nodes;
  try {
    revalidate();
    $('save-status').textContent = '已保存并通过解析';
  } catch (e) {
    showBanner('bad', `保存失败（${e.segment ?? '消息'}）：${e.message}`);
  }
});

function renderFallbackEditor() {
  const langSel = $('fb-lang');
  langSel.innerHTML = '';
  for (const l of state.project.languages) {
    const o = document.createElement('option');
    o.value = l;
    o.textContent = l;
    langSel.appendChild(o);
  }
  langSel.value = state.activeLang;
  langSel.onchange = () => {
    state.activeLang = langSel.value;
    renderFallbackEditor();
    renderEditor();
    renderLangList();
  };

  const target = $('fb-target');
  target.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '（链尾 null）';
  target.appendChild(none);
  for (const l of state.project.languages) {
    if (l === state.activeLang) continue;
    const o = document.createElement('option');
    o.value = l;
    o.textContent = l;
    target.appendChild(o);
  }
  const cur = state.raw.fallback[state.activeLang];
  target.value = cur ?? '';

  $('save-fallback').onclick = () => {
    state.raw.fallback[state.activeLang] = target.value === '' ? null : target.value;
    try {
      revalidate();
      showBanner('ok', `回退链已保存：${state.activeLang} → ${target.value || 'null'}`);
    } catch (e) {
      showBanner('bad', `回退链保存失败（${e.segment ?? 'fallback'}）：${e.message}`);
    }
  };
}

$('add-lang').addEventListener('click', () => {
  $('add-lang-row').hidden = false;
  $('new-lang-code').value = '';
  $('new-lang-code').focus();
});
$('cancel-add-lang').addEventListener('click', () => {
  $('add-lang-row').hidden = true;
});
$('confirm-add-lang').addEventListener('click', () => {
  const code = $('new-lang-code').value.trim();
  if (!code) {
    showBanner('warn', '语言代码不能为空');
    return;
  }
  if (code in state.raw.catalog) {
    showBanner('warn', `语言 ${code} 已存在`);
    return;
  }
  state.raw.catalog[code] = {};
  state.raw.localeModes[code] = $('new-lang-mode').value;
  state.raw.fallback[code] = state.project.languages[state.project.languages.length - 1] ?? null;
  try {
    revalidate();
    state.activeLang = code;
    state.previewLang = code;
    $('add-lang-row').hidden = true;
    renderAll();
  } catch (e) {
    showBanner('bad', `添加语言失败：${e.message}`);
  }
});
$('new-lang-code').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') $('confirm-add-lang').click();
});

// ---------- 预览 ----------
function renderPreviewControls() {
  const langSel = $('preview-lang');
  const keySel = $('preview-key');
  langSel.innerHTML = '';
  for (const l of state.project.languages) {
    const o = document.createElement('option');
    o.value = l;
    o.textContent = l;
    langSel.appendChild(o);
  }
  langSel.value = state.previewLang;
  langSel.onchange = () => {
    state.previewLang = langSel.value;
    renderParamsForm();
    runPreview();
  };

  keySel.innerHTML = '';
  for (const k of utf8SortedKeys(state.project.signatures)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = k;
    keySel.appendChild(o);
  }
  keySel.value = state.previewKey;
  keySel.onchange = () => {
    state.previewKey = keySel.value;
    renderParamsForm();
    runPreview();
  };
}

function renderParamsForm() {
  const form = $('params-form');
  form.innerHTML = '';
  const sig = state.project.signatures[state.previewKey] || {};
  for (const name of utf8SortedKeys(sig)) {
    const label = document.createElement('label');
    const type = sig[name];
    label.innerHTML = `<span><span class="ptype"></span> <span class="pname"></span></span>`;
    label.querySelector('.ptype').textContent = type === 'i' ? 'int32' : 'string';
    label.querySelector('.pname').textContent = name;
    const input = document.createElement('input');
    input.type = type === 'i' ? 'number' : 'text';
    input.dataset.param = name;
    input.dataset.type = type;
    input.value = type === 'i' ? '1' : '示例';
    input.addEventListener('input', () => runPreview());
    label.appendChild(input);
    form.appendChild(label);
  }
}

function collectParams() {
  const params = {};
  for (const input of $('params-form').querySelectorAll('input')) {
    if (input.dataset.type === 'i') {
      const n = Number(input.value);
      params[input.dataset.param] = Number.isInteger(n) ? n : input.value; // 非法值留给展开报错展示
    } else {
      params[input.dataset.param] = input.value;
    }
  }
  return params;
}

function runPreview() {
  if (!state.project) return;
  const meta = $('result-meta');
  const text = $('result-text');
  const traceBox = $('trace-box');
  const traceList = $('trace-list');
  try {
    const r = expandMessage(state.project, state.previewLang, state.previewKey, collectParams());
    meta.innerHTML = '';
    const pills = [
      ['请求语言', r.requestedLang],
      ['命中语言', r.hitLang, true],
      ['码点', String(r.codePoints)],
      ['回退链', r.chain.join(' → ')],
    ];
    for (const [label, value, hit] of pills) {
      const span = document.createElement('span');
      span.className = 'pill' + (hit ? ' hit' : '');
      span.textContent = `${label} ${value}`;
      meta.appendChild(span);
    }
    text.classList.remove('error');
    text.textContent = r.text;
    traceBox.hidden = r.trace.length <= 1;
    traceList.innerHTML = '';
    for (const t of r.trace) {
      const li = document.createElement('li');
      if (t.kind === 'root') li.textContent = `根 ${t.key}：请求 ${t.requestedLang} → 命中 ${t.hitLang}`;
      else if (t.kind === 'r')
        li.textContent = `r 引用 ${t.key}：从请求语言 ${t.requestedLang} 重查链 [${t.chain.join(' → ')}] → 命中 ${t.hitLang}`;
      else
        li.textContent = `p(${t.param}=${t.value})：命中语言 ${t.hitLang} 模式 ${t.mode} → 分支 ${t.branch}`;
      traceList.appendChild(li);
    }
  } catch (e) {
    meta.innerHTML = '';
    text.classList.add('error');
    text.textContent = `${e.segment ? `[${e.segment}] ` : ''}${e.message}`;
    traceBox.hidden = true;
  }
}
$('refresh-preview').addEventListener('click', runPreview);

// ---------- 发布检查 ----------
function renderCheckList() {
  const ul = $('check-list');
  ul.innerHTML = '';
  if (state.errors.length === 0) {
    const li = document.createElement('li');
    li.className = 'ok';
    li.textContent = '全部请求语言的可达分支检查通过：无缺项、签名匹配、无引用环';
    ul.appendChild(li);
    return;
  }
  for (const err of state.errors) {
    const li = document.createElement('li');
    li.className = 'err';
    li.textContent = err.message;
    const seg = document.createElement('span');
    seg.className = 'seg';
    seg.textContent = `坏段/路径：${err.segment ?? '—'}`;
    li.appendChild(seg);
    ul.appendChild(li);
  }
}
$('run-check').addEventListener('click', () => revalidate());

// 重新规范化 + 检查，保持选择状态，全量重渲染
function revalidate() {
  const { project, errors } = validateProject(state.raw);
  state.project = project;
  state.errors = errors;
  if (!project.languages.includes(state.activeLang)) state.activeLang = project.languages[0];
  const keys = utf8SortedKeys(project.signatures);
  if (!keys.includes(state.activeKey)) state.activeKey = keys[0];
  if (!project.languages.includes(state.previewLang)) state.previewLang = state.activeLang;
  if (!keys.includes(state.previewKey)) state.previewKey = state.activeKey;
  renderAll();
}

// ---------- 发布 ----------
$('publish').addEventListener('click', () => {
  try {
    const { project, errors } = validateProject(state.raw);
    if (errors.length > 0) {
      state.project = project;
      state.errors = errors;
      renderCheckList();
      showBanner('bad', `发布被阻止：${errors.length} 个问题未修复。右侧“发布检查”列出了请求语言与引用路径。`);
      return;
    }
    const bin = compileProject(project);
    // 发布前自检：读回必须得到同一工程，再编译必须逐字节一致
    const reread = readPack(bin);
    const bin2 = compileProject(reread);
    const identical = bin.length === bin2.length && bin.every((v, i) => v === bin2[i]);
    if (!identical) throw new LcpError('发布自检失败：读包后重编译与原包不一致');

    state.lastGoodPack = bin;
    state.lastGoodProject = project;
    state.project = project;
    state.errors = [];
    renderAll();

    const blob = new Blob([bin], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dialogue-pack.lcp1';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showBanner('ok', `发布成功：${bin.length} 字节，CRC-32 校验通过；读包重编译逐字节一致，已触发下载 dialogue-pack.lcp1`);
  } catch (e) {
    showBanner('bad', `发布失败（${e.segment ?? '编译'}）：${e.message}\n上次预览保留。`);
  }
});

// 初始载入样例
loadRaw(SAMPLE, '内置样例');
