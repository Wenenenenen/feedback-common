/* 实例化射线拾取校验台 — UI / 渲染层。核心算法全部在 js/core.js（IRB）。 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // ---------------- 状态 ----------------
  const state = {
    scene: IRB.createScene(),
    rays: [],
    expected: null,
    selectedInstance: null,   // 实例 id
    pick: null,               // 最近一次拾取 {origin, dir, result, stats, brute}
    batch: { running: false, cancel: false },
    report: null,             // {revision, hash, time, rows, totals, completed}
    sceneName: '',
  };

  // ================= WebGL 渲染 =================
  const canvas = $('gl');
  const gl = canvas.getContext('webgl2', { antialias: true });

  const MESH_VS = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aNormal;
  layout(location=2) in mat4 aMat;
  layout(location=6) in mat4 aInv;
  layout(location=10) in float aId;
  layout(location=11) in vec3 aColor;
  uniform mat4 uVP;
  uniform float uSelected;
  uniform float uFlat;
  flat out vec3 vN; flat out vec3 vColor; flat out float vSel;
  void main(){
    gl_Position = uVP * (aMat * vec4(aPos,1.0));
    vN = normalize(aNormal * mat3(aInv));
    vColor = aColor;
    vSel = (uFlat<0.5 && abs(aId-uSelected)<0.5) ? 1.0 : 0.0;
  }`;
  const MESH_FS = `#version 300 es
  precision highp float;
  flat in vec3 vN; flat in vec3 vColor; flat in float vSel;
  uniform float uFlat; uniform vec4 uFlatColor;
  out vec4 outColor;
  void main(){
    if(uFlat>0.5){ outColor = uFlatColor; return; }
    vec3 L = normalize(vec3(0.5,0.8,0.6));
    float diff = abs(dot(normalize(vN), L));
    vec3 c = vColor*(0.28+0.72*diff);
    c = mix(c, vec3(1.0,0.85,0.2), vSel*0.7);
    outColor = vec4(c,1.0);
  }`;
  const LINE_VS = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aColor;
  uniform mat4 uVP;
  flat out vec3 vColor;
  void main(){ gl_Position = uVP*vec4(aPos,1.0); vColor=aColor; }`;
  const LINE_FS = `#version 300 es
  precision highp float;
  flat in vec3 vColor; out vec4 outColor;
  void main(){ outColor = vec4(vColor,1.0); }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  let meshProg = null, lineProg = null;
  const meshGroups = []; // {vao, count, instCount, invalidVao, invalidCount}
  let lineVao = null, lineBuf = null, lineVertCount = 0;

  function initGL() {
    meshProg = program(MESH_VS, MESH_FS);
    lineProg = program(LINE_VS, LINE_FS);
    lineVao = gl.createVertexArray();
    lineBuf = gl.createBuffer();
    gl.bindVertexArray(lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
  }

  function idToIndex(id) {
    return state.scene.instances.findIndex((x) => x.id === id) + 1;
  }
  function colorForIndex(i) {
    const h = (i * 2654435761) >>> 0;
    return [0.35 + 0.5 * ((h & 255) / 255), 0.35 + 0.5 * (((h >> 8) & 255) / 255), 0.35 + 0.5 * (((h >> 16) & 255) / 255)];
  }

  // 场景变更后重建 GPU 资源（网格几何 + 每网格实例属性）
  function rebuildGpuScene() {
    if (!gl) return;
    for (const g of meshGroups) {
      gl.deleteVertexArray(g.vao); gl.deleteBuffer(g.vbo);
      gl.deleteBuffer(g.instBuf); gl.deleteVertexArray(g.invalidVao); gl.deleteBuffer(g.invalidInstBuf);
    }
    meshGroups.length = 0;
    const scene = state.scene;
    for (const mesh of scene.meshes.values()) {
      // 展开为非索引三角 + 面法线
      const nv = mesh.faces.length * 3;
      const pos = new Float32Array(nv * 3);
      const nrm = new Float32Array(nv * 3);
      mesh.faces.forEach((f, fi) => {
        const [a, b, c] = f.map((vi) => mesh.vertices[vi]);
        const n = IRB.vnormalize(IRB.vcross(IRB.vsub(b, a), IRB.vsub(c, a))) || [0, 0, 1];
        [a, b, c].forEach((v, k) => {
          pos.set(v, (fi * 3 + k) * 3);
          nrm.set(n, (fi * 3 + k) * 3);
        });
      });
      const interleaved = new Float32Array(nv * 6);
      for (let i = 0; i < nv; i++) { interleaved.set(pos.subarray(i * 3, i * 3 + 3), i * 6); interleaved.set(nrm.subarray(i * 3, i * 3 + 3), i * 6 + 3); }

      const instOf = (valid) => scene.instances.filter((x) => x.mesh === mesh.name && x.valid === valid);
      // 核心库矩阵为行主序，WebGL mat4 属性按列主序读取 → 上传转置
      const toColumnMajor = (m) => [
        m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13],
        m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15],
      ];
      const makeInstBuf = (list) => {
        const data = new Float32Array(list.length * 36);
        list.forEach((inst, k) => {
          // 展示用矩阵：强制末行 [0,0,0,1]，避免非法矩阵把顶点送到无穷远
          const m = inst.matrix.slice();
          m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
          data.set(toColumnMajor(m), k * 36);
          data.set(toColumnMajor(inst.inv || [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]), k * 36 + 16);
          data[k * 36 + 32] = idToIndex(inst.id);
          data.set(colorForIndex(idToIndex(inst.id)), k * 36 + 33);
        });
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        return { buf, count: list.length };
      };

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);

      const setupInst = (buf) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        const stride = 36 * 4;
        for (let m = 0; m < 4; m++) {
          gl.enableVertexAttribArray(2 + m);
          gl.vertexAttribPointer(2 + m, 4, gl.FLOAT, false, stride, m * 16);
          gl.vertexAttribDivisor(2 + m, 1);
          gl.enableVertexAttribArray(6 + m);
          gl.vertexAttribPointer(6 + m, 4, gl.FLOAT, false, stride, 64 + m * 16);
          gl.vertexAttribDivisor(6 + m, 1);
        }
        gl.enableVertexAttribArray(10);
        gl.vertexAttribPointer(10, 1, gl.FLOAT, false, stride, 128);
        gl.vertexAttribDivisor(10, 1);
        gl.enableVertexAttribArray(11);
        gl.vertexAttribPointer(11, 3, gl.FLOAT, false, stride, 132);
        gl.vertexAttribDivisor(11, 1);
      };

      const valid = makeInstBuf(instOf(true));
      setupInst(valid.buf);
      gl.bindVertexArray(null);

      // 非法实例：仅矩阵属性（法线无意义），平涂红色半透明
      const invalidList = instOf(false);
      let invalidVao = null, invalidInstBuf = null, invalidCount = 0;
      if (invalidList.length) {
        const inv = makeInstBuf(invalidList);
        invalidInstBuf = inv.buf; invalidCount = inv.count;
        invalidVao = gl.createVertexArray();
        gl.bindVertexArray(invalidVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        setupInst(invalidInstBuf);
        gl.bindVertexArray(null);
      }
      meshGroups.push({ vao, vbo, count: nv, instBuf: valid.buf, instCount: valid.count, invalidVao, invalidInstBuf, invalidCount });
    }
  }

  // ---------------- 相机 ----------------
  const cam = { target: [0, 0, 0], dist: 50, theta: 0.9, phi: 1.1, fov: 50 * Math.PI / 180 };
  function camEye() {
    const sp = Math.sin(cam.phi), cp = Math.cos(cam.phi);
    return [
      cam.target[0] + cam.dist * sp * Math.cos(cam.theta),
      cam.target[1] + cam.dist * sp * Math.sin(cam.theta),
      cam.target[2] + cam.dist * cp,
    ];
  }
  function mat4Perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function mat4LookAt(eye, target, up) {
    const z = IRB.vnormalize(IRB.vsub(eye, target));
    const x = IRB.vnormalize(IRB.vcross(up, z));
    const y = IRB.vcross(z, x);
    return [
      x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -IRB.vdot(x, eye), -IRB.vdot(y, eye), -IRB.vdot(z, eye), 1,
    ];
  }
  function mat4Mul(a, b) { // 列主序 a*b
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function viewProj() {
    const aspect = canvas.width / Math.max(1, canvas.height);
    return mat4Mul(mat4Perspective(cam.fov, aspect, 0.1, 20000), mat4LookAt(camEye(), cam.target, [0, 0, 1]));
  }
  // 屏幕点 → 世界射线
  function pickRay(px, py) {
    const r = canvas.getBoundingClientRect();
    const nx = ((px - r.left) / r.width) * 2 - 1;
    const ny = 1 - ((py - r.top) / r.height) * 2;
    const aspect = r.width / r.height;
    const eye = camEye();
    const fwd = IRB.vnormalize(IRB.vsub(cam.target, eye));
    const right = IRB.vnormalize(IRB.vcross(fwd, [0, 0, 1]));
    const up = IRB.vcross(right, fwd);
    const t = Math.tan(cam.fov / 2);
    const dir = IRB.vnormalize([
      fwd[0] + nx * t * aspect * right[0] + ny * t * up[0],
      fwd[1] + nx * t * aspect * right[1] + ny * t * up[1],
      fwd[2] + nx * t * aspect * right[2] + ny * t * up[2],
    ]);
    return { origin: eye, dir };
  }

  function fitCamera() {
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    let any = false;
    for (const inst of state.scene.instances) {
      if (!inst.valid) continue;
      any = true;
      for (let k = 0; k < 3; k++) {
        box.min[k] = Math.min(box.min[k], inst.aabb.min[k]);
        box.max[k] = Math.max(box.max[k], inst.aabb.max[k]);
      }
    }
    if (!any) return;
    cam.target = box.min.map((v, k) => (v + box.max[k]) / 2);
    const radius = Math.max(1, IRB.vlen(IRB.vsub(box.max, box.min)) / 2);
    cam.dist = radius * 2.4;
  }

  // ---------------- 线段叠加层 ----------------
  function pushLine(arr, a, b, color) {
    arr.push(a[0], a[1], a[2], ...color, b[0], b[1], b[2], ...color);
  }
  function pushBox(arr, min, max, color, matrix) {
    const corners = [];
    for (let n = 0; n < 8; n++) {
      let p = [(n & 1) ? max[0] : min[0], (n & 2) ? max[1] : min[1], (n & 4) ? max[2] : min[2]];
      if (matrix) p = IRB.transformPoint(matrix, p);
      corners.push(p);
    }
    const E = [[0,1],[1,3],[3,2],[2,0],[4,5],[5,7],[7,6],[6,4],[0,4],[1,5],[2,6],[3,7]];
    for (const [i, j] of E) pushLine(arr, corners[i], corners[j], color);
  }
  function rebuildLines() {
    if (!gl) return;
    const arr = [];
    // 地面网格 + 坐标轴
    for (let i = -5; i <= 5; i++) {
      pushLine(arr, [i * 20, -100, 0], [i * 20, 100, 0], [0.16, 0.18, 0.22]);
      pushLine(arr, [-100, i * 20, 0], [100, i * 20, 0], [0.16, 0.18, 0.22]);
    }
    pushLine(arr, [0, 0, 0], [10, 0, 0], [0.9, 0.25, 0.25]);
    pushLine(arr, [0, 0, 0], [0, 10, 0], [0.3, 0.85, 0.35]);
    pushLine(arr, [0, 0, 0], [0, 0, 10], [0.3, 0.5, 0.95]);

    const p = state.pick;
    if (p) {
      const end = p.result.hit
        ? p.result.hit.position
        : [p.origin[0] + p.dir[0] * p.rayLen, p.origin[1] + p.dir[1] * p.rayLen, p.origin[2] + p.dir[2] * p.rayLen];
      pushLine(arr, p.origin, end, [1, 0.25, 0.25]); // 射线路径
      if (p.result.hit) {
        const h = p.result.hit.position, s = 0.6;
        pushLine(arr, [h[0] - s, h[1], h[2]], [h[0] + s, h[1], h[2]], [1, 0.9, 0.2]);
        pushLine(arr, [h[0], h[1] - s, h[2]], [h[0], h[1] + s, h[2]], [1, 0.9, 0.2]);
        pushLine(arr, [h[0], h[1], h[2] - s], [h[0], h[1], h[2] + s], [1, 0.9, 0.2]);
        const n = p.result.hit.normal;
        pushLine(arr, h, [h[0] + n[0] * 2, h[1] + n[1] * 2, h[2] + n[2] * 2], [0.4, 1, 0.5]); // 世界法线
      }
      if ($('chk-visited').checked && p.result.stats.visited) {
        for (const v of p.result.stats.visited) {
          if (v.level === 'tlas') pushBox(arr, v.min, v.max, [0.95, 0.75, 0.15]);
          else {
            const inst = state.scene.instances.find((x) => x.id === v.instance);
            pushBox(arr, v.min, v.max, [0.2, 0.85, 0.95], inst ? inst.matrix : null);
          }
        }
      }
    }
    if (state.selectedInstance) {
      const inst = state.scene.instances.find((x) => x.id === state.selectedInstance);
      if (inst && inst.valid) pushBox(arr, inst.aabb.min, inst.aabb.max, [0.3, 1, 0.4]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.DYNAMIC_DRAW);
    lineVertCount = arr.length / 6;
  }

  // ---------------- 渲染循环 ----------------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  function render() {
    if (!gl) return;
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.05, 0.06, 0.075, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = viewProj();
    gl.useProgram(meshProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(meshProg, 'uVP'), false, vp);
    gl.uniform1f(gl.getUniformLocation(meshProg, 'uSelected'), state.selectedInstance ? idToIndex(state.selectedInstance) : -1);
    gl.uniform1f(gl.getUniformLocation(meshProg, 'uFlat'), 0);
    for (const g of meshGroups) {
      if (g.instCount > 0) {
        gl.bindVertexArray(g.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, g.count, g.instCount);
      }
    }
    // 非法实例：半透明红
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniform1f(gl.getUniformLocation(meshProg, 'uFlat'), 1);
    gl.uniform4f(gl.getUniformLocation(meshProg, 'uFlatColor'), 0.9, 0.2, 0.2, 0.25);
    for (const g of meshGroups) {
      if (g.invalidCount > 0) {
        gl.bindVertexArray(g.invalidVao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, g.count, g.invalidCount);
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.useProgram(lineProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, 'uVP'), false, vp);
    gl.bindVertexArray(lineVao);
    gl.drawArrays(gl.LINES, 0, lineVertCount);
    gl.bindVertexArray(null);
    requestAnimationFrame(render);
  }

  // ---------------- 交互 ----------------
  let drag = null;
  canvas.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, shift: e.shiftKey, moved: false }; });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.shift) {
      const eye = camEye();
      const fwd = IRB.vnormalize(IRB.vsub(cam.target, eye));
      const right = IRB.vnormalize(IRB.vcross(fwd, [0, 0, 1]));
      const up = IRB.vcross(right, fwd);
      const s = cam.dist * 0.0016;
      for (let k = 0; k < 3; k++) cam.target[k] += (-dx * right[k] + dy * up[k]) * s;
    } else {
      cam.theta -= dx * 0.005;
      cam.phi = Math.min(3.13, Math.max(0.01, cam.phi - dy * 0.005));
    }
    drag.x = e.clientX; drag.y = e.clientY;
  });
  window.addEventListener('mouseup', (e) => {
    if (drag && !drag.moved && e.target === canvas) doPick(e.clientX, e.clientY);
    drag = null;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.dist = Math.min(15000, Math.max(1, cam.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
  }, { passive: false });

  // ---------------- 拾取 ----------------
  function sceneDiagonal() {
    let m = 0;
    for (const inst of state.scene.instances) if (inst.valid) m = Math.max(m, IRB.vlen(inst.aabb.max), IRB.vlen(inst.aabb.min));
    return Math.max(10, m * 2);
  }
  function doPick(px, py, rayOverride) {
    const { origin, dir } = rayOverride || pickRay(px, py);
    const result = IRB.queryBVH(state.scene, origin, dir, { recordVisited: true });
    let brute = null;
    if ($('chk-brute-pick').checked) brute = IRB.queryBruteForce(state.scene, origin, dir);
    state.pick = { origin, dir, result, brute, rayLen: sceneDiagonal() * 1.2 };
    state.selectedInstance = result.hit ? result.hit.instance : state.selectedInstance;
    showPick();
    rebuildLines();
  }
  function fmt(v, n) { return v === null || v === undefined ? '—' : Number(v).toFixed(n === undefined ? 6 : n); }
  function fmtVec(v) { return v ? '(' + v.map((x) => fmt(x, 4)).join(', ') + ')' : '—'; }
  function showPick() {
    const p = state.pick;
    if (!p) return;
    const h = p.result.hit;
    const ro = $('pick-readout');
    ro.classList.remove('hidden');
    $('pick-result').classList.remove('dim');
    if (p.result.error) {
      $('pick-result').innerHTML = '<span class="bad">射线无效：' + p.result.error + '</span>';
      ro.textContent = '射线无效';
      return;
    }
    const rows = [];
    if (h) {
      rows.push(['命中实例', h.instance], ['原面号', h.face], ['世界距离 t', fmt(h.t)],
        ['重心坐标', fmtVec(h.barycentric)], ['命中位置', fmtVec(h.position)], ['单位法线(绕序)', fmtVec(h.normal)]);
      ro.textContent = '命中 ' + h.instance + ' 面#' + h.face + '  t=' + fmt(h.t, 4);
    } else {
      rows.push(['结果', '未命中 (null)']);
      ro.textContent = '未命中';
    }
    $('pick-result').innerHTML = rows.map((r) => '<div><span class="k">' + r[0] + '</span>' + r[1] + '</div>').join('');
    const s = p.result.stats;
    let statHtml = '<div><span class="k">TLAS 盒测试</span>' + s.tlasAabbTests + '</div>' +
      '<div><span class="k">BLAS 盒测试</span>' + s.blasAabbTests + '</div>' +
      '<div><span class="k">BVH 三角测试</span>' + s.triTests + '</div>' +
      '<div><span class="k">访问包围盒</span>' + (s.visited ? s.visited.length : 0) + ' 个</div>';
    if (p.brute) {
      const same = IRB.hitsEqual(h, p.brute.hit);
      statHtml += '<div><span class="k">穷举三角测试</span>' + p.brute.stats.triTests + '</div>' +
        '<div><span class="k">与穷举对照</span><span class="' + (same ? 'ok' : 'bad') + '">' + (same ? '一致' : '不一致！') + '</span></div>';
    }
    $('pick-stats').innerHTML = statHtml;
  }

  // ---------------- 场景信息 ----------------
  function refreshSceneInfo() {
    const st = IRB.sceneStats(state.scene);
    $('scene-stats').innerHTML =
      '<div><span class="k">场景</span>' + (state.sceneName || '未命名') + ' (rev ' + st.revision + ')</div>' +
      '<div><span class="k">网格 / 唯一 BLAS</span>' + st.meshCount + ' / ' + st.uniqueBlas + '</div>' +
      '<div><span class="k">实例（有效/总数）</span>' + st.validInstances + ' / ' + st.instanceCount + '</div>' +
      '<div><span class="k">BLAS 构建次数</span>' + st.blasBuilds + '（共享网格各一次）</div>' +
      '<div><span class="k">TLAS 构建次数</span>' + st.tlasBuilds + '</div>' +
      '<div><span class="k">射线</span>' + state.rays.length + ' 条' + (state.expected ? '（含 expected 对照）' : '') + '</div>' +
      '<div><span class="k">场景指纹</span>' + IRB.sceneHash(state.scene) + '</div>';
    $('invalid-list').innerHTML = st.invalidInstances.map((x) => '<div>⊘ ' + x.id + '：' + x.reason + '</div>').join('') ||
      '<div class="dim">无被排除实例</div>';
    const sel = $('inst-select');
    const cur = sel.value;
    sel.innerHTML = state.scene.instances.map((x) =>
      '<option value="' + x.id + '"' + (x.valid ? '' : ' data-invalid="1"') + '>' + x.id + (x.valid ? '' : '（已排除）') + '</option>').join('');
    if (state.scene.instances.some((x) => x.id === cur)) sel.value = cur;
    fillMatrixGrid();
    refreshBuildCounters();
    refreshReportStatus();
  }
  function refreshBuildCounters() {
    const st = IRB.sceneStats(state.scene);
    $('build-counters').innerHTML =
      '<div><span class="k">BLAS 构建次数</span>' + st.blasBuilds + '（改实例矩阵不应增长）</div>' +
      '<div><span class="k">TLAS 构建次数</span>' + st.tlasBuilds + '</div>';
  }

  function loadScene(data, name) {
    IRB.loadSceneData(state.scene, data);
    state.sceneName = name;
    state.selectedInstance = null;
    state.pick = null;
    $('pick-readout').classList.add('hidden');
    $('pick-result').textContent = '在左侧视口中点击物体';
    $('pick-result').classList.add('dim');
    $('pick-stats').innerHTML = '';
    rebuildGpuScene();
    fitCamera();
    rebuildLines();
    refreshSceneInfo();
    if (state.scene.errors.length) $('invalid-list').innerHTML += state.scene.errors.map((e) => '<div>⚠ ' + e + '</div>').join('');
  }

  // ---------------- 批量比对 ----------------
  function hitShort(h) { return h ? h.instance + ' / 面' + h.face + ' / t=' + fmt(h.t, 4) : 'null'; }

  function runBatch() {
    if (state.batch.running || !state.rays.length) return;
    state.batch = { running: true, cancel: false };
    $('btn-run').disabled = true; $('btn-cancel').disabled = false; $('btn-export').disabled = true;
    const revAtStart = state.scene.revision;
    const hashAtStart = IRB.sceneHash(state.scene);
    const rows = [];
    const totals = { tlasAabb: 0, blasAabb: 0, tri: 0, bruteTri: 0, mismatch: 0, expectedFail: 0, expectedChecked: 0, invalidRays: 0 };
    const t0 = performance.now();
    let i = 0;
    $('batch-table').innerHTML = '';
    $('batch-summary').innerHTML = '';

    function step() {
      if (state.batch.cancel) {
        state.batch.running = false;
        $('btn-run').disabled = false; $('btn-cancel').disabled = true;
        $('batch-status').textContent = '已取消（第 ' + i + '/' + state.rays.length + ' 条）——部分结果已丢弃，不生成报告';
        state.report = null;
        refreshReportStatus();
        return;
      }
      const tEnd = performance.now() + 40; // 分片，保持界面响应
      while (i < state.rays.length && performance.now() < tEnd) {
        const ray = state.rays[i];
        const r1 = IRB.queryBVH(state.scene, ray.origin, ray.direction);
        const r2 = IRB.queryBruteForce(state.scene, ray.origin, ray.direction);
        let row;
        if (r1.error || r2.error) {
          totals.invalidRays++;
          row = { id: ray.id, error: r1.error || r2.error };
        } else {
          const match = IRB.hitsEqual(r1.hit, r2.hit);
          if (!match) totals.mismatch++;
          const exp = state.expected ? state.expected[ray.id] : undefined;
          let expPass = null;
          if (exp !== undefined) {
            totals.expectedChecked++;
            expPass = IRB.hitMatchesExpected(r1.hit, exp);
            if (!expPass) totals.expectedFail++;
          }
          totals.tlasAabb += r1.stats.tlasAabbTests;
          totals.blasAabb += r1.stats.blasAabbTests;
          totals.tri += r1.stats.triTests;
          totals.bruteTri += r2.stats.triTests;
          row = { id: ray.id, bvh: r1.hit, brute: r2.hit, match, expPass, stats: r1.stats, bruteStats: r2.stats, ray };
        }
        rows.push(row);
        i++;
      }
      $('batch-progress').value = i / state.rays.length;
      $('batch-status').textContent = '进行中 ' + i + '/' + state.rays.length;
      if (i < state.rays.length) { setTimeout(step, 0); return; }

      // 完成
      state.batch.running = false;
      $('btn-run').disabled = false; $('btn-cancel').disabled = true;
      const timeMs = performance.now() - t0;
      const sceneSt = IRB.sceneStats(state.scene);
      // 场景级期望（singular_excluded / unique_blas）
      const sceneChecks = [];
      if (state.expected) {
        if (state.expected.singular_excluded !== undefined) {
          const got = sceneSt.invalidInstances.map((x) => x.id).sort();
          const want = [...state.expected.singular_excluded].sort();
          sceneChecks.push({ name: 'singular_excluded', pass: JSON.stringify(got) === JSON.stringify(want), got: got.join(','), want: want.join(',') });
        }
        if (state.expected.unique_blas !== undefined) {
          sceneChecks.push({ name: 'unique_blas', pass: sceneSt.uniqueBlas === state.expected.unique_blas, got: sceneSt.uniqueBlas, want: state.expected.unique_blas });
        }
      }
      state.report = {
        completed: true,
        revision: revAtStart,
        hash: hashAtStart,
        time: new Date().toISOString(),
        timeMs,
        rows, totals, sceneChecks,
        singularExcluded: sceneSt.invalidInstances.map((x) => x.id),
        uniqueBlas: sceneSt.uniqueBlas,
        blasBuilds: sceneSt.blasBuilds,
        tlasBuilds: sceneSt.tlasBuilds,
      };
      renderBatchTable();
      renderBatchSummary(timeMs, totals, sceneChecks);
      refreshReportStatus();
      $('batch-status').textContent = '完成 ' + rows.length + ' 条射线，耗时 ' + timeMs.toFixed(1) + ' ms';
    }
    setTimeout(step, 0);
  }

  function renderBatchTable() {
    const rep = state.report;
    const head = '<tr><th>射线</th><th>BVH 命中</th><th>穷举</th><th>expected</th><th>盒测试(T/B)</th><th>三角</th><th>穷举三角</th></tr>';
    $('batch-table').innerHTML = head + rep.rows.map((r, idx) => {
      if (r.error) return '<tr class="fail"><td>' + r.id + '</td><td colspan="6">射线无效：' + r.error + '</td></tr>';
      const cls = (!r.match || r.expPass === false) ? 'fail' : 'pass';
      return '<tr class="' + cls + '" data-idx="' + idx + '" title="点击在视口中显示该射线">' +
        '<td>' + r.id + '</td><td>' + hitShort(r.bvh) + '</td>' +
        '<td>' + (r.match ? '一致' : '不一致: ' + hitShort(r.brute)) + '</td>' +
        '<td>' + (r.expPass === null ? '—' : r.expPass ? '通过' : '失败') + '</td>' +
        '<td>' + r.stats.tlasAabbTests + ' / ' + r.stats.blasAabbTests + '</td>' +
        '<td>' + r.stats.triTests + '</td><td>' + r.bruteStats.triTests + '</td></tr>';
    }).join('');
    $('batch-table').querySelectorAll('tr[data-idx]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const r = state.report.rows[Number(tr.dataset.idx)];
        if (r && r.ray) doPick(0, 0, { origin: r.ray.origin, dir: IRB.vnormalize(r.ray.direction) });
      });
    });
  }

  function renderBatchSummary(timeMs, t, sceneChecks) {
    const ratio = t.tri > 0 ? (t.bruteTri / t.tri).toFixed(1) : '—';
    const checksHtml = (sceneChecks || []).map((c) =>
      '<div><span class="k">' + c.name + '</span><span class="' + (c.pass ? 'ok' : 'bad') + '">' +
      (c.pass ? '通过' : '失败：得 ' + c.got + '，期望 ' + c.want) + '</span></div>').join('');
    $('batch-summary').innerHTML =
      '<div><span class="k">BVH vs 穷举不一致</span><span class="' + (t.mismatch ? 'bad' : 'ok') + '">' + t.mismatch + '</span></div>' +
      '<div><span class="k">expected 校验</span>' + (t.expectedChecked ? '<span class="' + (t.expectedFail ? 'bad' : 'ok') + '">' + (t.expectedChecked - t.expectedFail) + '/' + t.expectedChecked + ' 通过</span>' : '无 expected 数据') + '</div>' +
      checksHtml +
      '<div><span class="k">AABB 测试总数</span>' + (t.tlasAabb + t.blasAabb) + '（TLAS ' + t.tlasAabb + ' + BLAS ' + t.blasAabb + '）</div>' +
      '<div><span class="k">三角测试 BVH/穷举</span>' + t.tri + ' / ' + t.bruteTri + '（' + ratio + 'x）</div>' +
      '<div><span class="k">耗时</span>' + timeMs.toFixed(1) + ' ms</div>';
  }

  // ---------------- 报告：防冒用 ----------------
  function refreshReportStatus() {
    const el = $('report-status');
    const rep = state.report;
    if (!rep) {
      el.innerHTML = '<span class="dim">尚未生成报告（运行批量比对后生成；取消或编辑场景会作废旧报告）</span>';
      $('btn-export').disabled = true;
      return;
    }
    const curRev = state.scene.revision;
    const curHash = IRB.sceneHash(state.scene);
    const fresh = rep.revision === curRev && rep.hash === curHash;
    el.innerHTML =
      '<div><span class="k">生成时间</span>' + rep.time + '</div>' +
      '<div><span class="k">报告场景版本</span>rev ' + rep.revision + ' / ' + rep.hash + '</div>' +
      '<div><span class="k">当前场景版本</span>rev ' + curRev + ' / ' + curHash + '</div>' +
      '<div><span class="k">状态</span>' + (fresh
        ? '<span class="fresh">有效 — 与当前场景一致</span>'
        : '<span class="stale">已失效 — 场景在报告生成后被修改，该报告不能代表当前结果，请重新运行批量比对</span>') + '</div>';
    $('btn-export').disabled = !fresh;
  }

  function exportReport() {
    const rep = state.report;
    if (!rep) return;
    if (rep.revision !== state.scene.revision || rep.hash !== IRB.sceneHash(state.scene)) {
      refreshReportStatus();
      return; // 双保险：过期报告不导出
    }
    const out = {
      type: 'instance-ray-bvh-comparison-report',
      generatedAt: rep.time,
      sceneRevision: rep.revision,
      sceneHash: rep.hash,
      sceneName: state.sceneName,
      stale: false,
      limits: { maxInstances: 2000, maxFacesPerMesh: 20000 },
      structure: {
        uniqueBlas: rep.uniqueBlas,
        blasBuilds: rep.blasBuilds,
        tlasBuilds: rep.tlasBuilds,
        singularExcluded: rep.singularExcluded,
      },
      totals: {
        rays: rep.rows.length,
        bvhVsBruteMismatches: rep.totals.mismatch,
        expectedChecked: rep.totals.expectedChecked,
        expectedFailed: rep.totals.expectedFail,
        invalidRays: rep.totals.invalidRays,
        sceneChecks: rep.sceneChecks,
        aabbTests: { tlas: rep.totals.tlasAabb, blas: rep.totals.blasAabb },
        triangleTests: { bvh: rep.totals.tri, bruteForce: rep.totals.bruteTri },
        timeMs: rep.timeMs,
      },
      rays: rep.rows.map((r) => r.error ? { id: r.id, error: r.error } : {
        id: r.id,
        bvh: r.bvh, brute: r.brute,
        bvhEqualsBrute: r.match,
        expectedPass: r.expPass,
        tests: { tlasAabb: r.stats.tlasAabbTests, blasAabb: r.stats.blasAabbTests, bvhTriangles: r.stats.triTests, bruteTriangles: r.bruteStats.triTests },
      }),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ray-bvh-report-rev' + rep.revision + '-' + rep.hash + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------------- 实例矩阵编辑 ----------------
  function fillMatrixGrid() {
    const id = $('inst-select').value;
    const inst = state.scene.instances.find((x) => x.id === id);
    const grid = $('matrix-grid');
    if (!inst) { grid.innerHTML = ''; return; }
    grid.innerHTML = inst.matrix.map((v, i) =>
      '<input type="text" data-i="' + i + '" value="' + v + '"' + (i >= 12 ? ' title="末行须为 0,0,0,1"' : '') + '>').join('');
    $('matrix-msg').textContent = inst.valid ? '' : '当前实例被排除：' + inst.invalidReason;
  }
  function applyMatrix() {
    const id = $('inst-select').value;
    if (!id) return;
    const vals = [...$('matrix-grid').querySelectorAll('input')].map((inp) => Number(inp.value));
    if (vals.some((x) => !isFinite(x))) { $('matrix-msg').textContent = '存在非数字输入'; return; }
    const before = IRB.sceneStats(state.scene);
    const err = IRB.updateInstanceMatrix(state.scene, id, vals);
    const after = IRB.sceneStats(state.scene);
    rebuildGpuScene();
    rebuildLines();
    refreshSceneInfo();
    state.selectedInstance = id;
    $('matrix-msg').textContent = (err ? '矩阵非法，实例已排除：' + err : '已应用。') +
      ' BLAS 构建 ' + before.blasBuilds + '→' + after.blasBuilds + '（不变=未重建共享网格），TLAS ' + before.tlasBuilds + '→' + after.tlasBuilds;
  }

  // ---------------- 事件绑定 ----------------
  $('btn-sample').addEventListener('click', () => {
    loadScene(window.SAMPLE_CASES.main.scene, '内置样例');
    state.rays = window.SAMPLE_CASES.main.rays;
    state.expected = window.SAMPLE_CASES.main.expected;
    state.report = null;
    $('batch-table').innerHTML = ''; $('batch-summary').innerHTML = ''; $('batch-status').textContent = '';
    refreshSceneInfo(); refreshReportStatus();
  });
  $('btn-invalid-sample').addEventListener('click', () => {
    loadScene(window.SAMPLE_CASES.invalidAffine.scene, '非法矩阵样例');
    state.rays = window.SAMPLE_CASES.main.rays;
    state.expected = null;
    state.report = null;
    $('batch-table').innerHTML = ''; $('batch-summary').innerHTML = '';
    refreshSceneInfo(); refreshReportStatus();
  });
  $('file-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const loaded = {};
    let left = files.length;
    files.forEach((f) => {
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const data = JSON.parse(rd.result);
          if (/rays/.test(f.name) || (Array.isArray(data) && data[0] && data[0].origin)) loaded.rays = data;
          else if (/expected/.test(f.name)) loaded.expected = data;
          else if (data.meshes && data.instances) loaded.scene = data;
        } catch (err) { alert(f.name + ' 解析失败：' + err.message); }
        if (--left === 0) {
          if (loaded.scene) loadScene(loaded.scene, '上传场景');
          if (loaded.rays) state.rays = loaded.rays;
          if (loaded.expected) state.expected = loaded.expected;
          state.report = null;
          refreshSceneInfo(); refreshReportStatus();
        }
      };
      rd.readAsText(f);
    });
    e.target.value = '';
  });
  $('btn-run').addEventListener('click', runBatch);
  $('btn-cancel').addEventListener('click', () => { state.batch.cancel = true; });
  $('btn-export').addEventListener('click', exportReport);
  $('inst-select').addEventListener('change', () => {
    fillMatrixGrid();
    state.selectedInstance = $('inst-select').value;
    rebuildLines();
  });
  $('btn-apply-matrix').addEventListener('click', applyMatrix);
  $('btn-reset-matrix').addEventListener('click', fillMatrixGrid);
  $('chk-visited').addEventListener('change', rebuildLines);

  // ---------------- 启动 ----------------
  if (gl) {
    initGL();
    loadScene(window.SAMPLE_CASES.main.scene, '内置样例');
    state.rays = window.SAMPLE_CASES.main.rays;
    state.expected = window.SAMPLE_CASES.main.expected;
    refreshSceneInfo();
    requestAnimationFrame(render);
  } else {
    $('viewport-hint').textContent = '当前浏览器不支持 WebGL2，3D 视图不可用（批量比对仍可使用）';
    loadScene(window.SAMPLE_CASES.main.scene, '内置样例');
    state.rays = window.SAMPLE_CASES.main.rays;
    state.expected = window.SAMPLE_CASES.main.expected;
    refreshSceneInfo();
  }
})();
