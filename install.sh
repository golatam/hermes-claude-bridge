#!/usr/bin/env bash
# Registers bin/poll.js as a macOS launchd job that fires every
# config.json -> pollIntervalSeconds seconds. Safe to re-run to pick up a
# changed interval or Node path.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

if [[ ! -f config.json ]]; then
  echo "Missing config.json — copy config.example.json to config.json and fill it in first." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example to .env and paste the bot token in first." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found on PATH." >&2
  exit 1
fi

POLL_INTERVAL_SECONDS="$(node -e "console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).pollIntervalSeconds)")"
SCRIPT_PATH="$REPO_DIR/bin/poll.js"
LOG_PATH="$REPO_DIR/bridge.log"
LABEL="com.hermes-claude-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s#__NODE_BIN__#$NODE_BIN#g" \
  -e "s#__SCRIPT_PATH__#$SCRIPT_PATH#g" \
  -e "s#__REPO_DIR__#$REPO_DIR#g" \
  -e "s#__PATH_ENV__#$PATH#g" \
  -e "s#__POLL_INTERVAL_SECONDS__#$POLL_INTERVAL_SECONDS#g" \
  -e "s#__LOG_PATH__#$LOG_PATH#g" \
  launchd/com.hermes-claude-bridge.plist.template > "$PLIST_PATH"

UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_PATH"

echo "Installed and loaded $LABEL, polling every ${POLL_INTERVAL_SECONDS}s."
echo "Logs: $LOG_PATH"
echo "Status: launchctl list | grep $LABEL"
echo "Uninstall: launchctl bootout gui/$UID_NUM/$LABEL && rm $PLIST_PATH"
