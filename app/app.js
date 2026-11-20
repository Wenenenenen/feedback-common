// app.js — 铰链 IK 校验台应用逻辑 (无第三方依赖, 配合 hinge-ik-solver.js)
"use strict";

// ---------------- 内嵌样例 (与 samples/extracted/*.json 一致) ----------------
const SAMPLES = {
  "two-link.json": {
    joints: [
      { id: "base", parent: null, offset: [0, 0, 0], axis: [0, 0, 1], angle: 20, min: -170, max: 170, rest: 0, locked: false },
      { id: "elbow", parent: "base", offset: [2, 0, 0], axis: [0, 0, 1], angle: -20, min: -170, max: 170, rest: 0, locked: false },
    ],
    effectors: [{ id: "tip", joint: "elbow", point: [1, 0, 0], target: [2, 1, 0], weight: 1 }],
    regularization: 0, positionTolerance: 0.01, maxIterations: 2000,
  },
  "unreachable.json": {
    joints: [
      { id: "base", parent: null, offset: [0, 0, 0], axis: [0, 0, 1], angle: 20, min: -170, max: 170, rest: 0, locked: false },
      { id: "elbow", parent: "base", offset: [2, 0, 0], axis: [0, 0, 1], angle: -20, min: -170, max: 170, rest: 0, locked: false },
    ],
    effectors: [{ id: "tip", joint: "elbow", point: [1, 0, 0], target: [8, 8, 3], weight: 1 }],
    regularization: 0.001, positionTolerance: 0.01, maxIterations: 2000,
  },
  "shared.json": {
    joints: [
      { id: "root", parent: null, offset: [0, 0, 0], axis: [0, 0, 1], angle: 5, min: -60, max: 60, rest: 0, locked: false },
      { id: "arm-a", parent: "root", offset: [2, 0, 0], axis: [0, 0, 1], angle: 10, min: -170, max: 170, rest: 0, locked: false },
      { id: "arm-b", parent: "root", offset: [0, 2, 0], axis: [0, 0, 1], angle: -10, min: -170, max: 170, rest: 0, locked: false },
    ],
    effectors: [
      { id: "arm-a-tip", joint: "arm-a", point: [1, 0, 0], target: [2.2352338358139994, 1.7515443105180486, 0], weight: 1 },
      { id: "arm-b-tip", joint: "arm-b", point: [1, 0, 0], target: [0.15095817461034666, 1.7254598313256417, 0], weight: 1 },
    ],
    regularization: 0, positionTolerance: 0.01, maxIterations: 2000,
  },
  "locked.json": {
    joints: [
      { id: "base", parent: null, offset: [0, 0, 0], axis: [0, 0, 1], angle: 20, min: -170, max: 170, rest: 0, locked: true },
      { id: "elbow", parent: "base", offset: [2, 0, 0], axis: [0, 0, 1], angle: -20, min: -170, max: 170, rest: 0, locked: false },
    ],
    effectors: [{ id: "tip", joint: "elbow", point: [1, 0, 0], target: [2, 1, 0], weight: 1 }],
    regularization: 0.01, positionTolerance: 0.01, maxIterations: 2000,
  },
};

// ---------------- 全局状态 ----------------
const state = {
  caseObj: null,
  model: null,
  theta0: [],          // 初值 (用于重置)
  theta: [],           // 当前角度 (弧度)
  logRows: [],         // 每轮记录
  iterCount: 0,
  runState: "idle",    // idle | running | converged | stalled | max_iterations
  runReason: "",
  running: false,
  runToken: 0,
  showAxes: true,
  liveSolve: true,     // 拖动目标时热启动求解
  dragEffector: null,
};

const LS_SLOTS = "hinge-ik-slots-v1";
const LS_THEME = "hinge-ik-theme";

// ---------------- 小工具 ----------------
const $ = (id) => document.getElementById(id);
const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => Math.hypot(a[0], a[1], a[2]),
  unit: (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; },
};
function mat4LookAt(eye, center, up) {
  const f = v3.unit(v3.sub(center, eye));
  const s = v3.unit(v3.cross(f, up));
  const u = v3.cross(s, f);
  return [
    s[0], s[1], s[2], -v3.dot(s, eye),
    u[0], u[1], u[2], -v3.dot(u, eye),
    -f[0], -f[1], -f[2], v3.dot(f, eye),
    0, 0, 0, 1,
  ];
}
function transformPt(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}
function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("err", !!isErr);
  t.classList.add("show");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove("show"), 2600);
}
function fmt(x, digits = 5) {
  if (!isFinite(x)) return "—";
  if (Math.abs(x) >= 1000 || (x !== 0 && Math.abs(x) < 1e-3)) return x.toExponential(3);
  return Number(x.toFixed(digits)).toString();
}

