/* Worker 侧运行器：由 tools/build-worker.mjs 拼接在 src/core.js 之后。
 * 每条消息只做有限工作量，主线程随时可以停止再发下一条，因此暂停能在一轮内生效。
 */

let engine = null;
let session = null;

function postProgress(tag, id, r) {
  self.postMessage({
    type: tag, id,
    round: r.round, loss: r.loss, planeLoss: r.planeLoss,
    stepSize: r.stepSize, done: r.done,
    history: session ? session.history : [],
  });
}

self.onmessage = (ev) => {
  const msg = ev.data || {};
  try {
    switch (msg.type) {
      case 'load': {
        engine = null; session = null;
        const res = PM.createProject(msg.project);
        if (!res.ok) { self.postMessage({ type: 'loadError', id: msg.id, errors: res.errors }); return; }
        engine = res.engine;
        session = PM.createSession(engine, { eta: msg.eta, steps: msg.steps });
        session.init();
        self.postMessage({
          type: 'loaded', id: msg.id, W: engine.W, H: engine.H,
          round: session.round, loss: session.loss, planeLoss: session.planeLoss,
          history: session.history,
        });
        break;
      }
      case 'step': {
        if (!session) { self.postMessage({ type: 'error', id: msg.id, message: '没有已载入的项目' }); return; }
        const r = session.step();
        postProgress('stepped', msg.id, r);
        break;
      }
      case 'snapshot': {
        if (!session) return;
        const snap = {
          type: 'snapshot', id: msg.id,
          round: session.round, loss: session.loss, planeLoss: session.planeLoss,
          stepSize: session.lastStep, done: session.done,
          p: Array.from(session.p), grad: Array.from(session.grad),
          intensity: engine.planes.map((_, j) => Array.from(session.intensity(j))),
          history: session.history,
        };
        self.postMessage(snap);
        break;
      }
      case 'export': {
        if (!session) return;
        const e = session.exportError();
        self.postMessage({
          type: 'export', id: msg.id,
          bytes: Array.from(e.bytes),
          error: { W: e.W, H: e.H, step: e.step, loss: e.loss, planeLoss: e.planeLoss },
        });
        break;
      }
      case 'setSteps': {
        if (!session) return;
        session.setSteps(msg.steps);
        self.postMessage({
          type: 'stepsSet', id: msg.id, done: session.done,
          round: session.round, loss: session.loss, planeLoss: session.planeLoss,
          history: session.history,
        });
        break;
      }
      case 'setZ': {
        if (!session || !engine) return;
        engine.setPlaneZ(msg.index, msg.z);
        // 改 z 必须回到新设置的第 0 轮
        session = PM.createSession(engine, { eta: msg.eta, steps: msg.steps });
        session.init();
        self.postMessage({
          type: 'reset', id: msg.id, round: 0, loss: session.loss,
          planeLoss: session.planeLoss, history: session.history,
        });
        break;
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};
