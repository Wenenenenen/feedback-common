// 自研 WebGL 三维线框渲染器：轨道旋转/缩放、射线拾取顶点、原网格叠加。
// 不使用任何现成网格/变形库，仅用裸 WebGL 画线段与点。

const VERT = `
attribute vec3 aPos;
attribute vec3 aColor;
attribute float aSize;
uniform mat4 uViewProj;
varying vec3 vColor;
varying float vSize;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  vColor = aColor;
  vSize = aSize;
  gl_PointSize = aSize;
}`;

const FRAG = `
precision mediump float;
varying vec3 vColor;
varying float vSize;
void main() {
  // 点精灵画成圆形
  vec2 d = gl_PointCoord - vec2(0.5);
  if (vSize > 1.0 && dot(d, d) > 0.25) discard;
  gl_FragColor = vec4(vColor, 1.0);
}`;

function mat4Identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}
function lookAt(eye, center, up) {
  const z = norm3(sub(eye, center));
  const x = norm3(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

export class WireView {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL');
    this.gl = gl;
    this.program = this._buildProgram(VERT, FRAG);
    this.loc = {
      aPos: gl.getAttribLocation(this.program, 'aPos'),
      aColor: gl.getAttribLocation(this.program, 'aColor'),
      aSize: gl.getAttribLocation(this.program, 'aSize'),
      uViewProj: gl.getUniformLocation(this.program, 'uViewProj'),
    };
    // 轨道相机状态：默认 3/4 等测视角
    this.yaw = 0.75;
    this.pitch = 0.5;
    this.distance = 0;
    this.target = [0, 0, 0];
    this.fovy = Math.PI / 5;
    this._lineBuffer = gl.createBuffer();
    this._pointBuffer = gl.createBuffer();
    this._counts = { lines: 0, points: 0 };
    this._restEdges = null; // 叠加用
    this.restVertices = null;
    this.showRest = true;
    this.highlight = new Set();
    this.selected = -1;
    this.pinnedSet = new Set();
    this.colors = {
      line: [0.36, 0.62, 0.95],
      rest: [0.42, 0.45, 0.52],
      point: [0.42, 0.66, 0.97],
      pin: [0.95, 0.45, 0.35],
      select: [1.0, 0.82, 0.25],
      freeze: [0.55, 0.55, 0.6],
    };
    this._bindControls();
    this.onPick = null;
  }

  _buildProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  setMesh(rest, edges, triangles) {
    this.restVertices = rest;
    // 边由三角形提取后的无向边（传入已去重的顶点对）
    this._restEdges = edges;
    this._computeBounds(rest);
  }

  _computeBounds(verts) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v[k]);
        max[k] = Math.max(max[k], v[k]);
      }
    }
    this.bounds = { min, max };
    this.target = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
    const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
    this.distance = radius * 2.6;
  }

  setPinned(set) { this.pinnedSet = set; }
  setSelected(i) { this.selected = i; }
  setShowRest(on) { this.showRest = on; }

  // 复位到默认 3/4 等测视角
  resetView() {
    this.yaw = 0.75;
    this.pitch = 0.5;
    if (this.restVertices) this._computeBounds(this.restVertices);
  }

  _bindControls() {
    const c = this.canvas;
    let dragging = false;
    let lastX = 0, lastY = 0;
    c.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.yaw -= dx * 0.008;
      this.pitch += dy * 0.008;
      this.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch));
    });
    c.addEventListener('pointerup', (e) => {
      if (dragging && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 4) {
        this._handleClick(e);
      }
      dragging = false;
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance *= 1 + Math.sign(e.deltaY) * 0.08;
      this.distance = Math.max(1e-3, this.distance);
    }, { passive: false });
  }

  _eyePos() {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
  }

  _viewProj() {
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const eye = this._eyePos();
    const view = lookAt(eye, this.target, [0, 1, 0]);
    const near = this.distance * 0.01;
    const far = this.distance * 100;
    const proj = perspective(this.fovy, aspect, Math.max(1e-4, near), far);
    return mat4Mul(proj, view);
  }

  // 射线拾取：由相机基向量直接解析构造屏幕射线（不依赖矩阵求逆）
  _handleClick(e) {
    if (!this.restVertices || !this.onPick) return;
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);

    // 相机局部基（与 lookAt 一致）：forward 指向目标，right/up 张成像平面
    const eye = this._eyePos();
    const fwd = norm3(sub(this.target, eye));
    const worldUp = [0, 1, 0];
    const right = norm3(cross(worldUp, fwd));
    const camUp = cross(fwd, right);
    const tanHalf = Math.tan(this.fovy / 2);

    // 像素射线方向：forward + 屏幕偏移 * right/up
    const dir = norm3([
      fwd[0] + right[0] * nx * tanHalf * aspect + camUp[0] * ny * tanHalf,
      fwd[1] + right[1] * nx * tanHalf * aspect + camUp[1] * ny * tanHalf,
      fwd[2] + right[2] * nx * tanHalf * aspect + camUp[2] * ny * tanHalf,
    ]);
    const origin = eye;

    // 找射线距离最小的顶点
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.restVertices.length; i++) {
      const v = this._pickPos(i);
      const rel = sub(v, origin);
      const t = dot(rel, dir);
      const closest = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
      const d = Math.hypot(v[0] - closest[0], v[1] - closest[1], v[2] - closest[2]);
      if (d < bestD) { bestD = d; best = i; }
    }
    // 世界距离阈值：相机距离的约 3%，屏幕上点选足够宽松又减少误选
    const threshold = this.distance * 0.03;
    if (best >= 0 && bestD <= threshold) this.onPick(best);
  }

  // 拾取使用当前变形坐标（若有），否则 rest
  _pickPos(i) {
    return this._deformed && this._deformed[i] ? this._deformed[i] : this.restVertices[i];
  }

  render(deformed, frozen) {
    const gl = this.gl;
    this._deformed = deformed;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(...this._clearColor(), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.program);
    const vp = this._viewProj();
    gl.uniformMatrix4fv(this.loc.uViewProj, false, vp);

    const lineVerts = [];
    const pushSeg = (a, b, col) => {
      lineVerts.push(...a, ...col, ...b, ...col);
    };
    // 原网格叠加（灰，虚线感用半透明色近似）
    if (this.showRest && this._restEdges) {
      const rc = this.colors.rest;
      for (const [a, b] of this._restEdges) {
        pushSeg(this.restVertices[a], this.restVertices[b], rc);
      }
    }
    // 变形网格边
    const lc = this.colors.line;
    for (const [a, b] of this._restEdges) {
      pushSeg(deformed[a], deformed[b], lc);
    }
    this._upload(this._lineBuffer, lineVerts, 7);
    this._counts.lines = lineVerts.length / 7;
    gl.drawArrays(gl.LINES, 0, this._counts.lines);

    // 顶点
    const pointVerts = [];
    const baseSize = this._pointPixelSize();
    for (let i = 0; i < deformed.length; i++) {
      let col = this.colors.point;
      let size = baseSize;
      if (frozen && frozen[i]) col = this.colors.freeze;
      if (this.pinnedSet.has(i)) { col = this.colors.pin; size = baseSize * 1.5; }
      if (i === this.selected) { col = this.colors.select; size = baseSize * 1.9; }
      pointVerts.push(...deformed[i], ...col, size);
    }
    this._upload(this._pointBuffer, pointVerts, 7);
    this._counts.points = pointVerts.length / 7;
    gl.drawArrays(gl.POINTS, 0, this._counts.points);
  }

  _pointPixelSize() {
    // 随距离衰减的点大小，限制在合理范围
    const s = 260 / this.distance;
    return Math.max(3, Math.min(14, s));
  }

  _upload(buffer, data, stride) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.loc.aPos);
    gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, stride * 4, 0);
    gl.enableVertexAttribArray(this.loc.aColor);
    gl.vertexAttribPointer(this.loc.aColor, 3, gl.FLOAT, false, stride * 4, 12);
    gl.enableVertexAttribArray(this.loc.aSize);
    gl.vertexAttribPointer(this.loc.aSize, 1, gl.FLOAT, false, stride * 4, 24);
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  _clearColor() {
    // 从 CSS 变量读取背景，保持主题一致
    const bg = getComputedStyle(this.canvas).getPropertyValue('--canvas-bg').trim() || '#0e1116';
    const n = parseInt(bg.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
}

// 通用 4x4 逆矩阵（余子式展开，列主序与本文件矩阵一致）
