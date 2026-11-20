// ARAP 求解 Worker：接收网格数据与约束，分帧执行迭代，
// 每批若干轮向主线程回传进度，保证全量计算期间界面视角仍可操作。
import { validateMesh } from './mesh.js';
import { ArapSolver, STOP } from './solver.js';

let solver = null;
let runToken = 0;

self.onmessage = (e) => {
  handleMessage(e.data).catch((err) => {
    self.postMessage({
      type: 'error',
      message: String((err && err.message) || err),
    });
  });
};

async function handleMessage(msg) {
  if (msg.type === 'init') {
    const { errors, data } = validateMesh(msg.input);
    if (errors.length) {
      self.postMessage({ type: 'invalid', errors });
      return;
    }
    solver = new ArapSolver(data);
    postState('initialized');
    return;
  }

  if (!solver) {
    self.postMessage({ type: 'error', message: '求解器尚未初始化' });
    return;
  }

  if (msg.type === 'constraints') {
    solver.resetConstraints(msg.constraints);
    postState('constraints_updated');
    return;
  }

  if (msg.type === 'step') {
    const reason = solver.step(msg.threshold);
    postState(reason === STOP.NONE ? 'stepped' : reason);
    return;
  }

  if (msg.type === 'run') {
    const token = ++runToken;
    const { maxIterations, threshold, yieldEvery } = msg;
    const batch = Math.max(1, yieldEvery || 1);
    let reason = STOP.NONE;
    for (let k = 0; k < maxIterations; k++) {
      if (token !== runToken) return; // 已被新的运行/取消取代
      reason = solver.step(threshold);
      if ((k + 1) % batch === 0) {
        postState('progress');
        // 让出事件循环，使取消/视角消息能被处理
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (reason !== STOP.NONE) break;
    }
    if (reason === STOP.NONE) solver.stopReason = STOP.MAX_ITER;
    postState(solver.stopReason);
    return;
  }

  if (msg.type === 'cancel') {
    runToken++;
    postState('cancelled');
    return;
  }

  if (msg.type === 'reset') {
    runToken++;
    solver.resetConstraints([]);
    postState('reset');
    return;
  }
}

function postState(kind) {
  self.postMessage({
    type: 'state',
    kind,
    vertices: solver.x.map((p) => p.slice()),
    rotations: solver.rotations.map((R) => R.slice()),
    energies: solver.energies.slice(),
    iterations: solver.iterations,
    stopReason: solver.stopReason,
    frozen: Array.from(solver.frozen),
    freeCount: solver.freeIdx.length,
  });
}