// ---------------- 相机 ----------------
const cam = { yaw: 0.7, pitch: 0.42, dist: 9, target: [0, 0, 0], fov: 42 * Math.PI / 180 };
function camBasis() {
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const eye = [
    cam.target[0] + cam.dist * cp * Math.sin(cam.yaw),
    cam.target[1] + cam.dist * sp,
    cam.target[2] + cam.dist * cp * Math.cos(cam.yaw),
  ];
  const forward = v3.unit(v3.sub(cam.target, eye));
  const right = v3.unit(v3.cross(forward, [0, 1, 0]));
  const up = v3.cross(right, forward);
  return { eye, forward, right, up };
}

// ---------------- Canvas 渲染器 ----------------
class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.screenTargets = []; // 拾取缓存: {index, x, y, r}
    this._resize();
    window.addEventListener("resize", () => this._resize());
    // canvas 自身尺寸随布局 (grid 列高/fullPage) 变化时也要重新分配
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
    }
  }
  _resize() {
    const r = this.cv.getBoundingClientRect();
    this.w = Math.max(50, r.width);
    this.h = Math.max(50, r.height);
    const pw = Math.round(this.w * this.dpr), ph = Math.round(this.h * this.dpr);
    if (this.cv.width !== pw || this.cv.height !== ph) {
      this.cv.width = pw;
      this.cv.height = ph;
    }
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.needsRepaint = true;
  }
  flushRepaint() {
    if (this.needsRepaint && state.model) {
      this.needsRepaint = false;
      this.render(buildScene(), cssColors());
    }
  }
  project(p, view) {
    const v = transformPt(view, p);
    const depth = -v[2];
    if (depth <= 0.05) return null;
    const focal = this.h / 2 / Math.tan(cam.fov / 2);
    return {
      x: this.w / 2 + (v[0] / depth) * focal,
      y: this.h / 2 - (v[1] / depth) * focal,
      depth,
      scale: focal / depth,
    };
  }
  line(a, b, view, color, width, dash) {
    const pa = this.project(a, view), pb = this.project(b, view);
    if (!pa || !pb) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "round";
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    ctx.restore();
  }
  sphere(p, radius, view, color, ring) {
    const pr = this.project(p, view);
    if (!pr) return null;
    const r = Math.max(2.2, radius * pr.scale);
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(pr.x - r * 0.3, pr.y - r * 0.3, r * 0.1, pr.x, pr.y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, shade(color, -0.28));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(pr.x, pr.y, r, 0, Math.PI * 2); ctx.fill();
    if (ring) { ctx.strokeStyle = ring; ctx.lineWidth = 1.4; ctx.stroke(); }
    return { x: pr.x, y: pr.y, r };
  }
  arrow(origin, dir, len, view, color) {
    const end = v3.add(origin, v3.scale(v3.unit(dir), len));
    this.line(origin, end, view, color, 1.6);
    const pa = this.project(origin, view), pb = this.project(end, view);
    if (!pa || !pb) return;
    const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
    const hs = 6 + pb.scale * 0.0;
    const ctx = this.ctx;
    ctx.save(); ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(pb.x, pb.y);
    ctx.lineTo(pb.x - hs * Math.cos(ang - 0.42), pb.y - hs * Math.sin(ang - 0.42));
    ctx.lineTo(pb.x - hs * Math.cos(ang + 0.42), pb.y - hs * Math.sin(ang + 0.42));
    ctx.closePath(); ctx.fill(); ctx.restore();
  }
  text(str, p, view, color) {
    if (!str) return;
    const pr = this.project(p, view);
    if (!pr) return;
    const ctx = this.ctx;
    ctx.font = "11px " + getComputedStyle(document.body).fontFamily;
    const tx = pr.x + 8, ty = pr.y - 7;
    const w = ctx.measureText(str).width;
    ctx.save();
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    roundRect(ctx, tx - 3, ty - 10, w + 6, 15, 4);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.fillText(str, tx, ty);
  }
  drawGrid(view, css) {
    const ctx = this.ctx;
    ctx.save(); ctx.strokeStyle = css.line; ctx.lineWidth = 1;
    const size = 6, step = 1;
    for (let i = -size; i <= size; i++) {
      this.line([i * step, 0, -size * step], [i * step, 0, size * step], view, css.line, 1);
      this.line([-size * step, 0, i * step], [size * step, 0, i * step], view, css.line, 1);
    }
    ctx.restore();
  }
  render(scene, css) {
    this._resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const { eye } = camBasis();
    const view = mat4LookAt(eye, cam.target, [0, 1, 0]);
    this.drawGrid(view, css);
    this.screenTargets = [];

    // 关节轴 (在骨架之下)
    if (state.showAxes) {
      for (const j of scene.joints)
        this.arrow(j.pivot, j.axisW, 0.55, view, css.axis);
    }
    // 骨架连杆
    for (const j of scene.joints) {
      if (j.parentPivot) this.line(j.parentPivot, j.pivot, view, css.link, 3.4);
    }
    // 目标到末端的虚线
    scene.effectors.forEach((e) => {
      this.line(e.point, e.target, view, css.targetDim, 1.2, [5, 4]);
    });
    // 球体按深度从远到近
    const balls = [];
    scene.joints.forEach((j) => {
      const pr = this.project(j.pivot, view);
      if (pr) balls.push({ t: "joint", depth: pr.depth, p: j.pivot, r: 0.075, color: j.locked ? css.warn : css.joint, label: j.id, locked: j.locked });
    });
    scene.effectors.forEach((e, i) => {
      const pr1 = this.project(e.point, view);
      if (pr1) balls.push({ t: "eff", depth: pr1.depth, p: e.point, r: 0.085, color: css.good, label: "" });
      const pr2 = this.project(e.target, view);
      if (pr2) balls.push({ t: "target", depth: pr2.depth, p: e.target, r: 0.12, color: css.target, label: e.id, effIndex: i });
    });
    balls.sort((a, b) => b.depth - a.depth);
    for (const b of balls) {
      const got = this.sphere(b.p, b.r, view, b.color, b.locked ? css.warn : null);
      if (b.t === "target" && got) this.screenTargets.push({ index: b.effIndex, x: got.x, y: got.y, r: got.r });
      this.text(b.label, b.p, view, css.label);
    }
  }
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, Math.round(r + 255 * amt)));
  g = Math.max(0, Math.min(255, Math.round(g + 255 * amt)));
  b = Math.max(0, Math.min(255, Math.round(b + 255 * amt)));
  return `rgb(${r},${g},${b})`;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------- 场景构造 ----------------
