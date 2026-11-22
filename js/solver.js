/*
 * solver.js — 三维导览标签排版的精确求解引擎（纯函数，无 DOM 依赖）
 *
 * 约定（与 README 保持一致）：
 *  - 相机空间点 p=[x,y,z]，z 朝相机前方，z < near 的锚点视为在近裁面外。
 *  - 针孔投影：u = fx*x/z + cx，v = fy*y/z + cy（像素坐标系，左上原点）。
 *  - 深度缓冲 depth 为逐像素、行优先的前向距离；0 表示该像素无遮挡物。
 *    锚点取最近像素 (round(u), round(v))，depth>0 且 depth < z 时被深度挡住。
 *  - 标签落位 [dx,dy,cost]：框左上角相对锚点投影点的偏移，框尺寸固定。
 *  - 框不得出画、不得与预留区有正面积交叠、两框不得有正面积交叠（边缘相接合法）。
 *  - 连线为锚点投影点到自身框最近点的线段；线段进入其他标签框内部才判冲突，
 *    贴边/端点接触不算。
 *
 * 求解（每帧精确）：
 *  1) 已显示标签的优先分之和最大；
 *  2) 其上总代价最低（落位代价 + 换落位罚分，默认 2）；
 *  3) 仍同分时按标签 ID 顺序比较落位序号的字典序（隐藏排在所有落位之后）。
 */

/** 将 .5 的四舍五入定义为偏离零（数学常用约定），避免各平台差异。 */
export function roundHalfAway(x) {
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}

export function projectPoint(p, cam) {
  const [x, y, z] = p;
  return {
    z,
    u: (cam.fx * x) / z + cam.cx,
    v: (cam.fy * y) / z + cam.cy,
  };
}

/** 矩形正面积重叠判定（边缘相接返回 false）。 */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectContains(r, x, y) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 点到矩形的最近点（在框内时返回该点本身）。 */
export function nearestPointOnRect(r, x, y) {
  return {
    x: Math.min(Math.max(x, r.x), r.x + r.w),
    y: Math.min(Math.max(y, r.y), r.y + r.h),
  };
}

/**
 * 严格线段-矩形相交：仅当线段存在位于矩形“内部”的点时返回 true。
 * 使用 Liang–Barsky 裁剪，开区间参数 t∈(0,1)，贴边与端点接触均判 false。
 */
export function segmentCrossesRectInterior(x1, y1, x2, y2, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const EPS = 1e-9;
  let tEnter = 0;
  let tExit = 1;
  const sides = [
    [-dx, x1 - r.x], // t 满足 x > r.x 的边界
    [dx, r.x + r.w - x1], // x < r.x+r.w
    [-dy, y1 - r.y], // y > r.y
    [dy, r.y + r.h - y1], // y < r.y+r.h
  ];
  for (const [p, q] of sides) {
    if (Math.abs(p) < EPS) {
      if (q <= 0) return false; // 平行于某边界且不在其严格内侧 → 不可能进入内部
    } else {
      const t = q / p;
      if (p < 0) tEnter = Math.max(tEnter, t);
      else tExit = Math.min(tExit, t);
    }
  }
  // 内部对应开区间 (tEnter, tExit)；要求与开线段 (0,1) 有非空交集。
  return tEnter < tExit - EPS && tEnter < 1 - EPS && tExit > EPS;
}

/**
 * 计算单个锚点在一帧中的可见性。
 * @returns {{visible:boolean, reason:('near'|'offscreen'|'depth'|null), px:number, py:number, proj:{u,v,z}}}
 */
export function anchorVisibility(position, cam, W, H, depth) {
  const [, , z] = position;
  if (!(z >= cam.near)) {
    return { visible: false, reason: 'near', px: -1, py: -1, proj: null };
  }
  const proj = projectPoint(position, cam);
  const px = roundHalfAway(proj.u);
  const py = roundHalfAway(proj.v);
  if (px < 0 || px >= W || py < 0 || py >= H) {
    return { visible: false, reason: 'offscreen', px, py, proj };
  }
  const d = depth[py * W + px];
  if (d > 0 && d < z) {
    return { visible: false, reason: 'depth', px, py, proj };
  }
  return { visible: true, reason: null, px, py, proj };
}

