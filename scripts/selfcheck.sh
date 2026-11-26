#!/usr/bin/env bash
# 离线自检：JS 语法 + 求解器/渲染测试
set -euo pipefail
cd "$(dirname "$0")/.."

node --check solver.js
node --check audio.js
node --check zipio.js
node --check app.js
node --test tests/solver.test.cjs tests/audio.test.cjs

echo
echo 'Self-check passed.'