function buildScene() {
  const { W, origin, axisW, pts } = state.model.fk(state.theta);
  const joints = state.model.joints.map((j, i) => ({
    pivot: origin[i],
    axisW: axisW[i],
    parentPivot: j.parent === null || j.parent === undefined ? null : origin[state.model.index[j.parent]],
    locked: state.model.locked[i],
    id: j.id,
  }));
  const effectors = state.model.effectors.map((e, ei) => ({
    id: e.id, point: pts[ei], target: e.target.slice(),
  }));
  return { joints, effectors };
}

function cssColors() {
  const s = getComputedStyle(document.documentElement);
  const get = (name) => s.getPropertyValue(name).trim();
  return {
    line: get("--line"), joint: get("--joint"), target: get("--target"),
    targetDim: get("--target"), good: get("--good"), axis: get("--axis"),
    warn: get("--warn"), label: get("--fg-dim"),
    link: get("--fg"),
  };
}

// ---------------- 配置装载与校验 ----------------
function validateCase(c) {
  if (!c || typeof c !== "object") throw new Error("配置不是 JSON 对象");
  if (!Array.isArray(c.joints) || c.joints.length === 0) throw new Error("joints 必须是非空数组");
  if (c.joints.length > 32) throw new Error("关节数超过上限 32");
  if (!Array.isArray(c.effectors) || c.effectors.length === 0) throw new Error("effectors 必须是非空数组");
  if (c.effectors.length > 8) throw new Error("末端数超过上限 8");
  const ids = new Set();
  for (const j of c.joints) {
    if (!j.id || typeof j.id !== "string") throw new Error("关节缺少 id");
    if (ids.has(j.id)) throw new Error("关节 id 重复: " + j.id);
    ids.add(j.id);
    for (const k of ["offset", "axis"]) if (!Array.isArray(j[k]) || j[k].length !== 3) throw new Error(`关节 ${j.id} 的 ${k} 必须是长度 3 的数组`);
    const n = Math.hypot(...j.axis);
    if (n < 1e-9) throw new Error(`关节 ${j.id} 的轴不能为零向量`);
    if (!(j.min <= j.angle && j.angle <= j.max)) throw new Error(`关节 ${j.id} 的初始角度超出 [min,max]`);
    if (!(j.min <= j.rest && j.rest <= j.max)) throw new Error(`关节 ${j.id} 的 rest 超出 [min,max]`);
    if (j.min > j.max) throw new Error(`关节 ${j.id} 的 min 大于 max`);
  }
  for (const j of c.joints) {
    if (j.parent !== null && j.parent !== undefined && !ids.has(j.parent))
      throw new Error(`关节 ${j.id} 引用了不存在的父关节 ${j.parent}`);
  }
  for (const e of c.effectors) {
    if (!ids.has(e.joint)) throw new Error(`末端 ${e.id} 引用了不存在的关节 ${e.joint}`);
    for (const k of ["point", "target"]) if (!Array.isArray(e[k]) || e[k].length !== 3) throw new Error(`末端 ${e.id} 的 ${k} 必须是长度 3 的数组`);
    if (!(Number(e.weight) > 0)) throw new Error(`末端 ${e.id} 的 weight 必须为正数`);
  }
  // 环检测 (KinModel 拓扑排序也会暴露, 这里提前给清晰错误)
  const byId = Object.fromEntries(c.joints.map((j) => [j.id, j]));
  for (const j of c.joints) {
    let cur = j, guard = 0;
    while (cur.parent !== null && cur.parent !== undefined) {
      cur = byId[cur.parent];
      if (++guard > c.joints.length) throw new Error("关节树存在环");
    }
  }
  c.positionTolerance = Number(c.positionTolerance ?? 0.01);
  c.maxIterations = Math.min(2000, Math.max(1, Number(c.maxIterations || 2000)));
  c.regularization = Number(c.regularization || 0);
  return c;
}

