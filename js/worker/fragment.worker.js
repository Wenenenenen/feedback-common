/*
 * Web Worker：在后台线程执行笼校验、变换构建与面裁分，避免阻塞渲染主线程。
 * 输入消息 {type:'process', data}，输出进度与最终结果/错误。
 */
'use strict';
importScripts('../geom/exact.js', '../geom/intersect.js', '../geom/cage.js', '../geom/fragmenter.js');

self.onmessage = function (ev) {
  const msg = ev.data;
  if (msg.type !== 'process') return;
  const data = msg.data;
  try {
    const rest = data.rest;
    const cells = data.cells;
    const pose = data.pose && data.pose.length === rest.length ? data.pose : rest;

    postMessage({ type: 'progress', stage: 'validate-rest', ratio: 0.05 });
    const vRest = TCCage.validateCage(rest, cells);

    postMessage({ type: 'progress', stage: 'validate-pose', ratio: 0.25 });
    const vPose = TCCage.validateCage(pose, cells);

    // 体积符号前后一致性
    const signFlip = TCCage.volumeSignMismatch(vRest.volSign, vPose.volSign);
    const badCells = Array.from(new Set([...vRest.badCells, ...vPose.badCells, ...signFlip])).sort((a, b) => a - b);
    const reasons = new Map([...vRest.reasons, ...vPose.reasons]);
    for (const ci of signFlip) if (!reasons.has(ci)) reasons.set(ci, '变形后有向体积符号翻转（单元反向）');

    postMessage({ type: 'progress', stage: 'transform', ratio: 0.4 });
    let transforms = TCCage.cellTransforms(rest, pose, cells);
    const degenerate = transforms.some(t => t === null);
    if (degenerate) {
      // 退化单元无法构造真实变换：用恒等变换兜底，使校验结论（badCells）仍能返回展示，
      // 碎片位置不代表真实变形，但非法单元已被明确标出，且上一份成功结果仍可导出。
      transforms = transforms.map((t, ci) => t || {
        F: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        N: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        t: [0, 0, 0],
      });
    }

    postMessage({ type: 'progress', stage: 'fragment', ratio: 0.5 });
    const result = TCFrag.fragmentModel(data, transforms, (ratio) => {
      postMessage({ type: 'progress', stage: 'fragment-scan', ratio: 0.5 + 0.45 * ratio });
    });

    postMessage({ type: 'progress', stage: 'finalize', ratio: 0.98 });
    // 组装可传输的纯数据结果
    const payload = {
      type: 'result',
      stats: result.stats,
      badCells,
      cellReasons: Array.from(reasons.entries()),
      badFaces: result.badFaces,
      faceErrors: result.faceErrors,
      verts: result.globalVerts.map(gv => ({
        rest: gv.rest,
        deformed: result.deformed[gv.id],
        ownerCell: gv.ownerCell,
        bary: gv.bary,
      })),
      fragments: result.fragments.map(fr => ({
        faceId: fr.faceId,
        cellId: fr.cellId,
        vertIds: fr.vertIds,
        cornerNormals: fr.cornerNormals,
        area: fr.polyArea,
      })),
      // 法线：每角法线经所属单元逆转置变换并归一化（在主线程也可重算，这里一并给出）
    };
    // 变形后法线（导出用）
    payload.fragments.forEach(fr => {
      const tr = transforms[fr.cellId];
      fr.deformedNormals = fr.cornerNormals.map(n => {
        const raw = TCCage.applyNormal(tr, n);
        const nn = TCCage.normalize3(raw);
        return nn || [0, 0, 1];
      });
    });
    postMessage(payload);
  } catch (err) {
    postMessage({ type: 'error', error: (err && err.message) ? err.message : String(err) });
  }
};
