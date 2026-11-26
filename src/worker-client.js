// Async wrapper around the exact moment engine.
//
// The engine's result carries BigInt Fraction instances, which structured
// clone cannot transport across a Worker boundary without a DTO conversion.
// Rather than pay that conversion on every result, computation runs on the
// main thread inside a microtask; the UI shows a "computing" state first and
// repaints afterward. The async signature keeps the call site ready to move
// back to a worker if a DTO serializer is introduced later.
import { computeRasterMoments } from './moments.js';

export function computeAsync(region, image) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(computeRasterMoments(region, image)); }
      catch (e) { reject(e); }
    }, 0);
  });
}
