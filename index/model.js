/*
 * model.js — 帧描述的解析与校验
 * 经典脚本：浏览器挂到 window.Tfs，Node 下通过 module.exports 暴露。
 */
(function (root) {
  const Tfs = (root.Tfs = root.Tfs || {});

  const REF_RE = /^(.+)\.(\d+)@(\d+)$/;

  // "a.0@1" -> { image:"a", mip:0, version:1, ref:"a.0@1" }
  Tfs.parseRef = function (ref) {
    if (typeof ref !== 'string') return null;
    const m = REF_RE.exec(ref);
    if (!m) return null;
    return { image: m[1], mip: Number(m[2]), version: Number(m[3]), ref };
  };

  const CHANNELS = { R8: 1, RGBA8: 4 };

  /*
   * 校验一个 case，返回：
   *   { ok:true,  model }  或 { ok:false, errors:[{kind, message, refs?}] }
   */
  Tfs.buildModel = function (caseObj) {
    const errors = [];
    const push = (kind, message, refs) => errors.push({ kind, message, refs: refs || [] });

    if (!caseObj || typeof caseObj !== 'object') {
      push('schema', '用例必须是 JSON 对象');
      return { ok: false, errors };
    }
    const images = caseObj.images || {};
    const passes = Array.isArray(caseObj.passes) ? caseObj.passes : [];
    const exports = Array.isArray(caseObj.exports) ? caseObj.exports : [];

    if (!passes.length) push('schema', '用例缺少 passes 或通道数为 0');
    if (passes.length > 18) push('schema', `每帧最多 18 个通道，当前有 ${passes.length} 个`);

    // ---- 图像表 ----
    const imageTable = {};
    for (const [name, img] of Object.entries(images)) {
      if (!img || !CHANNELS[img.format]) {
        push('image', `图像 ${name} 的格式无效（仅支持 R8 / RGBA8）`);
        continue;
      }
      if (!Array.isArray(img.mips) || !img.mips.length) {
        push('image', `图像 ${name} 缺少 mip 尺寸表`);
        continue;
      }
      const mips = img.mips.map((pair, mi) => {
        const w = pair[0], h = pair[1];
        if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
          push('image', `图像 ${name} 的 mip ${mi} 尺寸无效`);
          return { w: 0, h: 0 };
        }
        if (w > 128 || h > 128) {
          push('image', `图像 ${name} 的 mip ${mi} 边长 ${w}×${h} 超过 128 像素上限`);
        }
        return { w, h };
      });
      imageTable[name] = { name, format: img.format, channels: CHANNELS[img.format], mips };
    }

    const resolveVersion = (ref) => {
      const pr = Tfs.parseRef(ref);
      if (!pr) return { error: `版本引用 "${ref}" 格式不正确，应为 图像.mip@版本` };
      const img = imageTable[pr.image];
      if (!img) return { error: `版本 ${ref} 引用了不存在的图像 ${pr.image}` };
      if (!img.mips[pr.mip]) return { error: `版本 ${ref} 引用了图像 ${pr.image} 不存在的 mip 层 ${pr.mip}` };
      return { parsed: pr, image: img };
    };

    // ---- 通道 ID 唯一性 ----
    const passIds = new Set();
    passes.forEach((p, i) => {
      if (!p || typeof p.id !== 'string' || !p.id) {
        push('pass', `第 ${i + 1} 个通道缺少 id`);
      } else if (passIds.has(p.id)) {
        push('pass', `通道 id "${p.id}" 重复`);
      } else passIds.add(p.id);
    });

    // ---- 输出版本注册表（写一次原则） ----
    const versionMap = new Map(); // ref -> version object
    passes.forEach((p, i) => {
      if (!p || typeof p.out !== 'string') return;
      const r = resolveVersion(p.out);
      if (r.error) { push('out', r.error, [p.out]); return; }
      if (versionMap.has(p.out)) {
        push('out', `版本 ${p.out} 被多个通道写入（${versionMap.get(p.out).producerId} 与 ${p.id}），每个版本只能有一个写者`, [p.out]);
        return;
      }
      const dim = r.image.mips[r.parsed.mip];
      versionMap.set(p.out, {
        ref: p.out,
        image: r.parsed.image,
        mip: r.parsed.mip,
        version: r.parsed.version,
        format: r.image.format,
        channels: r.image.channels,
        w: dim.w, h: dim.h,
        bytes: dim.w * dim.h * r.image.channels,
        producerIndex: i,
        producerId: p.id,
        readers: [],
        lastReaderMask: 0,
        retained: false,
      });
    });

    // ---- 读取引用解析 ----
    passes.forEach((p, i) => {
      if (!p || !Array.isArray(p.read)) return;
      for (const ref of p.read) {
        const r = resolveVersion(ref);
        if (r.error) { push('read', r.error, [ref]); continue; }
        const v = versionMap.get(ref);
        if (!v) {
          push('missing-read', `通道 ${p.id} 读取的版本 ${ref} 没有任何通道写入，无法满足该读取`, [ref]);
          continue;
        }
        v.readers.push(i);
        v.lastReaderMask |= 1 << i;
      }
    });

    // ---- 导出引用 ----
    const retainRefs = new Set();
    for (const ref of exports) {
      const r = resolveVersion(ref);
      if (r.error) { push('export', r.error, [ref]); continue; }
      if (!versionMap.has(ref)) {
        push('export', `导出版本 ${ref} 没有任何通道写入`, [ref]);
        continue;
      }
      retainRefs.add(ref);
    }

    // ---- 操作语义校验 ----
    passes.forEach((p, i) => {
      if (!p || typeof p.out !== 'string') return;
      const out = versionMap.get(p.out);
      if (!out) return;
      const reads = (p.read || []).map((r) => versionMap.get(r)).filter(Boolean);
      const n = out.w * out.h * out.channels;

      if (p.op === 'const') {
        if (p.read.length) push('op', `通道 ${p.id} 的 const 操作不应声明读取`);
        if (!Array.isArray(p.values) || p.values.length !== n) {
          push('op', `通道 ${p.id} 的 const 需要 ${n} 个值（${out.w}×${out.h}×${out.channels}），实际 ${Array.isArray(p.values) ? p.values.length : 0} 个`);
        } else if (p.values.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) {
          push('op', `通道 ${p.id} 的 const 值必须是 0..255 的整数`);
        }
      } else if (p.op === 'add') {
        if (reads.length !== 2) {
          push('op', `通道 ${p.id} 的 add 操作必须读取恰好两个版本，实际 ${reads.length} 个`);
        } else {
          for (const v of reads) {
            if (v.w !== out.w || v.h !== out.h || v.channels !== out.channels) {
              push('op', `通道 ${p.id} 的 add 输入 ${v.ref}（${v.w}×${v.h} ${v.format}）与输出 ${out.ref}（${out.w}×${out.h} ${out.format}）尺寸或格式不一致`);
            }
          }
        }
      } else if (p.op === 'box2') {
        if (reads.length !== 1) {
          push('op', `通道 ${p.id} 的 box2 操作必须读取恰好一个版本，实际 ${reads.length} 个`);
        } else {
          const v = reads[0];
          if (v.image !== out.image || v.mip !== out.mip - 1) {
            push('op', `通道 ${p.id} 的 box2 必须读取同一图像的上一级 mip（期望 ${out.image}.${out.mip - 1}@*，实际 ${v.ref}）`);
          }
          const ew = Math.ceil(v.w / 2), eh = Math.ceil(v.h / 2);
          if (ew !== out.w || eh !== out.h) {
            push('op', `通道 ${p.id} 的 box2 输出尺寸应为 ${ew}×${eh}（输入 ${v.w}×${v.h} 向上取整的一半），实际 ${out.w}×${out.h}`);
          }
        }
      } else {
        push('op', `通道 ${p.id} 的操作 "${p.op}" 不受支持（支持 const / add / box2）`);
      }
    });

    if (errors.length) return { ok: false, errors };

    // ---- 依赖图 + 环检测 ----
    const depsMask = passes.map((p) => {
      let mask = 0;
      for (const ref of p.read || []) {
        const v = versionMap.get(ref);
        if (v) mask |= 1 << v.producerIndex;
      }
      return mask;
    });

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Array(passes.length).fill(WHITE);
    const stack = [];
    let cycle = null;
    const dfs = (u) => {
      color[u] = GRAY;
      stack.push(u);
      for (let v = 0; v < passes.length; v++) {
        if (!(depsMask[u] & (1 << v))) continue;
        if (color[v] === GRAY) {
          const idx = stack.indexOf(v);
          cycle = stack.slice(idx).concat(v);
          return true;
        }
        if (color[v] === WHITE && dfs(v)) return true;
      }
      stack.pop();
      color[u] = BLACK;
      return false;
    };
    for (let i = 0; i < passes.length && !cycle; i++) {
      if (color[i] === WHITE) dfs(i);
    }
    if (cycle) {
      // 把环上的边映射回具体版本引用，便于定位
      const chain = [];
      for (let k = 0; k < cycle.length - 1; k++) {
        const from = cycle[k], to = cycle[k + 1];
        const ref = (passes[from].read || []).find((r) => {
          const v = versionMap.get(r);
          return v && v.producerIndex === to;
        });
        chain.push({ from: passes[from].id, ref, to: passes[to].id });
      }
      const text = chain.map((e) => `${e.from} —读取 ${e.ref}→ ${e.to}`).join('；');
      push('cycle', `依赖存在环：${text}`, chain.flatMap((e) => [e.ref]));
      return { ok: false, errors };
    }

    const versions = [...versionMap.values()];
    return {
      ok: true,
      model: {
        id: caseObj.id || '(未命名)',
        images: imageTable,
        passes,
        versions,
        versionMap,
        depsMask,
        exportRefs: retainRefs,
      },
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.Tfs;
