/*
 * render.js — 原生 WebGL1 渲染器：着色/线框、轨道相机、屏幕投影（供拾取用）。
 * 不依赖任何几何/图形库。
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------ 小矩阵库（列主序 4x4）
  function mat4Perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function mat4Mul(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
  }
  function mat4LookAt(eye, center, up) {
    let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return [
      xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1
    ];
  }
  function transformPoint(m, p) {
    const [x, y, z] = p;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w
    ];
  }

  // ------------------------------------------------------------ 着色器
  const MESH_VS = `
attribute vec3 aPos; attribute vec3 aNormal;
uniform mat4 uMVP;
varying vec3 vNormal; varying vec3 vPos;
void main(){ vNormal = aNormal; vPos = aPos; gl_Position = uMVP * vec4(aPos,1.0); }`;
  const MESH_FS = `
precision mediump float;
varying vec3 vNormal; varying vec3 vPos;
uniform vec3 uColor; uniform vec3 uEye;
void main(){
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 l1 = normalize(vec3(0.6, 0.8, 0.5));
  vec3 l2 = normalize(vec3(-0.5, -0.3, -0.6));
  float d1 = max(dot(n, l1), 0.0);
  float d2 = max(dot(n, l2), 0.0) * 0.35;
  vec3 v = normalize(uEye - vPos);
  vec3 h = normalize(l1 + v);
  float spec = pow(max(dot(n, h), 0.0), 32.0) * 0.25;
  vec3 col = uColor * (0.28 + 0.75 * d1 + d2) + vec3(spec);
  gl_FragColor = vec4(col, 1.0);
}`;
  const FLAT_VS = `
attribute vec3 aPos;
uniform mat4 uMVP; uniform float uPointSize;
void main(){ gl_Position = uMVP * vec4(aPos,1.0); gl_PointSize = uPointSize; }`;
  const FLAT_FS = `
precision mediump float;
uniform vec3 uColor; uniform float uRound;
void main(){
  if (uRound > 0.5) { vec2 d = gl_PointCoord - vec2(0.5); if (dot(d,d) > 0.25) discard; }
  gl_FragColor = vec4(uColor, 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  // ------------------------------------------------------------ 网格数据 → GPU
  function faceNormal(P, f) {
    // Newell 法，适配任意多边形
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < f.length; i++) {
      const a = P[f[i]], b = P[f[(i + 1) % f.length]];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return [nx, ny, nz];
  }

  function buildSurface(P, faces) {
    // 顶点法线 = 相邻面法线平均；三角形扇展开任意多边形
    const normals = P.map(() => [0, 0, 0]);
    faces.forEach(f => {
      const n = faceNormal(P, f);
      f.forEach(i => { normals[i][0] += n[0]; normals[i][1] += n[1]; normals[i][2] += n[2]; });
    });
    const pos = [], nrm = [];
    P.forEach((p, i) => {
      const n = normals[i];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      pos.push(p[0], p[1], p[2]);
      nrm.push(n[0] / l, n[1] / l, n[2] / l);
    });
    const tris = [];
    faces.forEach(f => {
      for (let i = 1; i + 1 < f.length; i++) tris.push(f[0], f[i], f[i + 1]);
    });
    return { positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(tris) };
  }

  function buildLines(P, faces) {
    const seen = new Set(); const out = [];
    faces.forEach(f => {
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        const k = a < b ? a + ',' + b : b + ',' + a;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(P[a][0], P[a][1], P[a][2], P[b][0], P[b][1], P[b][2]);
      }
    });
    return new Float32Array(out);
  }

  function buildPoints(P) {
    const out = new Float32Array(P.length * 3);
    P.forEach((p, i) => { out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2]; });
    return out;
  }

  // ------------------------------------------------------------ 渲染器
  function createRenderer(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true }) || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('当前浏览器不支持 WebGL');
    const extUint = gl.getExtension('OES_element_index_uint');
    if (!extUint) throw new Error('当前环境不支持 32 位索引（OES_element_index_uint）');

    const meshProg = program(gl, MESH_VS, MESH_FS);
    const flatProg = program(gl, FLAT_VS, FLAT_FS);
    const loc = {
      mesh: {
        aPos: gl.getAttribLocation(meshProg, 'aPos'),
        aNormal: gl.getAttribLocation(meshProg, 'aNormal'),
        uMVP: gl.getUniformLocation(meshProg, 'uMVP'),
        uColor: gl.getUniformLocation(meshProg, 'uColor'),
        uEye: gl.getUniformLocation(meshProg, 'uEye')
      },
      flat: {
        aPos: gl.getAttribLocation(flatProg, 'aPos'),
        uMVP: gl.getUniformLocation(flatProg, 'uMVP'),
        uColor: gl.getUniformLocation(flatProg, 'uColor'),
        uPointSize: gl.getUniformLocation(flatProg, 'uPointSize'),
        uRound: gl.getUniformLocation(flatProg, 'uRound')
      }
    };

    const cam = { target: [0, 0, 0], dist: 5, theta: 0.7, phi: 1.1, fov: 45 * Math.PI / 180 };
    let surface = null;          // {posBuf,nrmBuf,idxBuf,triCount}
    let meshLines = null;        // 细分结果线框 {buf,count}
    let ctrlLines = null, ctrlPoints = null, ctrlPointCount = 0;
    let selectedPos = null;      // 选中顶点世界坐标
    let needDraw = true;

    function makeBuf(data) {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return b;
    }

    function setSurface(P, faces) {
      const s = buildSurface(P, faces);
      if (surface) { gl.deleteBuffer(surface.posBuf); gl.deleteBuffer(surface.nrmBuf); gl.deleteBuffer(surface.idxBuf); }
      const idxBuf = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, s.indices, gl.STATIC_DRAW);
      surface = { posBuf: makeBuf(s.positions), nrmBuf: makeBuf(s.normals), idxBuf, triCount: s.indices.length };
      if (meshLines) gl.deleteBuffer(meshLines.buf);
      const lines = buildLines(P, faces);
      meshLines = { buf: makeBuf(lines), count: lines.length / 3 };
      needDraw = true;
    }

    function setControl(P, faces) {
      if (ctrlLines) { gl.deleteBuffer(ctrlLines.buf); gl.deleteBuffer(ctrlPoints); }
      const lines = buildLines(P, faces);
      ctrlLines = { buf: makeBuf(lines), count: lines.length / 3 };
      ctrlPoints = makeBuf(buildPoints(P));
      ctrlPointCount = P.length;
      needDraw = true;
    }

    function clearControl() {
      if (ctrlLines) { gl.deleteBuffer(ctrlLines.buf); gl.deleteBuffer(ctrlPoints); ctrlLines = null; }
      needDraw = true;
    }

    function frame(P) {
      // 依包围盒自动取景
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      P.forEach(p => { for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); } });
      cam.target = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
      const r = Math.max(0.1, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2);
      cam.dist = r * 3.2;
      needDraw = true;
    }

    function eye() {
      const sp = Math.sin(cam.phi), cp = Math.cos(cam.phi);
      return [
        cam.target[0] + cam.dist * sp * Math.cos(cam.theta),
        cam.target[1] + cam.dist * cp,
        cam.target[2] + cam.dist * sp * Math.sin(cam.theta)
      ];
    }

    function mvp() {
      const w = canvas.width, h = canvas.height;
      const proj = mat4Perspective(cam.fov, w / h, cam.dist / 100, cam.dist * 100);
      const view = mat4LookAt(eye(), cam.target, [0, 1, 0]);
      return mat4Mul(proj, view);
    }

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h; needDraw = true;
      }
    }

    function draw() {
      resize();
      if (!needDraw) return;
      needDraw = false;
      const opts = draw.options;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.11, 0.12, 0.14, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      const M = mvp();

      if (surface && opts.shaded) {
        gl.useProgram(meshProg);
        gl.uniformMatrix4fv(loc.mesh.uMVP, false, M);
        gl.uniform3fv(loc.mesh.uColor, opts.meshColor);
        gl.uniform3fv(loc.mesh.uEye, eye());
        gl.bindBuffer(gl.ARRAY_BUFFER, surface.posBuf);
        gl.enableVertexAttribArray(loc.mesh.aPos);
        gl.vertexAttribPointer(loc.mesh.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, surface.nrmBuf);
        gl.enableVertexAttribArray(loc.mesh.aNormal);
        gl.vertexAttribPointer(loc.mesh.aNormal, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, surface.idxBuf);
        if (opts.wireframe) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1); }
        gl.drawElements(gl.TRIANGLES, surface.triCount, gl.UNSIGNED_INT, 0);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      }

      gl.useProgram(flatProg);
      gl.uniformMatrix4fv(loc.flat.uMVP, false, M);
      gl.uniform1f(loc.flat.uRound, 0);

      function drawLines(buf, count, color) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(loc.flat.aPos);
        gl.vertexAttribPointer(loc.flat.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.uniform3fv(loc.flat.uColor, color);
        gl.drawArrays(gl.LINES, 0, count);
      }

      if (surface && opts.wireframe && meshLines) drawLines(meshLines.buf, meshLines.count, opts.wireColor);

      // 控制网格（可置顶）
      if (ctrlLines && opts.showControl) {
        if (opts.controlOnTop) gl.disable(gl.DEPTH_TEST);
        drawLines(ctrlLines.buf, ctrlLines.count, opts.ctrlColor);
        gl.uniform1f(loc.flat.uRound, 1);
        gl.uniform1f(loc.flat.uPointSize, 6 * (window.devicePixelRatio || 1));
        gl.bindBuffer(gl.ARRAY_BUFFER, ctrlPoints);
        gl.enableVertexAttribArray(loc.flat.aPos);
        gl.vertexAttribPointer(loc.flat.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.uniform3fv(loc.flat.uColor, opts.ctrlPointColor);
        gl.drawArrays(gl.POINTS, 0, ctrlPointCount);
        gl.uniform1f(loc.flat.uRound, 0);
        if (opts.controlOnTop) gl.enable(gl.DEPTH_TEST);
      }

      // 选中顶点高亮
      if (selectedPos) {
        gl.disable(gl.DEPTH_TEST);
        gl.uniform1f(loc.flat.uRound, 1);
        gl.uniform1f(loc.flat.uPointSize, 12 * (window.devicePixelRatio || 1));
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(selectedPos), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(loc.flat.aPos);
        gl.vertexAttribPointer(loc.flat.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.uniform3fv(loc.flat.uColor, [1, 0.85, 0.2]);
        gl.drawArrays(gl.POINTS, 0, 1);
        gl.deleteBuffer(b);
        gl.uniform1f(loc.flat.uRound, 0);
        gl.enable(gl.DEPTH_TEST);
      }
    }
    draw.options = {
      shaded: true, wireframe: true, showControl: true, controlOnTop: true,
      meshColor: [0.45, 0.62, 0.85], wireColor: [0.15, 0.2, 0.28],
      ctrlColor: [0.95, 0.55, 0.2], ctrlPointColor: [1, 0.7, 0.3]
    };

    // 交互：左键旋转，右键/Shift+左键平移，滚轮缩放
    let dragging = false, panning = false, lx = 0, ly = 0, moved = 0;
    canvas.addEventListener('mousedown', e => {
      dragging = true; moved = 0;
      panning = e.button === 2 || e.shiftKey;
      lx = e.clientX; ly = e.clientY;
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (panning) {
        const s = cam.dist * 0.0016;
        const t = cam.theta;
        const right = [-Math.sin(t), 0, Math.cos(t)];
        const up = [Math.cos(t) * Math.cos(cam.phi), -Math.sin(cam.phi), Math.sin(t) * Math.cos(cam.phi)];
        for (let i = 0; i < 3; i++) cam.target[i] += (-dx * right[i] + dy * up[i]) * s;
      } else {
        cam.theta += dx * 0.008;
        cam.phi = Math.min(Math.PI - 0.05, Math.max(0.05, cam.phi - dy * 0.008));
      }
      needDraw = true;
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      cam.dist = Math.max(0.05, cam.dist * Math.exp(e.deltaY * 0.0012));
      needDraw = true;
    }, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    function loop() { draw(); requestAnimationFrame(loop); }
    requestAnimationFrame(loop);

    return {
      setSurface, setControl, clearControl, frame,
      invalidate: () => { needDraw = true; },
      setOption: (k, v) => { draw.options[k] = v; needDraw = true; },
      setSelected: p => { selectedPos = p; needDraw = true; },
      wasClick: () => moved < 5,
      /** 世界坐标 → 画布像素坐标（找不到返回 null） */
      project(p) {
        const ndc = transformPoint(mvp(), p);
        if (ndc[2] < -1 || ndc[2] > 1) return null;
        const dpr = window.devicePixelRatio || 1;
        return [(ndc[0] + 1) / 2 * canvas.width / dpr, (1 - ndc[1]) / 2 * canvas.height / dpr];
      }
    };
  }

  global.Renderer = { create: createRenderer };
})(typeof window !== 'undefined' ? window : globalThis);
