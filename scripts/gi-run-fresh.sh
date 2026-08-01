#!/usr/bin/env bash
# Runs a GI harness against a FRESH vite port, retrying on the known
# intermittent editor boot hang (no camera / no [gi] logs — see the gi-module
# memory's HARNESS PROTOCOL note). Usage: gi-run-fresh.sh <script.mjs> [ENV=val ...]
set -u
SCRIPT="$1"; shift
for attempt in 1 2 3; do
  PORT=$(( 5300 + RANDOM % 400 ))
  LOG="/tmp/vite-$PORT.log"
  npx vite --port "$PORT" --strictPort > "$LOG" 2>&1 &
  VITE_PID=$!
  for i in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/" || true)
    [ "$code" = "200" ] && break
    sleep 1
  done
  echo "=== attempt $attempt: $SCRIPT on port $PORT ==="
  OUT=$(env "$@" timeout 300 node "$SCRIPT" "http://localhost:$PORT/" 2>&1)
  STATUS=$?
  kill $VITE_PID 2>/dev/null
  sleep 1
  if [ $STATUS -eq 0 ]; then echo "$OUT"; exit 0; fi
  if ! echo "$OUT" | grep -q "reading 'position'\|getBoundingClientRect\|createRoot\|no canvas"; then
    echo "$OUT"; exit $STATUS
  fi
  echo "--- boot flake, retrying ---"
done
echo "$OUT"
exit 1