function loadCase(c) {
  stopRun();
  c = validateCase(structuredCloneSafe(c));
  state.caseObj = c;
  state.model = new KinModel(c);
  state.theta0 = state.model.theta.slice();
  state.theta = state.model.theta.slice();
  state.logRows = [];
  state.iterCount = 0;
  state.runState = "idle";
  state.runReason = "";
  frameCamera();
  resetLogToInitial();
  rebuildJointPanel();
  rebuildEffectorPanel();
  syncLambdaInput();
  refreshAll();
  $("config-text").value = JSON.stringify(exportConfig(), null, 2);
  $("vp-sub").textContent = `${c.joints.length} 关节 · ${c.effectors.length} 末端 · λ=${c.regularization} · 容差 ${c.positionTolerance}`;
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}

function exportConfig() {
  const c = state.caseObj;
  return {
    joints: c.joints.map((j, i) => ({
      id: j.id, parent: j.parent, offset: j.offset, axis: j.axis,
      angle: Number((state.theta[i] / DEG).toFixed(10)),
      min: j.min, max: j.max, rest: j.rest, locked: state.model.locked[i],
    })),
    effectors: c.effectors.map((e) => ({
      id: e.id, joint: e.joint, point: e.point,
      target: e.target.map((v) => Number(v.toFixed(10))), weight: e.weight,
    })),
    regularization: state.model.lam,
    positionTolerance: state.model.tol,
    maxIterations: state.model.maxIter,
  };
}

function frameCamera() {
  // 用骨架包围盒设定相机距离与注视中心; 不依赖画布尺寸 (首帧画布可能尚未布局)
  const { origin } = state.model.fk(state.theta);
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of origin) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
  for (const e of state.model.effectors) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], e.target[k]); mx[k] = Math.max(mx[k], e.target[k]); }
  const center = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2);
  const radius = Math.max(1.5, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2);
  cam.target = center;
  // 固定垂直视场角下, 让包围盒占视口约 60% 高; 宽高比留给投影处理
  cam.dist = radius / Math.sin(cam.fov / 2) / 0.6;
  cam.dist = Math.max(2, Math.min(40, cam.dist));
}

// ---------------- 面板构建 ----------------
function rebuildJointPanel() {
  const host = $("joint-list");
  host.innerHTML = "";
  state.model.joints.forEach((j, i) => {
    const div = document.createElement("div");
    div.className = "row-item";
    const locked = state.model.locked[i];
    div.innerHTML = `
      <div class="top">
        <span class="name">${j.id}</span>
        <span class="tag">${j.parent ?? "root"}</span>
        <label class="flex-between gap6" style="font-size:11px;color:var(--fg-dim)">
          <input type="checkbox" data-lock="${i}" ${locked ? "checked" : ""}> 锁定
        </label>
      </div>
      <div class="angle-line">
        <input type="range" data-rang="${i}" min="${j.min}" max="${j.max}" step="0.01"
          value="${(state.theta[i] / DEG).toFixed(3)}" ${locked ? "disabled" : ""}>
        <input type="number" data-num="${i}" min="${j.min}" max="${j.max}" step="0.1"
          value="${(state.theta[i] / DEG).toFixed(3)}" ${locked ? "disabled" : ""}>
      </div>
      <div class="limit-note">轴 [${j.axis.join(", ")}] · 限位 [${j.min}°, ${j.max}°] · rest ${j.rest}°</div>`;
    host.appendChild(div);
  });
  host.querySelectorAll("[data-rang]").forEach((el) => el.addEventListener("input", onAngleSlide));
  host.querySelectorAll("[data-num]").forEach((el) => el.addEventListener("input", onAngleNum));
  host.querySelectorAll("[data-lock]").forEach((el) => el.addEventListener("change", onLockToggle));
}

function rebuildEffectorPanel() {
  const host = $("eff-list");
  host.innerHTML = "";
  state.model.effectors.forEach((e, ei) => {
    const div = document.createElement("div");
    div.className = "eff-item";
    div.innerHTML = `
      <div class="flex-between">
        <span class="name" style="font-weight:600;font-size:12.5px">${e.id}</span>
        <span class="tag">挂于 ${e.joint} · w=${e.weight}</span>
      </div>
      <div class="eff-grid">
        ${["x", "y", "z"].map((ax, k) => `
          <label class="fld"><span class="axis-tag">目标 ${ax}</span>
            <input type="number" step="0.01" data-tgt="${ei}" data-axis="${k}" value="${e.target[k].toFixed(4)}">
          </label>`).join("")}
      </div>
      <div class="eff-meta">
        <span>当前误差</span><span class="err mono" data-err="${ei}">—</span>
      </div>`;
    host.appendChild(div);
  });
  host.querySelectorAll("[data-tgt]").forEach((el) => el.addEventListener("input", onTargetNum));
}

