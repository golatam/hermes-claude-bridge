# hermes-claude-bridge

A Telegram-topic bridge for [Claude Code](https://claude.com/claude-code).
Mention a dedicated bot in a Forum-topic supergroup, and a scheduled poll
picks up the message, runs `claude -p` headless in the matching local git
repository, and replies in the same thread — done, blocked on a question, or
error. Finished work always lands as a branch + pull request, never a direct
push to the base branch (see the security note below).

Built for a workflow where a chat-based AI agent (or a human) drops task
specs into an existing project discussion, without needing a dedicated
"dev" channel per project.

## How it works

1. A launchd job runs `bin/poll.js` on a fixed interval (`StartInterval` in
   the generated plist — launchd will not overlap runs, so a slow task never
   collides with the next tick).
2. Each run calls Telegram's `getUpdates` once and exits — it is not a
   long-running daemon.
3. A message that @mentions the bot, or replies to one of the bot's own
   messages, is treated as addressed to it. Everything else in the topic
   (regular discussion) is ignored.
4. The message's topic (`message_thread_id`) is looked up in `config.json`
   → `projects` to find the target repo.
5. `claude -p` runs in that repo with the message text as the prompt, plus
   an appended instruction to branch off the configured base branch and
   open a PR rather than pushing directly (`lib/dispatch.js`).
6. The reply posted back to the thread is `STATUS`-tagged by the task
   prompt itself: done / question / error. A `question` reply is recorded
   in `state.json`; the next reply to *that specific message* resumes the
   same Claude Code session via `--resume`.

## Requirements

- macOS (the installer registers a launchd job; other schedulers would work
  too, but `install.sh` only targets launchd).
- Node.js 20+, and the `claude` CLI on `PATH`, already logged in.
- `gh` CLI on `PATH` and authenticated (`gh auth login`) in every target
  repo — the dispatched tasks use `gh pr create` to open pull requests.
- A Telegram supergroup with Forum topics enabled.

## Setup

See `SKILL.md` — it's written to be followed by Claude Code itself when you
ask it to set this up, but the steps read fine standalone too.

Quick version:

```bash
cp config.example.json config.json   # fill in chatId, botUsername, projects
cp .env.example .env                 # paste the bot token
./install.sh                         # registers the launchd job
```

## Repository layout

```
bin/poll.js       entry point, one pass per invocation
lib/telegram.js   Bot API client + mention/reply detection
lib/dispatch.js   builds the task prompt, runs `claude -p`, parses STATUS
lib/state.js      state.json (Telegram offset + pending questions)
lib/config.js     config.json loading/validation
lib/env.js        minimal .env loader
launchd/          plist template, filled in by install.sh
```

## Security notes

- `config.json`, `.env`, and `state.json` are all gitignored — the example
  files are the only things meant to be committed.
- `claude.permissionMode` defaults to `acceptEdits` with an explicit
  `claude.allowedTools` allowlist, not `bypassPermissions`. Widen the
  allowlist deliberately per project.
- The base-branch protection is a prompt-level instruction, not a hard
  technical restriction — `Bash(git *)` in the allowlist can technically
  push anywhere. For a repo where an accidental push to the base branch
  would actually hurt, add branch protection / required review on the
  remote as the real backstop.
- `claude.maxBudgetUsd` bounds API spend per dispatched task.

## Not handled (yet)

- Multiple Telegram groups (one `chatId` per bridge instance today).
- Concurrent tasks in the same repo (a second mention while one is running
  in that repo will start a second `claude` process in the same working
  tree — fine for independent files, risky for overlapping edits).
- Webhooks — this polls; a webhook-based variant would react faster but
  needs a publicly reachable endpoint.
