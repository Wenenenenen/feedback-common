/* 原生 WebGL 渲染器：着色/线框/法线/控制网/误差热图/超限标记/控制点拾取 */
(function (global) {
  'use strict';

  const { v3 } = global.Math3D;

  const VERT = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    attribute vec3 aColor;
    uniform mat4 uVP;
    varying vec3 vNormal;
    varying vec3 vColor;
    varying vec3 vWorld;
    void main() {
      vNormal = aNormal;
      vColor = aColor;
      vWorld = aPosition;
      gl_Position = uVP * vec4(aPosition, 1.0);
    }
  `;

  const FRAG = `
    precision mediump float;
    varying vec3 vNormal;
    varying vec3 vColor;
    varying vec3 vWorld;
    uniform int uMode;   // 0 shaded, 1 flat color, 2 heatmap(颜色已进 aColor)
    uniform vec3 uEye;
    void main() {
      if (uMode == 1 || uMode == 2) {
        gl_FragColor = vec4(vColor, 1.0);
        return;
      }
      vec3 N = normalize(vNormal);
      vec3 L = normalize(vec3(0.4, 0.8, 0.6));
      float diff = max(dot(N, L), 0.0) * 0.75 + 0.25;
      vec3 viewDir = normalize(uEye - vWorld);
      float rim = pow(1.0 - max(dot(N, viewDir), 0.0), 2.0) * 0.15;
      gl_FragColor = vec4(vColor * diff + vec3(rim), 1.0);
    }
  `;

  const LINE_VERT = `
    attribute vec3 aPosition;
    attribute vec3 aColor;
    uniform mat4 uVP;
    varying vec3 vColor;
    void main() {
      vColor = aColor;
      gl_Position = uVP * vec4(aPosition, 1.0);
    }
  `;
  const LINE_FRAG = `
    precision mediump float;
    varying vec3 vColor;
    void main() { gl_FragColor = vec4(vColor, 1.0); }
  `;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('程序链接失败: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  /* 蓝 -> 青 -> 绿 -> 黄 -> 红 误差热图 */
  function heatColor(t) {
    const stops = [
      [0.0, [0.13, 0.35, 0.95]],
      [0.25, [0.1, 0.8, 0.85]],
      [0.5, [0.2, 0.8, 0.35]],
      [0.75, [0.98, 0.82, 0.15]],
      [1.0, [0.92, 0.18, 0.18]],
    ];
    const x = Math.min(1, Math.max(0, t));
    for (let i = 0; i < stops.length - 1; i++) {
      if (x <= stops[i + 1][0]) {
        const f = (x - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
        const a = stops[i][1];
        const b = stops[i + 1][1];
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      }
    }
    return stops[stops.length - 1][1];
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
      if (!gl) throw new Error('当前环境不支持 WebGL');
      this.gl = gl;
      this.meshProg = program(gl, VERT, FRAG);
      this.lineProg = program(gl, LINE_VERT, LINE_FRAG);
      this.meshLoc = this.locations(this.meshProg, ['aPosition', 'aNormal', 'aColor'], ['uVP', 'uMode', 'uEye']);
      this.lineLoc = this.locations(this.lineProg, ['aPosition', 'aColor'], ['uVP']);
      gl.enable(gl.DEPTH_TEST);
      gl.clearColor(0.07, 0.08, 0.1, 1);
      this.buffers = {};
    }

    locations(prog, attrs, unis) {
      const gl = this.gl;
      const out = { attr: {}, uni: {} };
      attrs.forEach((n) => (out.attr[n] = gl.getAttribLocation(prog, n)));
      unis.forEach((n) => (out.uni[n] = gl.getUniformLocation(prog, n)));
      return out;
    }

    makeBuffer(data, target) {
      const gl = this.gl;
      const buf = gl.createBuffer();
      gl.bindBuffer(target || gl.ARRAY_BUFFER, buf);
      gl.bufferData(target || gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      return buf;
    }

    /* 上传细分结果；mode 决定顶点着色 */
    uploadMesh(tess, model, mode, pixelError) {
      const gl = this.gl;
      const pos = [];
      const nor = [];
      const col = [];
      const patchColor = {};
      const palette = [
        [0.62, 0.72, 0.92], [0.92, 0.68, 0.58], [0.6, 0.85, 0.65],
        [0.85, 0.65, 0.9], [0.95, 0.88, 0.55], [0.5, 0.82, 0.9],
        [0.95, 0.6, 0.7], [0.75, 0.8, 0.55],
      ];
      model.patches.forEach((p, i) => {
        patchColor[p.id] = palette[i % palette.length];
      });
      const maxErr = Math.max(pixelError * 1.5, tess.stats.maxError, 1e-6);

      for (const t of tess.triangles) {
        const base = patchColor[t.patch];
        for (let k = 0; k < 3; k++) {
          const idx = t.position[k];
          pos.push(...tess.positions[idx]);
          nor.push(...t.normal[k]);
          let c;
          if (t.overLimit) c = [1.0, 0.08, 0.08]; // 超限：醒目的红
          else if (mode === 'heatmap') c = heatColor(t.error / maxErr);
          else c = base;
          col.push(...c);
        }
      }
      this.buffers.meshPos = this.makeBuffer(pos);
      this.buffers.meshNor = this.makeBuffer(nor);
      this.buffers.meshCol = this.makeBuffer(col);
      this.meshVertexCount = pos.length / 3;

      // 线框：每个三角形的三条边（独立线段）
      const wPos = [];
      const wCol = [];
      tess.triangles.forEach((t) => {
        const edge = t.overLimit ? [1, 0.3, 0.3] : [0.05, 0.06, 0.09];
        for (let e = 0; e < 3; e++) {
          const a = t.position[e];
          const b = t.position[(e + 1) % 3];
          wPos.push(...tess.positions[a], ...tess.positions[b]);
          wCol.push(...edge, ...edge);
        }
      });
      this.buffers.wirePos = this.makeBuffer(wPos);
      this.buffers.wireCol = this.makeBuffer(wCol);
      this.wireVertexCount = wPos.length / 3;

      // 法线 glyph：从每角点沿法线画线段
      const nPos = [];
      const nCol = [];
      const span = this.modelSpan(model);
      const glyphLen = span * 0.05;
      tess.triangles.forEach((t) => {
        for (let k = 0; k < 3; k++) {
          const idx = t.position[k];
          const p = tess.positions[idx];
          const n = t.normal[k];
          nPos.push(...p, p[0] + n[0] * glyphLen, p[1] + n[1] * glyphLen, p[2] + n[2] * glyphLen);
          nCol.push(0.2, 1, 0.5, 0.2, 1, 0.5);
        }
      });
      this.buffers.normPos = this.makeBuffer(nPos);
      this.buffers.normCol = this.makeBuffer(nCol);
      this.normVertexCount = nPos.length / 3;
    }

    modelSpan(model) {
      let min = [Infinity, Infinity, Infinity];
      let max = [-Infinity, -Infinity, -Infinity];
      model.patches.forEach((p) => p.points.forEach((row) => row.forEach((c) => {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], c[k]);
          max[k] = Math.max(max[k], c[k]);
        }
      })));
      return Math.max(v3.len(v3.sub(max, min)), 1e-6);
    }

    /* 控制网：片的 4x4 点、网格线、接缝高亮 */
    uploadControlNet(model, linkGroups) {
      const cPos = [];
      const cCol = [];
      const pushLine = (a, b, color) => {
        cPos.push(...a, ...b);
        cCol.push(...color, ...color);
      };
      const seamEdgeSet = new Set();
      model.seams.forEach((s) => {
        seamEdgeSet.add(`${s.a[0]}.${s.a[1]}`);
        seamEdgeSet.add(`${s.b[0]}.${s.b[1]}`);
      });
      const gridColor = [0.75, 0.78, 0.85];
      const seamColor = [1.0, 0.75, 0.2];
      const B = global.Bezier;
      for (const patch of model.patches) {
        // 行（v 固定，沿 u）与列（u 固定，沿 v）
        for (let j = 0; j < 4; j++) {
          for (let i = 0; i < 3; i++) {
            const onSeam = (j === 0 && seamEdgeSet.has(`${patch.id}.v0`)) ||
              (j === 3 && seamEdgeSet.has(`${patch.id}.v1`));
            pushLine(patch.points[j][i], patch.points[j][i + 1], onSeam ? seamColor : gridColor);
          }
        }
        for (let i = 0; i < 4; i++) {
          for (let j = 0; j < 3; j++) {
            const onSeam = (i === 0 && seamEdgeSet.has(`${patch.id}.u0`)) ||
              (i === 3 && seamEdgeSet.has(`${patch.id}.u1`));
            pushLine(patch.points[j][i], patch.points[j + 1][i], onSeam ? seamColor : gridColor);
          }
        }
      }
      this.buffers.cnPos = this.makeBuffer(cPos);
      this.buffers.cnCol = this.makeBuffer(cCol);
      this.cnVertexCount = cPos.length / 3;

      // 控制点（点精灵用小方块线段表示，拾取另用射线）
      const pts = [];
      const ptCol = [];
      const r = this.modelSpan(model) * 0.012;
      model.patches.forEach((patch) => {
        const onSeamPoint = (j, i) => {
          const edges = [];
          if (j === 0) edges.push('v0');
          if (j === 3) edges.push('v1');
          if (i === 0) edges.push('u0');
          if (i === 3) edges.push('u1');
          return edges.some((e) => seamEdgeSet.has(`${patch.id}.${e}`));
        };
        patch.points.forEach((row, j) => row.forEach((p, i) => {
          const c = onSeamPoint(j, i) ? [1, 0.8, 0.3] : [0.85, 0.9, 1];
          // 屏幕对齐小立方体代价高，这里用三轴短线段做 marker
          pts.push(p[0] - r, p[1], p[2], p[0] + r, p[1], p[2]);
          pts.push(p[0], p[1] - r, p[2], p[0], p[1] + r, p[2]);
          pts.push(p[0], p[1], p[2] - r, p[0], p[1], p[2] + r);
          for (let q = 0; q < 3; q++) ptCol.push(...c, ...c);
        }));
      });
      this.buffers.cpPos = this.makeBuffer(pts);
      this.buffers.cpCol = this.makeBuffer(ptCol);
      this.cpVertexCount = pts.length / 3;
    }

    bindAttr(loc, buf, name) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const a = loc.attr[name];
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 0, 0);
    }

    render(camera, view) {
      const gl = this.gl;
      const vp = camera.viewProjection;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      // 网格面
      if (view.showMesh && this.buffers.meshPos) {
        gl.useProgram(this.meshProg);
        gl.uniformMatrix4fv(this.meshLoc.uni.uVP, false, new Float32Array(vp));
        gl.uniform1i(this.meshLoc.uni.uMode, view.shadeMode === 'shaded' ? 0 : (view.shadeMode === 'heatmap' ? 2 : 1));
        gl.uniform3fv(this.meshLoc.uni.uEye, new Float32Array(camera.position));
        this.bindAttr(this.meshLoc, this.buffers.meshPos, 'aPosition');
        this.bindAttr(this.meshLoc, this.buffers.meshNor, 'aNormal');
        this.bindAttr(this.meshLoc, this.buffers.meshCol, 'aColor');
        gl.drawArrays(gl.TRIANGLES, 0, this.meshVertexCount);
      }

      // 线段类
      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(this.lineLoc.uni.uVP, false, new Float32Array(vp));
      const drawLines = (posBuf, colBuf, count) => {
        if (!posBuf) return;
        this.bindAttr(this.lineLoc, posBuf, 'aPosition');
        this.bindAttr(this.lineLoc, colBuf, 'aColor');
        gl.drawArrays(gl.LINES, 0, count);
      };
      if (view.showWireframe) drawLines(this.buffers.wirePos, this.buffers.wireCol, this.wireVertexCount);
      if (view.showNormals) drawLines(this.buffers.normPos, this.buffers.normCol, this.normVertexCount);
      if (view.showControlNet) {
        drawLines(this.buffers.cnPos, this.buffers.cnCol, this.cnVertexCount);
        drawLines(this.buffers.cpPos, this.buffers.cpCol, this.cpVertexCount);
      }
    }

    /* 拾取：返回最近控制点 {patchId, j, i, point} 或 null */
    pickControlPoint(model, camera, px, py) {
      const ray = camera.screenRay(px, py);
      const span = this.modelSpan(model);
      const threshold = span * 0.03;
      let best = null;
      let bestD = threshold;
      model.patches.forEach((patch) => {
        patch.points.forEach((row, j) => row.forEach((point, i) => {
          const d = rayPointDistance(ray, point);
          if (d < bestD) {
            bestD = d;
            best = { patchId: patch.id, j, i, point };
          }
        }));
      });
      return best;
    }
  }

  function rayPointDistance(ray, p) {
    const ap = v3.sub(p, ray.origin);
    const t = v3.dot(ap, ray.dir);
    const closest = v3.add(ray.origin, v3.scale(ray.dir, Math.max(0, t)));
    return v3.dist(closest, p);
  }

  const api = { Renderer, heatColor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Render = api;
})(typeof window !== 'undefined' ? window : globalThis);
