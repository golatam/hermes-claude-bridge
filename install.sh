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
LABEL="com.hermes-claude-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

# launchd needs the executable, its WorkingDirectory, and the log path to
# resolve on the *internal* disk — $REPO_DIR sits on an external drive that
# may not be mounted when a scheduled tick fires. If any of those three
# don't resolve at spawn time, launchd fails the job with EX_CONFIG before a
# single line of our code runs, and there's nothing in the log to explain
# why. So launchd only ever points at a small wrapper (run.sh) on internal
# storage; the wrapper itself checks whether $REPO_DIR is reachable before
# handing off to node.
SUPPORT_DIR="$HOME/Library/Application Support/hermes-claude-bridge"
WRAPPER_PATH="$SUPPORT_DIR/run.sh"
LOG_PATH="$HOME/Library/Logs/hermes-claude-bridge.log"

mkdir -p "$HOME/Library/LaunchAgents" "$SUPPORT_DIR" "$HOME/Library/Logs"

sed \
  -e "s#__REPO_DIR__#$REPO_DIR#g" \
  -e "s#__NODE_BIN__#$NODE_BIN#g" \
  launchd/run.sh.template > "$WRAPPER_PATH"
chmod +x "$WRAPPER_PATH"

sed \
  -e "s#__WRAPPER_PATH__#$WRAPPER_PATH#g" \
  -e "s#__SUPPORT_DIR__#$SUPPORT_DIR#g" \
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
