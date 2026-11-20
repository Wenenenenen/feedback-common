#!/usr/bin/env bash
# 一键自检：Node 单元测试 + 无头 Chrome 端到端测试。
# CHROME 未设置时使用 Playwright 缓存里的 Chromium（如存在）。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 单元测试 =="
node tests/unit.mjs

if [ -z "${CHROME:-}" ]; then
  for c in \
    "$HOME/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome" \
    "$HOME/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell" \
    "$(command -v chromium || true)" "$(command -v google-chrome || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then CHROME="$c"; break; fi
  done
fi
if [ -z "${CHROME:-}" ]; then
  echo "跳过端到端：未找到 Chromium（可用 CHROME=/path/to/chrome 指定）"
  exit 0
fi

echo "\n== 端到端测试（$CHROME）=="
CHROME="$CHROME" node tests/e2e.mjs
