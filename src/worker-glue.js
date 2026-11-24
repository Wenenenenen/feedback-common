/*
 * 分析 Worker：接收一路采集与扫频，做定标反卷积与窗口定位，回传定标后的
 * 反卷积区间（可转移）与窗口分析结果。
 *
 * 主线程为 4 逻辑核环境最多起 4 个 Worker，每个负责一条采集通道。
 * 请求按 token 取消：被取代的任务在让出点停止，不回传结果。
 */
(function () {
  'use strict';

  const Core = self.SHMCore;
  let activeToken = 0;
  let running = false;
  let queued = null;

  function post(msg, transfer) {
    self.postMessage(msg, transfer || []);
  }

  function startJob(msg) {
    const token = msg.id;
    activeToken = token;
    running = true;
    const done = () => {
      running = false;
      if (queued) {
        const next = queued;
        queued = null;
        startJob(next);
      }
    };
    const isStale = () => activeToken !== token;
    try {
      const params = msg.params;
      const sweep = msg.sweep;
      const capture = msg.capture;
      const N = sweep.length;
      const calib = Core.selfCalibration(sweep, params.f0, params.f1);
      if (isStale()) { done(); return; }
      if (!(calib !== 0 && Number.isFinite(calib))) {
        throw new Error('扫频自测主响应 D = 0，无法定标');
      }
      const g = Core.inverseSweep(sweep, params.f0, params.f1);
      if (isStale()) { done(); return; }
      const dataLen = capture.length + N - 1;
      const plan = Core.planBand(N, dataLen, params);
      const band = Core.deconvolveBand(capture, g, calib, plan.lo, plan.hi);
      if (isStale()) { done(); return; }
      const analysis = Core.analyzeBand(band, N, params, { bins: msg.bins || 2400 });
      const payload = {
        type: 'result',
        id: token,
        channel: msg.channel,
        calib,
        dataLen,
        analysis,
        band,                    // {lo, hi, dataLen, values}
      };
      post(payload, [band.values.buffer]);
      activeToken = 0;
      done();
    } catch (err) {
      if (activeToken === token) {
        post({ type: 'error', id: token, channel: msg.channel, message: err && err.message ? err.message : String(err) });
        activeToken = 0;
      }
      done();
    }
  }

  self.onmessage = function (ev) {
    const msg = ev.data || {};
    if (msg.type === 'cancel') {
      if (activeToken === msg.id) { post({ type: 'superseded', id: msg.id }); activeToken = 0; }
      if (queued && queued.id === msg.id) queued = null;
      return;
    }
    if (msg.type !== 'job') return;
    if (running) {
      // 正在跑的任务立刻作废（下一个让出点停止），新任务排队。
      // 先同步告诉主线程「旧任务不会再有结果」，它才能立刻结束那个 Promise。
      if (activeToken) post({ type: 'superseded', id: activeToken });
      activeToken = 0;
      queued = msg;
      return;
    }
    startJob(msg);
  };
})();