/** 计算某个落位对应的框矩形（锚点投影为浮点坐标，框可以落在亚像素位置）。 */
export function choiceRect(proj, choice, label) {
  const [dx, dy] = choice;
  const [w, h] = label.size;
  return { x: proj.u + dx, y: proj.v + dy, w, h };
}

function rectInsideCanvas(r, W, H) {
  const EPS = 1e-9;
  return r.x >= -EPS && r.y >= -EPS && r.x + r.w <= W + EPS && r.y + r.h <= H + EPS;
}

/**
 * 为一帧构建求解上下文：每个标签的候选落位、可见性、框、连线及冲突位掩码。
 * 选项全局编号 optionIndex，便于用 BigInt 位掩码表达互斥。
 */
export function buildFrameContext(data, frameIndex) {
  const { camera: cam, size: sizeArr, labels, reserved, frames } = data;
  const W = sizeArr[0];
  const H = sizeArr[1];
  const frame = frames[frameIndex];
  const depth = frame.depth;

  const labelRanges = []; // {labelIdx, start, count}
  let totalOptions = 0;
  const options = []; // {labelIdx, choiceIdx, rect, line, cost, feasible, infeasibleReason}
  const labelInfo = labels.map((label, li) => {
    const vis = anchorVisibility(label.position, cam, W, H, depth);
    const start = totalOptions;
    const choices = label.choices || [];
    const entry = { labelIdx: li, start, count: choices.length, vis };
    labelRanges.push(entry);
    choices.forEach((choice, ci) => {
      const rect = choiceRect(vis.proj || { u: NaN, v: NaN }, choice, label);
      let feasible = true;
      let infeasibleReason = null;
      if (!vis.visible) {
        feasible = false;
        infeasibleReason = vis.reason;
      } else if (!rectInsideCanvas(rect, W, H)) {
        feasible = false;
        infeasibleReason = 'offscreen-box';
      } else if (reserved.some((rr) => rectsOverlap(rect, rr))) {
        feasible = false;
        infeasibleReason = 'reserved';
      }
      const np = vis.proj ? nearestPointOnRect(rect, vis.proj.u, vis.proj.v) : null;
      options.push({
        labelIdx: li,
        choiceIdx: ci,
        rect,
        line: np ? { x1: vis.proj.u, y1: vis.proj.v, x2: np.x, y2: np.y } : null,
        cost: choice[2],
        feasible,
        infeasibleReason,
      });
    });
    totalOptions += choices.length;
    return entry;
  });

  // 选项对冲突：框正面积交叠，或任一连线穿过对方框内部
  const conflict = new Array(totalOptions).fill(0).map(() => 0n);
  for (let i = 0; i < totalOptions; i++) {
    const oi = options[i];
    if (!oi.feasible) continue;
    for (let j = i + 1; j < totalOptions; j++) {
      const oj = options[j];
      if (!oj.feasible || oi.labelIdx === oj.labelIdx) continue;
      let hit = rectsOverlap(oi.rect, oj.rect);
      if (!hit) {
        hit =
          segmentCrossesRectInterior(oi.line.x1, oi.line.y1, oi.line.x2, oi.line.y2, oj.rect) ||
          segmentCrossesRectInterior(oj.line.x1, oj.line.y1, oj.line.x2, oj.line.y2, oi.rect);
      }
      if (hit) {
        conflict[i] |= 1n << BigInt(j);
        conflict[j] |= 1n << BigInt(i);
      }
    }
  }

  return { W, H, labels, labelRanges, labelInfo, options, conflict, totalOptions, frame };
}

const MAX_NODES = 2_000_000;

