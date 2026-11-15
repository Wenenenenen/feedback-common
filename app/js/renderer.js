// WebGL2 渲染器：表面合成与各投影帧缓冲输出，全部在线性 RGB 中计算。
(function (global) {
  'use strict';

  const MAX_PROJECTORS = 4;
  const QUAD_VEC4S = MAX_PROJECTORS * 2; // 每台投影两个 vec4

  const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_image;
uniform int u_mode;          // 0: 表面合成  1: 单投影帧  2: 权重蒙层
uniform int u_count;
uniform vec2 u_surfaceSize;
uniform float u_feather;
uniform vec4 u_quads[${QUAD_VEC4S}];   // 每台两个 vec4：(TL,TR) 与 (BR,BL)
uniform mat3 u_quadToH[${MAX_PROJECTORS}]; // 帧缓冲 -> 幕布
uniform mat3 u_hToQuad[${MAX_PROJECTORS}]; // 幕布 -> 帧缓冲
uniform int u_activeProjector;
uniform float u_opacity;

${global.ColorUtil.GLSL}

// 第 i 台的两个打包向量
vec4 quadA(int i) { return u_quads[i * 2]; }
vec4 quadB(int i) { return u_quads[i * 2 + 1]; }

// 点是否在凸四边形内（含边界），返回到四边的最小有符号距离（内部为正）
vec2 insideAndDist(vec2 p, vec4 q01, vec4 q23, out float minDist) {
  vec2 q0 = q01.xy, q1 = q01.zw, q2 = q23.xy, q3 = q23.zw;
  vec2 c = (q0 + q1 + q2 + q3) * 0.25;
  minDist = 1e30;
  float inside = 1.0;
  // 四条边完全展开，避免动态数组索引
  // edge 0: q0->q1
  // edge 1: q1->q2
  // edge 2: q2->q3
  // edge 3: q3->q0
  vec2 a4[4];
  a4[0] = q0; a4[1] = q1; a4[2] = q2; a4[3] = q3;
  vec2 b4[4];
  b4[0] = q1; b4[1] = q2; b4[2] = q3; b4[3] = q0;
  for (int i = 0; i < 4; i++) {
    vec2 e = b4[i] - a4[i];
    vec2 n = vec2(-e.y, e.x);
    n /= length(n);
    if (dot(n, c - a4[i]) < 0.0) n = -n; // 法线指向内侧
    float d = dot(n, p - a4[i]);
    if (d < -1e-6) inside = 0.0;
    minDist = min(minDist, d);
  }
  return vec2(inside, max(minDist, 0.0));
}

vec3 sampleImageLinear(vec2 fbPos) {
  vec2 texSize = vec2(textureSize(u_image, 0));
  vec2 uv = fbPos / texSize;
  uv.y = 1.0 - uv.y;
  vec3 srgb = texture(u_image, uv).rgb;
  return srgbToLinear(srgb);
}

void main() {
  // ---------- 单投影帧缓冲输出 ----------
  if (u_mode == 1 || u_mode == 2) {
    vec2 texSize = vec2(textureSize(u_image, 0));
    // gl_FragCoord.xy 即像素中心 (col+0.5, row+0.5)，原点左下
    vec2 fbPos = vec2(gl_FragCoord.x, texSize.y - gl_FragCoord.y + 1.0) - 0.5;
    mat3 H = u_quadToH[u_activeProjector];
    vec3 sp = H * vec3(fbPos, 1.0);
    vec2 surfacePos = sp.xy / sp.z;
    float md;
    vec2 info = insideAndDist(surfacePos, quadA(u_activeProjector),
                              quadB(u_activeProjector), md);
    float raw = clamp(md / u_feather, 0.0, 1.0);
    if (u_mode == 2) {
      outColor = vec4(vec3(raw), 1.0);
      return;
    }
    vec3 lin = sampleImageLinear(fbPos);
    outColor = vec4(linearToSrgb(lin * raw * u_opacity), 1.0);
    return;
  }

  // ---------- 表面合成 ----------
  // gl_FragCoord 原点左下、位于像素中心；幕布坐标原点左上，故 y 翻转
  vec2 surfacePos = vec2(gl_FragCoord.x - 0.5, u_surfaceSize.y - gl_FragCoord.y + 0.5);
  float raws[${MAX_PROJECTORS}];
  float cover[${MAX_PROJECTORS}];
  float coverCount = 0.0;
  float total = 0.0;
  for (int i = 0; i < ${MAX_PROJECTORS}; i++) {
    raws[i] = 0.0;
    cover[i] = 0.0;
    if (i < u_count) {
      float md;
      vec2 info = insideAndDist(surfacePos, quadA(i), quadB(i), md);
      if (info.x > 0.5) {
        cover[i] = 1.0;
        raws[i] = clamp(md / u_feather, 0.0, 1.0);
        total += raws[i];
        coverCount += 1.0;
      }
    }
  }

  if (u_mode == 2) {
    float w = 0.0;
    if (coverCount == 1.0) {
      w = cover[0];
    } else if (coverCount > 1.0 && total <= 0.0) {
      w = cover[0] / coverCount;
    } else if (total > 0.0) {
      w = raws[0] / total;
    }
    outColor = vec4(vec3(w), 1.0);
    return;
  }

  vec3 accum = vec3(0.0);
  if (coverCount == 1.0) {
    // 规格：仅一台覆盖时权重为 1
    for (int i = 0; i < ${MAX_PROJECTORS}; i++) {
      if (cover[i] > 0.5) {
        vec3 fp = u_hToQuad[i] * vec3(surfacePos, 1.0);
        accum = sampleImageLinear(fp.xy / fp.z);
      }
    }
  } else if (coverCount > 1.0 && total <= 0.0) {
    // 权重总和为零：覆盖者均分
    float w = 1.0 / coverCount;
    for (int i = 0; i < ${MAX_PROJECTORS}; i++) {
      if (cover[i] > 0.5) {
        vec3 fp = u_hToQuad[i] * vec3(surfacePos, 1.0);
        accum += sampleImageLinear(fp.xy / fp.z) * w;
      }
    }
  } else if (total > 0.0) {
    for (int i = 0; i < ${MAX_PROJECTORS}; i++) {
      if (cover[i] > 0.5) {
        float w = raws[i] / total;
        vec3 fp = u_hToQuad[i] * vec3(surfacePos, 1.0);
        accum += sampleImageLinear(fp.xy / fp.z) * w;
      }
    }
  }
  // 未覆盖处 accum 保持黑色
  outColor = vec4(linearToSrgb(accum), 1.0);
}`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('着色器编译失败: ' + log);
    }
    return sh;
  }

  function createProgram(gl) {
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  class Renderer {
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, preserveDrawingBuffer: true
      });
      if (!gl) throw new Error('当前浏览器不支持 WebGL2');
      this.gl = gl;
      this.prog = createProgram(gl);
      this.quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1
      ]), gl.STATIC_DRAW);
      this.loc = {
        aPos: gl.getAttribLocation(this.prog, 'a_pos'),
        uImage: gl.getUniformLocation(this.prog, 'u_image'),
        uMode: gl.getUniformLocation(this.prog, 'u_mode'),
        uCount: gl.getUniformLocation(this.prog, 'u_count'),
        uSurfaceSize: gl.getUniformLocation(this.prog, 'u_surfaceSize'),
        uFeather: gl.getUniformLocation(this.prog, 'u_feather'),
        uQuads: gl.getUniformLocation(this.prog, 'u_quads'),
        uQuadToH: gl.getUniformLocation(this.prog, 'u_quadToH'),
        uHToQuad: gl.getUniformLocation(this.prog, 'u_hToQuad'),
        uActive: gl.getUniformLocation(this.prog, 'u_activeProjector'),
        uOpacity: gl.getUniformLocation(this.prog, 'u_opacity')
      };
      this.textureCache = new WeakMap();
    }

    getTexture(image) {
      const gl = this.gl;
      let tex = this.textureCache.get(image);
      if (tex) return tex;
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      // RGBA8：纹理内保留 sRGB 字节，解码在 shader 中显式完成，避免自动转换
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textureCache.set(image, tex);
      return tex;
    }

    computeMatrices(state) {
      return state.projectors.map((p) => {
        // 非法/退化四边形不求单应，回退单位矩阵；其覆盖判定为假，不参与合成
        if (p.invalidReason) {
          return { H: [1, 0, 0, 0, 1, 0, 0, 0, 1], inv: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
        }
        const [w, h] = p.size;
        const H = Geo.homography(Geo.frameCorners(w, h), p.quad);
        return { H, inv: Geo.invert3(H) };
      });
    }

    copyMat3(out, offset, rowMajor) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          out[offset + c * 3 + r] = rowMajor[r * 3 + c];
        }
      }
    }

    bindCommon(state, mats) {
      const gl = this.gl;
      gl.useProgram(this.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.enableVertexAttribArray(this.loc.aPos);
      gl.vertexAttribPointer(this.loc.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.loc.uImage, 0);
      gl.bindTexture(gl.TEXTURE_2D, this.getTexture(state.image));
      gl.uniform2f(this.loc.uSurfaceSize, state.surface[0], state.surface[1]);
      gl.uniform1f(this.loc.uFeather, state.feather);
      gl.uniform1i(this.loc.uCount, Math.min(state.projectors.length, MAX_PROJECTORS));

      const quads = new Float32Array(QUAD_VEC4S * 4);
      const hFwd = new Float32Array(MAX_PROJECTORS * 9);
      const hInv = new Float32Array(MAX_PROJECTORS * 9);
      for (let i = 0; i < MAX_PROJECTORS; i++) {
        if (i < state.projectors.length) {
          const proj = state.projectors[i];
          if (proj.invalidReason) {
            // 退化到单点：任意点都不在内部，该投影不参与覆盖与合成
            quads.set([0, 0, 0, 0], i * 8);
            quads.set([0, 0, 0, 0], i * 8 + 4);
          } else {
            const q = proj.quad;
            quads.set([q[0][0], q[0][1], q[1][0], q[1][1]], i * 8);
            quads.set([q[2][0], q[2][1], q[3][0], q[3][1]], i * 8 + 4);
          }
          this.copyMat3(hFwd, i * 9, mats[i].H);
          this.copyMat3(hInv, i * 9, mats[i].inv);
        }
      }
      gl.uniform4fv(this.loc.uQuads, quads);
      gl.uniformMatrix3fv(this.loc.uQuadToH, false, hFwd);
      gl.uniformMatrix3fv(this.loc.uHToQuad, false, hInv);
    }

    renderSurface(canvas, state) {
      const gl = this.gl;
      canvas.width = state.surface[0];
      canvas.height = state.surface[1];
      gl.viewport(0, 0, canvas.width, canvas.height);
      const mats = this.computeMatrices(state);
      this.bindCommon(state, mats);
      gl.uniform1i(this.loc.uMode, 0);
      gl.uniform1i(this.loc.uActive, 0);
      gl.uniform1f(this.loc.uOpacity, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    renderProjector(canvas, state, index, opacity = 1) {
      const gl = this.gl;
      const p = state.projectors[index];
      canvas.width = p.size[0];
      canvas.height = p.size[1];
      gl.viewport(0, 0, canvas.width, canvas.height);
      const mats = this.computeMatrices(state);
      this.bindCommon(state, mats);
      gl.uniform1i(this.loc.uMode, 1);
      gl.uniform1i(this.loc.uActive, index);
      gl.uniform1f(this.loc.uOpacity, opacity);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // 单投影的原始羽化权重蒙层（灰度），用于调试可视化
    renderMask(canvas, state, index) {
      const gl = this.gl;
      const p = state.projectors[index];
      canvas.width = p.size[0];
      canvas.height = p.size[1];
      gl.viewport(0, 0, canvas.width, canvas.height);
      const mats = this.computeMatrices(state);
      this.bindCommon(state, mats);
      gl.uniform1i(this.loc.uMode, 2);
      gl.uniform1i(this.loc.uActive, index);
      gl.uniform1f(this.loc.uOpacity, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    readPixels(canvas) {
      const gl = this.gl;
      const w = canvas.width, h = canvas.height;
      const data = new Uint8ClampedArray(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
      const flipped = new Uint8ClampedArray(w * h * 4);
      const row = w * 4;
      for (let y = 0; y < h; y++) {
        flipped.set(data.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      }
      return { width: w, height: h, data: flipped };
    }
  }

  global.Renderer = { Renderer, MAX_PROJECTORS };
})(typeof window !== 'undefined' ? window : globalThis);
