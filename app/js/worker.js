/**
 * Web Worker: parsing + mesh preparation + slicing.
 *
 * Keeping this off the main thread means a 20k-triangle slice never blocks
 * orbit/pan interaction, and rapid plane drags can be coalesced to the latest
 * request without queueing up stale work.
 */

import { parseStl, StlError } from './stl.js';
import { buildMesh } from './mesh.js';
import { sliceMesh } from './section.js';

let mesh = null;

function errorPayload(id, stage, err) {
  const code = err instanceof StlError ? err.code : 'internal';
  return {
    type: 'error',
    id,
    stage,
    code,
    message: err && err.message ? err.message : String(err),
    details: err && err.details ? err.details : null,
  };
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  try {
    if (msg.type === 'load') {
      try {
        const bytes = new Uint8Array(msg.buffer);
        const parsed = parseStl(bytes);
        const built = buildMesh(parsed, { name: msg.name, source: msg.source });
        mesh = built;
        // The mesh keeps its own copies: transferring the buffers used for
        // slicing would detach them inside this worker and silently break
        // body grouping on every later slice.
        const triangles = built.renderPositions.slice();
        const components = built.triComponent.slice();
        const payload = {
          type: 'loaded',
          id: msg.id,
          meta: built.meta,
          diagnostics: built.diagnostics,
          triangleCount: built.triangleCount,
          componentCount: built.componentCount,
          triangles,
          components,
        };
        self.postMessage(payload, [triangles.buffer, components.buffer]);
      } catch (err) {
        self.postMessage(errorPayload(msg.id, 'load', err));
      }
      return;
    }
    if (msg.type === 'slice') {
      if (!mesh) {
        self.postMessage({
          type: 'error', id: msg.id, stage: 'slice', code: 'no-mesh',
          message: '尚未加载模型', details: null,
        });
        return;
      }
      try {
        const result = sliceMesh(mesh, msg.n, msg.d);
        self.postMessage({ type: 'sliced', id: msg.id, result });
      } catch (err) {
        self.postMessage(errorPayload(msg.id, 'slice', err));
      }
      return;
    }
    if (msg.type === 'selfcheck') {
      // Each job carries the fixture bytes fetched by the main thread; parse
      // and slice here, never touching the user's mesh.
      const results = [];
      const cache = new Map(); // url -> built mesh
      for (const job of msg.jobs) {
        try {
          let built = cache.get(job.url);
          if (!built) {
            const parsed = parseStl(new Uint8Array(job.buffer));
            built = buildMesh(parsed, { name: job.file, source: 'sample' });
            cache.set(job.url, built);
          }
          const result = sliceMesh(built, job.expect.n, job.expect.d);
          const got = result.measurements;
          const exp = job.expect;
          const close = (a, b) =>
            Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-5);
          results.push({
            file: job.file,
            n: exp.n,
            d: exp.d,
            expect: exp,
            got: {
              loopCount: got.loopCount,
              holeCount: got.holeCount,
              area_mm2: got.area_mm2,
              perimeter_mm: got.perimeter_mm,
            },
            ok: got.loopCount === exp.loops &&
              got.holeCount === exp.holes &&
              close(got.area_mm2, exp.area_mm2) &&
              close(got.perimeter_mm, exp.perimeter_mm),
          });
        } catch (err) {
          results.push({ file: job.file, n: job.expect.n, d: job.expect.d, ok: false, error: err.message });
        }
      }
      self.postMessage({ type: 'selfcheck', id: msg.id, results });
      return;
    }
    if (msg.type === 'clear') {
      mesh = null;
      return;
    }
  } catch (err) {
    self.postMessage(errorPayload(msg && msg.id, 'worker', err));
  }
};