/**
 * 单帧精确求解（分支定界）。
 * @param ctx buildFrameContext 的结果
 * @param prevAssign 上一帧分配：{labelIdx -> choiceIdx}，仅对“上一帧显示”的标签生效
 * @param weights 每标签优先分
 * @param switchPenalty 换落位罚分（默认 2）
 * @returns {{assign:number[], hidden:number[], score:{weight,cost,switchCost,baseCost,tieKey:number[]}, nodes:number}}
 *
 * 标签按输入顺序（即 ID 定序）处理；每个标签先试各可行落位（序号升序）再试隐藏，
 * 因而找到的第一个最优解天然满足同分字典序规则，无需在节点内额外比较 tie。
 */
export function solveFrame(ctx, prevAssign, weights, switchPenalty = 2) {
  const n = ctx.labels.length;
  const { labelRanges, options, conflict } = ctx;
  const HIDDEN_TIE = 99; // 隐藏在字典序中排在所有真实落位之后

  const feasibleChoiceLists = labelRanges.map((range) => {
    const out = [];
    for (let g = range.start; g < range.start + range.count; g++) {
      if (options[g].feasible) out.push(g);
    }
    return out;
  });

  function optionCost(g) {
    const opt = options[g];
    const prev = prevAssign ? prevAssign[opt.labelIdx] : undefined;
    const switched = prev !== undefined && prev !== opt.choiceIdx;
    return opt.cost + (switched ? switchPenalty : 0);
  }

  function lexLess(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  }

  // 后缀最大权重（乐观上界：剩余标签全部可显示），用于权重剪枝
  const suffixWeight = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffixWeight[i] = suffixWeight[i + 1] + weights[i];

  // 贪心初始可行解（每标签取第一个未被禁用的落位），给 B&B 一个紧的初始界
  let bm0 = 0n;
  const greedyPick = new Array(n).fill(-1);
  let greedyW = 0;
  let greedyC = 0;
  for (let i = 0; i < n; i++) {
    let chosen = -1;
    for (const g of feasibleChoiceLists[i]) {
      if ((bm0 & (1n << BigInt(g))) === 0n) {
        chosen = g;
        break;
      }
    }
    if (chosen >= 0) {
      greedyPick[i] = chosen;
      bm0 |= conflict[chosen];
      greedyW += weights[i];
      greedyC += optionCost(chosen);
    }
  }

  // 现任最优解（完整三级目标：权重 > 代价 > 字典序）
  let incW = greedyW;
  let incC = greedyC;
  let incTie = greedyPick.map((g, li) => (g < 0 ? HIDDEN_TIE : options[g].choiceIdx));
  const pick = new Array(n).fill(-1);

  let nodes = 0;
  let aborted = false;

  // 判断完整解 (w,c,tie) 是否优于现任，若是则更新
  function improve(w, c, tie) {
    if (w > incW || (w === incW && (c < incC || (c === incC && lexLess(tie, incTie))))) {
      incW = w;
      incC = c;
      incTie = tie.slice();
      return true;
    }
    return false;
  }

  function dfs(idx, blockedMask, curW, curC) {
    if (aborted) return;
    if (++nodes > MAX_NODES) {
      aborted = true;
      return;
    }
    const ubW = curW + suffixWeight[idx];
    // 剪枝 1：权重乐观上界低于现任权重
    if (ubW < incW) return;
    // 剪枝 2：权重最多持平且当前代价已不低于现任（所有代价非负）
    if (ubW <= incW && curC >= incC) return;

    if (idx === n) {
      improve(curW, curC, pick.map((g, li) => (g < 0 ? HIDDEN_TIE : options[g].choiceIdx)));
      return;
    }

    // 分支 1：各可行落位（choiceIdx 升序）
    for (const g of feasibleChoiceLists[idx]) {
      if ((blockedMask & (1n << BigInt(g))) !== 0n) continue;
      pick[idx] = g;
      dfs(idx + 1, blockedMask | conflict[g], curW + weights[idx], curC + optionCost(g));
      if (aborted) return;
    }

    // 分支 2：隐藏（字典序中排在所有真实落位之后）
    pick[idx] = -1;
    dfs(idx + 1, blockedMask, curW, curC);
  }

  dfs(0, 0n, 0, 0);
  if (aborted) throw new Error('求解节点数超过上限 ' + MAX_NODES);

  // 由 incTie 还原全局选项选择
  const bestPicks = incTie.map((t, li) => {
    if (t === HIDDEN_TIE) return -1;
    return labelRanges[li].start + t;
  });
  if (aborted) throw new Error('求解节点数超过上限 ' + MAX_NODES);

  const assign = new Array(n).fill(-1);
  const hidden = [];
  let baseCost = 0;
  let switchCost = 0;
  const tieKey = [];
  bestPicks.forEach((g, li) => {
    if (g < 0) {
      hidden.push(li);
      tieKey.push(-1);
      return;
    }
    assign[li] = options[g].choiceIdx;
    tieKey.push(options[g].choiceIdx);
    baseCost += options[g].cost;
    const prev = prevAssign ? prevAssign[li] : undefined;
    if (prev !== undefined && prev !== options[g].choiceIdx) switchCost += switchPenalty;
  });

  return {
    assign,
    hidden,
    score: { weight: incW, cost: incC, baseCost, switchCost, tieKey },
    nodes,
  };
}

