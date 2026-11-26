// 对齐计算运行在 Web Worker，避免阻塞 UI 线程
import {
  parseFingerprints, validateSettings, align, buildExport,
} from './algo.js';

let lastValidResult = null; // 保留上一次有效结果
let lastValidLocks = [];

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type !== 'align') return;
  const { masterArr, deliveryArr, settingsRaw, locks } = msg;
  try {
    const master = parseFingerprints(masterArr, '主版');
    const delivery = parseFingerprints(deliveryArr, '交付版');
    const settings = validateSettings(settingsRaw);
    const result = align(master, delivery, settings, locks || [], (p) => {
      self.postMessage({ type: 'progress', progress: p });
    });
    lastValidResult = result;
    lastValidLocks = (locks || []).map((l) => ({ ...l }));
    self.postMessage({
      type: 'done',
      result,
      export: buildExport(result),
      masterCount: master.hi.length,
      deliveryCount: delivery.hi.length,
    });
  } catch (err) {
    // 失败：回传定位信息，并明确上一次有效结果仍可用
    self.postMessage({
      type: 'error',
      code: err.code || 'ERROR',
      message: err.message,
      at: err.at || null,
      segment: err.segment || null,
      distance: err.distance ?? null,
      hasLastResult: !!lastValidResult,
      lastLocks: lastValidLocks.map((l) => ({ ...l })),
    });
  }
};
