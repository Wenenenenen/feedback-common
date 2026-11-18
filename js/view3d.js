// 原生 WebGL 3D 视图。切线变换与法线映射均在自写着色器中完成，不调用任何现成接口。
// 顶点着色器内做：位置乘实例矩阵、N 乘逆转置、T 乘线性部分后重新正交化、h 乘行列式符号。
import { v3, m4 } from './math.js';

const MESH_VS = `
attribute vec3 aPos;
attribute vec3 aN;
attribute vec3 aT;
attribute vec2 aUV;
attribute float aH;       // 手性 ±1
attribute float aDetSign; // UV 行列式符号
uniform mat4 uProj, uView, uModel;
uniform mat3 uLinear, uNormalMat;
uniform float uDetSign;
varying vec3 vN, vT, vB;
varying vec2 vUV;
varying float vH, vDetSign;
void main() {
  vec3 N = normalize(uNormalMat * aN);
  vec3 T = uLinear * aT;
  T = T - N * dot(N, T);
  T = length(T) > 1e-10 ? normalize(T) : normalize(cross(N, vec3(1.0, 0.0, 0.0)) + vec3(1e-6));
  float h = aH * uDetSign;
  vN = N; vT = T; vB = h * cross(N, T);
  vH = h; vDetSign = aDetSign; vUV = aUV;
  gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
}`;

const MESH_FS = `
precision mediump float;
varying vec3 vN, vT, vB;
varying vec2 vUV;
varying float vH, vDetSign;
uniform vec3 uLightDir; // 指向光源的固定方向（世界系）
uniform int uMode;      // 0 几何法线 1 切线法线 2 手性 3 UV手性
uniform sampler2D uMap;
uniform bool uUseMap;
void main() {
  vec3 N = normalize(vN);
  if (uMode == 2) {
    gl_FragColor = vec4(vH > 0.0 ? vec3(0.2, 0.85, 0.3) : vec3(0.95, 0.25, 0.2), 1.0);
    return;
  }
  if (uMode == 3) {
    gl_FragColor = vec4(vDetSign >= 0.0 ? vec3(0.35, 0.55, 0.95) : vec3(0.95, 0.6, 0.2), 1.0);
    return;
  }
  vec3 n = N;
  if (uMode == 1 && uUseMap) {
    vec3 t = texture2D(uMap, vec2(vUV.x, 1.0 - vUV.y)).rgb * 2.0 - 1.0;
    float l = length(t);
    t = l > 1e-4 ? t / l : vec3(0.0, 0.0, 1.0);
    n = normalize(normalize(vT) * t.x + normalize(vB) * t.y + N * t.z);
  }
  float diff = max(dot(n, uLightDir), 0.0);
  vec3 base = uMode == 1 ? vec3(0.75, 0.72, 0.68) : vec3(0.55, 0.7, 0.9);
  gl_FragColor = vec4(base * (0.18 + 0.82 * diff), 1.0);
}`;

const LINE_VS = `
attribute vec3 aPos;
attribute vec3 aColor;
uniform mat4 uProj, uView;
varying vec3 vColor;
void main() { vColor = aColor; gl_Position = uProj * uView * vec4(aPos, 1.0); }`;

