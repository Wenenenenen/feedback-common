'use strict';

/* ============================================================
 * 图集过滤实验室
 * 过滤核心全部手写：sRGB 解码 → 线性空间预乘 alpha → 2×2 盒式
 * 过滤生成 mip 链（向上取半，奇数边只平均实际存在的像素，
 * 全透明结果 RGB 置零）→ 每级外扩 2px 复制本级边缘。
 * 不使用浏览器的缩图 / 自动 mip。
 * ============================================================ */

const PADDING = 2;
const MAX_ATLAS = 2048;
const MAX_SPRITES = 128;

/* ---------- sRGB <-> 线性 ---------- */
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function lin2srgbByte(c) {
  c = Math.min(1, Math.max(0, c));
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

/* ---------- 全局状态（导入失败时保留上一次有效结果） ---------- */
let state = null; // {imgW,imgH,rgba,sprites,chains,spriteMap,pngName,jsonName}
const ui = {
  mode: 'trilinear',
  zoomExp: 0,
  manualLodOn: false,
  manualLod: 0,
  bg: 'checker',
  bgColor: '#808080',
  selected: -1,      // 选中的图标索引
  inspect: null,     // 点击检查的结果
};

const pending = { png: null, pngName: '', json: null, jsonName: '' };

/* ---------- DOM ---------- */
const $ = id => document.getElementById(id);
const preview = $('preview');
const pctx = preview.getContext('2d');

/* ============================================================
 * 导入与校验
 * ============================================================ */
$('pngInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const cx = c.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    const data = cx.getImageData(0, 0, bmp.width, bmp.height).data;
    pending.png = { w: bmp.width, h: bmp.height, rgba: new Uint8ClampedArray(data) };
    pending.pngName = f.name;
  } catch (err) {
    pending.png = null;
    showErrors([`PNG 解码失败：${err.message || err}`]);
    return;
  }
  rebuild();
});

$('jsonInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    pending.json = JSON.parse(await f.text());
    pending.jsonName = f.name;
  } catch (err) {
    pending.json = null;
    showErrors([`JSON 解析失败：${err.message || err}`]);
    return;
  }
  rebuild();
});

function showErrors(list) {
  $('errorList').innerHTML = list.map(s => `<li></li>`).join('');
  [...$('errorList').children].forEach((li, i) => li.textContent = list[i]);
  $('importStatus').textContent = list.length
    ? '导入失败，已保留上一次有效结果。'
    : (state ? '导入成功。' : '尚未导入。');
  $('importStatus').className = 'status' + (list.length ? '' : ' ok');
}

function rebuild() {
  const errors = [];
  if (!pending.png || !pending.json) {
    showErrors([]);
    $('importStatus').textContent =
      `已就绪：${pending.png ? 'PNG✓' : 'PNG…'} ${pending.json ? 'JSON✓' : 'JSON…'}`;
    $('importStatus').className = 'status';
    return;
  }
  const next = validateAndBuild(pending.png, pending.json, errors);
  if (!next) {
    showErrors(errors);           // 保留上一次有效结果
    return;
  }
  next.pngName = pending.pngName;
  next.jsonName = pending.jsonName;
  state = next;
  ui.selected = -1;
  ui.inspect = null;
  showErrors([]);
  $('importStatus').textContent =
    `导入成功：${state.imgW}×${state.imgH}，${state.sprites.length} 个图标。`;
  $('importStatus').className = 'status ok';
  $('exportBtn').disabled = false;
  buildSpriteList();
  renderPreview();
  renderInspect();
  renderChain();
}

