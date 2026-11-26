// Web Worker body: inlined inside app.html and wrapped in a Blob.
// It has access to the inlined solver functions (solveImage, inspectPixel,
// encodeRgbaPng, encodeStatusPng, recomposite) via closure of the Blob scope.
self.onmessage = function (ev) {
  const msg = ev.data;
  try {
    if (msg.type === "solve") {
      const { width, height, groups, tol, solveId } = msg;
      const result = solveImage(width, height, groups, tol, (frac) => {
        self.postMessage({ type: "progress", solveId, frac });
      });
      // Transfer the big buffers; keep structured copies small.
      self.postMessage({
        type: "solved",
        solveId,
        width,
        height,
        tol,
        counts: result.counts,
        status: result.status,
        rgba: result.rgba,
        feasibleCount: result.feasibleCount,
      }, [result.status.buffer, result.rgba.buffer, result.feasibleCount.buffer]);
      return;
    }
    if (msg.type === "inspect") {
      const { width, groups, tol, x, y, seq } = msg;
      const info = inspectPixel(width, groups, tol, x, y);
      self.postMessage({ type: "inspected", seq, x, y, info });
      return;
    }
    if (msg.type === "encode") {
      const { kind, width, height, data, nonce } = msg;
      const promise = kind === "rgba"
        ? encodeRgbaPng(width, height, data)
        : encodeStatusPng(width, height, data);
      promise.then((bytes) => {
        self.postMessage({ type: "encoded", kind, nonce, bytes }, [bytes.buffer]);
      });
      return;
    }
    if (msg.type === "recomposite") {
      const { width, height, rgba, backdrop, nonce } = msg;
      const out = recomposite(width, height, rgba, backdrop);
      self.postMessage({ type: "recomposited", nonce, out }, [out.buffer]);
      return;
    }
    self.postMessage({ type: "error", message: "未知的 worker 消息: " + msg.type });
  } catch (e) {
    self.postMessage({ type: "error", message: String(e && e.message || e) });
  }
};
