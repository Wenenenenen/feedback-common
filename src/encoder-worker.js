/* QG01 编码 Web Worker：避免 512×512 的 DP 阻塞界面。 */
'use strict';

importScripts('./qg01-core.js');

const analyses = new Map();

self.onmessage = function onMessage(event) {
  const msg = event.data || {};
  try {
    if (msg.type === 'analyze') {
      const analysis = QG01.analyzeQuadtree({
        width: msg.width,
        data: msg.pixels,
        mask: msg.mask,
      });
      analyses.set(msg.id, analysis);
      const root = analysis.rootNode.entries;
      self.postMessage({
        type: 'analyzed',
        id: msg.id,
        frontierSize: root.length,
        minBits: root[0]?.bits ?? null,
        maxBits: root[root.length - 1]?.bits ?? null,
      });
      return;
    }

    if (msg.type === 'materialize') {
      const analysis = analyses.get(msg.id);
      if (!analysis) throw new Error('编码分析已失效，请重新导入图像');
      const plan = QG01.encodeOptimal({ ...analysis, budget: msg.budget });
      const planData = {
        width: plan.width,
        height: plan.height,
        budget: plan.budget,
        usedBits: plan.usedBits,
        distortion: plan.distortion,
        nodes: plan.nodes,
        leafIds: plan.leaves.map((node) => node.id),
        reconstructed: plan.reconstructed,
        payload: plan.payload,
      };
      self.postMessage({ type: 'plan', id: msg.id, plan: planData }, [
        plan.reconstructed.buffer,
        plan.payload.buffer,
      ]);
      return;
    }

    if (msg.type === 'dispose') {
      analyses.delete(msg.id);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: msg.id,
      message: error?.message || String(error),
      report: error && typeof error.toReport === 'function' ? error.toReport() : null,
      code: error?.code || null,
    });
  }
};
