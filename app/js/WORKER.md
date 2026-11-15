// WORKER.md — notes for maintaining the render worker protocol.
//
// The worker is loaded by app/js/app.js as
//   new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' })
// so the page must be served over http(s) or from a same-origin file set;
// `python3 server.py` provides that.
//
// Messages (main → worker)
//   init   {dims, spacing, ext, invSpacing, values, valueMin, valueMax, dataType, meta}
//          Replaces the volume wholesale and drops any queued/running job.
//   render {jobId, view, width, height, mode, step, tf, refMm, window}
//          While one render runs, a new one marks the old stale (cancelled
//          at the next band) and waits; only the newest is ever delivered.
//   probe  {requestId, ray, mode, step, tf, refMm, window}
//          Answered on demand; never changes the frame.
//
// Messages (worker → main)
//   progress     {jobId, fraction}
//   done         {jobId, buffer, width, height, elapsedMs}   buffer transferred
//   probe-result {requestId, trace | null, error?}
//   error        {jobId, message}
//
// app.js additionally guards with a monotonic jobId: `doneFrame` ignores any
// result whose id is not the current `jobSeq`, which covers the window
// between issuing a render and the worker noticing the pre-emption.
//
// The main-thread fallback (when Worker construction fails) uses the same
// renderRows bands and the same jobId check, so both paths share one policy.
//
// Testing: tests/e2e.mjs drives the real page and checks that the frame on
// screen corresponds to the last request after a burst of parameter changes.
// Nothing here is a build step; there is no bundler.
