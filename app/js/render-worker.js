// render-worker.js — time-sliced stereo renderer.
//
// The page hands over decoded buffers once per dataset; parameter changes send
// only numbers.  Rasterisation results are cached per geometry signature, so
// toggling only the hole fill reuses the eyes and costs almost nothing.
//
// Both eyes are always filled (cheap); whether the fill is *displayed* is the
// page's decision, and the export writes the unfilled eyes, the fill previews
// and the raw masks side by side.
//
// Work is sliced so a cancel message (or a newer request) is seen between
// slices: the cancel button stays responsive even at 1024×768.
//
// In:
//   { type:'load', datasetId, width, height, depth: ArrayBuffer, color: ArrayBuffer }
//   { type:'render', requestId, geomKey, params }
//   { type:'cancel', requestId }
// Out:
//   { type:'progress', requestId, phase, frac }
//   { type:'result', requestId, eyesIncluded, ... }
//   { type:'cancelled', requestId }
//   { type:'error', requestId, message }

import {
  buildMesh, createEyeTarget, rasterRange, finalizeEye, fillHoles,
  makeAnaglyph, depthRange,
} from './core.js';

const state = {
  datasetId: null,
  width: 0,
  height: 0,
  depth: null,
  color: null,
  mesh: null,
  jump: NaN,
};

const cache = { geomKey: null, eyes: null };

let active = null;
let generation = 0;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'load') {
    state.datasetId = msg.datasetId;
    state.width = msg.width;
    state.height = msg.height;
    state.depth = new Float32Array(msg.depth);
    state.color = new Uint8ClampedArray(msg.color);
    state.mesh = null;
    state.jump = NaN;
    cache.geomKey = null;
    cache.eyes = null;
    if (active) active.cancelled = true;
    active = null;
    generation++;
    return;
  }

  if (msg.type === 'cancel') {
    if (active && active.requestId === msg.requestId) active.cancelled = true;
    return;
  }

  if (msg.type === 'render') {
    if (active) active.cancelled = true;
    const run = { requestId: msg.requestId, cancelled: false };
    active = run;
    const gen = ++generation;
    runJob(run, msg.params, msg.geomKey, gen).catch((err) => {
      if (run.cancelled || (err && err.name === 'RenderCancelled')) {
        post({ type: 'cancelled', requestId: run.requestId });
        return;
      }
      post({ type: 'error', requestId: run.requestId, message: String((err && err.message) || err) });
    });
  }
};

const yieldToMessages = () => new Promise((resolve) => setTimeout(resolve, 0));

class RenderCancelledLocal extends Error {
  constructor() { super('渲染已取消'); this.name = 'RenderCancelled'; }
}

async function runJob(run, params, geomKey, gen) {
  if (!state.depth) throw new Error('尚未载入数据');
  const { width, height, depth, color } = state;
  const cancelled = () => run.cancelled || gen !== generation;
  const checkpoint = async () => {
    await yieldToMessages();
    if (cancelled()) throw new RenderCancelledLocal();
  };

  let eyesIncluded = false;
  let eyes;

  if (cache.geomKey === geomKey && cache.eyes) {
    eyes = cache.eyes;
  } else {
    if (!state.mesh || state.jump !== params.jump) {
      state.mesh = buildMesh(depth, width, height, params.jump);
      state.jump = params.jump;
    }
    const mesh = state.mesh;
    const common = {
      fx: params.fx, fy: params.fy, cx: params.cx, cy: params.cy,
      eyeDistance: params.eyeDistance, zeroPlane: params.zeroPlane,
    };

    eyes = {};
    const totalWork = Math.max(1, mesh.triCount * 2);
    // Slice by wall-clock time rather than a fixed triangle count: a 3k-triangle
    // sample should finish in one slice, while a 1.5M-triangle 1024x768 mesh
    // still yields often enough for the cancel button to react in ~30 ms.
    const SLICE_MS = 24;
    let done = 0;

    for (const eye of ['left', 'right']) {
      if (cancelled()) throw new RenderCancelledLocal();
      const target = createEyeTarget(width, height, { ...common, eye });
      let t = 0;
      while (t < mesh.triCount) {
        const sliceStart = performance.now();
        let next = t;
        do {
          const from = next;
          next = Math.min(mesh.triCount, from + 2000);
          rasterRange(target, mesh, depth, color, from, next);
        } while (next < mesh.triCount && performance.now() - sliceStart < SLICE_MS);
        done += next - t;
        t = next;
        post({
          type: 'progress', requestId: run.requestId,
          phase: eye === 'left' ? '左眼光栅化' : '右眼光栅化', frac: done / totalWork,
        });
        await checkpoint();
      }
      eyes[eye] = finalizeEye(target);
    }
    cache.geomKey = geomKey;
    cache.eyes = eyes;
    eyesIncluded = true;
  }

  post({ type: 'progress', requestId: run.requestId, phase: '补洞与红青合成', frac: 0.94 });
  await checkpoint();

  const maxGap = params.fillMaxGap;
  const fillLeft = fillHoles(eyes.left.rgba, eyes.left.mask, eyes.left.zbuf, width, height, maxGap);
  const fillRight = fillHoles(eyes.right.rgba, eyes.right.mask, eyes.right.zbuf, width, height, maxGap);

  const anaglyph = makeAnaglyph(eyes.left.rgba, eyes.right.rgba, eyes.left.mask, eyes.right.mask, width, height);
  const anaglyphFilled = makeAnaglyph(fillLeft.rgba, fillRight.rgba, eyes.left.mask, eyes.right.mask, width, height);

  if (cancelled()) throw new RenderCancelledLocal();

  const mesh = state.mesh;
  const result = {
    type: 'result',
    requestId: run.requestId,
    eyesIncluded,
    geomKey,
    width,
    height,
    triangleCount: mesh ? mesh.triCount : 0,
    cellCount: (width - 1) * (height - 1),
    leftRGBA: eyes.left.rgba.slice(),
    rightRGBA: eyes.right.rgba.slice(),
    leftMask: eyes.left.mask.slice(),
    rightMask: eyes.right.mask.slice(),
    fillLeftRGBA: fillLeft.rgba.slice(),
    fillRightRGBA: fillRight.rgba.slice(),
    anaglyph: anaglyph.slice(),
    anaglyphFilled: anaglyphFilled.slice(),
    depthRange: depthRange(depth),
    stats: {
      leftCovered: eyes.left.stats.covered,
      leftHoles: eyes.left.stats.holes,
      rightCovered: eyes.right.stats.covered,
      rightHoles: eyes.right.stats.holes,
      leftFill: fillLeft.stats,
      rightFill: fillRight.stats,
    },
  };

  post(result);
}