function syncLambdaInput() { $("lambda-in").value = state.model.lam; }

// ---------------- 交互回调 ----------------
function onAngleSlide(ev) {
  const i = Number(ev.target.dataset.rang);
  setAngleDeg(i, Number(ev.target.value));
}
function onAngleNum(ev) {
  const i = Number(ev.target.dataset.num);
  let v = Number(ev.target.value);
  if (!isFinite(v)) return;
  const j = state.model.joints[i];
  v = Math.min(Math.max(v, j.min), j.max);
  setAngleDeg(i, v);
}
function setAngleDeg(i, deg) {
  stopRun();
  const j = state.model.joints[i];
  deg = Math.min(Math.max(deg, j.min), j.max);
  state.theta[i] = deg * DEG;
  state.model.theta = state.theta.slice();
  // 手动改角度后, 求解回到未运行状态并以当前姿态重记第 0 轮
  state.runState = "idle"; state.runReason = "";
  resetLogToInitial();
  const panel = $("joint-list");
  const r = panel.querySelector(`[data-rang="${i}"]`), n = panel.querySelector(`[data-num="${i}"]`);
  if (r) r.value = deg.toFixed(3);
  if (n) n.value = deg.toFixed(3);
  refreshAll();
}
function onLockToggle(ev) {
  const i = Number(ev.target.dataset.lock);
  const locked = ev.target.checked;
  state.model.locked[i] = locked;
  state.model.free = [];
  for (let k = 0; k < state.model.n; k++) if (!state.model.locked[k]) state.model.free.push(k);
  state.caseObj.joints[i].locked = locked;
  // 锁定集合改变后重新进入未运行状态, 重记第 0 轮
  state.runState = "idle"; state.runReason = "";
  resetLogToInitial();
  rebuildJointPanel();
  refreshAll();
  toast(locked ? `关节 ${state.model.joints[i].id} 已锁定, 不再参与更新` : `关节 ${state.model.joints[i].id} 已解锁`);
}
function onTargetNum(ev) {
  const ei = Number(ev.target.dataset.tgt), k = Number(ev.target.dataset.axis);
  const v = Number(ev.target.value);
  if (!isFinite(v)) return;
  state.model.effectors[ei].target[k] = v;
  state.caseObj.effectors[ei].target[k] = v;
  afterTargetChanged(false);
}

// liveDrag=true 时 (鼠标拖动中) 仅更新几何, 松手再求解, 避免逐像素跑完整 IK
function afterTargetChanged(liveDrag = false) {
  if (state.runState === "converged" || state.runState === "stalled" || state.runState === "max_iterations") {
    state.runState = "idle"; state.runReason = "";
  }
  if (!liveDrag && state.liveSolve && state.model.free.length > 0) {
    // 热启动: 从当前角度继续, 预算内求解 (多目标耦合, 共享关节只保留一个状态)
    const r = solve(state.model, state.theta, true);
    state.theta = r.theta;
    state.model.theta = state.theta.slice();
    state.iterCount = r.iterations;
    state.runState = r.status; state.runReason = r.reason;
    state.logRows = r.log;
    state.ik = new IKIterator(state.model, state.theta);
    syncAngleControls();
  } else {
    resetLogToInitial();
  }
  refreshAll();
}

function syncAngleControls() {
  const panel = $("joint-list");
  state.model.joints.forEach((j, i) => {
    const r = panel.querySelector(`[data-rang="${i}"]`), n = panel.querySelector(`[data-num="${i}"]`);
    const deg = (state.theta[i] / DEG).toFixed(3);
    if (r && !r.disabled) r.value = deg;
    if (n && !n.disabled) n.value = deg;
  });
}

// ---------------- 求解运行控制 ----------------
function resetLogToInitial() {
  const c = state.model.costs(state.theta);
  state.logRows = [{
    iteration: 0, effectorErrors: c.errs.slice(), positionCost: c.pos,
    regCost: c.reg, totalCost: c.total, mu: 1e-3, stepNorm: 0,
  }];
  state.iterCount = 0;
  // 任何改变问题或初值的操作都重置迭代器, 保证单步与运行走同一条确定性路径
  state.ik = new IKIterator(state.model, state.theta);
}

function appendLogRow(snap) {
  state.logRows.push({
    iteration: snap.iteration,
    effectorErrors: snap.errors.slice(),
    positionCost: snap.positionCost, regCost: snap.regCost,
    totalCost: snap.totalCost, mu: snap.mu, stepNorm: snap.stepNorm,
  });
  if (state.logRows.length > 2005) state.logRows.shift();
}

function stepSolver() {
  if (!state.model) return;
  if (state.runState === "converged" || state.runState === "stalled" || state.runState === "max_iterations") return;
  const snap = state.ik.next();
  state.theta = snap.theta;
  state.model.theta = state.theta.slice();
  state.iterCount = snap.iteration;
  appendLogRow(snap);
  if (snap.done) { state.runState = snap.status; state.runReason = snap.reason; }
  else state.runState = "running";
  syncAngleControls();
  refreshAll();
}

