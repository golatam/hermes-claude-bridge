---
name: hermes-claude-bridge
description: Set up, inspect, or debug the Telegram-topic bridge that dispatches tasks from a chat-based AI agent (e.g. Hermes) to headless Claude Code sessions and reports back into the thread. Use when the user asks to install/configure this bridge, check whether it's running, read its logs, or change which Telegram topic maps to which repository.
---

# hermes-claude-bridge

A background bridge, not an interactive skill: a cron/launchd job runs
`bin/poll.js` on a schedule. It watches one Telegram supergroup (with Forum
topics) for messages that @mention the bridge bot or reply to one of its
messages, maps the topic to a local git repository via `config.json`, runs
`claude -p` headless in that repo with the message text as the task, and
replies in the same thread with a status update. Finished work lands on a
branch with a PR — nothing is pushed to the base branch automatically.

## When invoked to help set this up

Walk the user through, in order:

1. **Create the bot.** Talk to `@BotFather` in Telegram → `/newbot`. Save the
   token.
2. **Disable privacy mode** (so the bot receives @mentions in a group without
   being admin): `@BotFather` → `/mypermissions` → select the bot →
   `/setprivacy` → Disable. Alternatively, make the bot a group admin, which
   also makes it see all messages.
3. **Add the bot** to the target supergroup (must have Topics/Forum mode
   enabled).
4. **Get the chat id.** Send any message in the group, then call
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id`
   (negative number for supergroups).
5. **Get topic ids.** Each Forum topic has a `message_thread_id` — same
   `getUpdates` call, sent from inside each topic, shows it.
6. **Copy `config.example.json` to `config.json`** and fill in `chatId`,
   `botUsername`, and one entry in `projects` per topic → local repo path.
7. **Copy `.env.example` to `.env`** and paste the bot token in, under the
   same var name referenced by `telegram.botTokenEnv` in `config.json`.
   `.env` is gitignored and never touches `config.json` — `install.sh` does
   not need to know the token, `poll.js` reads `.env` itself at startup.
8. **Run `./install.sh`** to register the launchd job (macOS). It reads
   `pollIntervalSeconds` from `config.json`.

## When invoked to check status or debug

- `tail -f /tmp/hermes-claude-bridge.log` (or the path `install.sh` printed)
  for the last poll run's output.
- `cat state.json` — `pendingQuestions` shows sessions waiting on a Telegram
  reply; `lastUpdateId` is the Telegram offset already processed.
- Run one pass by hand: `node bin/poll.js` (uses the same `config.json` /
  `state.json` next to the script unless `HERMES_CLAUDE_BRIDGE_CONFIG` /
  `HERMES_CLAUDE_BRIDGE_STATE` env vars point elsewhere).
- `launchctl list | grep hermes-claude-bridge` to confirm the job is loaded.

## Security-relevant defaults (review before enabling on a real repo)

- `claude.permissionMode` defaults to `acceptEdits`, not
  `bypassPermissions` — file edits are auto-accepted but every allowed tool
  is still explicit via `claude.allowedTools`. Anything not in that list is
  denied, not silently escalated.
- `claude.allowedTools` in the example config only permits `git` and
  `gh pr create|view` — no arbitrary shell commands. Note this does **not**
  by itself stop a push to the base branch: `Bash(git *)` covers `git push`
  to any branch. The base-branch protection is enforced by an explicit
  instruction baked into every dispatched task's prompt (see
  `lib/dispatch.js` → `buildTaskPrompt`), not by the tool allowlist. Treat
  that prompt instruction as best-effort, not a hard guarantee — for a repo
  where that matters, also add branch protection on the remote (e.g. a
  required-review rule on the base branch in GitHub).
- `claude.maxBudgetUsd` caps API spend per dispatched task as a safety net
  against a runaway session.