function validateAndBuild(img, root, errors) {
  const sp = root && root.sprites;
  if (!root || typeof root !== 'object' || !Array.isArray(sp)) {
    errors.push('JSON 缺少 sprites 数组。');
    return null;
  }
  if (img.w > MAX_ATLAS || img.h > MAX_ATLAS) {
    errors.push(`图集尺寸 ${img.w}×${img.h} 超过 ${MAX_ATLAS}×${MAX_ATLAS}。`);
    return null;
  }
  if (sp.length === 0) { errors.push('sprites 为空。'); return null; }
  if (sp.length > MAX_SPRITES) {
    errors.push(`图标数量 ${sp.length} 超过上限 ${MAX_SPRITES}。`);
    return null;
  }
  const sprites = [];
  const names = new Set();
  for (let i = 0; i < sp.length; i++) {
    const s = sp[i] || {};
    const tag = `图标 #${i}${typeof s.name === 'string' ? ` "${s.name}"` : ''}`;
    if (typeof s.name !== 'string' || s.name === '') {
      errors.push(`${tag}：name 缺失或不是非空字符串。`); continue;
    }
    if (names.has(s.name)) { errors.push(`${tag}：名称重复。`); continue; }
    const nums = ['x', 'y', 'w', 'h'];
    let bad = false;
    for (const k of nums) {
      if (!Number.isInteger(s[k])) { errors.push(`${tag}：${k} 不是整数。`); bad = true; }
    }
    if (bad) continue;
    if (s.w < 1 || s.h < 1) { errors.push(`${tag}：w/h 必须 ≥ 1。`); continue; }
    if (s.x < 0 || s.y < 0 || s.x + s.w > img.w || s.y + s.h > img.h) {
      errors.push(`${tag}：矩形 [${s.x},${s.y} ${s.w}×${s.h}] 超出图集边界（半开区间，图集 ${img.w}×${img.h}）。`);
      continue;
    }
    names.add(s.name);
    sprites.push({ name: s.name, x: s.x, y: s.y, w: s.w, h: s.h });
  }
  if (errors.length) return null;
  // 重叠检查（不旋转，半开区间）
  for (let i = 0; i < sprites.length; i++) {
    for (let j = i + 1; j < sprites.length; j++) {
      const a = sprites[i], b = sprites[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        errors.push(`图标 "${a.name}" 与 "${b.name}" 重叠。`);
      }
    }
  }
  if (errors.length) return null;

  // 图集 texel → 图标索引（用于预览与点选）
  const spriteMap = new Int16Array(img.w * img.h).fill(-1);
  sprites.forEach((s, idx) => {
    for (let y = s.y; y < s.y + s.h; y++)
      for (let x = s.x; x < s.x + s.w; x++)
        spriteMap[y * img.w + x] = idx;
  });

  const chains = sprites.map(s => buildChain(s, img.rgba, img.w));
  return { imgW: img.w, imgH: img.h, rgba: img.rgba, sprites, chains, spriteMap };
}

/* ============================================================
 * mip 链生成（手写过滤核心）
 * 每级存储为外扩 2px 后的预乘线性浮点图，内容位于 (2,2)。
 * ============================================================ */
function buildChain(sprite, rgba, imgW) {
  // level 0：从图集裁剪，sRGB 解码到线性并预乘 alpha
  const { x: x0, y: y0, w, h } = sprite;
  let lw = w, lh = h;
  let cur = new Float32Array(lw * lh * 4);
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const si = ((y0 + y) * imgW + (x0 + x)) * 4;
      const a = rgba[si + 3] / 255;
      const di = (y * lw + x) * 4;
      cur[di]     = S2L[rgba[si]]     * a;
      cur[di + 1] = S2L[rgba[si + 1]] * a;
      cur[di + 2] = S2L[rgba[si + 2]] * a;
      cur[di + 3] = a;
    }
  }
  const levels = [];
  for (;;) {
    levels.push(padLevel(cur, lw, lh));
    if (lw === 1 && lh === 1) break;
    const nw = Math.ceil(lw / 2), nh = Math.ceil(lh / 2);
    const nxt = new Float32Array(nw * nh * 4);
    for (let oy = 0; oy < nh; oy++) {
      for (let ox = 0; ox < nw; ox++) {
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = ox * 2 + dx, sy = oy * 2 + dy;
            if (sx < lw && sy < lh) {          // 奇数边只平均实际存在的像素
              const si = (sy * lw + sx) * 4;
              r += cur[si]; g += cur[si + 1]; b += cur[si + 2]; a += cur[si + 3];
              n++;
            }
          }
        }
        const di = (oy * nw + ox) * 4;
        nxt[di] = r / n; nxt[di + 1] = g / n; nxt[di + 2] = b / n; nxt[di + 3] = a / n;
        // 全透明结果 RGB 置零（预乘空间下 RGB 随 alpha 已为 0 时自然满足，
        // 这里显式处理浮点残余之外的通用情况）
        if (nxt[di + 3] <= 0) { nxt[di] = 0; nxt[di + 1] = 0; nxt[di + 2] = 0; }
      }
    }
    cur = nxt; lw = nw; lh = nh;
  }
  return levels; // levels[i] = {w,h,pw,ph,data}
}

