/*
 * worker-body.js — Worker 消息循环的纯函数形式（不含 self 绑定）。
 * 由 app.js 通过 <script> 载入后，用 Function.prototype.toString 序列化进 Blob，
 * 因此 file:// 打开页面也能创建 Worker，不依赖 XHR/importScripts。
 *
 * 与 solver-worker.js 行为完全一致；两处只保留这一份逻辑。
 */
(function (root) {
  'use strict';

  // 挂到全局，供 app.js 序列化；名字固定，Blob 内会重新声明
  root.NR_WORKER_BODY = function NR_WORKER_BODY(global) {
    var NR = global.NormalRelief;
    var latestSeq = -1;
    var currentSeq = -1;
    var cancelled = false;

    global.onmessage = function (ev) {
      var msg = ev.data;
      if (!msg || msg.type !== 'solve') return;
      latestSeq = msg.seq;
      currentSeq = msg.seq;
      cancelled = false;

      try {
        var v = NR.validateInput(msg.input);
        if (!v.ok) {
          global.postMessage({ type: 'result', seq: currentSeq, ok: false, errors: v.errors });
          return;
        }
        var model = NR.buildModel(v.data);
        var result = NR.solveModel(model, {
          warm: msg.warm,
          shouldCancel: function () {
            if (currentSeq !== latestSeq) {
              cancelled = true;
              return true;
            }
            return false;
          }
        });

        // 回传前最终核对：过期或已取消的结果直接丢弃
        if (currentSeq !== latestSeq || cancelled || result.cancelled) return;

        result.type = 'result';
        result.seq = currentSeq;
        result.ok = true;
        result.width = model.width;
        result.height = model.height;
        result.edgeA = model.edgeA;
        result.edgeB = model.edgeB;
        result.edgeW = model.edgeW;
        result.edgeG = model.edgeG;
        result.edgeAxis = model.edgeAxis;
        result.edgeWrap = model.edgeWrap;
        result.edgeCount = model.edgeCount;
        result.validCell = model.validCell;
        result.conf = model.conf;
        result.pinKind = model.pinKind;
        result.pinHeight = model.pinHeight;
        result.userPins = model.userPins;
        result.autoPins = model.autoPins;
        result.cellRatio = result.cellRatio;
        result.cellWSum = result.cellWSum;
        global.postMessage(result);
      } catch (err) {
        if (currentSeq !== latestSeq) return;
        global.postMessage({
          type: 'error',
          seq: currentSeq,
          message: (err && err.message) ? err.message : String(err)
        });
      }
    };
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
