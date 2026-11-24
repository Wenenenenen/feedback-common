// timeline.js — 源轨/成片双时间线渲染(无框架, Canvas 波形 + DOM 区域块)
import { SAMPLE_RATE, peakEnvelope } from './wav-codec.js';

const ENV_BUCKETS = 4096;
const TAKE_HUES = [200, 28, 152, 45, 268, 330, 180, 95];

export function takeColor(take, alpha = 1) {
  const h = TAKE_HUES[take % TAKE_HUES.length];
  return `hsl(${h} 65% 55% / ${alpha})`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

export function fmtTime(frames) {
  const s = frames / SAMPLE_RATE;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(3);
  return `${m}:${rem.padStart(6, '0')}`;
}

export class Timeline {
  /**
   * @param {object} roots { ruler, sourceWrap, deliveryWrap }
   */
  constructor(roots, handlers) {
    this.rulerEl = roots.ruler;
    this.sourceWrap = roots.sourceWrap;
    this.deliveryWrap = roots.deliveryWrap;
    this.handlers = handlers; // { onSelect(cueIdx, candId), onSeek(seconds, mode) }
    this.pps = 80; // 像素/秒
    this.lanes = []; // { take, inner, canvas, markers, playhead, env }
    this.delivery = null;
    this.scrollSynced = false;
  }

  setData(instance, takeAudio) {
    this.instance = instance;
    this.takeAudio = takeAudio;
    this.envelopes = new Map();
    for (const [take, wav] of takeAudio) {
      this.envelopes.set(take, peakEnvelope(wav.samples, ENV_BUCKETS));
    }
    this._buildLanes();
    this._buildDelivery();
    this.renderStatic();
  }

  // ---- 布局尺寸 ----
  px(frames) { return (frames / SAMPLE_RATE) * this.pps; }
  frameAt(clientX, laneInner) {
    const rect = laneInner.getBoundingClientRect();
    return Math.round(((clientX - rect.left) / this.pps) * SAMPLE_RATE);
  }

  setPps(pps) {
    this.pps = Math.min(240, Math.max(20, pps));
    for (const l of this.lanes) l.inner.style.width = `${this.px(this.takeAudio.get(l.take).frames)}px`;
    this.delivery.inner.style.width = `${this.px(this.instance.frames)}px`;
    this.renderStatic();
  }

  _buildLanes() {
    this.sourceWrap.innerHTML = '';
    this.lanes = [];
    for (let t = 0; t < this.instance.takes.length; t++) {
      const lane = document.createElement('div');
      lane.className = 'lane';
      lane.dataset.take = t;
      const inner = document.createElement('div');
      inner.className = 'lane-inner';
      inner.style.width = `${this.px(this.takeAudio.get(t).frames)}px`;

      const canvas = document.createElement('canvas');
      canvas.className = 'wave';
      const markers = document.createElement('div');
      markers.className = 'markers';
      const playhead = document.createElement('div');
      playhead.className = 'playhead';
      playhead.hidden = true;

      inner.append(canvas, markers, playhead);
      lane.append(this._laneLabel(`t${t}`, t), inner);
      this.sourceWrap.append(lane);
      this.lanes.push({ take: t, lane, inner, canvas, markers, playhead });

      lane.addEventListener('click', (e) => {
        if (e.target.closest('.region')) return;
        const f = this.frameAt(e.clientX, inner);
        this.handlers.onSeek?.(f / SAMPLE_RATE, 'segment', t);
      });
    }
    this._syncScroll(this.sourceWrap);
  }

  _laneLabel(text, take) {
    const lab = document.createElement('div');
    lab.className = 'lane-label';
    lab.innerHTML = `<span class="take-dot" style="background:${takeColor(take)}"></span>${text}`;
    return lab;
  }

  _buildDelivery() {
    this.deliveryWrap.innerHTML = '';
    const lane = document.createElement('div');
    lane.className = 'lane delivery-lane';
    const inner = document.createElement('div');
    inner.className = 'lane-inner';
    inner.style.width = `${this.px(this.instance.frames)}px`;
    const slotLayer = document.createElement('div');
    slotLayer.className = 'markers slot-layer';
    const blockLayer = document.createElement('div');
    blockLayer.className = 'markers block-layer';
    const ghostLayer = document.createElement('div');
    ghostLayer.className = 'markers ghost-layer';
    const playhead = document.createElement('div');
    playhead.className = 'playhead delivery';
    playhead.hidden = true;
    inner.append(slotLayer, ghostLayer, blockLayer, playhead);
    lane.append(this._laneLabel('成片', -1), inner);
    this.deliveryWrap.append(lane);
    this.delivery = { lane, inner, slotLayer, blockLayer, ghostLayer, playhead };
    lane.addEventListener('click', (e) => {
      if (e.target.closest('.region')) return;
      const f = this.frameAt(e.clientX, inner);
      this.handlers.onSeek?.(f / SAMPLE_RATE, 'delivery');
    });
    this._syncScroll(this.deliveryWrap);
  }

  _syncScroll(wrap) {
    wrap.addEventListener('scroll', () => {
      if (this.scrollSynced) return;
      this.scrollSynced = true;
      const x = wrap.scrollLeft;
      this.sourceWrap.scrollLeft = x;
      this.deliveryWrap.scrollLeft = x;
      this.rulerEl.scrollLeft = x;
      requestAnimationFrame(() => { this.scrollSynced = false; });
    }, { passive: true });
  }

  // ---- 静态绘制: 波形、标尺、槽位 ----
  renderStatic() {
    this._drawRuler();
    for (const l of this.lanes) this._drawWave(l);
    this._drawSlots();
  }

  _drawRuler() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.px(this.instance.frames);
    const cssH = 28;
    const r = this.rulerEl;
    r.innerHTML = '';
    const inner = document.createElement('div');
    inner.style.width = `${cssW}px`;
    inner.style.height = `${cssH}px`;
    inner.style.position = 'relative';
    const canvas = document.createElement('canvas');
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = cssH * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = cssVar('--muted');
    ctx.strokeStyle = cssVar('--rule');
    ctx.textBaseline = 'top';
    // 选一个合适的刻度间隔(秒)
    const targetPx = 90;
    const rawStep = targetPx / this.pps;
    const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60].find((v) => v >= rawStep) ?? 120;
    for (let t = 0; t * this.pps <= cssW; t += step) {
      const x = t * this.pps;
      ctx.beginPath(); ctx.moveTo(x, cssH - 8); ctx.lineTo(x, cssH); ctx.stroke();
      ctx.fillText(`${t.toFixed(step < 1 ? 1 : 0)}s`, x + 3, 3);
    }
    inner.append(canvas);
    r.append(inner);
  }

  _drawWave(l) {
    const dpr = window.devicePixelRatio || 1;
    const wav = this.takeAudio.get(l.take);
    const cssW = this.px(wav.frames);
    const cssH = 56;
    l.canvas.style.width = `${cssW}px`;
    l.canvas.style.height = `${cssH}px`;
    l.canvas.width = Math.round(cssW * dpr);
    l.canvas.height = cssH * dpr;
    const ctx = l.canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);
    const env = this.envelopes.get(l.take);
    const mid = cssH / 2;
    ctx.fillStyle = cssVar('--wave');
    const span = wav.frames / SAMPLE_RATE;
    for (let x = 0; x < cssW; x++) {
      const t0 = (x / this.pps) / span;
      const t1 = ((x + 1) / this.pps) / span;
      const b0 = Math.max(0, Math.floor(t0 * ENV_BUCKETS));
      const b1 = Math.min(ENV_BUCKETS - 1, Math.floor(t1 * ENV_BUCKETS));
      let lo = 1, hi = -1;
      for (let b = b0; b <= b1; b++) {
        if (env.min[b] < lo) lo = env.min[b];
        if (env.max[b] > hi) hi = env.max[b];
      }
      const y1 = mid - hi * (mid - 2);
      const y2 = mid - lo * (mid - 2);
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }

  _drawSlots() {
    const { slotLayer } = this.delivery;
    slotLayer.innerHTML = '';
    this.instance.cues.forEach((cue, k) => {
      const r = document.createElement('div');
      r.className = 'slot';
      r.style.left = `${this.px(cue.slot[0])}px`;
      r.style.width = `${this.px(cue.slot[1] - cue.slot[0])}px`;
      r.title = `句 ${k + 1} 槽位 ${fmtTime(cue.slot[0])}–${fmtTime(cue.slot[1])}`;
      slotLayer.append(r);
    });
  }

  // ---- 结果与选中态更新 ----
  update(result, selectedCue, selectedCandId, locks) {
    this.result = result;
    this.selectedCue = selectedCue;
    this.selectedCandId = selectedCandId;
    this.locks = locks;
    this._updateSourceMarkers();
    this._updateDeliveryBlocks();
    this._updateGhosts();
  }

  _region(c, cls, title, color, alpha) {
    const el = document.createElement('div');
    el.className = `region ${cls}`;
    el.style.left = `${this.px(c.src ?? c.dst)}px`;
    el.style.width = `${this.px(c.len)}px`;
    el.style.background = color ?? takeColor(c.take, alpha);
    el.title = title;
    return el;
  }

  _updateSourceMarkers() {
    for (const l of this.lanes) l.markers.innerHTML = '';
    // 所有已选片段(淡色)
    if (this.result?.ok) {
      this.result.chosen.forEach((c, k) => {
        const lane = this.lanes[c.take];
        const el = this._region(
          c, 'chosen-faint',
          `句 ${k + 1} · 候选 ${c.id} · 源 ${fmtTime(c.src)}–${fmtTime(c.src + c.len)}`,
          takeColor(c.take, 0.22)
        );
        el.addEventListener('click', (e) => { e.stopPropagation(); this.handlers.onSelect?.(k, c.id); });
        lane.markers.append(el);
      });
    }
    // 当前句的候选(描边) + 选中(实心)
    if (this.selectedCue == null) return;
    const cue = this.instance.cues[this.selectedCue];
    const fits = (c) => c.dst >= cue.slot[0] && c.dst + c.len <= cue.slot[1];
    for (const c of cue.candidates) {
      const lane = this.lanes[c.take];
      const isSel = c.id === this.selectedCandId;
      const el = document.createElement('div');
      el.className = `region cand ${isSel ? 'selected' : ''} ${fits(c) ? '' : 'oob'}`;
      el.style.left = `${this.px(c.src)}px`;
      el.style.width = `${this.px(c.len)}px`;
      el.style.borderColor = takeColor(c.take);
      el.title = `候选 ${c.id} · 轨 t${c.take} · 源 ${fmtTime(c.src)}–${fmtTime(c.src + c.len)}` +
        (fits(c) ? '' : ' · 超槽不可用');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (fits(c)) this.handlers.onSelect?.(this.selectedCue, c.id);
      });
      lane.markers.append(el);
    }
  }

  _updateDeliveryBlocks() {
    const { blockLayer } = this.delivery;
    blockLayer.innerHTML = '';
    if (!this.result?.ok) return;
    this.result.chosen.forEach((c, k) => {
      const el = this._region(
        c, k === this.selectedCue ? 'placed selected' : 'placed',
        `句 ${k + 1} · 候选 ${c.id} · 目标 ${fmtTime(c.dst)}–${fmtTime(c.dst + c.len)}`,
        takeColor(c.take, 0.85)
      );
      el.style.left = `${this.px(c.dst)}px`;
      const tag = document.createElement('span');
      tag.className = 'region-tag';
      tag.textContent = c.id;
      el.append(tag);
      el.addEventListener('click', (e) => { e.stopPropagation(); this.handlers.onSelect?.(k, c.id); });
      blockLayer.append(el);
    });
  }

  _updateGhosts() {
    const { ghostLayer } = this.delivery;
    ghostLayer.innerHTML = '';
    if (this.selectedCue == null) return;
    const cue = this.instance.cues[this.selectedCue];
    for (const c of cue.candidates) {
      if (c.dst < cue.slot[0] || c.dst + c.len > cue.slot[1]) continue;
      const el = document.createElement('div');
      const isSel = c.id === this.selectedCandId;
      el.className = `region ghost ${isSel ? 'selected' : ''}`;
      el.style.left = `${this.px(c.dst)}px`;
      el.style.width = `${this.px(c.len)}px`;
      el.style.borderColor = takeColor(c.take);
      el.title = `候选 ${c.id} 的目标落点`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handlers.onSelect?.(this.selectedCue, c.id);
      });
      ghostLayer.append(el);
    }
  }

  // ---- 播放头 ----
  setPlayhead(seconds, mode, take = null) {
    for (const l of this.lanes) {
      if (mode === 'segment' && l.take === take) {
        l.playhead.hidden = false;
        l.playhead.style.left = `${seconds * this.pps}px`;
      } else {
        l.playhead.hidden = true;
      }
    }
    if (mode === 'delivery') {
      this.delivery.playhead.hidden = false;
      this.delivery.playhead.style.left = `${seconds * this.pps}px`;
    } else {
      this.delivery.playhead.hidden = true;
    }
  }

  clearPlayhead() {
    for (const l of this.lanes) l.playhead.hidden = true;
    this.delivery.playhead.hidden = true;
  }

  scrollToCue(cueIdx) {
    const cue = this.instance.cues[cueIdx];
    const x = Math.max(0, this.px(cue.slot[0]) - 40);
    this.sourceWrap.scrollTo({ left: x, behavior: 'smooth' });
  }
}