/* 外扩 2px，复制本级边缘；返回带边级别 */
function padLevel(src, w, h) {
  const pw = w + PADDING * 2, ph = h + PADDING * 2;
  const data = new Float32Array(pw * ph * 4);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - PADDING));
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - PADDING));
      const si = (sy * w + sx) * 4, di = (y * pw + x) * 4;
      data[di] = src[si]; data[di + 1] = src[si + 1];
      data[di + 2] = src[si + 2]; data[di + 3] = src[si + 3];
    }
  }
  return { w, h, pw, ph, data };
}

/* 取级别内容像素（预乘线性），x,y 为内容坐标 */
function lvlPx(lvl, x, y) {
  const i = ((y + PADDING) * lvl.pw + (x + PADDING)) * 4;
  return [lvl.data[i], lvl.data[i + 1], lvl.data[i + 2], lvl.data[i + 3]];
}

/* 双线性采样（UV 已钳制到本图标内容范围），返回颜色与采样明细 */
function sampleBilinear(lvl, tx, ty) {
  const x0 = Math.floor(tx), y0 = Math.floor(ty);
  const x1 = Math.min(x0 + 1, lvl.w - 1), y1 = Math.min(y0 + 1, lvl.h - 1);
  const fx = tx - x0, fy = ty - y0;
  const taps = [
    { x: x0, y: y0, w: (1 - fx) * (1 - fy) },
    { x: x1, y: y0, w: fx * (1 - fy) },
    { x: x0, y: y1, w: (1 - fx) * fy },
    { x: x1, y: y1, w: fx * fy },
  ];
  const out = [0, 0, 0, 0];
  for (const t of taps) {
    t.c = lvlPx(lvl, t.x, t.y);
    for (let k = 0; k < 4; k++) out[k] += t.c[k] * t.w;
  }
  return { color: out, taps };
}

/* ============================================================
 * 预览渲染（逐像素手写采样）
 * ============================================================ */
function currentLod(scale) {
  const auto = Math.max(0, -Math.log2(scale));
  return ui.manualLodOn ? Math.max(0, ui.manualLod) : auto;
}

function pickLevels(lod, maxLvl) {
  if (ui.mode === 'bilinear') {
    // 最近整数级，半级向上
    const l = Math.min(maxLvl, Math.floor(lod + 0.5));
    return [{ lvl: l, w: 1 }];
  }
  const c = Math.min(lod, maxLvl);
  const l0 = Math.floor(c);
  const l1 = Math.min(l0 + 1, maxLvl);
  const f = c - l0;
  return (l1 === l0 || f === 0) ? [{ lvl: l0, w: 1 }]
                                : [{ lvl: l0, w: 1 - f }, { lvl: l1, w: f }];
}

