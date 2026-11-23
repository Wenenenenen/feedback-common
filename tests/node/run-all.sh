#!/usr/bin/env bash
# 全量测试：求解核心 + Worker 协议 + 浏览器端到端（需全局 Playwright/Chromium）
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "== 求解核心（含 384² 性能） =="
node tests/node/test-solver.js

echo
echo "== Worker 协议 =="
node tests/node/test-worker-protocol.js

echo
echo "== 浏览器端到端 =="
node tests/node/test-browser.js
