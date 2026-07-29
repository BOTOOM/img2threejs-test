#!/usr/bin/env bash
# Start the kimik3 review harness (idempotent).
cd "$(dirname "$0")"
if curl -s -o /dev/null http://localhost:5199/; then
  echo "already running"
  exit 0
fi
nohup npx vite --port 5199 --strictPort > vite.log 2>&1 &
echo $! > vite.pid
sleep 3
curl -s -o /dev/null -w "vite up: %{http_code}\n" http://localhost:5199/