/**
 * 顺序求解整段帧序列（顺播）。换落位罚分只依赖紧邻的上一帧。
 * 返回每帧结果，UI 回拖时直接复用该数组即可逐帧重现顺播结果。
 */
export function solveSequence(data, opts = {}) {
  const weights = opts.weights || data.labels.map((l) => l.weight);
  const switchPenalty = opts.switchPenalty ?? 2;
  const results = [];
  let prev = null;
  for (let f = 0; f < data.frames.length; f++) {
    const ctx = buildFrameContext(data, f);
    const res = solveFrame(ctx, prev, weights, switchPenalty);
    results.push({ frame: f, ctx, ...res });
    const nextPrev = {};
    res.assign.forEach((ci, li) => {
      if (ci >= 0) nextPrev[li] = ci;
    });
    prev = nextPrev;
  }
  return results;
}

/**
 * 诊断：列出当前帧上的全部冲突（供 UI“点看冲突”）。
 * 包含锚点不可见、落位不可行原因，以及可行落位两两之间的几何冲突。
 */
export function diagnoseFrame(ctx) {
  const items = [];
  ctx.labelInfo.forEach((info, li) => {
    if (!info.vis.visible) {
      items.push({
        type: 'anchor-hidden',
        labelIdx: li,
        reason: info.vis.reason,
        px: info.vis.px,
        py: info.vis.py,
      });
    }
  });
  ctx.options.forEach((opt, g) => {
    if (!opt.feasible) {
      items.push({
        type: 'infeasible',
        labelIdx: opt.labelIdx,
        choiceIdx: opt.choiceIdx,
        optionIndex: g,
        reason: opt.infeasibleReason,
        rect: opt.rect,
      });
    }
  });
  for (let i = 0; i < ctx.totalOptions; i++) {
    for (let j = i + 1; j < ctx.totalOptions; j++) {
      if ((ctx.conflict[i] & (1n << BigInt(j))) !== 0n) {
        const a = ctx.options[i];
        const b = ctx.options[j];
        const overlap = rectsOverlap(a.rect, b.rect);
        items.push({
          type: 'pair',
          kind: overlap ? 'box-overlap' : 'line-cross',
          labelA: a.labelIdx,
          choiceA: a.choiceIdx,
          optionA: i,
          labelB: b.labelIdx,
          choiceB: b.choiceIdx,
          optionB: j,
          rectA: a.rect,
          rectB: b.rect,
        });
      }
    }
  }
  return items;
}

export const REASON_TEXT = {
  near: '近裁面外',
  offscreen: '锚点投影出画',
  depth: '被深度遮挡',
  'offscreen-box': '标签框出画',
  reserved: '压预留区',
  'box-overlap': '标签框互相覆盖',
  'line-cross': '连线穿过标签框内部',
};
