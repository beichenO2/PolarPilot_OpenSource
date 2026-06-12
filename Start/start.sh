#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# ── Dynamic port allocation via PolarPort ────────────
source "$PROJECT_DIR/../Agent_core/scripts/port-claim.sh"
PORT=$(claim_port "polarpilot" "PolarPilot" "4900")
PID_FILE="$SCRIPT_DIR/.pid"

cd "$PROJECT_DIR"

# ── Helpers ──────────────────────────────────────────────────────────────

is_port_in_use() {
    lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n -t >/dev/null 2>&1
}

get_port_pid() {
    lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n -t 2>/dev/null | head -1 || true
}

do_start() {
    # Idempotent: already listening on the port
    if is_port_in_use; then
        OCCUPANT=$(get_port_pid)
        echo "PolarPilot already running pid=$OCCUPANT port=$PORT"
        exit 0
    fi

    # Clean up stale PID file
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE" 2>/dev/null || true)
        if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
            echo "PolarPilot already running pid=$OLD_PID"
            exit 0
        fi
        rm -f "$PID_FILE"
    fi

    # Install deps if needed
    if [ ! -d "node_modules" ]; then
        echo "Installing dependencies..."
        npm install
    fi

    # Build TypeScript if needed
    if [ ! -f "dist/cli.mjs" ] || [ "src/cli.ts" -nt "dist/cli.mjs" ]; then
        echo "Building..."
        npm run build
    fi

    # Start daemon in background (--project PolarClaw is the primary managed project)
    nohup node dist/cli.mjs --daemon --project PolarClaw > /dev/null 2>&1 &
    DAEMON_PID=$!
    echo "$DAEMON_PID" > "$PID_FILE"

    # Wait for port to become available (max 30s)
    for i in $(seq 1 30); do
        if is_port_in_use; then
            ACTUAL_PID=$(get_port_pid || echo "$DAEMON_PID")
            echo "PolarPilot started pid=$ACTUAL_PID port=$PORT"
            exit 0
        fi
        sleep 1
    done

    echo "Timed out waiting for port $PORT" >&2
    rm -f "$PID_FILE"
    exit 1
}

do_stop() {
    local pid=""

    # Prefer PID from port occupant (most accurate)
    if is_port_in_use; then
        pid=$(get_port_pid)
    fi

    # Fallback to PID file
    if [ -z "$pid" ] && [ -f "$PID_FILE" ]; then
        local file_pid
        file_pid=$(cat "$PID_FILE" 2>/dev/null || true)
        if [ -n "$file_pid" ] && kill -0 "$file_pid" 2>/dev/null; then
            pid="$file_pid"
        fi
        rm -f "$PID_FILE"
    fi

    if [ -z "$pid" ]; then
        echo "PolarPilot is not running"
        exit 0
    fi

    echo "Stopping PolarPilot pid=$pid..."
    kill "$pid" 2>/dev/null || true

    # Wait for process to exit (max 10s)
    for i in $(seq 1 10); do
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "PolarPilot stopped"
            exit 0
        fi
        sleep 1
    done

    # Force kill if still alive
    kill -9 "$pid" 2>/dev/null || true
    echo "PolarPilot force stopped"
    exit 0
}

do_restart() {
    do_stop
    do_start
}

do_status() {
    local pid=""

    if is_port_in_use; then
        pid=$(get_port_pid)
        echo "PolarPilot is running pid=$pid port=$PORT"
        exit 0
    fi

    if [ -f "$PID_FILE" ]; then
        local file_pid
        file_pid=$(cat "$PID_FILE" 2>/dev/null || true)
        if [ -n "$file_pid" ] && kill -0 "$file_pid" 2>/dev/null; then
            echo "PolarPilot pid=$file_pid (port $PORT not listening — may be starting)"
            exit 0
        fi
    fi

    echo "PolarPilot is not running"
    exit 0
}

# ── Main ─────────────────────────────────────────────────────────────────

COMMAND="${1:-start}"

case "$COMMAND" in
    start)
        do_start
        ;;
    stop)
        do_stop
        ;;
    restart)
        do_restart
        ;;
    status)
        do_status
        ;;
    *)
        echo "Usage: bash Start/start.sh [start|stop|restart|status]" >&2
        exit 1
        ;;
esac
