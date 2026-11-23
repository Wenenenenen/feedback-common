/* Web Worker driver for the demix engine. */
importScripts("demixer.js");

onmessage = function (e) {
  var data = e.data;
  try {
    var res = Demixer.demix(data.cfg, data.frames, function (frac) {
      postMessage({ type: "progress", frac: frac });
    });
    postMessage(
      { type: "done", res: res },
      [
        res.layers[0].buffer,
        res.layers[1].buffer,
        res.layers[2].buffer,
        res.mask.buffer,
        res.dropped.buffer,
        res.sse.buffer,
      ]
    );
  } catch (err) {
    postMessage({
      type: "error",
      message: err && err.message ? err.message : String(err),
    });
  }
};