/* 计算屏幕上 (px,py) 处的采样结果；也用于点选检查 */
function sampleAt(px, py, scale) {
  const ax = (px + 0.5) / scale - 0.5;   // 图集连续 texel 坐标
  const ay = (py + 0.5) / scale - 0.5;
  const ix = Math.floor(ax + 0.5), iy = Math.floor(ay + 0.5);
  if (ix < 0 || iy < 0 || ix >= state.imgW || iy >= state.imgH) return null;
  const si = state.spriteMap[iy * state.imgW + ix];
  if (si < 0) return null;
  const sp = state.sprites[si];
  const chain = state.chains[si];
  // 本图标局部连续 texel 坐标，钳制到本图标
  const lx = Math.min(sp.w - 1, Math.max(0, ax - sp.x));
  const ly = Math.min(sp.h - 1, Math.max(0, ay - sp.y));
  const lod = currentLod(scale);
  const picks = pickLevels(lod, chain.length - 1);
  const details = [];
  const out = [0, 0, 0, 0];
  for (const p of picks) {
    const lvl = chain[p.lvl];
    const sc = Math.pow(2, p.lvl);
    // 级内 texel 坐标并钳制
    const tx = Math.min(lvl.w - 1, Math.max(0, (lx + 0.5) / sc - 0.5));
    const ty = Math.min(lvl.h - 1, Math.max(0, (ly + 0.5) / sc - 0.5));
    const r = sampleBilinear(lvl, tx, ty);
    for (let k = 0; k < 4; k++) out[k] += r.color[k] * p.w;
    details.push({ level: p.lvl, weight: p.w, lw: lvl.w, lh: lvl.h, tx, ty, taps: r.taps, color: r.color });
  }
  return { sprite: sp, spriteIdx: si, atlasX: ix, atlasY: iy, lod, details, color: out };
}

