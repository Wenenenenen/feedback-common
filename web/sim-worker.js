// Simulation worker: exact per-sample fixed-point processing with progress.
'use strict';
importScripts('headroom.js');

self.onmessage = (ev) => {
  const { sections, order, wav, reqId } = ev.data;
  const byId = {};
  sections.forEach((s) => { byId[s.id] = s; });
  const samples = new Int16Array(wav.samplesBuffer);
  const res = self.HEADROOM.simulate(
    byId, order, wav.frames, wav.channels, samples,
    (p) => self.postMessage({ reqId, progress: p }),
  );
  // copy into a fresh transferable buffer
  const out = new Int16Array(res.output.length);
  out.set(res.output);
  self.postMessage({
    reqId,
    done: true,
    clips: res.clips.map((a) => Array.from(a)),
    outputBuffer: out.buffer,
  }, [out.buffer]);
};
