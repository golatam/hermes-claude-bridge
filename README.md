# hermes-claude-bridge

A Telegram-topic bridge for [Claude Code](https://claude.com/claude-code).
Mention a dedicated bot in a Forum-topic supergroup, and a scheduled poll
picks up the message, runs `claude -p` headless in the matching local git
repository, and replies in the same thread — done, blocked on a question, or
error. Per project, finished work either lands as a branch + pull request
(`gitMode: "pr"`, the default) or is pushed straight to the base branch
(`gitMode: "direct"`) — see the security note below before turning that on.

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
5. If the message carries a document or photo (with or without a caption),
   it's downloaded into `inbox/` (gitignored) and Claude Code is given
   access to that directory via `--add-dir`, since it's outside the target
   repo's working directory. Telegram mentions/text in a photo or document's
   *caption* are detected the same way as in a plain text message.
6. `claude -p` runs in that repo with the message text as the prompt, plus
   an appended git-workflow instruction that depends on the project's
   `gitMode` (`lib/dispatch.js` → `GIT_WORKFLOW_INSTRUCTIONS`): `"pr"`
   branches off the base branch and opens a PR; `"direct"` commits and
   pushes straight to the base branch.
7. The reply posted back to the thread is `STATUS`-tagged by the task
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
- Which branch is/isn't safe to push to is a prompt-level instruction
  (`gitMode`), not a hard technical restriction — `Bash(git *)` in the
  allowlist permits pushing anywhere regardless of `gitMode`. For a repo
  where an accidental push to the base branch would actually hurt, add
  branch protection / required review on the remote as the real backstop —
  especially if you turn on `gitMode: "direct"`, which removes the PR
  review checkpoint entirely: a misread task can land on the base branch
  unattended, with nobody looking at a diff first. Default is `"pr"`; treat
  `"direct"` as an explicit, per-project opt-in for low-stakes repos only.
- `claude.maxBudgetUsd` bounds API spend per dispatched task.

## Not handled (yet)

- Multiple Telegram groups (one `chatId` per bridge instance today).
- Concurrent tasks in the same repo (a second mention while one is running
  in that repo will start a second `claude` process in the same working
  tree — fine for independent files, risky for overlapping edits).
- Webhooks — this polls; a webhook-based variant would react faster but
  needs a publicly reachable endpoint.
- Files over 20MB — that's a Telegram Bot API hard limit on `getFile`
  downloads for regular (non-local) bots; larger files need a
  self-hosted Bot API server, out of scope here.