const LINE_FS = `
precision mediump float;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function link(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export class View3D {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { antialias: true });
    if (!gl) throw new Error('当前环境不支持 WebGL');
    this.gl = gl;
    this.meshProg = link(gl, MESH_VS, MESH_FS);
    this.lineProg = link(gl, LINE_VS, LINE_FS);
    this.mode = 0;
    this.lightDir = v3.normalize([0.45, 0.75, 0.55]); // 固定方向光
    this.cam = { theta: 0.7, phi: 1.0, dist: 3.0, target: [0, 0, 0] };
    this.vertCount = 0;
    this.axes = null; // {data: Float32Array, count}
    this.texture = null;
    this._initBuffers();
    this._initInput();
  }

  _initBuffers() {
    const gl = this.gl;
    this.meshVAO = {
      pos: gl.createBuffer(), n: gl.createBuffer(), t: gl.createBuffer(),
      uv: gl.createBuffer(), h: gl.createBuffer(), det: gl.createBuffer(),
    };
    this.lineBuf = gl.createBuffer();
    this.lineColorBuf = gl.createBuffer();
  }

  _initInput() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, btn: e.button, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.btn === 0 && !e.shiftKey) {
        this.cam.theta -= dx * 0.008;
        this.cam.phi = Math.min(3.1, Math.max(0.05, this.cam.phi - dy * 0.008));
      } else {
        const right = v3.normalize([Math.cos(this.cam.theta), 0, -Math.sin(this.cam.theta)]);
        const up = [0, 1, 0];
        const s = this.cam.dist * 0.0016;
        this.cam.target = v3.add(this.cam.target, v3.add(v3.scale(right, -dx * s), v3.scale(up, dy * s)));
      }
      this.render();
    });
    c.addEventListener('pointerup', (e) => {
      const wasClick = drag && !drag.moved && drag.btn === 0;
      drag = null;
      if (wasClick && this.onPick) this.onPick(e);
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.dist = Math.min(100, Math.max(0.2, this.cam.dist * (1 + Math.sign(e.deltaY) * 0.12)));
      this.render();
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // mesh: 解析后的场景；corners: computeTangentFrames 结果
  setMesh(mesh, corners) {
    const gl = this.gl;
    const n = mesh.faces.length * 3;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), tan = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2), h = new Float32Array(n), det = new Float32Array(n);
    let k = 0;
    for (const c of corners) {
      const p = mesh.positions[c.posIndex];
      pos.set(p, k * 3);
      nor.set(c.N, k * 3);
      tan.set(c.T, k * 3);
      uv.set(c.uv, k * 2);
      h[k] = c.h;
      det[k] = c.uvDetSign;
      k++;
    }
    const upload = (buf, arr) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    };
    upload(this.meshVAO.pos, pos); upload(this.meshVAO.n, nor); upload(this.meshVAO.t, tan);
    upload(this.meshVAO.uv, uv); upload(this.meshVAO.h, h); upload(this.meshVAO.det, det);
    this.vertCount = n;
    // 视野适配
    const bb = mesh.positions.reduce(
      (acc, p) => {
        for (let i = 0; i < 3; i++) {
          acc.min[i] = Math.min(acc.min[i], p[i]);
          acc.max[i] = Math.max(acc.max[i], p[i]);
        }
        return acc;
      },
      { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    );
    this.cam.target = bb.min.map((v, i) => (v + bb.max[i]) / 2);
    const size = Math.max(1e-3, Math.hypot(...bb.max.map((v, i) => v - bb.min[i])));
    this.cam.dist = size * 2.2;
    this.render();
  }

  setNormalMapTexture(tex) {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = null;
    if (tex) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      // 直接上传原始字节，不做 sRGB 处理；最近邻 + 钳位
      const rgba = new Uint8Array(tex.data.buffer, tex.data.byteOffset, tex.width * tex.height * 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tex.width, tex.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.texture = t;
    }
    this.render();
  }

  // axes: [[from, to, color], ...]
  setAxes(axes) {
    const gl = this.gl;
    const pos = [], col = [];
    for (const [a, b, c] of axes) {
      pos.push(...a, ...b);
      col.push(...c, ...c);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineColorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(col), gl.DYNAMIC_DRAW);
    this.lineCount = axes.length * 2;
    this.render();
  }

  setModel(instanceM4) {
    this.model = instanceM4;
    this.render();
  }

  render() {
    const gl = this.gl;
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr), hgt = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== hgt) { c.width = w; c.height = hgt; }
    gl.viewport(0, 0, w, hgt);
    gl.clearColor(0.11, 0.12, 0.14, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    if (!this.vertCount) return;

    const { theta, phi, dist, target } = this.cam;
    const eye = [
      target[0] + dist * Math.sin(phi) * Math.sin(theta),
      target[1] + dist * Math.cos(phi),
      target[2] + dist * Math.sin(phi) * Math.cos(theta),
    ];
    const proj = m4.perspective(0.8, w / hgt, dist * 0.01, dist * 100);
    const view = m4.lookAt(eye, target, [0, 1, 0]);
    const projC = m4.toColumnMajor(proj), viewC = m4.toColumnMajor(view);
    const model = this.model || m4.identity();
    const L = [model[0], model[1], model[2], model[4], model[5], model[6], model[8], model[9], model[10]];
    const detL =
      L[0] * (L[4] * L[8] - L[5] * L[7]) - L[1] * (L[3] * L[8] - L[5] * L[6]) + L[2] * (L[3] * L[7] - L[4] * L[6]);
    // 逆转置（余子式 / 行列式）
    const cof = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const rows = [0, 1, 2].filter((r) => r !== i), cols = [0, 1, 2].filter((s) => s !== j);
      const minor = L[rows[0] * 3 + cols[0]] * L[rows[1] * 3 + cols[1]] - L[rows[0] * 3 + cols[1]] * L[rows[1] * 3 + cols[0]];
      cof[i * 3 + j] = (((i + j) % 2 === 0) ? minor : -minor) / detL;
    }

    const p = this.meshProg;
    gl.useProgram(p);
    const u = (name) => gl.getUniformLocation(p, name);
    gl.uniformMatrix4fv(u('uProj'), false, projC);
    gl.uniformMatrix4fv(u('uView'), false, viewC);
    gl.uniformMatrix4fv(u('uModel'), false, m4.toColumnMajor(model));
    gl.uniformMatrix3fv(u('uLinear'), false, [L[0], L[3], L[6], L[1], L[4], L[7], L[2], L[5], L[8]]);
    gl.uniformMatrix3fv(u('uNormalMat'), false, [cof[0], cof[3], cof[6], cof[1], cof[4], cof[7], cof[2], cof[5], cof[8]]);
    gl.uniform1f(u('uDetSign'), detL >= 0 ? 1 : -1);
    gl.uniform3fv(u('uLightDir'), this.lightDir);
    gl.uniform1i(u('uMode'), this.mode);
    gl.uniform1i(u('uUseMap'), this.texture ? 1 : 0);
    if (this.texture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(u('uMap'), 0);
    }
    const bindAttr = (name, buf, size) => {
      const loc = gl.getAttribLocation(p, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bindAttr('aPos', this.meshVAO.pos, 3);
    bindAttr('aN', this.meshVAO.n, 3);
    bindAttr('aT', this.meshVAO.t, 3);
    bindAttr('aUV', this.meshVAO.uv, 2);
    bindAttr('aH', this.meshVAO.h, 1);
    bindAttr('aDetSign', this.meshVAO.det, 1);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertCount);

    if (this.lineCount > 0) {
      const lp = this.lineProg;
      gl.useProgram(lp);
      gl.uniformMatrix4fv(gl.getUniformLocation(lp, 'uProj'), false, projC);
      gl.uniformMatrix4fv(gl.getUniformLocation(lp, 'uView'), false, viewC);
      const pl = gl.getAttribLocation(lp, 'aPos');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.enableVertexAttribArray(pl);
      gl.vertexAttribPointer(pl, 3, gl.FLOAT, false, 0, 0);
      const cl = gl.getAttribLocation(lp, 'aColor');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineColorBuf);
      gl.enableVertexAttribArray(cl);
      gl.vertexAttribPointer(cl, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, this.lineCount);
    }
  }

  // 屏幕坐标 -> 最近的角（用于点选）；corners 与实例矩阵由调用方提供
  pickCorner(mx, my, mesh, corners, model) {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.width, hgt = c.height;
    const { theta, phi, dist, target } = this.cam;
    const eye = [
      target[0] + dist * Math.sin(phi) * Math.sin(theta),
      target[1] + dist * Math.cos(phi),
      target[2] + dist * Math.sin(phi) * Math.cos(theta),
    ];
    const proj = m4.perspective(0.8, w / hgt, dist * 0.01, dist * 100);
    const view = m4.lookAt(eye, target, [0, 1, 0]);
    const pv = m4.multiply(proj, view);
    let best = -1, bestD = 14 * dpr;
    for (let i = 0; i < corners.length; i++) {
      const p = m4.transformPoint(model, mesh.positions[corners[i].posIndex]);
      const cx = pv[0] * p[0] + pv[1] * p[1] + pv[2] * p[2] + pv[3];
      const cy = pv[4] * p[0] + pv[5] * p[1] + pv[6] * p[2] + pv[7];
      const cw = pv[12] * p[0] + pv[13] * p[1] + pv[14] * p[2] + pv[15];
      if (cw <= 0) continue;
      const sx = ((cx / cw) * 0.5 + 0.5) * w;
      const sy = (1 - (cy / cw) * 0.5 - 0.5) * hgt;
      const d = Math.hypot(sx - mx * dpr, sy - my * dpr);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
}
