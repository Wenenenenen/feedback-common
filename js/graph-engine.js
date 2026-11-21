/*
 * 游戏音频处理图 —— 渲染引擎（浏览器 / Node 通用）
 *
 * 约定（见 samples/约定.txt）：
 * - 普通边无 delay，构成前向有向无环图；带 delay 的边是反馈边，只接受正整数 delay
 *   和有限 gain，读节点过去的输出，初态为 0，不参与路径延迟对齐。
 * - 普通信号路径按最长路径对齐：在普通边上插入补偿延迟，使得到达同一节点的
 *   各普通路径总延迟相等（解决并行效果链汇合后出现两次瞬态的问题）。
 * - 节点先将各对齐普通输入和各反馈输入相加，再做节点运算。
 * - latency 实际延迟 samples 帧；gain 按节点当前样本时刻在线性关键帧间插值，两端保持；
 *   mix 直接输出输入和；impulse 为无输入节点。
 * - 输出 48kHz 单声道 IEEE float32 WAV。
 *
 * 渲染按样本顺序精确求值：反馈边 delay >= 1，读到的永远是“过去”的样本，
 * 因此结果与每批处理的样本数（blockSize）完全无关（逐位一致）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GraphEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const SAMPLE_RATE = 48000;
  const MAX_NODES = 64;
  const MAX_EDGES = 128;
  const MAX_SECONDS = 10;
  const MAX_FRAMES = SAMPLE_RATE * MAX_SECONDS;

  class GraphError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.name = 'GraphError';
      this.code = code;
      if (extra) Object.assign(this, extra);
    }
  }

  function isFiniteNumber(x) {
    return typeof x === 'number' && Number.isFinite(x);
  }

  function isPairArray(a) {
    return Array.isArray(a) && a.every(p => Array.isArray(p) && p.length === 2 &&
      isFiniteNumber(p[0]) && isFiniteNumber(p[1]));
  }

  /* ---------------- 校验 + 编译 ---------------- */

  /**
   * 校验图描述并编译成可渲染结构。
   * 失败时抛出 GraphError：
   *  - code 'cycle'：普通边成环，附带 cycleNodes（环上节点）与 cyclePath（一条具体环路径）
   *  - 其它 code：各类非法参数
   */
  function compile(spec) {
    if (!spec || typeof spec !== 'object') {
      throw new GraphError('spec', '图描述必须是 JSON 对象');
    }
    const sampleRate = spec.sample_rate === undefined ? SAMPLE_RATE : spec.sample_rate;
    if (sampleRate !== SAMPLE_RATE) {
      throw new GraphError('sample_rate', `sample_rate 必须是 ${SAMPLE_RATE}`);
    }
    if (!Number.isInteger(spec.frames) || spec.frames < 1 || spec.frames > MAX_FRAMES) {
      throw new GraphError('frames', `frames 必须是 1..${MAX_FRAMES}（48kHz 下最长 10 秒）的整数`);
    }
    const frames = spec.frames;

    if (!Array.isArray(spec.nodes) || spec.nodes.length < 1 || spec.nodes.length > MAX_NODES) {
      throw new GraphError('nodes', `nodes 数量必须在 1..${MAX_NODES} 之间`);
    }
    if (!Array.isArray(spec.edges)) {
      throw new GraphError('edges', 'edges 必须是数组');
    }
    if (spec.edges.length > MAX_EDGES) {
      throw new GraphError('edges', `edges 数量不能超过 ${MAX_EDGES}`);
    }

    const TYPES = new Set(['impulse', 'gain', 'latency', 'mix']);
    const nodes = new Map();
    for (const n of spec.nodes) {
      if (!n || typeof n.id !== 'string' || n.id.length === 0) {
        throw new GraphError('node', '每个节点必须有非空字符串 id');
      }
      if (nodes.has(n.id)) {
        throw new GraphError('node', `节点 id 重复：${n.id}`);
      }
      if (!TYPES.has(n.type)) {
        throw new GraphError('node', `节点 ${n.id} 类型非法：${n.type}（应为 impulse/gain/latency/mix）`);
      }
      const node = { id: n.id, type: n.type };
      if (n.type === 'impulse') {
        if (!isPairArray(n.events)) {
          throw new GraphError('node', `impulse 节点 ${n.id} 需要 events：[[帧, 幅度], ...]`);
        }
        const eventMap = new Map();
        for (const [f, a] of n.events) {
          if (!Number.isInteger(f) || f < 0) {
            throw new GraphError('node', `impulse 节点 ${n.id} 的事件帧必须是非负整数，得到 ${f}`);
          }
          eventMap.set(f, (eventMap.get(f) || 0) + a);
        }
        node.eventMap = eventMap;
      } else if (n.type === 'gain') {
        if (!isPairArray(n.points)) {
          throw new GraphError('node', `gain 节点 ${n.id} 需要 points：[[时刻, 增益], ...]`);
        }
        const pts = n.points.map(p => [p[0], p[1]]);
        for (const [t] of pts) {
          if (t < 0) throw new GraphError('node', `gain 节点 ${n.id} 的关键帧时刻不能为负：${t}`);
        }
        pts.sort((a, b) => a[0] - b[0]);
        node.pts = pts;
        node.ptTimes = pts.map(p => p[0]);
        node.ptValues = pts.map(p => p[1]);
      } else if (n.type === 'latency') {
        if (!Number.isInteger(n.samples) || n.samples < 0) {
          throw new GraphError('node', `latency 节点 ${n.id} 的 samples 必须是非负整数，得到 ${n.samples}`);
        }
        node.samples = n.samples;
      }
      nodes.set(n.id, node);
    }

    if (typeof spec.output !== 'string' || !nodes.has(spec.output)) {
      throw new GraphError('output', `output 必须指向存在的节点，得到 ${spec.output}`);
    }

    // 拆边：无 delay 字段 → 普通边；有 delay 字段 → 反馈边
    const normalEdges = [];
    const feedbackEdges = [];
    spec.edges.forEach((e, i) => {
      const where = `第 ${i} 条边`;
      if (!e || typeof e.src !== 'string' || typeof e.dst !== 'string' ||
          !nodes.has(e.src) || !nodes.has(e.dst)) {
        throw new GraphError('edge', `${where} 的 src/dst 必须指向存在的节点`);
      }
      if (e.delay === undefined || e.delay === null) {
        if (e.gain !== undefined) {
          throw new GraphError('edge', `${where}（${e.src} -> ${e.dst}）是普通边，不接受 gain；反馈边必须显式给出正整数 delay`);
        }
        normalEdges.push({ src: e.src, dst: e.dst, index: i, comp: 0 });
      } else {
        if (!Number.isInteger(e.delay) || e.delay < 1) {
          throw new GraphError('feedback-delay',
            `反馈边 ${e.src} -> ${e.dst} 的 delay 必须是正整数（>= 1），得到 ${e.delay}`);
        }
        const gain = e.gain === undefined ? 1 : e.gain;
        if (!isFiniteNumber(gain)) {
          throw new GraphError('feedback-gain', `反馈边 ${e.src} -> ${e.dst} 的 gain 必须是有限数，得到 ${e.gain}`);
        }
        feedbackEdges.push({ src: e.src, dst: e.dst, delay: e.delay, gain, index: i });
      }
    });

    // impulse 是无输入节点
    for (const e of normalEdges.concat(feedbackEdges)) {
      if (nodes.get(e.dst).type === 'impulse') {
        throw new GraphError('edge', `impulse 节点 ${e.dst} 是无输入节点，但存在指向它的边 ${e.src} -> ${e.dst}`);
      }
    }

    // 普通边必须构成 DAG
    const ids = [...nodes.keys()];
    const cycleNodes = findCycleNodes(ids, normalEdges);
    if (cycleNodes.size > 0) {
      const cyclePath = findOneCycle(ids, normalEdges);
      throw new GraphError('cycle',
        `普通边构成环，环上的节点：${[...cycleNodes].join('、')}。` +
        `普通边必须是无环的；如需反馈，请给边加上正整数 delay。`,
        { cycleNodes: [...cycleNodes], cyclePath });
    }

    // 拓扑序（Kahn）
    const indeg = new Map(ids.map(id => [id, 0]));
    const adj = new Map(ids.map(id => [id, []]));
    for (const e of normalEdges) {
      indeg.set(e.dst, indeg.get(e.dst) + 1);
      adj.get(e.src).push(e);
    }
    const queue = ids.filter(id => indeg.get(id) === 0);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const e of adj.get(id)) {
        indeg.set(e.dst, indeg.get(e.dst) - 1);
        if (indeg.get(e.dst) === 0) queue.push(e.dst);
      }
    }

    // 路径延迟对齐：inTime = 各普通输入边源 outTime 的最大值；outTime = inTime + 自身延迟
    const inTime = new Map();
    const outTime = new Map();
    for (const id of order) {
      const n = nodes.get(id);
      let t = 0;
      for (const e of normalEdges) {
        if (e.dst === id) t = Math.max(t, outTime.get(e.src));
      }
      inTime.set(id, t);
      outTime.set(id, t + (n.type === 'latency' ? n.samples : 0));
    }
    for (const e of normalEdges) {
      e.comp = inTime.get(e.dst) - outTime.get(e.src);
    }

    // 每个节点的输入列表（渲染内层循环用）：普通边 gain=1、offset=补偿；反馈边 offset=delay
    const inputsOf = new Map(ids.map(id => [id, []]));
    for (const e of normalEdges) {
      inputsOf.get(e.dst).push({ src: e.src, offset: e.comp, gain: 1, feedback: false, edge: e });
    }
    for (const e of feedbackEdges) {
      inputsOf.get(e.dst).push({ src: e.src, offset: e.delay, gain: e.gain, feedback: true, edge: e });
    }

    return {
      spec: { sampleRate, frames, output: spec.output },
      nodes, order, normalEdges, feedbackEdges, inputsOf, inTime, outTime,
    };
  }

  /** Tarjan SCC：返回所有处在普通边环上的节点 id（含自环） */
  function findCycleNodes(ids, normalEdges) {
    const adj = new Map(ids.map(id => [id, []]));
    for (const e of normalEdges) adj.get(e.src).push(e.dst);
    const index = new Map(), low = new Map(), onStack = new Set(), stack = [];
    let counter = 0;
    const cyclic = new Set();
    function strongconnect(v) {
      index.set(v, counter); low.set(v, counter); counter++;
      stack.push(v); onStack.add(v);
      for (const w of adj.get(v)) {
        if (!index.has(w)) {
          strongconnect(w);
          low.set(v, Math.min(low.get(v), low.get(w)));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      }
      if (low.get(v) === index.get(v)) {
        const scc = [];
        let w;
        do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
        if (scc.length > 1) {
          for (const n of scc) cyclic.add(n);
        } else if (adj.get(v).includes(v)) {
          cyclic.add(v);
        }
      }
    }
    for (const id of ids) if (!index.has(id)) strongconnect(id);
    return cyclic;
  }

  /** DFS 找一条具体的环路径（用于展示），如 [a, b, c, a] */
  function findOneCycle(ids, normalEdges) {
    const adj = new Map(ids.map(id => [id, []]));
    for (const e of normalEdges) adj.get(e.src).push(e.dst);
    const color = new Map(); // 1=在栈上 2=完成
    const stack = [];
    function dfs(v) {
      color.set(v, 1); stack.push(v);
      for (const w of adj.get(v)) {
        if (color.get(w) === 1) {
          return stack.slice(stack.indexOf(w)).concat([w]);
        }
        if (!color.get(w)) {
          const r = dfs(w);
          if (r) return r;
        }
      }
      stack.pop(); color.set(v, 2);
      return null;
    }
    for (const id of ids) {
      if (!color.get(id)) {
        const r = dfs(id);
        if (r) return r;
      }
    }
    return null;
  }

  /* ---------------- 增益关键帧 ---------------- */

  /** t 时刻的增益：线性插值，两端保持 */
  function gainAt(node, t) {
    const ts = node.ptTimes, vs = node.ptValues;
    const n = ts.length;
    if (n === 0) return 1;
    if (t <= ts[0]) return vs[0];
    if (t >= ts[n - 1]) return vs[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) lo = mid; else hi = mid;
    }
    const t0 = ts[lo], t1 = ts[hi];
    if (t1 === t0) return vs[hi];
    return vs[lo] + (vs[hi] - vs[lo]) * (t - t0) / (t1 - t0);
  }

  /* ---------------- 渲染 ---------------- */

  /**
   * 渲染整图。
   * @param compiled  compile() 的结果
   * @param blockSize 每批处理的样本数（>=1 的整数）；结果与其取值无关
   * @param keep      可选，额外需要保留输出缓冲的节点 id（如探针节点）
   * @returns { output, buffers, inputBuffers, frames }
   *   output：输出节点的 Float32Array；buffers：Map<id, Float32Array>（所有边的源节点 +
   *   输出节点 + keep 中的节点）；inputBuffers：latency 节点的输入延迟线
   */
  function render(compiled, blockSize, keep) {
    const { frames, output: outputId } = compiled.spec;
    if (!Number.isInteger(blockSize) || blockSize < 1) {
      throw new GraphError('block', `blockSize 必须是正整数，得到 ${blockSize}`);
    }

    const keepSet = new Set([outputId]);
    for (const e of compiled.normalEdges) keepSet.add(e.src);
    for (const e of compiled.feedbackEdges) keepSet.add(e.src);
    if (keep) for (const id of keep) keepSet.add(id);

    const buffers = new Map();
    for (const id of keepSet) buffers.set(id, new Float32Array(frames));
    const inputBuffers = new Map(); // latency 节点的输入历史
    for (const [id, n] of compiled.nodes) {
      if (n.type === 'latency') inputBuffers.set(id, new Float32Array(frames));
    }

    // impulse 事件表
    const eventTables = new Map();
    for (const [id, n] of compiled.nodes) {
      if (n.type === 'impulse') {
        const table = new Float32Array(frames);
        for (const [f, a] of n.eventMap) if (f < frames) table[f] += a;
        eventTables.set(id, table);
      }
    }

    const order = compiled.order;
    const nodes = compiled.nodes;
    const inputsOf = compiled.inputsOf;

    for (let start = 0; start < frames; start += blockSize) {
      const end = Math.min(frames, start + blockSize);
      for (let t = start; t < end; t++) {
        for (let k = 0; k < order.length; k++) {
          const id = order[k];
          const node = nodes.get(id);
          const inputs = inputsOf.get(id);
          let sum = 0;
          for (let j = 0; j < inputs.length; j++) {
            const inp = inputs[j];
            const s = t - inp.offset;
            if (s >= 0) sum += inp.gain * buffers.get(inp.src)[s];
          }
          let y;
          switch (node.type) {
            case 'impulse':
              y = eventTables.get(id)[t];
              break;
            case 'gain':
              y = gainAt(node, t) * sum;
              break;
            case 'latency': {
              inputBuffers.get(id)[t] = sum;
              const s = t - node.samples;
              y = s >= 0 ? inputBuffers.get(id)[s] : 0;
              break;
            }
            default: // mix
              y = sum;
          }
          const buf = buffers.get(id);
          if (buf) buf[t] = y;
        }
      }
    }

    return { output: buffers.get(outputId), buffers, inputBuffers, frames };
  }

  /* ---------------- 探针 ---------------- */

  /**
   * 节点 nodeId 在样本 t 处的输入明细与输出。
   * 需要 render() 时把 nodeId 放进 keep。
   * 返回 { t, normal: [{edge, value}], feedback: [{edge, value}], input, gainValue, output }
   */
  function probeAt(compiled, buffers, nodeId, t) {
    const node = compiled.nodes.get(nodeId);
    const inputs = compiled.inputsOf.get(nodeId) || [];
    const normal = [];
    const feedback = [];
    let input = 0;
    for (const inp of inputs) {
      const s = t - inp.offset;
      const value = s >= 0 ? inp.gain * buffers.get(inp.src)[s] : 0;
      input += value;
      (inp.feedback ? feedback : normal).push({ edge: inp.edge, value });
    }
    const buf = buffers.get(nodeId);
    return {
      t,
      normal,
      feedback,
      input,
      gainValue: node.type === 'gain' ? gainAt(node, t) : null,
      output: buf ? buf[t] : null,
    };
  }

  /* ---------------- WAV（IEEE float32） ---------------- */

  function encodeWavFloat32(samples, sampleRate) {
    const n = samples.length;
    const buffer = new ArrayBuffer(44 + n * 4);
    const dv = new DataView(buffer);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + n * 4, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);      // fmt 块大小
    dv.setUint16(20, 3, true);       // 3 = IEEE float
    dv.setUint16(22, 1, true);       // 单声道
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 4, true);
    dv.setUint16(32, 4, true);
    dv.setUint16(34, 32, true);
    writeStr(36, 'data');
    dv.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) dv.setFloat32(44 + i * 4, samples[i], true);
    return buffer;
  }

  return {
    SAMPLE_RATE, MAX_NODES, MAX_EDGES, MAX_FRAMES,
    GraphError, compile, render, probeAt, gainAt, encodeWavFloat32,
    findCycleNodes, findOneCycle,
  };
});