function bgAt(px, py) {
  if (ui.bg === 'checker') {
    return ((px >> 3) + (py >> 3)) & 1 ? [200, 200, 200] : [140, 140, 140];
  }
  const n = parseInt(ui.bgColor.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function renderPreview() {
  if (!state) return;
  const scale = Math.pow(2, ui.zoomExp);
  const maxDim = 1600;
  const ow = Math.max(1, Math.min(maxDim, Math.round(state.imgW * scale)));
  const oh = Math.max(1, Math.min(maxDim, Math.round(state.imgH * scale)));
  preview.width = ow; preview.height = oh;
  const img = pctx.createImageData(ow, oh);
  const d = img.data;
  for (let py = 0; py < oh; py++) {
    for (let px = 0; px < ow; px++) {
      const di = (py * ow + px) * 4;
      const bg = bgAt(px, py);
      const r = sampleAt(px, py, scale);
      if (!r) { d[di] = bg[0]; d[di + 1] = bg[1]; d[di + 2] = bg[2]; d[di + 3] = 255; continue; }
      const [pr, pg, pb, pa] = r.color;
      let sr = 0, sg = 0, sb = 0;
      if (pa > 0) { sr = lin2srgbByte(pr / pa); sg = lin2srgbByte(pg / pa); sb = lin2srgbByte(pb / pa); }
      d[di]     = Math.round(sr * pa + bg[0] * (1 - pa));
      d[di + 1] = Math.round(sg * pa + bg[1] * (1 - pa));
      d[di + 2] = Math.round(sb * pa + bg[2] * (1 - pa));
      d[di + 3] = 255;
    }
  }
  pctx.putImageData(img, 0, 0);
  // 选中图标高亮框
  if (ui.selected >= 0) {
    const sp = state.sprites[ui.selected];
    pctx.strokeStyle = '#4f9cf9';
    pctx.lineWidth = Math.max(1, scale / 2);
    pctx.strokeRect(sp.x * scale, sp.y * scale, sp.w * scale, sp.h * scale);
  }
  $('zoomLabel').textContent = `${Math.round(scale * 100)}%`;
  $('autoLod').textContent = Math.max(0, -Math.log2(scale)).toFixed(2);
}

/* ============================================================
 * 点选检查
 * ============================================================ */
preview.addEventListener('click', e => {
  if (!state) return;
  const rect = preview.getBoundingClientRect();
  const px = Math.floor((e.clientX - rect.left) * preview.width / rect.width);
  const py = Math.floor((e.clientY - rect.top) * preview.height / rect.height);
  const scale = Math.pow(2, ui.zoomExp);
  ui.inspect = sampleAt(px, py, scale);
  if (ui.inspect) {
    ui.selected = ui.inspect.spriteIdx;
    buildSpriteList();
  }
  renderPreview();
  renderInspect();
  renderChain();
});

function fmtC(c) {
  const [r, g, b, a] = c;
  if (a <= 0) return 'rgba(0,0,0,0)';
  return `rgba(${lin2srgbByte(r / a)},${lin2srgbByte(g / a)},${lin2srgbByte(b / a)},${Math.round(a * 255)})`;
}
function swatch(c) {
  let css = 'rgba(0,0,0,0)';
  if (c[3] > 0) css = `rgb(${lin2srgbByte(c[0] / c[3])},${lin2srgbByte(c[1] / c[3])},${lin2srgbByte(c[2] / c[3])})`;
  return `<span class="swatch" style="background:${css}"></span>`;
}

function renderInspect() {
  const el = $('inspectBody');
  const r = ui.inspect;
  if (!r) { el.textContent = '尚未选择像素（或点击处不在任何图标内）。'; el.className = 'hint'; return; }
  el.className = '';
  let html = `<p>图集 texel (${r.atlasX}, ${r.atlasY}) · 图标 <b>${esc(r.sprite.name)}</b> · ` +
             `LOD ${r.lod.toFixed(2)}（${ui.mode === 'bilinear' ? '双线性' : '三线性'}）</p>`;
  for (const d of r.details) {
    html += `<p>级别 ${d.level}（${d.lw}×${d.lh}）权重 ${d.weight.toFixed(3)} · ` +
            `采样点 (${d.tx.toFixed(3)}, ${d.ty.toFixed(3)})</p><table>` +
            `<tr><th>texel</th><th>权重</th><th>颜色</th></tr>`;
    for (const t of d.taps) {
      html += `<tr><td>(${t.x}, ${t.y})</td><td>${t.w.toFixed(3)}</td>` +
              `<td>${swatch(t.c)}${fmtC(t.c)}</td></tr>`;
    }
    html += `<tr><td colspan="2">本级结果</td><td>${swatch(d.color)}${fmtC(d.color)}</td></tr></table>`;
  }
  html += `<p><b>最终：</b>${swatch(r.color)}${fmtC(r.color)}</p>`;
  el.innerHTML = html;
}

function esc(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============================================================
 * 图标列表 / mip 链视图
 * ============================================================ */
function buildSpriteList() {
  const ul = $('spriteList');
  ul.innerHTML = '';
  if (!state) { $('spriteCount').textContent = ''; return; }
  $('spriteCount').textContent = `（${state.sprites.length}）`;
  state.sprites.forEach((s, i) => {
    const li = document.createElement('li');
    if (i === ui.selected) li.className = 'sel';
    const nm = document.createElement('span'); nm.textContent = s.name;
    const dim = document.createElement('span'); dim.className = 'dim';
    dim.textContent = `${s.w}×${s.h} · ${state.chains[i].length}级`;
    li.append(nm, dim);
    li.addEventListener('click', () => {
      ui.selected = i;
      buildSpriteList(); renderPreview(); renderChain();
    });
    ul.appendChild(li);
  });
}

function levelToBytes(lvl) {
  const out = new Uint8ClampedArray(lvl.pw * lvl.ph * 4);
  for (let i = 0; i < lvl.pw * lvl.ph; i++) {
    const r = lvl.data[i * 4], g = lvl.data[i * 4 + 1],
          b = lvl.data[i * 4 + 2], a = lvl.data[i * 4 + 3];
    const di = i * 4;
    if (a <= 0) { out[di] = out[di + 1] = out[di + 2] = out[di + 3] = 0; continue; }
    out[di]     = lin2srgbByte(r / a);
    out[di + 1] = lin2srgbByte(g / a);
    out[di + 2] = lin2srgbByte(b / a);
    out[di + 3] = Math.round(a * 255);
  }
  return out;
}

function renderChain() {
  const el = $('chainBody');
  el.innerHTML = '';
  if (!state || ui.selected < 0) { el.textContent = '尚未选择图标。'; el.className = 'hint'; return; }
  el.className = '';
  const chain = state.chains[ui.selected];
  chain.forEach((lvl, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'lvl';
    const cv = document.createElement('canvas');
    cv.width = lvl.pw; cv.height = lvl.ph;
    cv.getContext('2d').putImageData(new ImageData(levelToBytes(lvl), lvl.pw, lvl.ph), 0, 0);
    const scaleCss = Math.max(1, Math.min(8, Math.floor(96 / Math.max(lvl.pw, lvl.ph)) || 1));
    cv.style.width = lvl.pw * scaleCss + 'px';
    cv.style.height = lvl.ph * scaleCss + 'px';
    const cap = document.createElement('div');
    cap.textContent = `L${i} 内容${lvl.w}×${lvl.h} 含边${lvl.pw}×${lvl.ph}`;
    wrap.append(cv, cap);
    el.appendChild(wrap);
  });
}

/* ============================================================
 * 控件
 * ============================================================ */
document.querySelectorAll('input[name="mode"]').forEach(r =>
  r.addEventListener('change', () => { ui.mode = r.value; renderPreview(); }));
$('zoom').addEventListener('input', e => { ui.zoomExp = parseFloat(e.target.value); renderPreview(); });
$('manualLod').addEventListener('change', e => {
  ui.manualLodOn = e.target.checked;
  $('lodValue').disabled = !ui.manualLodOn;
  renderPreview();
});
$('lodValue').addEventListener('input', e => { ui.manualLod = parseFloat(e.target.value) || 0; renderPreview(); });
document.querySelectorAll('input[name="bg"]').forEach(r =>
  r.addEventListener('change', () => { ui.bg = r.value; renderPreview(); }));
$('bgColor').addEventListener('input', e => { ui.bgColor = e.target.value; renderPreview(); });

/* ============================================================
 * 导出：手写 store 模式 ZIP + canvas PNG 编码
 * ============================================================ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(entries) {
  // entries: [{name, data:Uint8Array}]
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);           // version
    lh.setUint16(6, 0x0800, true);       // UTF-8 标志
    lh.setUint16(8, 0, true);            // store
    lh.setUint16(14, crc, true);
    lh.setUint32(18, e.data.length, true);
    lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, e.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, e.data.length, true);
    ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + e.data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

async function pngBytes(bytes, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').putImageData(new ImageData(bytes, w, h), 0, 0);
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

$('exportBtn').addEventListener('click', async () => {
  if (!state) return;
  const btn = $('exportBtn');
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    const entries = [];
    const manifest = {
      image: state.pngName,
      atlas: { width: state.imgW, height: state.imgH },
      padding: PADDING,
      colorSpace: 'sRGB 解码到线性空间，预乘 alpha 过滤；全透明结果 RGB 置零',
      sprites: [],
    };
    for (let i = 0; i < state.sprites.length; i++) {
      const sp = state.sprites[i];
      const rec = { name: sp.name, x: sp.x, y: sp.y, w: sp.w, h: sp.h, levels: [] };
      const chain = state.chains[i];
      for (let l = 0; l < chain.length; l++) {
        const lvl = chain[l];
        const path = `mips/${sp.name}/level_${l}.png`;
        entries.push({ name: path, data: await pngBytes(levelToBytes(lvl), lvl.pw, lvl.ph) });
        rec.levels.push({
          level: l,
          file: path,
          width: lvl.pw,
          height: lvl.ph,
          content: { x: PADDING, y: PADDING, w: lvl.w, h: lvl.h },
        });
      }
      manifest.sprites.push(rec);
    }
    entries.push({
      name: 'mips/manifest.json',
      data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    });
    const blob = zipStore(entries);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'atlas-mips.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } finally {
    btn.disabled = false;
    btn.textContent = '导出全部图标各级 PNG + JSON（ZIP）';
  }
});