async function runToStop() {
  if (!state.model || state.running) return;
  if (state.runState === "converged" || state.runState === "stalled" || state.runState === "max_iterations") return;
  const token = ++state.runToken;
  state.running = true;
  state.runState = "running";
  updateRunButtons();
  const delay = Math.max(0, Number($("run-delay").value) || 0);
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  while (state.runToken === token) {
    const snap = state.ik.next();
    state.theta = snap.theta;
    state.model.theta = state.theta.slice();
    state.iterCount = snap.iteration;
    appendLogRow(snap);
    syncAngleControls();
    refreshAll();
    if (snap.done) { state.runState = snap.status; state.runReason = snap.reason; break; }
    if (state.iterCount >= state.model.maxIter) {
      state.runState = "max_iterations";
      state.runReason = "达到最大迭代次数仍未满足位置容差";
      break;
    }
    if (delay > 0) await sleep(delay);
  }
  state.running = false;
  updateRunButtons();
  refreshAll();
}

function stopRun() {
  state.runToken++;
  state.running = false;
  if (state.runState === "running") { state.runState = "idle"; state.runReason = ""; }
  updateRunButtons();
}

function resetPose() {
  stopRun();
  state.theta = state.theta0.slice();
  state.model.theta = state.theta.slice();
  state.runState = "idle"; state.runReason = "";
  resetLogToInitial();
  rebuildJointPanel();
  refreshAll();
  toast("已重置为配置中的初始角度");
}

function updateRunButtons() {
  $("btn-run").disabled = state.running || ["converged", "stalled", "max_iterations"].includes(state.runState);
  $("btn-step").disabled = state.running || ["converged", "stalled", "max_iterations"].includes(state.runState);
  $("btn-stop").disabled = !state.running;
}

// ---------------- 刷新所有读数 ----------------
function refreshAll() {
  if (!state.model) return;
  const c = state.model.costs(state.theta);
  const maxErr = c.errs.length ? Math.max(...c.errs) : 0;
  $("m-iter").textContent = state.iterCount;
  const me = $("m-maxerr");
  me.textContent = fmt(maxErr, 5);
  me.className = "v mono " + (maxErr < state.model.tol ? "good" : "bad");
  $("m-poscost").textContent = fmt(c.pos, 6);
  $("m-regcost").textContent = fmt(c.reg, 6);
  $("m-totalcost").textContent = fmt(c.total, 6);
  $("budget-note").textContent = `上限 ${state.model.maxIter} 轮`;

  // 末端误差
  state.model.effectors.forEach((e, ei) => {
    const el = document.querySelector(`[data-err="${ei}"]`);
    if (el) {
      const d = c.errs[ei];
      el.textContent = fmt(d, 5);
      el.style.color = d < state.model.tol ? "var(--good)" : "var(--bad)";
    }
  });

  // 状态徽章
  const pill = $("status-pill");
  const map = {
    idle: ["status-idle", "未运行"],
    running: ["status-running", "迭代中"],
    converged: ["status-converged", "已到达"],
    stalled: ["status-stalled", "停滞/不可达"],
    max_iterations: ["status-stalled", "达到迭代上限"],
  };
  const [cls, label] = map[state.runState] || map.idle;
  pill.className = "status-pill " + cls;
  pill.textContent = label;

  // 停止原因
  const box = $("reason-box");
  if (state.runReason && state.runState !== "idle" && state.runState !== "running") {
    box.classList.remove("hidden");
    box.className = "reason-box " + (state.runState === "converged" ? "good" : "bad");
    $("reason-text").textContent = state.runReason +
      (state.runState !== "converged" ? `；当前最大残差 ${fmt(maxErr, 5)} (容差 ${state.model.tol})` : "");
  } else box.classList.add("hidden");

  renderLogTable();
  updateRunButtons();
  renderer.render(buildScene(), cssColors());
  $("config-text").value = JSON.stringify(exportConfig(), null, 2);
}

function renderLogTable() {
  const tb = $("log-body");
  const rows = state.logRows.slice(-120);
  const freshIter = state.logRows.length ? state.logRows[state.logRows.length - 1].iteration : 0;
  tb.innerHTML = rows.map((r) => {
    const maxE = r.effectorErrors.length ? Math.max(...r.effectorErrors) : 0;
    return `<tr class="${r.iteration === freshIter && r.iteration > 0 ? "fresh" : ""}">
      <td>${r.iteration}</td><td>${fmt(r.totalCost, 5)}</td><td>${fmt(r.positionCost, 5)}</td>
      <td>${fmt(r.regCost, 5)}</td><td>${fmt(maxE, 5)}</td><td>${fmt(r.mu, 3)}</td></tr>`;
  }).join("");
  tb.parentElement.parentElement.scrollTop = tb.parentElement.parentElement.scrollHeight;
}

