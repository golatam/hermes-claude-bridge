# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Telegram-topic bridge for Claude Code: a scheduled `launchd` job polls one
Telegram Forum supergroup, and a message that @mentions the bridge bot (or
replies to one of its own messages) in a topic mapped to a local git repo
gets dispatched as a headless `claude -p` task in that repo. The reply
posted back to the thread is done/question/error, driven entirely by a
`STATUS:`/`SUMMARY:` protocol appended to every dispatched prompt (see
"The STATUS/SUMMARY protocol" below) — there is no other way the poller
knows whether a task finished.

No test suite, build step, or lint config exists in this repo (plain
Node.js, `"type": "module"`, no dependencies). Node 20+ is required
(`package.json` → `engines`).

## Commands

- **Run one poll pass by hand** (uses `config.json`/`state.json` next to
  the script, or `HERMES_CLAUDE_BRIDGE_CONFIG`/`HERMES_CLAUDE_BRIDGE_STATE`
  env vars if set elsewhere): `node bin/poll.js`
- **Register/refresh the launchd job**: `./install.sh` — safe to re-run
  after changing `pollIntervalSeconds` in `config.json`, changing Node's
  path, or editing the `launchd/*.template` files. Requires `config.json`
  and `.env` to already exist (copy from the `.example` files first).
- **Check the launchd job's state**: `launchctl print gui/$(id -u)/com.hermes-claude-bridge`
  (look at `last exit code` — `78`/`EX_CONFIG` means launchd itself
  couldn't spawn the job, before any of this repo's code ran) or
  `launchctl list | grep hermes-claude-bridge`.
- **Force one launchd-driven tick immediately** (useful to verify a config
  change without waiting for `pollIntervalSeconds`):
  `launchctl kickstart -k gui/$(id -u)/com.hermes-claude-bridge`
- **Tail the live log**: `tail -f ~/Library/Logs/hermes-claude-bridge.log`
  — this path is on internal storage deliberately, see below.
- **Uninstall**: `launchctl bootout gui/$(id -u)/com.hermes-claude-bridge && rm ~/Library/LaunchAgents/com.hermes-claude-bridge.plist`

## Architecture

### Request flow

`launchd` (timer, `StartInterval`) → `~/Library/Application Support/hermes-claude-bridge/run.sh`
(generated wrapper) → `bin/poll.js` → one pass: `TelegramClient.getUpdates()`
→ for each new message, `handleMessage()` decides between three paths:

1. **Resume** — the message replies to a message this bot previously sent
   with `STATUS: question` (tracked in `state.json` → `pendingQuestions`,
   keyed by `"<chatId>:<messageId>"` of the bot's own question). Resumes
   the exact same Claude Code session via `claude --resume <sessionId>`,
   using `pending.repoPath`/`pending.sessionId` stored at question-time —
   **this does not re-check `config.json`'s current `projects` list**, so
   a topic can be removed from config and an in-flight question there
   still resolves correctly.
2. **New task** — the message @mentions the bot or replies to one of its
   messages (`isAddressedToBot()`), and its `message_thread_id` maps to a
   project in `config.json` → `projects`. Dispatches a fresh
   `claude --session-id <uuid>` task in that project's `repoPath`.
3. **Ignored** — anything else, including (critically) any message whose
   `from.is_bot` is true. This supergroup is shared with a separate
   personal agent (a different bot); without this filter, that other
   bot's reply to one of this bridge's status messages would satisfy the
   same reply-to-bot check a human's reply does, and could trigger a real
   dispatch loop burning API budget in a real repo.

### The STATUS/SUMMARY protocol (`lib/dispatch.js`)

`claude -p` has no structured-output mode for this use case, so
`buildTaskPrompt()` appends a fixed instruction to every dispatched
prompt: end the turn with exactly `STATUS: done|question|error` and
`SUMMARY: <text>`. `parseStatus()` regex-matches those two lines out of
`--output-format json`'s `result` field. If the model doesn't emit them,
`parseStatus` defaults to `status: 'done'` with the raw text as the
summary — there is no hard enforcement, just a strongly-worded prompt.

### Git workflow enforcement is prompt-level, not tool-level

`claudeConfig.allowedTools` (e.g. `Bash(git *)`) permits `git push` to any
branch regardless of a project's `gitMode`. Which branch is safe to push
to is instead stated as an explicit instruction baked into the prompt
(`GIT_WORKFLOW_INSTRUCTIONS` in `lib/dispatch.js`, selected by
`gitMode: "pr"` vs `"direct"`, per-project override over
`claude.defaultGitMode`). Treat this as best-effort steering, not a
security boundary — a repo where an unwanted push to the base branch
would actually hurt needs branch protection on the remote as the real
backstop, especially under `gitMode: "direct"` (no PR checkpoint at all).

### Why `launchd` points at a generated wrapper, not the repo directly

The repo (and therefore `bin/poll.js`, `config.json`, any log path inside
the repo) lives on an external disk that may be unmounted when
`StartInterval` fires. If `WorkingDirectory` or the log path don't
resolve at spawn time, `launchd` fails the entire job with `EX_CONFIG`
(`78`) *before* Node even starts — this happened silently for 307
consecutive runs with zero log output. `install.sh` now generates
`~/Library/Application Support/hermes-claude-bridge/run.sh` (from
`launchd/run.sh.template`) on internal storage; the wrapper checks the
repo directory is reachable and exits 0 quietly if not (a skipped tick
just adds latency — Telegram retains unfetched updates for ~24h). The
plist's `WorkingDirectory`/`StandardOutPath`/`StandardErrorPath` all point
at internal-storage paths for the same reason; only the wrapper's own
`exec` argument reaches into the external-disk repo.

### State files (all gitignored; `.example` variants are the committed templates)

- `config.json` — `telegram.{chatId,botUsername,botTokenEnv}`,
  `pollIntervalSeconds`, `claude.{permissionMode,allowedTools,maxBudgetUsd,defaultGitMode}`,
  and `projects[]` (`topicId` → `repoPath`/`baseBranch`/`gitMode`).
  Validated by `lib/config.js` (`loadConfig`), which also builds the
  `topicToProject` `Map` used for dispatch and throws on duplicate
  `topicId`s or an invalid `gitMode`.
- `.env` — only the bot token, under the var name `telegram.botTokenEnv`
  points at. Loaded by `lib/env.js`'s minimal parser (no dependency); an
  explicit shell `export` always wins over the file.
- `state.json` — `lastUpdateId` (Telegram offset) and `pendingQuestions`
  (see Resume path above). Saved after *every* processed update, not just
  at the end of a batch, so a mid-batch crash doesn't replay already-handled
  messages.
- `inbox/` — Telegram photo/document attachments downloaded per dispatched
  task, granted to Claude Code via `--add-dir` since it's outside the
  target repo. Not a general drop folder; only holds files for messages
  that were actually dispatched.
