#!/usr/bin/env bash
# 把 web/engine.js 注入 index.template.html 的 /*__ENGINE__*/ 占位处，生成 index.html。
# 这样 Worker 可在 file:// 下直接内联引擎源码，而 engine.js 仍可被 Node 单测 require。
set -euo pipefail
cd "$(dirname "$0")/.."

tpl="web/index.template.html"
engine="web/engine.js"
out="web/index.html"

python3 -I - "$tpl" "$engine" "$out" <<'PY'
import sys
tpl, engine, out = sys.argv[1:4]
with open(tpl, encoding="utf-8") as f:
    html = f.read()
with open(engine, encoding="utf-8") as f:
    src = f.read()
if "__DIC_ENGINE_PLACEHOLDER__" not in html:
    raise SystemExit("模板缺少 __DIC_ENGINE_PLACEHOLDER__ 占位符")
with open(out, "w", encoding="utf-8") as f:
    f.write(html.replace("__DIC_ENGINE_PLACEHOLDER__", src, 1))
print(f"已生成 {out}（内联 {len(src)} 字符引擎源码）")
PY