// ---------------- 视口交互: 旋转/缩放/平移/拖拽目标 ----------------
let renderer;
function initViewport() {
  const cv = $("gl");
  renderer = new Renderer(cv);
  const ptr = { down: false, mode: null, x: 0, y: 0 };

  cv.addEventListener("pointerdown", (ev) => {
    cv.setPointerCapture(ev.pointerId);
    ptr.x = ev.clientX; ptr.y = ev.clientY; ptr.down = true;
    const rect = cv.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    if (ev.button === 2) { ptr.mode = "pan"; return; }
    // 优先拾取目标球
    let hit = null;
    for (const t of renderer.screenTargets) {
      if (Math.hypot(t.x - sx, t.y - sy) <= t.r + 7) { hit = t; break; }
    }
    if (hit) {
      ptr.mode = "target";
      state.dragEffector = hit.index;
      const { eye, forward } = camBasis();
      ptr.drag = {
        planeP: state.model.effectors[hit.index].target.slice(),
        normal: forward, eye, depth: ev.shiftKey,
      };
      cv.classList.add("dragging");
    } else { ptr.mode = "rotate"; cv.classList.add("dragging"); }
  });

  cv.addEventListener("pointermove", (ev) => {
    if (!ptr.down) { hoverCursor(ev, cv); return; }
    const dx = ev.clientX - ptr.x, dy = ev.clientY - ptr.y;
    ptr.x = ev.clientX; ptr.y = ev.clientY;
    if (ptr.mode === "rotate") {
      cam.yaw += dx * 0.008;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.008));
      renderer.render(buildScene(), cssColors());
    } else if (ptr.mode === "pan") {
      const { right, up } = camBasis();
      const k = cam.dist * 0.0016;
      cam.target = v3.add(cam.target, v3.add(v3.scale(right, -dx * k), v3.scale(up, dy * k)));
      renderer.render(buildScene(), cssColors());
    } else if (ptr.mode === "target") {
      dragTarget(ev, cv, ptr);
    }
  });

  const end = (ev) => {
    const wasTarget = ptr.mode === "target";
    ptr.down = false; ptr.mode = null; state.dragEffector = null;
    cv.classList.remove("dragging");
    if (wasTarget) afterTargetChanged(false); // 松手后执行一次完整热启动 IK
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("contextmenu", (ev) => ev.preventDefault());
  cv.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    cam.dist = Math.max(0.5, Math.min(60, cam.dist * (1 + Math.sign(ev.deltaY) * 0.09)));
    renderer.render(buildScene(), cssColors());
  }, { passive: false });
}

function hoverCursor(ev, cv) {
  const rect = cv.getBoundingClientRect();
  const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
  const over = renderer.screenTargets.some((t) => Math.hypot(t.x - sx, t.y - sy) <= t.r + 7);
  cv.style.cursor = over ? "pointer" : "grab";
}

function dragTarget(ev, cv, ptr) {
  const rect = cv.getBoundingClientRect();
  const ndcX = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
  const { eye, forward, right, up } = camBasis();
  const aspect = rect.width / rect.height;
  const tFov = Math.tan(cam.fov / 2);
  const dir = v3.unit(v3.add(forward, v3.add(
    v3.scale(right, ndcX * tFov * aspect),
    v3.scale(up, ndcY * tFov))));
  const ei = state.dragEffector;
  const p0 = ptr.drag.planeP;
  let newPos;
  if (ev.shiftKey) {
    // 深度模式: 沿视线方向移动, 位移量由垂直拖动控制
    const t = v3.dot(v3.sub(p0, eye), forward) / Math.max(1e-6, v3.dot(dir, forward));
    const hit = v3.add(eye, v3.scale(dir, t));
    const depthShift = v3.dot(v3.sub(hit, p0), forward);
    newPos = v3.add(p0, v3.scale(forward, depthShift));
  } else {
    const denom = v3.dot(dir, ptr.drag.normal);
    if (Math.abs(denom) < 1e-6) return;
    const t = v3.dot(v3.sub(p0, ptr.drag.eye), ptr.drag.normal) / denom;
    newPos = v3.add(ptr.drag.eye, v3.scale(dir, t));
  }
  state.model.effectors[ei].target = newPos;
  state.caseObj.effectors[ei].target = newPos.slice();
  // 同步数字输入
  const host = $("eff-list");
  [0, 1, 2].forEach((k) => {
    const inp = host.querySelector(`[data-tgt="${ei}"][data-axis="${k}"]`);
    if (inp) inp.value = newPos[k].toFixed(4);
  });
  afterTargetChanged(true);
}

// ---------------- 配置存取 (localStorage 槽位 + 剪贴板 + 文件) ----------------
function listSlots() {
  try { return JSON.parse(localStorage.getItem(LS_SLOTS) || "{}"); }
  catch { return {}; }
}
function writeSlots(slots) { localStorage.setItem(LS_SLOTS, JSON.stringify(slots)); }

