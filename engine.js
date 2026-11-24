// QuadEngine — 片元四格组 (quad) 导数/LOD 校验引擎
// 纯计算，无 DOM 依赖；浏览器与 Node 通用 (UMD)。
// 语义严格按 samples/quad-program.json 内 rules 实现。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QuadEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const OP = {
    CONST: 0, ADD: 1, MUL: 2,
    FINE_X: 3, FINE_Y: 4, COARSE_X: 5, COARSE_Y: 6,
    DISCARD: 7, TEXTURE: 8,
  };
  const OP_NAME = {
    常量: OP.CONST, 加: OP.ADD, 乘: OP.MUL,
    细横: OP.FINE_X, 细纵: OP.FINE_Y, 粗横: OP.COARSE_X, 粗纵: OP.COARSE_Y,
    舍弃: OP.DISCARD, 纹理: OP.TEXTURE,
  };

  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }
  function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
  function mod(n, m) { return ((n % m) + m) % m; }

  // ---------- 校验 + 构建扁平模型 ----------
  // 返回 { errors:[{scope,line,message}], model }
  function build(pkg) {
    const errors = [];
    const err = (scope, line, message) => errors.push({ scope, line: line || null, message });

    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
      err('package', null, '包必须是 JSON 对象');
      return { errors, model: null };
    }
    const W = pkg.width, H = pkg.height;
    if (!isInt(W) || W < 1 || W > 512) err('package', null, 'width 须为 1..512 的整数');
    if (!isInt(H) || H < 1 || H > 512) err('package', null, 'height 须为 1..512 的整数');
    if (errors.length) return { errors, model: null };

    // ---- quads ----
    const quadsRaw = pkg.quads;
    if (!Array.isArray(quadsRaw) || quadsRaw.length === 0) {
      err('quads', null, 'quads 须为非空数组');
      return { errors, model: null };
    }
    const N = quadsRaw.length;
    const qx = new Int32Array(N), qy = new Int32Array(N), qid = new Float64Array(N);
    const qmask = new Uint8Array(N), qz = new Float64Array(4 * N);
    const qu = new Float64Array(4 * N), qv = new Float64Array(4 * N);
    const seenKey = new Set();
    for (let q = 0; q < N; q++) {
      const qd = quadsRaw[q];
      const tag = `quads[${q}]`;
      if (!qd || typeof qd !== 'object' || Array.isArray(qd)) { err('quads', null, `${tag} 必须是对象`); continue; }
      if (!isInt(qd.x) || qd.x < 0 || qd.x >= W || qd.x % 2 !== 0)
        err('quads', null, `${tag}.x 须为 [0,${W - 1}] 内的偶数整数（越界格不得在 mask 置位）`);
      if (!isInt(qd.y) || qd.y < 0 || qd.y >= H || qd.y % 2 !== 0)
        err('quads', null, `${tag}.y 须为 [0,${H - 1}] 内的偶数整数（越界格不得在 mask 置位）`);
      if (!isInt(qd.id)) err('quads', null, `${tag}.id 须为整数`);
      if (!isInt(qd.mask) || qd.mask < 0 || qd.mask > 15) err('quads', null, `${tag}.mask 须为 0..15 的 4 位掩码`);
      if (!Array.isArray(qd.z) || qd.z.length !== 4 || qd.z.some((z) => !isInt(z)))
        err('quads', null, `${tag}.z 须为 4 个整数`);
      if (!Array.isArray(qd.uv) || qd.uv.length !== 4 ||
        qd.uv.some((p) => !Array.isArray(p) || p.length !== 2 || !isFiniteNum(p[0]) || !isFiniteNum(p[1])))
        err('quads', null, `${tag}.uv 须为 4 对有限浮点`);
      if (errors.length && errors[errors.length - 1].scope === 'quads') continue;

      qx[q] = qd.x; qy[q] = qd.y; qid[q] = qd.id; qmask[q] = qd.mask;
      for (let l = 0; l < 4; l++) {
        qz[4 * q + l] = qd.z[l];
        qu[4 * q + l] = qd.uv[l][0];
        qv[4 * q + l] = qd.uv[l][1];
      }
      // 越界位不得置 1
      const lanePos = [[qd.x, qd.y], [qd.x + 1, qd.y], [qd.x, qd.y + 1], [qd.x + 1, qd.y + 1]];
      for (let l = 0; l < 4; l++) {
        const [lx, ly] = lanePos[l];
        const inb = lx >= 0 && lx < W && ly >= 0 && ly < H;
        if (!inb && (qd.mask & (1 << l)))
          err('quads', null, `${tag} 第 ${l} 格 (${lx},${ly}) 越界，mask 第 ${l} 位不得置 1`);
      }
      const key = qd.x + ',' + qd.y + ',' + qd.id;
      if (seenKey.has(key)) err('quads', null, `${tag} 与更早的 quad 位置、id 完全相同 (${key})`);
      seenKey.add(key);
    }
    if (errors.length) return { errors, model: null };

    // ---- mips ----
    const mipsRaw = pkg.mips;
    if (!Array.isArray(mipsRaw) || mipsRaw.length === 0) {
      err('mips', null, 'mips 须为非空数组');
      return { errors, model: null };
    }
    const mips = [];
    for (let i = 0; i < mipsRaw.length; i++) {
      const m = mipsRaw[i];
      const tag = `mips[${i}]`;
      if (!m || typeof m !== 'object' || Array.isArray(m)) { err('mips', null, `${tag} 必须是对象`); break; }
      if (!isInt(m.width) || m.width < 1 || !isInt(m.height) || m.height < 1) {
        err('mips', null, `${tag}.width/height 须为正整数`); break;
      }
      if (i > 0) {
        const pw = mips[i - 1].W, ph = mips[i - 1].H;
        const ew = Math.max(1, Math.floor(pw / 2)), eh = Math.max(1, Math.floor(ph / 2));
        if (m.width !== ew || m.height !== eh)
          err('mips', null, `${tag} 尺寸应为 ${ew}×${eh}（前层各轴减半向下取整、至少 1）`);
      }
      const hasConst = m.rgb !== undefined, hasPix = m.pixels !== undefined;
      if (hasConst === hasPix) { err('mips', null, `${tag} 须且仅须提供 rgb 常量或 pixels 之一`); break; }
      const layer = { W: m.width, H: m.height, constRGB: null, pix: null };
      if (hasConst) {
        if (!Array.isArray(m.rgb) || m.rgb.length !== 3 || m.rgb.some((c) => !isFiniteNum(c))) {
          err('mips', null, `${tag}.rgb 须为 3 个有限数`); break;
        }
        layer.constRGB = m.rgb.slice();
      } else {
        const need = m.width * m.height;
        if (!Array.isArray(m.pixels) || m.pixels.length !== need ||
          m.pixels.some((p) => !Array.isArray(p) || p.length !== 3 || p.some((c) => !isFiniteNum(c)))) {
          err('mips', null, `${tag}.pixels 须为 ${need} 个 rgb 三元组（按行）`); break;
        }
        const flat = new Float64Array(need * 3);
        for (let k = 0; k < need; k++) { flat[3 * k] = m.pixels[k][0]; flat[3 * k + 1] = m.pixels[k][1]; flat[3 * k + 2] = m.pixels[k][2]; }
        layer.pix = flat;
      }
      mips.push(layer);
    }
    if (errors.length) return { errors, model: null };
    if (mips[mips.length - 1].W !== 1 || mips[mips.length - 1].H !== 1)
      err('mips', null, `mips 链必须完整到 1×1，末层实际为 ${mips[mips.length - 1].W}×${mips[mips.length - 1].H}`);
    if (errors.length) return { errors, model: null };

    // ---- program ----
    const progRaw = pkg.program;
    if (!Array.isArray(progRaw) || progRaw.length === 0) {
      err('program', null, 'program 须为非空数组');
      return { errors, model: null };
    }
    if (!Array.isArray(pkg.out) || pkg.out.length !== 3 || pkg.out.some((n) => typeof n !== 'string' || n.length === 0)) {
      err('program', null, 'out 须为 3 个寄存器名');
      return { errors, model: null };
    }
    const regIndex = new Map();
    const regNames = [];
    const regReg = (name) => {
      let idx = regIndex.get(name);
      if (idx === undefined) { idx = regNames.length; regIndex.set(name, idx); regNames.push(name); }
      return idx;
    };
    const uIdx = regReg('u'), vIdx = regReg('v');
    const written = new Set(['u', 'v']);
    const operand = (raw, line, label) => {
      if (isFiniteNum(raw)) return { reg: -1, lit: raw };
      if (typeof raw === 'string' && raw.length > 0) {
        if (!written.has(raw)) err('program', line, `第 ${line} 行：${label} 读取了尚未写入的寄存器 "${raw}"`);
        return { reg: regReg(raw), lit: 0 };
      }
      err('program', line, `第 ${line} 行：${label} 须是寄存器名或数值常量`);
      return { reg: -1, lit: 0 };
    };
    const ops = [];
    for (let i = 0; i < progRaw.length; i++) {
      const line = i + 1;
      const ins = progRaw[i];
      if (!Array.isArray(ins) || ins.length === 0 || typeof ins[0] !== 'string') {
        err('program', line, `第 ${line} 行：无法识别的指令格式`);
        continue;
      }
      const op = OP_NAME[ins[0]];
      if (op === undefined) { err('program', line, `第 ${line} 行：未知操作码 "${ins[0]}"`); continue; }
      const tgtName = ins[1];
      if (typeof tgtName !== 'string' || tgtName.length === 0) {
        err('program', line, `第 ${line} 行：目标寄存器名非法`);
        continue;
      }
      const tgt = regReg(tgtName);
      if (op === OP.CONST) {
        if (ins.length !== 3) { err('program', line, `第 ${line} 行：常量指令需要 [常量,目标,数值]`); continue; }
        if (!isFiniteNum(ins[2])) { err('program', line, `第 ${line} 行：常量必须是有限数`); continue; }
        ops.push({ op, line, tgt, lit: ins[2] });
      } else if (op === OP.ADD || op === OP.MUL) {
        if (ins.length !== 4) { err('program', line, `第 ${line} 行：${ins[0]}指令需要 4 个元素`); continue; }
        const a = operand(ins[2], line, '甲'), b = operand(ins[3], line, '乙');
        ops.push({ op, line, tgt, a, b });
      } else if (op >= OP.FINE_X && op <= OP.COARSE_Y) {
        if (ins.length !== 3) { err('program', line, `第 ${line} 行：${ins[0]}指令需要 [${ins[0]},目标,源]`); continue; }
        const s = operand(ins[2], line, '源');
        ops.push({ op, line, tgt, s });
      } else if (op === OP.DISCARD) {
        if (ins.length !== 3) { err('program', line, `第 ${line} 行：舍弃指令需要 [舍弃,甲,乙]`); continue; }
        const a = operand(ins[1], line, '甲'), b = operand(ins[2], line, '乙');
        ops.push({ op, line, tgt: -1, a, b });
      } else if (op === OP.TEXTURE) {
        if (ins.length !== 5) { err('program', line, `第 ${line} 行：纹理指令需要 [纹理,目标,u寄存器,v寄存器,通道]`); continue; }
        const cu = operand(ins[2], line, 'u 寄存器'), cv = operand(ins[3], line, 'v 寄存器');
        if (!isInt(ins[4]) || ins[4] < 0 || ins[4] > 2) { err('program', line, `第 ${line} 行：颜色通道编号须为 0、1 或 2`); continue; }
        ops.push({ op, line, tgt, cu, cv, ch: ins[4] });
      }
      written.add(tgtName);
    }
    if (errors.length) return { errors, model: null };
    for (const name of pkg.out) {
      if (!written.has(name)) err('program', null, `输出寄存器 "${name}" 从未被写入`);
    }
    if (errors.length) return { errors, model: null };

    const model = {
      W, H, N, qx, qy, qid, qmask, qz, qu, qv,
      mips, ops, regNames, regIndex, uIdx, vIdx,
      outIdx: pkg.out.map((n) => regIndex.get(n)),
      outNames: pkg.out.slice(),
      texCount: ops.reduce((c, o) => c + (o.op === OP.TEXTURE ? 1 : 0), 0),
    };
    return { errors, model };
  }

  // ---------- 执行 ----------
  function run(model, opts) {
    opts = opts || {};
    const { W, H, N } = model;
    const L = model.mips.length - 1;
    const baseW = model.mips[0].W, baseH = model.mips[0].H;
    const lanes = 4 * N;

    // 寄存器文件
    const regs = model.regNames.map(() => new Float64Array(lanes));
    regs[model.uIdx].set(model.qu);
    regs[model.vIdx].set(model.qv);
    const discard = new Uint8Array(lanes);

    // 覆盖关系：lane -> 像素；像素 -> 覆盖 lane 链表
    const lanePixel = new Int32Array(lanes).fill(-1);
    const covered = new Uint8Array(lanes);
    const head = new Int32Array(W * H).fill(-1);
    const next = new Int32Array(lanes).fill(-1);
    for (let q = 0; q < N; q++) {
      const x = model.qx[q], y = model.qy[q], mask = model.qmask[q];
      const pos = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]];
      for (let l = 0; l < 4; l++) {
        const g = 4 * q + l;
        if (mask & (1 << l)) {
          const p = pos[l][1] * W + pos[l][0];
          covered[g] = 1; lanePixel[g] = p;
          next[g] = head[p]; head[p] = g;
        }
      }
    }

    // 纹理诊断日志（每条纹理指令一组）
    const logBudgetOk = lanes * model.texCount * 8 <= (opts.logByteBudget || 256 * 1024 * 1024);
    const texLogs = [];

    const texel = (layer, x, y, ch) => {
      if (layer.constRGB !== null) return layer.constRGB[ch];
      return layer.pix[3 * (y * layer.W + x) + ch];
    };
    const bilinear = (layer, u, v, ch) => {
      const lw = layer.W, lh = layer.H;
      const s = u * lw - 0.5, t = v * lh - 0.5;
      const i0 = Math.floor(s), j0 = Math.floor(t);
      const fx = s - i0, fy = t - j0;
      const x0 = mod(i0, lw), x1 = mod(i0 + 1, lw);
      const y0 = mod(j0, lh), y1 = mod(j0 + 1, lh);
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy, w11 = fx * fy;
      return texel(layer, x0, y0, ch) * w00 + texel(layer, x1, y0, ch) * w10
        + texel(layer, x0, y1, ch) * w01 + texel(layer, x1, y1, ch) * w11;
    };
    const valOf = (opd, g) => (opd.reg === -1 ? opd.lit : regs[opd.reg][g]);

    for (let oi = 0; oi < model.ops.length; oi++) {
      const o = model.ops[oi];
      const T = regs[o.tgt];
      switch (o.op) {
        case OP.CONST: {
          for (let g = 0; g < lanes; g++) T[g] = o.lit;
          break;
        }
        case OP.ADD: {
          for (let g = 0; g < lanes; g++) T[g] = valOf(o.a, g) + valOf(o.b, g);
          break;
        }
        case OP.MUL: {
          for (let g = 0; g < lanes; g++) T[g] = valOf(o.a, g) * valOf(o.b, g);
          break;
        }
        case OP.FINE_X: {
          const S = regs[o.s.reg];
          for (let q = 0; q < N; q++) {
            const b = 4 * q;
            const d0 = S[b + 1] - S[b], d2 = S[b + 3] - S[b + 2];
            T[b] = d0; T[b + 1] = d0; T[b + 2] = d2; T[b + 3] = d2;
          }
          break;
        }
        case OP.FINE_Y: {
          const S = regs[o.s.reg];
          for (let q = 0; q < N; q++) {
            const b = 4 * q;
            const d0 = S[b + 2] - S[b], d1 = S[b + 3] - S[b + 1];
            T[b] = d0; T[b + 1] = d1; T[b + 2] = d0; T[b + 3] = d1;
          }
          break;
        }
        case OP.COARSE_X: {
          const S = regs[o.s.reg];
          for (let q = 0; q < N; q++) {
            const b = 4 * q;
            const d = S[b + 1] - S[b];
            T[b] = d; T[b + 1] = d; T[b + 2] = d; T[b + 3] = d;
          }
          break;
        }
        case OP.COARSE_Y: {
          const S = regs[o.s.reg];
          for (let q = 0; q < N; q++) {
            const b = 4 * q;
            const d = S[b + 2] - S[b];
            T[b] = d; T[b + 1] = d; T[b + 2] = d; T[b + 3] = d;
          }
          break;
        }
        case OP.DISCARD: {
          for (let g = 0; g < lanes; g++) {
            if (valOf(o.a, g) < valOf(o.b, g)) discard[g] = 1;
          }
          break;
        }
        case OP.TEXTURE: {
          const RU = regs[o.cu.reg], RV = regs[o.cv.reg];
          const lodArr = new Float32Array(lanes);
          const resArr = logBudgetOk ? new Float32Array(lanes) : null;
          for (let q = 0; q < N; q++) {
            const b = 4 * q;
            // 坐标细导数（当时值）
            const dux0 = RU[b + 1] - RU[b], dux2 = RU[b + 3] - RU[b + 2];
            const duy0 = RU[b + 2] - RU[b], duy1 = RU[b + 3] - RU[b + 1];
            const dvx0 = RV[b + 1] - RV[b], dvx2 = RV[b + 3] - RV[b + 2];
            const dvy0 = RV[b + 2] - RV[b], dvy1 = RV[b + 3] - RV[b + 1];
            const fdx = [dux0, dux0, dux2, dux2];
            const fdy = [duy0, duy1, duy0, duy1];
            const gdx = [dvx0, dvx0, dvx2, dvx2];
            const gdy = [dvy0, dvy1, dvy0, dvy1];
            for (let l = 0; l < 4; l++) {
              const g = b + l;
              // 换算为基底纹素
              const ax = fdx[l] * baseW, ay = gdx[l] * baseH;
              const bx = fdy[l] * baseW, by = gdy[l] * baseH;
              const rho = Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
              const lod = rho === 0 ? 0 : Math.min(Math.max(Math.log2(rho), 0), L);
              lodArr[g] = lod;
              const u = RU[g], v = RV[g];
              let val;
              const k = Math.floor(lod);
              if (k >= L) {
                val = bilinear(model.mips[L], u, v, o.ch);
              } else {
                const f = lod - k;
                const c0 = bilinear(model.mips[k], u, v, o.ch);
                const c1 = bilinear(model.mips[k + 1], u, v, o.ch);
                val = (1 - f) * c0 + f * c1;
              }
              T[g] = val;
              if (resArr) resArr[g] = val;
            }
          }
          texLogs.push({ line: o.line, target: model.regNames[o.tgt], cu: model.regNames[o.cu.reg], cv: model.regNames[o.cv.reg], ch: o.ch, lod: lodArr, result: resArr, layers: model.mips.length });
          break;
        }
      }
    }

    // ---------- 深度选择：仅已覆盖且未舍弃者，深度小优先，同深度取小 id ----------
    const winLane = new Int32Array(W * H).fill(-1);
    const winZ = new Float64Array(W * H).fill(Infinity);
    const winId = new Float64Array(W * H).fill(Infinity);
    for (let g = 0; g < lanes; g++) {
      if (!covered[g] || discard[g]) continue;
      const p = lanePixel[g];
      const z = model.qz[g], id = model.qid[g >> 2];
      const cur = winLane[p];
      const better = cur === -1
        || z < winZ[p]
        || (z === winZ[p] && id < winId[p])
        || (z === winZ[p] && id === winId[p] && g < cur); // 兜底：输入顺序 + 车道编号
      if (better) {
        winZ[p] = z; winId[p] = id; winLane[p] = g;
      }
    }

    // ---------- 组装帧 ----------
    const rgb = new Float64Array(W * H * 3);
    const alpha = new Uint8Array(W * H);
    const o0 = model.outIdx[0], o1 = model.outIdx[1], o2 = model.outIdx[2];
    for (let p = 0; p < W * H; p++) {
      const g = winLane[p];
      if (g !== -1) {
        rgb[3 * p] = regs[o0][g]; rgb[3 * p + 1] = regs[o1][g]; rgb[3 * p + 2] = regs[o2][g];
        alpha[p] = 1;
      }
    }

    return {
      W, H, N, regs, regNames: model.regNames.slice(), discard, covered, lanePixel,
      head, next, qx: model.qx, qy: model.qy, qid: model.qid, qmask: model.qmask, qz: model.qz,
      texLogs, logBudgetOk,
      frame: { rgb, alpha, winLane, winZ, winId },
      outNames: model.outNames.slice(),
    };
  }

  // 一站式入口：解析由调用方完成（便于把 JSON.parse 耗时单独计时）
  function validateAndRun(pkg, opts) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const { errors, model } = build(pkg);
    const tBuild = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    if (errors.length) return { ok: false, errors, timings: { build: tBuild } };
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const state = run(model, opts);
    const tRun = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t1;
    return { ok: true, errors: [], model, state, timings: { build: tBuild, run: tRun, total: tBuild + tRun } };
  }

  // 导出线性浮点 RGBA（IEEE binary32，小端，行优先，左上原点）
  function exportRGBAf32(state) {
    const { W, H, frame } = state;
    const buf = new ArrayBuffer(W * H * 16);
    const f32 = new Float32Array(buf);
    for (let p = 0; p < W * H; p++) {
      f32[4 * p] = frame.rgb[3 * p];
      f32[4 * p + 1] = frame.rgb[3 * p + 1];
      f32[4 * p + 2] = frame.rgb[3 * p + 2];
      f32[4 * p + 3] = frame.alpha[p];
    }
    return new Uint8Array(buf);
  }

  // PFM（RGB, f32 小端；alpha 不进 PFM）
  function exportPFM(state) {
    const { W, H, frame } = state;
    const head = `PF\n${W} ${H}\n-1.0\n`;
    const enc = new TextEncoder().encode(head);
    const out = new Uint8Array(enc.length + W * H * 12);
    out.set(enc, 0);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    let off = enc.length;
    for (let y = 0; y < H; y++) { // PFM 行序自下而上
      for (let x = 0; x < W; x++) {
        const p = (H - 1 - y) * W + x;
        dv.setFloat32(off, frame.rgb[3 * p], true);
        dv.setFloat32(off + 4, frame.rgb[3 * p + 1], true);
        dv.setFloat32(off + 8, frame.rgb[3 * p + 2], true);
        off += 12;
      }
    }
    return out;
  }

  return { build, run, validateAndRun, exportRGBAf32, exportPFM, OP, OP_NAME };
});
