/*
 * solver-worker.js — 独立 Worker 入口（HTTP 部署时可直接 new Worker 本文件）。
 * 主页面默认走 Blob Worker（见 app.js + worker-body.js），file:// 下也可用。
 * 两条路径的消息循环是 worker-body.js 中同一份函数，行为一致。
 */
'use strict';

if (typeof importScripts === 'function') {
  importScripts('solver-core.js', 'worker-body.js');
  NR_WORKER_BODY(self);
}
