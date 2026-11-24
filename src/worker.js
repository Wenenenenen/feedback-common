/*
 * 页面 Worker：异步执行导入校验、包围计算、编辑后重算，避免阻塞 UI。
 * 依赖 engine.js（通过 importScripts 加载，同源；由 index.html 注册 worker 根）。
 */
'use strict';

if (typeof importScripts === 'function') {
  importScripts(new URL('engine.js', self.location.href).href);
}

let currentModel = null; // 已生效模型；错误导入不会覆盖它
let currentRaw = null;   // 已生效的原始数据（编辑基于其副本）

self.onmessage = function (ev) {
  const msg = ev.data;
  try {
    if (msg.type === 'ping') {
      self.postMessage({ type: 'pong' });
      return;
    }
    if (msg.type === 'load') {
      const parsed = JSON.parse(msg.text);
      const r = self.engine.validateModel(parsed);
      if (r.error) {
        self.postMessage({ type: 'loadError', error: r.error });
        return;
      }
      currentModel = r.model;
      currentRaw = parsed;
      self.postMessage({
        type: 'loaded',
        summary: {
          bones: currentModel.bones.length,
          vertices: currentModel.vertices.length,
          keys: currentModel.keys.length,
          intervals: currentModel.keys.length - 1,
          triangles: currentModel.triangles ? currentModel.triangles.length : 0,
          t0: currentModel.t0,
          t1: currentModel.t1,
        },
      });
      return;
    }

    if (msg.type === 'fullFilm') {
      const raw = self.engine.buildFullLengthFilm();
      const r = self.engine.validateModel(raw);
      if (r.error) { self.postMessage({ type: 'loadError', error: r.error }); return; }
      currentModel = r.model;
      currentRaw = raw;
      self.postMessage({
        type: 'loaded',
        summary: {
          bones: 64, vertices: 8192, keys: 129, intervals: 128, triangles: 0,
          t0: 0, t1: 128,
        },
      });
      return;
    }

    if (msg.type === 'compute') {
      if (!currentModel) throw new Error('尚未导入有效模型');
      const { ta, tb } = msg;
      const t0 = performance.now();
      const res = self.engine.computeEnvelope(currentModel, ta, tb);
      const elapsed = performance.now() - t0;
      self.postMessage({
        type: 'result',
        box: res.box,
        faces: res.faces.map((f) => ({
          isMin: f.isMin, axis: f.axis, value: f.value, bound: f.bound, witness: f.witness,
          gap: f.isMin ? f.value - f.bound : f.bound - f.value,
        })),
        range: res.range,
        stats: res.stats,
        elapsed,
      });
      return;
    }

    if (msg.type === 'poseAt') {
      if (!currentModel) throw new Error('尚未导入有效模型');
      const sc = self.engine.makeScratch(currentModel);
      const world = self.engine.evalWorldMatrices(currentModel, msg.t, sc);
      const positions = new Array(currentModel.vertices.length);
      for (let vi = 0; vi < currentModel.vertices.length; vi++) {
        positions[vi] = self.engine.skinVertex(currentModel, world, vi, sc.tmp, sc.pos).slice();
      }
      self.postMessage({ type: 'pose', t: msg.t, positions, requestId: msg.requestId });
      return;
    }

    if (msg.type === 'editKey') {
      // 基于当前已生效数据的深拷贝修改，重新校验；失败则保留旧模型与旧结果
      if (!currentRaw) throw new Error('尚未导入有效模型');
      const copy = JSON.parse(JSON.stringify(currentRaw));
      const { keyIndex, boneIndex, component, value } = msg;
      if (!copy.keys[keyIndex] || !copy.keys[keyIndex].pose[boneIndex]) {
        throw new Error('编辑目标不存在');
      }
      copy.keys[keyIndex].pose[boneIndex][component] = value;
      const r = self.engine.validateModel(copy);
      if (r.error) {
        self.postMessage({ type: 'editError', error: r.error });
        return;
      }
      currentModel = r.model;
      currentRaw = copy;
      self.postMessage({ type: 'edited', keyIndex, boneIndex, component, value });
      return;
    }

    if (msg.type === 'exportBox') {
      // 仅回传数据，文件保存由主线程完成
      self.postMessage({ type: 'exportData', payload: msg.payload });
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.message || err) });
  }
};
