// 管线编排：校验 -> 建模 -> 展开 -> 得分 -> 配额 -> 渲染；增量更新与导出
import { validateScene } from './validate.js';
import {
  buildModel, comparePath, expandBeams, expandBeamsIncremental,
  scoreBeams, solveBudget,
} from './beam.js';
import { render } from './rasterize.js';

export class Engine {
  constructor() {
    this.scene = null;
    this.model = null;
    this.tree = null;
    this.candidates = [];
    this.activeSet = new Set();
    this.totalScore = 0;
    this.result = null;
    this.lastTiming = {};
    this._bufferCache = new Map(); // 键 `路径@version` -> 像素缓冲
  }

  // 缓存键 = 路径 + 子树版本：整棵子树（含自身与所有后代）均未重建才复用，
  // 否则父缓冲可能持有已变化的子镜面窗口引用
  static beamCacheKey(beam) {
    return `${beam.path.join('>') || 'root'}#${beam.subtreeVersion ?? beam.version ?? 0}`;
  }

  // 全量载入；失败返回错误且保留当前状态
  load(scene) {
    const v = validateScene(scene);
    if (!v.valid) return { ok: false, errors: v.errors };
    this.scene = deepCopy(scene);
    this._bufferCache = new Map();
    this.recompute({ mode: 'full' });
    return { ok: true, errors: [] };
  }

  // 编辑应用：先校验新场景；非法则拒绝并保留当前场景
  // changedMirrorId 给出时走子树增量路径；其余编辑全量重算
  applyEdit(nextScene, opts = {}) {
    const v = validateScene(nextScene);
    if (!v.valid) return { ok: false, errors: v.errors };
    const prevScene = this.scene;
    this.scene = deepCopy(nextScene);
    const changedMirrorId = this._detectChangedMirror(prevScene, nextScene, opts);
    if (changedMirrorId) {
      this.recompute({ mode: 'incremental', changedMirrorId });
    } else {
      this._bufferCache = new Map();
      this.recompute({ mode: 'full' });
    }
    return { ok: true, errors: [] };
  }

  // 仅当恰好只有一个镜面的几何/反射率/enabled 变化（其余场景完全相同）时返回其 id
  _detectChangedMirror(prev, next, opts) {
    if (opts.changedMirrorId) return opts.changedMirrorId;
    if (!prev) return null;
    if (JSON.stringify(prev.camera) !== JSON.stringify(next.camera)
      || JSON.stringify(prev.vertices) !== JSON.stringify(next.vertices)
      || JSON.stringify(prev.triangles) !== JSON.stringify(next.triangles)
      || prev.maxBounceDepth !== next.maxBounceDepth
      || prev.beamBudgetK !== next.beamBudgetK) return null;
    if (prev.mirrors.length !== next.mirrors.length) return null;
    let changed = null;
    for (let i = 0; i < prev.mirrors.length; i++) {
      if (JSON.stringify(prev.mirrors[i]) !== JSON.stringify(next.mirrors[i])) {
        if (changed !== null) return null; // 多镜面变更 -> 全量
        changed = next.mirrors[i].id;
      }
    }
    return changed;
  }

  recompute({ mode, changedMirrorId }) {
    const t0 = performance.now();
    this.model = buildModel(this.scene);
    const t1 = performance.now();
    if (mode === 'incremental' && this.tree) {
      this.tree = expandBeamsIncremental(this.model, this.tree, changedMirrorId);
    } else {
      const built = expandBeams(this.model);
      this.tree = built;
      this._bufferCache = new Map();
    }
    this.candidates = scoreBeams(this.model, this.tree);
    const t2 = performance.now();
    if (this.candidates.length > this.model.K) {
      const sol = solveBudget(this.tree, this.model.K);
      this.activeSet = sol.selected;
      this.totalScore = sol.totalScore;
    } else {
      this.activeSet = new Set(this.candidates);
      this.totalScore = this.candidates.reduce((s, b) => s + b.score, 0);
    }
    const t3 = performance.now();
    // 缓冲失效：清掉不在当前激活集合内的键；版本变化的 beam 键名不同，天然不会命中旧缓冲
    const activeKeys = new Set(this.tree.all
      .filter((b) => b.depth === 0 || this.activeSet.has(b))
      .map(Engine.beamCacheKey));
    for (const key of [...this._bufferCache.keys()]) {
      if (!activeKeys.has(key)) this._bufferCache.delete(key);
    }
    this.result = render(this.model, this.tree, this.activeSet, this._bufferCache, Engine.beamCacheKey);
    const t4 = performance.now();
    this.lastTiming = {
      mode, changedMirrorId: changedMirrorId || null,
      modelMs: t1 - t0,
      expandMs: t2 - t1,
      budgetMs: t3 - t2,
      renderMs: t4 - t3,
      totalMs: t4 - t0,
      candidateCount: this.candidates.length,
      selectedCount: this.activeSet.size,
      bufferReuse: this.result.bufferReuse,
    };
  }

  pickPixel(i, j) {
    if (!this.result) return null;
    const { width, height } = this.model;
    if (i < 0 || j < 0 || i >= width || j >= height) return null;
    const trace = this.result.pixelInfo[j * width + i];
    return {
      pixel: [i, j],
      trace,
      beamCount: this.candidates.length,
      K: this.model.K,
    };
  }

  exportJSON() {
    const selected = [...this.activeSet].sort((a, b) => comparePath(a.path, b.path));
    return {
      sceneId: this.scene.sceneId,
      maxBounceDepth: this.scene.maxBounceDepth,
      beamBudgetK: this.scene.beamBudgetK,
      candidateBeamCount: this.candidates.length,
      selectedBeamCount: this.activeSet.size,
      totalSelectedScore: this.totalScore,
      selectedBeams: selected.map((b) => ({
        path: b.path.slice(),
        depth: b.depth,
        score: b.score,
        virtualEye: b.eye.map((x) => round6(x)),
        clippedPolygon: b.window.map((p) => p.map((x) => round6(x))),
      })),
    };
  }
}

function round6(x) {
  return Math.abs(x) < 5e-13 ? 0 : Number(x.toFixed(6));
}

function deepCopy(o) {
  return JSON.parse(JSON.stringify(o));
}

// Node 与浏览器双环境的 performance 兼容
if (typeof performance === 'undefined' && typeof process !== 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1e6 };
}
