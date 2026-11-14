#!/usr/bin/env bash
# 端到端测试编排：WSL NAT + Hyper-V 防火墙环境下，
# WSL 中继（本地）+ Windows 主动连出桥接（Start-Process 脱离）驱动无头 Chrome。
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
PS="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
DEBUG_PORT=9240
FRONT_PORT=9320
MANAGER_PORT=9321
DATA_PORT=9322
WSL_IP=$(ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}')

cleanup() {
  "$PS" -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { \$_.CommandLine -like '*bridge.ps1*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>/dev/null || true
  "/mnt/c/Windows/System32/taskkill.exe" //F //IM chrome.exe 2>/dev/null | head -1 || true
  [ -n "${RELAY_PID:-}" ] && kill "$RELAY_PID" 2>/dev/null || true
}
trap cleanup EXIT

# 1) WSL 三端口中继（前端/管理器/数据）
FRONT_PORT=$FRONT_PORT MANAGER_PORT=$MANAGER_PORT DATA_PORT=$DATA_PORT \
  node tests/cdp-relay.mjs >/tmp/cdp-relay.log 2>&1 &
RELAY_PID=$!
sleep 1

# 2) 无头 Chrome（唯一 profile，避免锁残留）
"$CHROME" --headless=new --disable-gpu --no-sandbox \
  "--remote-debugging-port=$DEBUG_PORT" "--user-data-dir=C:\\temp\\cdp-e2e-$$" about:blank >/tmp/cdp-chrome.log 2>&1 &
sleep 4

# 3) Windows 桥接，Start-Process 脱离 shell 生命周期
"$PS" -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-ExecutionPolicy','Bypass','-File','C:\temp\bridge.ps1','-WslIp','$WSL_IP','-ManagerPort','$MANAGER_PORT','-DataPort','$DATA_PORT','-ChromeHost','127.0.0.1','-ChromePort','$DEBUG_PORT') -WindowStyle Hidden -RedirectStandardOutput 'C:\temp\bridge-out.log' -RedirectStandardError 'C:\temp\bridge-err.log'"
sleep 5

# 4) 连通性
curl -s --max-time 8 "http://127.0.0.1:$FRONT_PORT/json/version" >/dev/null || {
  echo "中继前端不可达"; cat /tmp/cdp-relay.log; iconv -f GBK -t UTF-8 /mnt/c/temp/bridge-err.log 2>/dev/null || true; exit 1;
}

# 5) CDP 测试（复用编排脚本启动的 Chrome，经中继访问）
node tests/cdp_check.mjs "$CHROME" "http://localhost:8000/" "http://127.0.0.1:$FRONT_PORT" "$DEBUG_PORT"