function saveSlot() {
  const name = $("slot-name").value.trim();
  if (!name) { toast("请先在上方输入槽位名称", true); $("slot-name").focus(); return; }
  const slots = listSlots();
  slots[name] = exportConfig();
  writeSlots(slots);
  refreshSlotSelect();
  $("sample-select").value = "slot:" + name;
  toast(`已保存到本地槽位「${name}」`);
}
function deleteSlot() {
  const name = $("slot-name").value.trim();
  const slots = listSlots();
  if (!name || !slots[name]) { toast("该名称的槽位不存在", true); return; }
  delete slots[name];
  writeSlots(slots);
  refreshSlotSelect();
  toast(`已删除槽位「${name}」`);
}
function refreshSlotSelect() {
  const sel = $("sample-select");
  const current = sel.value;
  const slots = listSlots();
  sel.innerHTML = `<optgroup label="内置样例">${Object.keys(SAMPLES).map((n) => `<option value="sample:${n}">${n}</option>`).join("")}</optgroup>` +
    (Object.keys(slots).length ? `<optgroup label="已保存槽位">${Object.keys(slots).map((n) => `<option value="slot:${n}">${n}</option>`).join("")}</optgroup>` : "");
  if (current) sel.value = current;
}
function loadSelected() {
  const v = $("sample-select").value;
  if (!v) return;
  if (v.startsWith("sample:")) loadCase(SAMPLES[v.slice(7)]);
  else if (v.startsWith("slot:")) {
    const c = listSlots()[v.slice(5)];
    if (c) loadCase(c); else toast("槽位不存在", true);
  }
}

async function copyConfig() {
  const text = JSON.stringify(exportConfig(), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    toast("完整配置已复制到剪贴板");
  } catch {
    $("config-text").value = text;
    $("config-text").select();
    toast("剪贴板不可用, 已填入下方文本框可手动复制", true);
  }
}
async function copyLog() {
  const payload = {
    exportedAt: new Date().toISOString(),
    case: exportConfig(),
    finalStatus: state.runState,
    reason: state.runReason,
    iterations: state.iterCount,
    log: state.logRows,
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    toast("每轮记录已复制为 JSON");
  } catch {
    $("config-text").value = JSON.stringify(payload, null, 2);
    toast("剪贴板不可用, 记录已填入文本框", true);
  }
}

function importFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const c = JSON.parse(String(reader.result));
      loadCase(c);
      toast(`已导入 ${file.name}`);
    } catch (e) {
      toast("导入失败: " + e.message, true);
    }
  };
  reader.readAsText(file);
}

// ---------------- 主题 ----------------
function initTheme() {
  let theme = null;
  try { theme = localStorage.getItem(LS_THEME); } catch {}
  if (theme) document.documentElement.dataset.theme = theme;
  $("theme-btn").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = cur;
    try { localStorage.setItem(LS_THEME, cur); } catch {}
    if (renderer) renderer.render(buildScene(), cssColors());
  });
}

// ---------------- 启动 ----------------
function init() {
  initTheme();
  initViewport();
  refreshSlotSelect();
  $("sample-select").value = "sample:shared.json";
  loadCase(SAMPLES["shared.json"]);
  // 统一在动画帧里处理布局变化导致的延迟重绘
  const tick = () => { renderer.flushRepaint(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  $("btn-run").addEventListener("click", runToStop);
  $("btn-step").addEventListener("click", stepSolver);
  $("btn-stop").addEventListener("click", stopRun);
  $("btn-reset").addEventListener("click", resetPose);
  $("btn-determinism").addEventListener("click", () => {
    const r = determinismCheck(state.model);
    if (r.identical)
      toast(`确定性通过: 两次求解均 ${r.iterations} 轮、状态 ${r.status}, 角度与逐轮日志逐位一致`);
    else
      toast("确定性失败: 两次结果不一致", true);
  });
  $("btn-load-sample").addEventListener("click", loadSelected);
  $("btn-save").addEventListener("click", saveSlot);
  $("btn-delete-slot").addEventListener("click", deleteSlot);
  $("sample-select").addEventListener("change", () => {
    const v = $("sample-select").value;
    if (v.startsWith("slot:")) $("slot-name").value = v.slice(5);
  });
  $("btn-copy-config").addEventListener("click", copyConfig);
  $("btn-export-log").addEventListener("click", copyLog);
  $("btn-apply-config").addEventListener("click", () => {
    try {
      const c = JSON.parse($("config-text").value);
      loadCase(c);
      toast("JSON 配置已应用");
    } catch (e) { toast("JSON 解析失败: " + e.message, true); }
  });
  $("file-in").addEventListener("change", (ev) => {
    if (ev.target.files[0]) importFile(ev.target.files[0]);
    ev.target.value = "";
  });
  $("lambda-in").addEventListener("change", (ev) => {
    const v = Number(ev.target.value);
    if (!(v >= 0)) { toast("λ 必须是非负数", true); syncLambdaInput(); return; }
    state.model.lam = v; state.caseObj.regularization = v;
    refreshAll();
  });
  $("show-axes").addEventListener("change", (ev) => {
    state.showAxes = ev.target.checked;
    renderer.render(buildScene(), cssColors());
  });
}

document.addEventListener("DOMContentLoaded", init);
