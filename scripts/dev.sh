#!/usr/bin/env bash
# Dev helper for the zone-handoff drill service.
#   ./scripts/dev.sh start     start in the background (or reuse a running one)
#   ./scripts/dev.sh stop      stop a service started by this script
#   ./scripts/dev.sh restart   stop + start
#   ./scripts/dev.sh run       run in the foreground
#   ./scripts/dev.sh supervise run under a supervisor that restarts after a
#                             simulated crash (exit 71) so the drill recovers
#                             without a manual restart
#   ./scripts/dev.sh status    show pid and health
#   ./scripts/dev.sh reset     stop and delete the journal (fresh baseline)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ADDR="${ADDR:-:8080}"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
PID_FILE="$DATA_DIR/server.pid"
LOG_FILE="$DATA_DIR/server.log"
mkdir -p "$DATA_DIR"

build() {
  mkdir -p "$DATA_DIR/bin"
  go build -o "$DATA_DIR/bin/zone-handoff-server" ./cmd/server
}

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

start() {
  if is_running; then
    echo "already running (pid $(cat "$PID_FILE")) at $ADDR"
    return 0
  fi
  build
  rm -f "$PID_FILE"
  nohup "$DATA_DIR/bin/zone-handoff-server" \
    -addr "$ADDR" -data-dir "$DATA_DIR" -sample samples/zone-handoff.json \
    >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1${ADDR#*:}/api/health" >/dev/null 2>&1 \
      || curl -fsS "http://127.0.0.1:${ADDR##*:}/api/health" >/dev/null 2>&1; then
      echo "started (pid $(cat "$PID_FILE")) at http://127.0.0.1:${ADDR##*:}/"
      return 0
    fi
    if ! is_running; then
      echo "server exited; last log lines:" >&2
      tail -n 20 "$LOG_FILE" >&2 || true
      return 1
    fi
    sleep 0.1
  done
  echo "started (pid $(cat "$PID_FILE")) but health check is slow; see $LOG_FILE"
}

stop() {
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped (pid $pid)"
  else
    echo "not running"
  fi
  rm -f "$PID_FILE"
}

status() {
  if is_running; then
    echo "running (pid $(cat "$PID_FILE"))"
    curl -fsS "http://127.0.0.1:${ADDR##*:}/api/health" && echo
  else
    echo "not running"
    return 1
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  run)
    build
    exec "$DATA_DIR/bin/zone-handoff-server" -addr "$ADDR" -data-dir "$DATA_DIR" -sample samples/zone-handoff.json
    ;;
  supervise)
    build
    echo "supervising on http://127.0.0.1:${ADDR##*:}/ (Ctrl-C to stop)"
    while true; do
      # `set -e` must not treat the deliberate exit(71) crash as a script error.
      code=0
      "$DATA_DIR/bin/zone-handoff-server" -addr "$ADDR" -data-dir "$DATA_DIR" -sample samples/zone-handoff.json || code=$?
      if [[ $code -ne 71 ]]; then
        echo "server exited with $code; supervisor stopping"
        exit "$code"
      fi
      echo "--- simulated crash detected (exit 71); restarting from the journal ---"
      sleep 0.2
    done
    ;;
  status) status ;;
  reset)
    stop
    rm -f "$DATA_DIR/journal.wal"
    echo "journal removed; a fresh baseline will be seeded on start"
    ;;
  *) echo "usage: $0 {start|stop|restart|run|supervise|status|reset}" >&2; exit 2 ;;
esac
