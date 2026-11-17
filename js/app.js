/* 级联阴影调试台 —— WebGL2 主程序（依赖 js/mat.js 与 js/csm.js） */
/* global CSMat, CSM */
(function () {
  'use strict';
  const M = CSMat;
  const C = CSM;

  // ---------- 内嵌样例（来自 samples/cascaded-shadow-bench-cases.zip 的 scene.json） ----------
  const SCENE = {
    camera: { position: [0, 3, 8], target: [0, 0, -12], up: [0, 1, 0], fov: 50, aspect: 1.6, near: 1, far: 81 },
    light: { to_light: [-1, 1, 0] },
    ground: { min: [-30, 0, -65], max: [30, 0, 12] },
    boxes: [
      { id: 'offscreen-caster', center: [-20, 16, -12], size: [2, 4, 2] },
      { id: 'near', center: [1, 1, 1], size: [1, 2, 1] },
      { id: 'middle', center: [3, 2, -18], size: [3, 4, 3] },
      { id: 'far', center: [-4, 4, -48], size: [5, 8, 5] },
    ],
    defaults: { lambda: 0.5, resolution: 512, transition: 0.1, bias: 0.0005, pcf: 3 },
  };
  // 内嵌 expected.json / translation-path.json，用于页内自检
  const EXPECTED = {
    near: 1, far: 81,
    splits: {
      '0': [1.0, 27.666666666666668, 54.333333333333336, 81.0],
      '0.5': [1.0, 15.996707688794446, 36.527043870400234, 81.0],
      '1': [1.0, 4.3267487109222245, 18.720754407467133, 81.0],
    },
    shadow_probe: [-4, 0, -12],
    probe_to_light: [-1, 1, 0],
  };
  const TRANSLATION_OFFSETS = [0, 0.1, 0.2, 0.4, 0.6, 1.1];

  const CASCADE_COLORS = [
    [1.0, 0.45, 0.45],
    [0.45, 1.0, 0.45],
    [0.5, 0.55, 1.0],
  ];
  const BOX_COLORS = [
    [0.85, 0.6, 0.3],
    [0.5, 0.75, 0.9],
    [0.7, 0.85, 0.5],
    [0.8, 0.65, 0.85],
  ];
  const GROUND_COLOR = [0.62, 0.64, 0.66];

  // ---------- 状态 ----------
  const state = {
    cam: {
      position: SCENE.camera.position.slice(),
      target: SCENE.camera.target.slice(),
      up: SCENE.camera.up.slice(),
      fov: SCENE.camera.fov,
      near: SCENE.camera.near,
      far: SCENE.camera.far,
    },
    lambda: SCENE.defaults.lambda,
    resolution: SCENE.defaults.resolution,
    transition: SCENE.defaults.transition,
    bias: SCENE.defaults.bias,
    pcf: SCENE.defaults.pcf,
    tint: true,
    frusta: true,
    depthMaps: true,
    splitView: true,
    singleMode: 'stabilized',
  };
  let anim = null; // 平移测试动画 {base, t0}

  const boxAABBs = SCENE.boxes.map((b) => ({
    min: b.center.map((c, i) => c - b.size[i] / 2),
    max: b.center.map((c, i) => c + b.size[i] / 2),
  }));
  const casters = boxAABBs.concat([{ min: SCENE.ground.min, max: SCENE.ground.max }]);

  // ---------- GL 初始化 ----------
  const canvas = document.getElementById('gl');
  const gl = canvas.getContext('webgl2', { antialias: true });
  const $ = (id) => document.getElementById(id);

  function fail(msg) {
    $('selfcheckOut').textContent = '错误：' + msg;
    throw new Error(msg);
  }
  if (!gl) fail('当前浏览器不支持 WebGL2');
  if (!gl.getExtension('EXT_color_buffer_float')) fail('缺少 EXT_color_buffer_float，无法渲染浮点深度图');

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      fail('着色器编译失败：' + gl.getShaderInfoLog(s));
    }
    return s;
  }
  function link(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      fail('着色器链接失败：' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  const VS_DEPTH = `#version 300 es
  layout(location=0) in vec3 aPos;
  uniform mat4 uMVP;
  void main(){ gl_Position = uMVP * vec4(aPos, 1.0); }`;
  const FS_DEPTH = `#version 300 es
  precision highp float;
  out vec4 o;
  void main(){ o = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }`;

  const VS_MAIN = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aNormal;
  uniform mat4 uModel, uView, uProj;
  out vec3 vWorld; out vec3 vNormal; out float vViewZ;
  void main(){
    vec4 w = uModel * vec4(aPos, 1.0);
    vWorld = w.xyz;
    vNormal = mat3(uModel) * aNormal;
    vec4 v = uView * w;
    vViewZ = -v.z;
    gl_Position = uProj * v;
  }`;
  const FS_MAIN = `#version 300 es
  precision highp float;
  in vec3 vWorld; in vec3 vNormal; in float vViewZ;
  uniform sampler2D uMap0, uMap1, uMap2;
  uniform mat4 uVP0, uVP1, uVP2;
  uniform vec4 uSplits;
  uniform vec2 uBands;
  uniform float uBias, uRes, uTintMix;
  uniform int uPCF;
  uniform vec3 uToLight, uBaseColor;
  out vec4 outColor;

  float cmpShadow(sampler2D map, vec2 uv, float depth){
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth < 0.0 || depth > 1.0) return 1.0;
    if (uPCF == 1) {
      return (depth - uBias <= texture(map, uv).r) ? 1.0 : 0.0;
    }
    float lit = 0.0;
    float t = 1.0 / uRes;
    for (int i = -1; i <= 1; i++)
      for (int j = -1; j <= 1; j++)
        lit += (depth - uBias <= texture(map, uv + vec2(float(i), float(j)) * t).r) ? 1.0 : 0.0;
    return lit / 9.0;
  }
  float cascadeShadow(int c, vec3 wp){
    vec4 p;
    if (c == 0) { p = uVP0 * vec4(wp, 1.0); return cmpShadow(uMap0, p.xy * 0.5 + 0.5, p.z * 0.5 + 0.5); }
    if (c == 1) { p = uVP1 * vec4(wp, 1.0); return cmpShadow(uMap1, p.xy * 0.5 + 0.5, p.z * 0.5 + 0.5); }
    p = uVP2 * vec4(wp, 1.0);
    return cmpShadow(uMap2, p.xy * 0.5 + 0.5, p.z * 0.5 + 0.5);
  }
  void main(){
    vec3 N = normalize(vNormal);
    float d = vViewZ;
    float d1 = uSplits[1], d2 = uSplits[2];
    float w1 = max(uBands.x, 1e-6), w2 = max(uBands.y, 1e-6);
    float s, ci;
    if (d < d1 - 0.5 * w1)            { s = cascadeShadow(0, vWorld); ci = 0.0; }
    else if (d < d1 + 0.5 * w1)       { float t = (d - (d1 - 0.5 * w1)) / w1; s = mix(cascadeShadow(0, vWorld), cascadeShadow(1, vWorld), t); ci = t; }
    else if (d < d2 - 0.5 * w2)       { s = cascadeShadow(1, vWorld); ci = 1.0; }
    else if (d < d2 + 0.5 * w2)       { float t = (d - (d2 - 0.5 * w2)) / w2; s = mix(cascadeShadow(1, vWorld), cascadeShadow(2, vWorld), t); ci = 1.0 + t; }
    else                              { s = cascadeShadow(2, vWorld); ci = 2.0; }
    vec3 T0 = vec3(1.0, 0.45, 0.45), T1 = vec3(0.45, 1.0, 0.45), T2 = vec3(0.5, 0.55, 1.0);
    vec3 tint = ci < 1.0 ? mix(T0, T1, ci) : mix(T1, T2, ci - 1.0);
    float ndl = max(dot(N, uToLight), 0.0);
    vec3 col = uBaseColor * (0.25 + 0.9 * ndl * s);
    col = mix(col, tint * (0.25 + 0.9 * ndl * s), uTintMix);
    outColor = vec4(col, 1.0);
  }`;

  const VS_LINE = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aColor;
  uniform mat4 uVP;
  out vec3 vColor;
  void main(){ vColor = aColor; gl_Position = uVP * vec4(aPos, 1.0); }`;
  const FS_LINE = `#version 300 es
  precision highp float;
  in vec3 vColor;
  out vec4 o;
  void main(){ o = vec4(vColor, 1.0); }`;

  const VS_THUMB = `#version 300 es
  layout(location=0) in vec2 aPos;
  out vec2 vUV;
  void main(){ vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const FS_THUMB = `#version 300 es
  precision highp float;
  in vec2 vUV;
  uniform sampler2D uTex;
  out vec4 o;
  void main(){ o = vec4(vec3(texture(uTex, vUV).r), 1.0); }`;

  const progDepth = link(VS_DEPTH, FS_DEPTH);
  const progMain = link(VS_MAIN, FS_MAIN);
  const progLine = link(VS_LINE, FS_LINE);
  const progThumb = link(VS_THUMB, FS_THUMB);

  const U = (prog, name) => gl.getUniformLocation(prog, name);
  const uDepth = { mvp: U(progDepth, 'uMVP') };
  const uMain = {
    model: U(progMain, 'uModel'), view: U(progMain, 'uView'), proj: U(progMain, 'uProj'),
    map0: U(progMain, 'uMap0'), map1: U(progMain, 'uMap1'), map2: U(progMain, 'uMap2'),
    vp0: U(progMain, 'uVP0'), vp1: U(progMain, 'uVP1'), vp2: U(progMain, 'uVP2'),
    splits: U(progMain, 'uSplits'), bands: U(progMain, 'uBands'),
    bias: U(progMain, 'uBias'), res: U(progMain, 'uRes'), tintMix: U(progMain, 'uTintMix'),
    pcf: U(progMain, 'uPCF'), toLight: U(progMain, 'uToLight'), baseColor: U(progMain, 'uBaseColor'),
  };
  const uLine = { vp: U(progLine, 'uVP') };
  const uThumb = { tex: U(progThumb, 'uTex') };

  // ---------- 几何 ----------
  function makeVAO(positions, normals, indices) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    if (normals) {
      const nb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, nb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    }
    if (indices) {
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  const g = SCENE.ground;
  const groundVAO = makeVAO(
    [
      g.min[0], 0, g.min[2], g.max[0], 0, g.min[2], g.max[0], 0, g.max[2],
      g.min[0], 0, g.min[2], g.max[0], 0, g.max[2], g.min[0], 0, g.max[2],
    ],
    [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    null
  );

  // 单位立方体（中心在原点，边长 1），24 顶点 + 36 索引
  const boxVAO = (() => {
    const P = [], N = [], I = [];
    const faces = [
      [[1, 0, 0], [[0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]]],
      [[-1, 0, 0], [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5]]],
      [[0, 1, 0], [[-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]],
      [[0, -1, 0], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5]]],
      [[0, 0, 1], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]],
      [[0, 0, -1], [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]]],
    ];
    for (const [n, quad] of faces) {
      const base = P.length / 3;
      for (const p of quad) { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return makeVAO(P, N, I);
  })();

  // 线段 VAO（动态）
  const lineVAO = gl.createVertexArray();
  const lineVBO = gl.createBuffer();
  gl.bindVertexArray(lineVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineVBO);
  gl.bufferData(gl.ARRAY_BUFFER, 6 * 4 * 4096, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.bindVertexArray(null);

  // 缩略图全屏四边形
  const thumbVAO = (() => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  })();

  // ---------- 阴影贴图 FBO（模式 × 级联） ----------
  const MODES = ['unstabilized', 'stabilized'];
  const shadowFBOs = { unstabilized: [], stabilized: [] };
  let fboSize = 0;

  function ensureFBOs(res) {
    if (fboSize === res) return;
    for (const m of MODES) {
      for (const f of shadowFBOs[m]) {
        if (f) { gl.deleteFramebuffer(f.fbo); gl.deleteTexture(f.tex); gl.deleteRenderbuffer(f.depth); }
      }
      shadowFBOs[m] = [];
      for (let i = 0; i < 3; i++) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, res, res, 0, gl.RED, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, res, res);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          fail('阴影贴图 FBO 不完整');
        }
        shadowFBOs[m].push({ fbo, tex, depth });
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fboSize = res;
  }

  // ---------- 级联计算（含矩阵） ----------
  function computeSets(aspect) {
    const cam = {
      position: state.cam.position, target: state.cam.target, up: state.cam.up,
      fov: state.cam.fov, aspect, near: state.cam.near, far: state.cam.far,
    };
    const splits = C.computeSplits(cam.near, cam.far, state.lambda);
    const bands = C.computeBands(splits, state.transition);
    const sets = {};
    for (const mode of MODES) {
      const r = C.computeCascadeSet({
        cam, splits, toLight: SCENE.light.to_light, casters,
        resolution: state.resolution, stabilize: mode === 'stabilized',
      });
      for (const cas of r.cascades) {
        const b = cas.bounds;
        cas.lightView = M.rotFromRows(r.basis.x, r.basis.y, r.basis.z);
        cas.ortho = M.orthoForwardZ(b.minX, b.maxX, b.minY, b.maxY, b.minZ, b.maxZ);
        cas.lightVP = M.multiply(cas.ortho, cas.lightView);
      }
      sets[mode] = r;
    }
    return { splits, bands, basis: sets.unstabilized.basis, sets };
  }

  // ---------- 视图布局 ----------
  function currentViews() {
    const w = canvas.width, h = canvas.height;
    if (state.splitView) {
      const hw = Math.floor(w / 2);
      return [
        { x: 0, y: 0, w: hw, h, aspect: hw / h, mode: 'unstabilized', label: '未稳定' },
        { x: hw, y: 0, w: w - hw, h, aspect: (w - hw) / h, mode: 'stabilized', label: '稳定' },
      ];
    }
    return [{
      x: 0, y: 0, w, h, aspect: w / h,
      mode: state.singleMode, label: state.singleMode === 'stabilized' ? '稳定' : '未稳定',
    }];
  }

  // ---------- 场景绘制 ----------
  const objects = [
    { vao: groundVAO, count: 6, indexed: false, model: M.modelTRS([0, 0, 0], [1, 1, 1]), color: GROUND_COLOR },
  ];
  SCENE.boxes.forEach((b, i) => {
    objects.push({
      vao: boxVAO, count: 36, indexed: true,
      model: M.modelTRS(b.center, b.size), color: BOX_COLORS[i % BOX_COLORS.length],
    });
  });

  function drawObjects(mvpOf) {
    for (const o of objects) {
      gl.bindVertexArray(o.vao);
      mvpOf(o);
      if (o.indexed) gl.drawElements(gl.TRIANGLES, o.count, gl.UNSIGNED_SHORT, 0);
      else gl.drawArrays(gl.TRIANGLES, 0, o.count);
    }
    gl.bindVertexArray(null);
  }

  function renderDepthPass(set, mode) {
    gl.useProgram(progDepth);
    gl.disable(gl.SCISSOR_TEST); // 清除与绘制必须覆盖整张深度图
    for (const cas of set.cascades) {
      const f = shadowFBOs[mode][cas.index];
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
      gl.viewport(0, 0, fboSize, fboSize);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      drawObjects((o) => {
        gl.uniformMatrix4fv(uDepth.mvp, false, new Float32Array(M.multiply(cas.lightVP, o.model)));
      });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.SCISSOR_TEST);
  }

  function renderMainPass(view, set, frame) {
    gl.viewport(view.x, view.y, view.w, view.h);
    gl.scissor(view.x, view.y, view.w, view.h);
    gl.clearColor(0.13, 0.14, 0.16, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(progMain);
    gl.uniformMatrix4fv(uMain.view, false, new Float32Array(frame.view));
    gl.uniformMatrix4fv(uMain.proj, false, new Float32Array(frame.proj[view.mode]));
    gl.uniform4fv(uMain.splits, new Float32Array(frame.splits));
    gl.uniform2fv(uMain.bands, new Float32Array(frame.bands));
    gl.uniform1f(uMain.bias, state.bias);
    gl.uniform1i(uMain.pcf, state.pcf);
    gl.uniform1f(uMain.res, state.resolution);
    gl.uniform1f(uMain.tintMix, state.tint ? 0.35 : 0.0);
    const L = C.vec.norm(SCENE.light.to_light);
    gl.uniform3fv(uMain.toLight, new Float32Array(L));
    const maps = [uMain.map0, uMain.map1, uMain.map2];
    const vps = [uMain.vp0, uMain.vp1, uMain.vp2];
    for (let i = 0; i < 3; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, shadowFBOs[view.mode][i].tex);
      gl.uniform1i(maps[i], i);
      gl.uniformMatrix4fv(vps[i], false, new Float32Array(set.cascades[i].lightVP));
    }
    drawObjects((o) => {
      gl.uniformMatrix4fv(uMain.model, false, new Float32Array(o.model));
      gl.uniform3fv(uMain.baseColor, new Float32Array(o.color));
    });
  }

  // ---------- 叠加线框 ----------
  function pushLine(arr, a, b, color) {
    arr.push(a[0], a[1], a[2], color[0], color[1], color[2]);
    arr.push(b[0], b[1], b[2], color[0], color[1], color[2]);
  }
  function pushQuad(arr, pts, color) {
    for (let i = 0; i < 4; i++) pushLine(arr, pts[i], pts[(i + 1) % 4], color);
  }
  function lightBoxCorners(basis, b) {
    const c = [];
    for (const x of [b.minX, b.maxX])
      for (const y of [b.minY, b.maxY])
        for (const z of [b.minZ, b.maxZ])
          c.push([
            basis.x[0] * x + basis.y[0] * y + basis.z[0] * z,
            basis.x[1] * x + basis.y[1] * y + basis.z[1] * z,
            basis.x[2] * x + basis.y[2] * y + basis.z[2] * z,
          ]);
    return c; // [ (x,y,z) 组合，顺序：z 最快 ]
  }
  function buildLines(frame, view) {
    const arr = [];
    const cam = {
      position: state.cam.position, target: state.cam.target, up: state.cam.up,
      fov: state.cam.fov, aspect: view.aspect, near: state.cam.near, far: state.cam.far,
    };
    // 相机视锥：分段平面四边形 + 棱线
    const quads = [];
    for (let i = 0; i < frame.splits.length - 1; i++) {
      const pts = C.frustumSliceCorners(cam, frame.splits[i], frame.splits[i + 1]);
      quads.push(pts.slice(0, 4));
      if (i === frame.splits.length - 2) quads.push(pts.slice(4, 8));
    }
    const gray = [0.75, 0.75, 0.75];
    quads.forEach((q, i) => {
      const col = i === 0 || i === quads.length - 1 ? gray : CASCADE_COLORS[(i - 1) % 3];
      pushQuad(arr, q, col);
    });
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i + 1 < quads.length; i++) pushLine(arr, quads[i][k], quads[i + 1][k], gray);
    }
    // 光空间正交盒（当前视图模式）
    const set = frame.sets[view.mode];
    for (const cas of set.cascades) {
      const c = lightBoxCorners(frame.basis, cas.bounds);
      const col = CASCADE_COLORS[cas.index];
      // 角点索引：bit0=x, bit1=y, bit2=z
      const idx = (x, y, z) => x * 4 + y * 2 + z;
      for (const [a, b] of [
        [idx(0, 0, 0), idx(1, 0, 0)], [idx(0, 1, 0), idx(1, 1, 0)],
        [idx(0, 0, 1), idx(1, 0, 1)], [idx(0, 1, 1), idx(1, 1, 1)],
        [idx(0, 0, 0), idx(0, 1, 0)], [idx(1, 0, 0), idx(1, 1, 0)],
        [idx(0, 0, 1), idx(0, 1, 1)], [idx(1, 0, 1), idx(1, 1, 1)],
        [idx(0, 0, 0), idx(0, 0, 1)], [idx(1, 0, 0), idx(1, 0, 1)],
        [idx(0, 1, 0), idx(0, 1, 1)], [idx(1, 1, 0), idx(1, 1, 1)],
      ]) pushLine(arr, c[a], c[b], col);
    }
    // 探针标记
    if (probePoint) {
      const m = [1, 0, 1];
      const s = 0.6;
      pushLine(arr, [probePoint[0] - s, probePoint[1], probePoint[2]], [probePoint[0] + s, probePoint[1], probePoint[2]], m);
      pushLine(arr, [probePoint[0], probePoint[1] - s, probePoint[2]], [probePoint[0], probePoint[1] + s, probePoint[2]], m);
      pushLine(arr, [probePoint[0], probePoint[1], probePoint[2] - s], [probePoint[0], probePoint[1], probePoint[2] + s], m);
    }
    return new Float32Array(arr);
  }

  function renderLines(frame, view) {
    if (!state.frusta && !probePoint) return;
    const data = buildLines(frame, view);
    if (data.length === 0) return;
    gl.useProgram(progLine);
    gl.uniformMatrix4fv(uLine.vp, false, new Float32Array(frame.viewProj[view.mode]));
    gl.bindVertexArray(lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineVBO);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    gl.viewport(view.x, view.y, view.w, view.h);
    gl.drawArrays(gl.LINES, 0, data.length / 6);
    gl.bindVertexArray(null);
  }

  // ---------- 深度图缩略图 ----------
  const thumbLabels = [];
  function renderThumbs(frame, views) {
    const container = $('canvasWrap');
    if (!state.depthMaps) {
      thumbLabels.forEach((d) => (d.style.display = 'none'));
      return;
    }
    const dpr = canvas.width / canvas.clientWidth;
    const size = Math.round(96 * dpr);
    const pad = Math.round(8 * dpr);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(progThumb);
    gl.bindVertexArray(thumbVAO);
    gl.uniform1i(uThumb.tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    let li = 0;
    for (const v of views) {
      for (let i = 0; i < 3; i++) {
        const x = v.x + pad + i * (size + pad);
        const y = pad;
        gl.viewport(x, y, size, size);
        gl.scissor(x, y, size, size);
        gl.bindTexture(gl.TEXTURE_2D, shadowFBOs[v.mode][i].tex);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        let div = thumbLabels[li];
        if (!div) {
          div = document.createElement('div');
          div.className = 'thumbLabel';
          container.appendChild(div);
          thumbLabels[li] = div;
        }
        div.style.display = 'block';
        div.style.left = (x / dpr) + 'px';
        div.style.bottom = ((size + pad + 2) / dpr) + 'px';
        div.textContent = `${v.label}·级${i + 1}`;
        li++;
      }
    }
    for (; li < thumbLabels.length; li++) thumbLabels[li].style.display = 'none';
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  // ---------- 帧数据与渲染 ----------
  let lastFrame = null;
  let probePoint = null;

  function renderFrame() {
    // 画布尺寸
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    ensureFBOs(state.resolution);

    // 平移测试动画：保持朝向，沿光空间 x 轴平移
    if (anim) {
      const T = 4000;
      const ph = ((performance.now() - anim.t0) % T) / T;
      const tri = ph < 0.5 ? ph * 2 : (1 - ph) * 2;
      const o = tri * 1.1; // 0 -> 1.1 -> 0 纹素
      const aspect = currentViews()[0].aspect;
      const base = C.computeCascadeSet({
        cam: { ...anim.base.cam, aspect }, splits: anim.base.splits,
        toLight: SCENE.light.to_light, casters,
        resolution: state.resolution, stabilize: false,
      });
      const texel = base.cascades[0].texel[0];
      const off = C.vec.scale(anim.base.basis.x, o * texel);
      state.cam.position = C.vec.add(anim.base.cam.position, off);
      state.cam.target = C.vec.add(anim.base.cam.target, off);
    }

    const views = currentViews();
    const aspect = views[0].aspect;
    const frame = computeSets(aspect);
    frame.splits = C.computeSplits(state.cam.near, state.cam.far, state.lambda);
    frame.bands = C.computeBands(frame.splits, state.transition);
    frame.view = M.lookAt(state.cam.position, state.cam.target, state.cam.up);
    frame.proj = {};
    frame.viewProj = {};
    for (const v of views) {
      frame.proj[v.mode] = M.perspective(state.cam.fov, v.aspect, state.cam.near, state.cam.far);
      frame.viewProj[v.mode] = M.multiply(frame.proj[v.mode], frame.view);
    }
    frame.views = views;
    frame.camBasis = C.cameraBasis({ position: state.cam.position, target: state.cam.target, up: state.cam.up });

    // 深度通道（每个出现的模式一次）
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.SCISSOR_TEST);
    const done = {};
    for (const v of views) {
      if (!done[v.mode]) { renderDepthPass(frame.sets[v.mode], v.mode); done[v.mode] = true; }
    }
    // 主通道 + 叠加
    for (const v of views) {
      renderMainPass(v, frame.sets[v.mode], frame);
      renderLines(frame, v);
    }
    renderThumbs(frame, views);
    gl.disable(gl.SCISSOR_TEST);

    lastFrame = frame;
    updateViewLabels(views);
  }

  // ---------- 探针（点击地面） ----------
  const readBuf = new Float32Array(4);
  let readbackWarned = false;
  function readTexel(mode, cascade, x, y) {
    const res = state.resolution;
    const cx = Math.min(Math.max(x, 0), res - 1);
    const cy = Math.min(Math.max(y, 0), res - 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFBOs[mode][cascade].fbo);
    gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.FLOAT, readBuf);
    const err = gl.getError();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (err !== gl.NO_ERROR && !readbackWarned) {
      readbackWarned = true;
      $('probeOut').textContent = `警告：深度图读回失败（GL 错误 0x${err.toString(16)}），GPU 阴影值不可用`;
    }
    return readBuf[0];
  }
  function cascadeShadowGPU(mode, cas, pt) {
    const p = M.transformPoint(cas.lightVP, pt);
    const u = p[0] * 0.5 + 0.5, v = p[1] * 0.5 + 0.5, depth = p[2] * 0.5 + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1 || depth < 0 || depth > 1) {
      return { value: 1, uv: [u, v], depth };
    }
    const res = state.resolution;
    const bx = Math.floor(u * res), by = Math.floor(v * res);
    let value;
    if (state.pcf === 1) {
      value = depth - state.bias <= readTexel(mode, cas.index, bx, by) ? 1 : 0;
    } else {
      let lit = 0;
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++)
          if (depth - state.bias <= readTexel(mode, cas.index, bx + i, by + j)) lit++;
      value = lit / 9;
    }
    return { value, uv: [u, v], depth };
  }
  function probeAt(worldPt, mode) {
    const frame = lastFrame;
    const viewDepth = C.vec.dot(C.vec.sub(worldPt, state.cam.position), frame.camBasis.f);
    const sel = C.selectCascade(viewDepth, frame.splits, frame.bands);
    const set = frame.sets[mode];
    const a = cascadeShadowGPU(mode, set.cascades[sel.from], worldPt);
    let value = a.value;
    let detail = `级 ${sel.from + 1}`;
    if (sel.t > 0) {
      const b = cascadeShadowGPU(mode, set.cascades[sel.to], worldPt);
      value = (1 - sel.t) * a.value + sel.t * b.value;
      detail = `级 ${sel.from + 1}→${sel.to + 1} 过渡带 t=${sel.t.toFixed(3)}`;
    }
    const analytic = C.analyticShadow(worldPt, SCENE.light.to_light, boxAABBs);
    return { viewDepth, sel, value, analytic, uv: a.uv, depth: a.depth, detail };
  }

  // ---------- 相机交互 ----------
  let drag = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: 0, button: e.button, shift: e.shiftKey };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    const cam = state.cam;
    if (drag.button === 2 || drag.shift) {
      // 平移
      const off = C.vec.sub(cam.position, cam.target);
      const dist = C.vec.norm(off);
      const b = C.cameraBasis(cam);
      const t = C.vec.add(C.vec.scale(b.r, -dx * dist * 0.0016), C.vec.scale(b.u, dy * dist * 0.0016));
      cam.position = C.vec.add(cam.position, t);
      cam.target = C.vec.add(cam.target, t);
    } else {
      // 轨道旋转
      const off = C.vec.sub(cam.position, cam.target);
      const r = Math.hypot(off[0], off[1], off[2]);
      let theta = Math.atan2(off[0], off[2]);
      let phi = Math.acos(Math.min(Math.max(off[1] / r, -1), 1));
      theta -= dx * 0.005;
      phi = Math.min(Math.max(phi - dy * 0.005, 0.05), Math.PI - 0.05);
      cam.position = [
        cam.target[0] + r * Math.sin(phi) * Math.sin(theta),
        cam.target[1] + r * Math.cos(phi),
        cam.target[2] + r * Math.sin(phi) * Math.cos(theta),
      ];
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    const wasClick = drag && drag.moved < 4 && drag.button === 0;
    drag = null;
    if (!wasClick || !lastFrame) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    const view = lastFrame.views.find((v) => px >= v.x && px < v.x + v.w);
    if (!view) return;
    const ndcX = ((px - view.x) / view.w) * 2 - 1;
    const ndcY = 1 - ((py - view.y) / view.h) * 2;
    const cam = state.cam;
    const b = lastFrame.camBasis;
    const tan = Math.tan((cam.fov * Math.PI) / 360);
    const dir = C.vec.norm(C.vec.add(
      C.vec.add(b.f, C.vec.scale(b.r, ndcX * tan * view.aspect)),
      C.vec.scale(b.u, ndcY * tan)
    ));
    if (dir[1] >= -1e-6) return;
    const t = -cam.position[1] / dir[1];
    const pt = C.vec.add(cam.position, C.vec.scale(dir, t));
    const gnd = SCENE.ground;
    if (pt[0] < gnd.min[0] || pt[0] > gnd.max[0] || pt[2] < gnd.min[2] || pt[2] > gnd.max[2]) {
      $('probeOut').textContent = '点击点在地面范围外';
      return;
    }
    probePoint = pt;
    const r = probeAt(pt, view.mode);
    $('probeOut').textContent =
      `模式：${view.label}　世界点：(${pt.map((v) => v.toFixed(2)).join(', ')})\n` +
      `视图深度：${r.viewDepth.toFixed(3)}　${r.detail}\n` +
      `GPU 阴影值：${r.value.toFixed(3)}（PCF ${state.pcf}×${state.pcf}，偏置 ${state.bias}）\n` +
      `解析阴影值：${r.analytic}（射线-盒求交）　采样 UV：(${r.uv[0].toFixed(3)}, ${r.uv[1].toFixed(3)})　片段深度：${r.depth.toFixed(4)}`;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const cam = state.cam;
    const off = C.vec.sub(cam.position, cam.target);
    const r = Math.hypot(off[0], off[1], off[2]) * Math.exp(e.deltaY * 0.001);
    const d = C.vec.norm(C.vec.sub(cam.position, cam.target));
    cam.position = C.vec.add(cam.target, C.vec.scale(d, Math.min(Math.max(r, 2), 400)));
  }, { passive: false });

  // ---------- 视图角标 ----------
  const viewLabelDivs = [];
  function updateViewLabels(views) {
    const container = $('canvasWrap');
    const dpr = canvas.width / canvas.clientWidth;
    views.forEach((v, i) => {
      let div = viewLabelDivs[i];
      if (!div) {
        div = document.createElement('div');
        div.className = 'viewLabel';
        container.appendChild(div);
        viewLabelDivs[i] = div;
      }
      div.style.display = 'block';
      div.style.left = ((v.x + 10 * dpr) / dpr) + 'px';
      div.style.top = '10px';
      div.textContent = v.label;
    });
    for (let i = views.length; i < viewLabelDivs.length; i++) viewLabelDivs[i].style.display = 'none';
  }

  // ---------- 导出 / 导入 ----------
  function roundN(v, n) { const p = Math.pow(10, n); return Math.round(v * p) / p; }
  function exportJSON() {
    if (!lastFrame) return;
    const frame = lastFrame;
    const packCascade = (set) => set.cascades.map((cas) => ({
      index: cas.index,
      viewDepthRange: [cas.d0, cas.d1],
      orthoBounds: cas.bounds,
      center: cas.center,
      texelWorldSize: cas.texel,
      depthRange: [cas.bounds.minZ, cas.bounds.maxZ],
      lightBasis: { x: frame.basis.x, y: frame.basis.y, z: frame.basis.z },
      lightViewRowMajor: M.transpose(cas.lightView).map((v) => roundN(v, 8)),
      lightViewProjRowMajor: M.transpose(cas.lightVP).map((v) => roundN(v, 8)),
    }));
    const obj = {
      version: 1,
      camera: {
        position: state.cam.position, target: state.cam.target, up: state.cam.up,
        fov: state.cam.fov, near: state.cam.near, far: state.cam.far,
      },
      light: { to_light: SCENE.light.to_light },
      params: {
        lambda: state.lambda, resolution: state.resolution, transition: state.transition,
        bias: state.bias, pcf: state.pcf,
      },
      splits: frame.splits,
      transitionBands: frame.bands,
      cascades: {
        unstabilized: packCascade(frame.sets.unstabilized),
        stabilized: packCascade(frame.sets.stabilized),
      },
    };
    $('ioText').value = JSON.stringify(obj, null, 2);
  }
  function importJSON() {
    try {
      const obj = JSON.parse($('ioText').value);
      if (obj.camera) {
        for (const k of ['position', 'target', 'up']) if (obj.camera[k]) state.cam[k] = obj.camera[k].slice();
        for (const k of ['fov', 'near', 'far']) if (typeof obj.camera[k] === 'number') state.cam[k] = obj.camera[k];
      }
      const p = obj.params || obj;
      for (const k of ['lambda', 'resolution', 'transition', 'bias', 'pcf']) {
        if (typeof p[k] === 'number') state[k] = p[k];
      }
      syncUI();
      $('probeOut').textContent = '参数已导入';
    } catch (err) {
      $('probeOut').textContent = '导入失败：' + err.message;
    }
  }

  // ---------- 自检 ----------
  function approx(a, b, eps) { return Math.abs(a - b) <= eps; }
  function runSelfCheck() {
    const out = [];
    const log = (name, ok, detail) => out.push(`${ok ? '通过' : '失败'} | ${name}${detail ? ' | ' + detail : ''}`);

    // 1. 分段公式 vs expected.json
    let ok = true, det = '';
    for (const [lam, exp] of Object.entries(EXPECTED.splits)) {
      const got = C.computeSplits(EXPECTED.near, EXPECTED.far, parseFloat(lam));
      for (let i = 0; i < 4; i++) {
        if (!approx(got[i], exp[i], 1e-9)) { ok = false; det = `λ=${lam} i=${i}: ${got[i]} != ${exp[i]}`; }
      }
    }
    log('分段公式与 expected.json 一致', ok, det);

    // 2. 解析探针：[-4,0,-12] 应被视锥外遮挡物投影
    const aProbe = C.analyticShadow(EXPECTED.shadow_probe, EXPECTED.probe_to_light, boxAABBs);
    log('解析探针 [-4,0,-12] 处于阴影', aProbe === 0, `解析值=${aProbe}`);
    const aLit = C.analyticShadow([4, 0, -12], EXPECTED.probe_to_light, boxAABBs);
    log('对照点 [4,0,-12] 受光', aLit === 1, `解析值=${aLit}`);

    // 3. 深度范围包含视锥外遮挡物
    {
      const cam = { ...SCENE.camera };
      const splits = C.computeSplits(cam.near, cam.far, SCENE.defaults.lambda);
      const set = C.computeCascadeSet({
        cam, splits, toLight: SCENE.light.to_light, casters,
        resolution: SCENE.defaults.resolution, stabilize: false,
      });
      const basis = set.basis;
      const casterZ = C.occluderZMin(basis, boxAABBs);
      const cb = C.cameraBasis(cam);
      const depth = C.vec.dot(C.vec.sub(EXPECTED.shadow_probe, cam.position), cb.f);
      const bands = C.computeBands(splits, SCENE.defaults.transition);
      const sel = C.selectCascade(depth, splits, bands);
      const zmin = set.cascades[sel.from].bounds.minZ;
      log('级联深度范围包含视锥外遮挡物', zmin <= casterZ,
        `探针深度=${depth.toFixed(2)} 级${sel.from + 1} zMin=${zmin.toFixed(2)} 遮挡物zMin=${casterZ.toFixed(2)}`);
    }

    // 4. 稳定模式：纯平移下投影尺寸不变、中心按纹素取整
    {
      const cam0 = { ...SCENE.camera };
      const splits = C.computeSplits(cam0.near, cam0.far, SCENE.defaults.lambda);
      const res = SCENE.defaults.resolution;
      const baseS = C.computeCascadeSet({ cam: cam0, splits, toLight: SCENE.light.to_light, casters, resolution: res, stabilize: true });
      const baseU = C.computeCascadeSet({ cam: cam0, splits, toLight: SCENE.light.to_light, casters, resolution: res, stabilize: false });
      let ok4 = true, det4 = '';
      for (let ci = 0; ci < 3 && ok4; ci++) {
        const texel = baseS.cascades[ci].texel[0];
        const unsnapped = baseU.cascades[ci].center[0];
        const w0 = baseS.cascades[ci].bounds.maxX - baseS.cascades[ci].bounds.minX;
        for (const o of TRANSLATION_OFFSETS) {
          const off = C.vec.scale(baseS.basis.x, o * texel);
          const camT = { ...cam0, position: C.vec.add(cam0.position, off), target: C.vec.add(cam0.target, off) };
          const sT = C.computeCascadeSet({ cam: camT, splits, toLight: SCENE.light.to_light, casters, resolution: res, stabilize: true });
          const cas = sT.cascades[ci];
          const w = cas.bounds.maxX - cas.bounds.minX;
          if (!approx(w, w0, 1e-9)) { ok4 = false; det4 = `级${ci + 1} 偏移${o}：宽度 ${w} != ${w0}`; break; }
          const snappedTex = cas.center[0] / texel;
          if (!approx(snappedTex, Math.round(snappedTex), 1e-6)) { ok4 = false; det4 = `级${ci + 1} 偏移${o}：中心未对齐纹素`; break; }
          const expect = Math.round(unsnapped / texel + o) - Math.round(unsnapped / texel);
          const gotTex = (cas.center[0] - baseS.cascades[ci].center[0]) / texel;
          if (!approx(gotTex, expect, 1e-6)) { ok4 = false; det4 = `级${ci + 1} 偏移${o}：跳动 ${gotTex} 纹素 != 期望 ${expect}`; break; }
        }
      }
      log('稳定模式平移取整边界（translation-path.json）', ok4, det4);
    }

    // 5. GPU 探针：默认参数下 [-4,0,-12] 阴影值应 < 0.5（两种模式）
    {
      const saved = JSON.parse(JSON.stringify({
        cam: state.cam, lambda: state.lambda, resolution: state.resolution,
        transition: state.transition, bias: state.bias, pcf: state.pcf,
        splitView: state.splitView, singleMode: state.singleMode,
      }));
      Object.assign(state, {
        lambda: SCENE.defaults.lambda, resolution: SCENE.defaults.resolution,
        transition: SCENE.defaults.transition, bias: SCENE.defaults.bias, pcf: SCENE.defaults.pcf,
        splitView: false,
      });
      setCamera(SCENE.camera);
      for (const mode of MODES) {
        state.singleMode = mode;
        renderFrame();
        const r = probeAt(EXPECTED.shadow_probe.slice(), mode);
        log(`GPU 探针阴影值（${mode === 'stabilized' ? '稳定' : '未稳定'}）< 0.5`, r.value < 0.5, `值=${r.value.toFixed(3)}`);
      }
      setCamera(saved.cam);
      Object.assign(state, {
        lambda: saved.lambda, resolution: saved.resolution, transition: saved.transition,
        bias: saved.bias, pcf: saved.pcf, splitView: saved.splitView, singleMode: saved.singleMode,
      });
      renderFrame();
    }

    $('selfcheckOut').textContent = out.join('\n');
  }

  // ---------- UI ----------
  function bindRange(id, obj, key, fmt) {
    const el = $(id);
    const lab = $(id + 'Val');
    const show = () => { if (lab) lab.textContent = fmt ? fmt(obj[key]) : String(obj[key]); };
    el.addEventListener('input', () => { obj[key] = parseFloat(el.value); show(); });
    show();
    return { el, show };
  }
  bindRange('near', state.cam, 'near', (v) => v.toFixed(1));
  bindRange('far', state.cam, 'far', (v) => v.toFixed(0));
  bindRange('fov', state.cam, 'fov', (v) => v.toFixed(0));
  bindRange('lambda', state, 'lambda', (v) => v.toFixed(2));
  bindRange('transition', state, 'transition', (v) => v.toFixed(3));
  bindRange('bias', state, 'bias', (v) => v.toFixed(4));
  $('resolution').addEventListener('change', () => { state.resolution = parseInt($('resolution').value, 10); });
  $('pcf').addEventListener('change', () => { state.pcf = parseInt($('pcf').value, 10); });
  $('tint').addEventListener('change', () => { state.tint = $('tint').checked; });
  $('frusta').addEventListener('change', () => { state.frusta = $('frusta').checked; });
  $('depthMaps').addEventListener('change', () => { state.depthMaps = $('depthMaps').checked; });
  $('splitView').addEventListener('change', () => {
    state.splitView = $('splitView').checked;
    $('singleMode').disabled = state.splitView;
  });
  $('singleMode').addEventListener('change', () => { state.singleMode = $('singleMode').value; });
  function setCamera(cam) { // 就地更新，保持 state.cam 引用不变（UI 绑定持有该引用）
    state.cam.position = cam.position.slice();
    state.cam.target = cam.target.slice();
    state.cam.up = cam.up.slice();
    state.cam.fov = cam.fov;
    state.cam.near = cam.near;
    state.cam.far = cam.far;
  }
  $('resetCam').addEventListener('click', () => {
    setCamera(SCENE.camera);
    syncUI();
  });
  $('animBtn').addEventListener('click', () => {
    if (anim) {
      state.cam.position = anim.base.cam.position;
      state.cam.target = anim.base.cam.target;
      anim = null;
      $('animBtn').textContent = '播放平移测试';
    } else {
      anim = {
        t0: performance.now(),
        base: {
          cam: { ...state.cam, position: state.cam.position.slice(), target: state.cam.target.slice() },
          splits: C.computeSplits(state.cam.near, state.cam.far, state.lambda),
          basis: C.lightBasis(SCENE.light.to_light),
        },
      };
      $('animBtn').textContent = '停止平移测试';
    }
  });
  $('exportBtn').addEventListener('click', exportJSON);
  $('importBtn').addEventListener('click', importJSON);
  $('selfcheckBtn').addEventListener('click', runSelfCheck);

  function syncUI() {
    $('near').value = state.cam.near; $('nearVal').textContent = state.cam.near.toFixed(1);
    $('far').value = state.cam.far; $('farVal').textContent = state.cam.far.toFixed(0);
    $('fov').value = state.cam.fov; $('fovVal').textContent = state.cam.fov.toFixed(0);
    $('lambda').value = state.lambda; $('lambdaVal').textContent = state.lambda.toFixed(2);
    $('transition').value = state.transition; $('transitionVal').textContent = state.transition.toFixed(3);
    $('bias').value = state.bias; $('biasVal').textContent = state.bias.toFixed(4);
    $('resolution').value = String(state.resolution);
    $('pcf').value = String(state.pcf);
    $('tint').checked = state.tint;
    $('frusta').checked = state.frusta;
    $('depthMaps').checked = state.depthMaps;
    $('splitView').checked = state.splitView;
    $('singleMode').disabled = state.splitView;
    $('singleMode').value = state.singleMode;
  }
  syncUI();

  // ---------- 信息面板（节流更新） ----------
  setInterval(() => {
    if (!lastFrame) return;
    const f = lastFrame;
    const lines = [];
    lines.push(`分段距离：${f.splits.map((v) => v.toFixed(2)).join(' / ')}`);
    lines.push(`过渡带宽：${f.bands.map((v) => v.toFixed(3)).join(' / ')}`);
    for (const mode of MODES) {
      const name = mode === 'stabilized' ? '稳定　' : '未稳定';
      f.sets[mode].cascades.forEach((cas, i) => {
        lines.push(
          `${name} 级${i + 1}：纹素 ${cas.texel[0].toFixed(4)}×${cas.texel[1].toFixed(4)}，` +
          `深度 [${cas.bounds.minZ.toFixed(1)}, ${cas.bounds.maxZ.toFixed(1)}]`
        );
      });
    }
    $('infoOut').textContent = lines.join('\n');
  }, 200);

  // ---------- 主循环 ----------
  function loop() {
    renderFrame();
    requestAnimationFrame(loop);
  }
  loop();

  // 调试钩子（冒烟测试用）
  window.__CSB_DEBUG = {
    state, probeAt, readTexel,
    lastFrame: () => lastFrame,
    glError: () => gl.getError(),
  };
})();
