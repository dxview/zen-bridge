#!/bin/bash
# Container entrypoint: dedicated opencode serve (loopback) + OpenAI bridge (public $PORT).
set -u

export XDG_DATA_HOME=/app/data XDG_CONFIG_HOME=/app/config
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"

: "${OPENCODE_SET_PASSWORD:?missing OPENCODE_SET_PASSWORD}"
: "${BRIDGE_KEY:?missing BRIDGE_KEY}"

OPENCODE_SERVER_PASSWORD="$OPENCODE_SET_PASSWORD" \
  nohup opencode serve --port 4097 --hostname 127.0.0.1 > /tmp/serve.log 2>&1 &

# Wait for serve, then determine the effective password (env is honored on v2,
# but fall back to the auto-generated one from the log just in case).
EFF="$OPENCODE_SET_PASSWORD"
code=""
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$EFF" http://127.0.0.1:4097/api/model)
  [ "$code" = "200" ] && break
  sleep 1
done
if [ "$code" != "200" ]; then
  GEN=$(grep -o 'server password .*' /tmp/serve.log | tail -1 | awk '{print $3}')
  [ -n "$GEN" ] && EFF="$GEN"
fi
echo "serve auth: $(curl -s -o /dev/null -w '%{http_code}' -u "opencode:$EFF" http://127.0.0.1:4097/api/model)"

OPENCODE_SERVER=http://127.0.0.1:4097 \
OPENCODE_PASSWORD="$EFF" \
BRIDGE_HOST=0.0.0.0 \
BRIDGE_PORT="${PORT:-4200}" \
BRIDGE_KEY="$BRIDGE_KEY" \
exec node /app/bridge-koyeb.mjs
