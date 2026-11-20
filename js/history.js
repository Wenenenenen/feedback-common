// 撤销/重做栈与逐步回放（trace player）。
// 撤销单位 = 一次完整用户操作（一次变换 / 一次画笔笔画 / 一次清屏）。

import {
  makeImage, cloneImage, computeEnergy, findVerticalSeam, removeVerticalSeam,
  transpose, insertVerticalSeams, mapSeamToSource, energyForAxis,
} from './seam-engine.js';

export class History {
  constructor(initialImage) {
    this.stack = [{ kind: 'load', label: '载入图像', image: cloneImage(initialImage), trace: null, meta: null }];
    this.cursor = 0;
  }

  get current() {
    return this.stack[this.cursor];
  }

  get canUndo() { return this.cursor > 0; }
  get canRedo() { return this.cursor < this.stack.length - 1; }

  /** 追加一次操作；新操作会丢弃当前位置之后的重做分支。 */
  push(entry) {
    this.stack = this.stack.slice(0, this.cursor + 1);
    this.stack.push(entry);
    this.cursor = this.stack.length - 1;
  }

  undo() {
    if (this.canUndo) this.cursor--;
    return this.current;
  }

  redo() {
    if (this.canRedo) this.cursor++;
    return this.current;
  }
}

/**
 * 把一次操作的 trace 展开为逐步帧。
 * 每帧：{ label, image, overlay:{seam,axis}|null, energy:{axis}|null, stage, event }
 * 图像按引擎口径现场重放（缩：逐条删；扩：发现阶段展示副本、应用阶段展示批次原图+映射缝）。
 */
export function buildReplayFrames(sourceImage, trace) {
  const frames = [];
  frames.push({
    label: '初始图像',
    image: cloneImage(sourceImage),
    overlay: null,
    stage: 'start',
    event: null,
  });
  let cur = cloneImage(sourceImage);

  // 收集按批次分组的扩图事件
  let i = 0;
  while (i < trace.length) {
    const ev = trace[i];
    if (ev.kind === 'shrink') {
      const frame = ev.axis === 'x' ? cur : transpose(cur);
      const E = computeEnergy(frame);
      // 从事件点还原竖缝（点为 [x,y] 原方向）
      const seam = ev.axis === 'x'
        ? ev.seam.map((p) => p[0])
        : ev.seam.map((p) => p[1]); // 原方向点 [x,y]，转置图列号 = 原 y
      const removed = removeVerticalSeam(frame, seam);
      const next = ev.axis === 'x' ? removed : transpose(removed);
      frames.push({
        label: `删除${ev.axis === 'x' ? '竖' : '水平'}缝 #${ev.index + 1}（${cur.width}×${cur.height}）`,
        image: cloneImage(cur),
        overlay: { seam: ev.seam, axis: ev.axis, cumulative: ev.cumulative },
        stage: 'shrink',
        event: ev,
      });
      cur = next;
      i++;
    } else if (ev.kind === 'expand-discover') {
      // 发现阶段：工作副本在该批次内逐条收窄。需要重建该时刻的工作副本。
      // 找到所属批次的 apply 事件以拿到完整信息。
      const batchEvents = [];
      let j = i;
      while (j < trace.length && trace[j].kind === 'expand-discover') {
        batchEvents.push(trace[j]);
        j++;
      }
      const apply = trace[j]; // expand-apply
      // 批次原图：cur（应用前）
      const batchSrc = cloneImage(cur);
      const orientedSrc = apply.axis === 'x' ? batchSrc : transpose(batchSrc);
      // 重放发现过程，逐帧展示工作副本
      let work = cloneImage(orientedSrc);
      const sourceSeams = [];
      for (let k = 0; k < batchEvents.length; k++) {
        const d = batchEvents[k];
        const E = computeEnergy(work);
        const found = findVerticalSeam(E, work.width, work.height);
        const workSeam = found.path;
        const sourceSeam = mapSeamToSource(workSeam, sourceSeams);
        sourceSeams.push(sourceSeam);
        // 工作副本上的覆盖层（转置回原方向坐标）
        const overlayPoints = apply.axis === 'x'
          ? workSeam.map((c, y) => [c, y])
          : workSeam.map((c, y) => [y, c]);
        frames.push({
          label: `批次 ${apply.batch + 1} · 发现缝 ${k + 1}/${apply.requested}（工作副本 ${work.width}×${work.height}）`,
          image: apply.axis === 'x' ? cloneImage(work) : transpose(work),
          overlay: { seam: overlayPoints, axis: apply.axis, cumulative: d.cumulative, work: true },
          stage: 'discover',
          event: d,
        });
        const removed = removeVerticalSeam(work, workSeam);
        work = removed;
      }
      // 应用帧：批次原图 + 映回的全部源坐标缝
      frames.push({
        label: `批次 ${apply.batch + 1} · 插回 ${apply.found} 条缝（${apply.startWidth}×${apply.startHeight} → ${apply.endWidth}×${apply.endHeight}）`,
        image: cloneImage(batchSrc),
        overlay: { seams: apply.seams, axis: apply.axis },
        stage: 'apply',
        event: apply,
      });
      // 计算应用后的新 cur
      const inserted = insertVerticalSeams(orientedSrc, sourceSeams);
      cur = apply.axis === 'x' ? inserted : transpose(inserted);
      i = j + 1;
    } else {
      i++;
    }
  }

  frames.push({
    label: '操作结果',
    image: cloneImage(cur),
    overlay: null,
    stage: 'end',
    event: null,
  });
  return frames;
}

/** 计算某帧在指定轴上的能量（供能量视图切换）。 */
export function frameEnergy(frame, axis) {
  return energyForAxis(frame.image, axis);
}
