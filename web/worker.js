// Dedicated worker: runs the coarse-to-fine flow pipeline off the UI thread
// and cooperates with cancellation. All heavy math lives in flow-core.js.
import { computeDenseFlow } from './flow-core.js';

let currentToken = 0;

self.onmessage = async (e) => {
  const { type, token, a, b, width, height, params, direction } = e.data || {};
  if (type === 'cancel') {
    currentToken = -1; // invalidate any in-flight run
    self.postMessage({ type: 'canceled', token });
    return;
  }
  if (type !== 'run') return;

  const myToken = token;
  currentToken = myToken;
  const shouldCancel = () => currentToken !== myToken;

  try {
    const result = await computeDenseFlow(
      a, b, width, height, params, direction, shouldCancel,
      (p) => {
        if (shouldCancel()) return;
        self.postMessage({ type: 'progress', token: myToken, ...p });
      }
    );
    if (shouldCancel()) {
      self.postMessage({ type: 'canceled', token: myToken });
      return;
    }
    // Transfer the typed arrays back without copying.
    self.postMessage({ type: 'done', token: myToken, result }, [
      result.u.buffer, result.v.buffer, result.valid.buffer,
      result.fbErr.buffer, result.reproj.buffer, result.eigen.buffer,
      result.reverse.u.buffer, result.reverse.v.buffer, result.reverse.valid.buffer,
    ]);
  } catch (err) {
    self.postMessage({ type: 'error', token: myToken, message: String(err && err.message || err) });
  }
};
