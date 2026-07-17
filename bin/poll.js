#!/usr/bin/env node
// Entry point run periodically (by launchd/cron). Does exactly one pass:
// fetch new Telegram updates, dispatch/resume Claude Code sessions, reply
// with status, persist state, exit. No long-running process.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { loadConfig } from '../lib/config.js';
import { loadState, saveState, pendingKey } from '../lib/state.js';
import { TelegramClient, isAddressedToBot, messageText, pickAttachment } from '../lib/telegram.js';
import { buildTaskPrompt, runClaudeTask, newSessionId } from '../lib/dispatch.js';
import { loadDotEnv } from '../lib/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const configPath = process.env.HERMES_CLAUDE_BRIDGE_CONFIG ?? join(ROOT, 'config.json');
const statePath = process.env.HERMES_CLAUDE_BRIDGE_STATE ?? join(ROOT, 'state.json');
const inboxDir = join(ROOT, 'inbox');

// Downloads any document/photo attached to the message into inboxDir and
// returns its local path, or null if the message has no attachment. Claude
// Code is granted access to inboxDir via --add-dir since it's outside the
// target repo's working directory.
async function downloadAttachment(message, telegram) {
  const attachment = pickAttachment(message);
  if (!attachment) return null;

  mkdirSync(inboxDir, { recursive: true });
  const safeName = attachment.fileName.replace(/[^\w.\-]+/g, '_');
  const destPath = join(inboxDir, `${message.message_id}-${safeName}`);
  await telegram.downloadFile(attachment.fileId, destPath);
  return destPath;
}

async function main() {
  loadDotEnv(join(ROOT, '.env'));
  const config = loadConfig(configPath);
  const state = loadState(statePath);
  const telegram = new TelegramClient(config.telegram.botToken);
  const me = await telegram.getMe();

  const updates = await telegram.getUpdates(state.lastUpdateId, 0);
  if (updates.length === 0) {
    console.log('No new updates.');
    return;
  }

  for (const update of updates) {
    state.lastUpdateId = Math.max(state.lastUpdateId, update.update_id);

    const message = update.message;
    if (!message || message.from?.id === me.id) continue;
    if (message.chat.id !== config.telegram.chatId) continue;

    try {
      await handleMessage({ message, config, state, telegram, me });
    } catch (err) {
      console.error(`Failed to handle message ${message.message_id}:`, err);
      await telegram
        .sendMessage(message.chat.id, `⚠️ Внутренняя ошибка моста: ${err.message}`, {
          messageThreadId: message.message_thread_id,
          replyToMessageId: message.message_id,
        })
        .catch(() => {});
    }

    // Persist after every update, not just at the end of the batch — if the
    // process dies mid-loop, already-handled updates aren't replayed.
    saveState(statePath, state);
  }
}

async function handleMessage({ message, config, state, telegram, me }) {
  const chatId = message.chat.id;
  const replyToId = message.reply_to_message?.message_id;
  const pending = replyToId ? state.pendingQuestions[pendingKey(chatId, replyToId)] : null;

  console.log(
    `msg ${message.message_id} thread=${message.message_thread_id} ` +
      `reply_to=${replyToId ?? '-'} reply_to_from=${message.reply_to_message?.from?.id ?? '-'} ` +
      `botId=${me.id} pendingMatch=${Boolean(pending)} attachment=${Boolean(pickAttachment(message))} ` +
      `text=${JSON.stringify(messageText(message).slice(0, 60))}`
  );

  if (pending) {
    await resumeSession({ message, pending, config, state, telegram, chatId, replyToId });
    return;
  }

  if (!isAddressedToBot(message, config.telegram.botUsername, me.id)) return;

  const project = config.topicToProject.get(message.message_thread_id);
  if (!project) {
    await telegram.sendMessage(
      chatId,
      `Этот топик не привязан ни к одному проекту в конфиге (topicId: ${message.message_thread_id}).`,
      { messageThreadId: message.message_thread_id, replyToMessageId: message.message_id }
    );
    return;
  }

  const sessionId = newSessionId();
  const attachmentPath = await downloadAttachment(message, telegram);
  const gitMode = project.gitMode ?? config.claude.defaultGitMode ?? 'pr';
  const prompt = buildTaskPrompt(messageText(message), project.baseBranch ?? 'main', attachmentPath, gitMode);
  console.log(`Dispatching new task for project "${project.name}" (session ${sessionId}, gitMode=${gitMode})`);

  const result = await runClaudeTask({
    repoPath: project.repoPath,
    prompt,
    sessionId,
    resume: false,
    claudeConfig: config.claude,
    addDir: attachmentPath ? inboxDir : null,
  });

  await reportResult({ telegram, chatId, message, project, result, state });
}

async function resumeSession({ message, pending, config, state, telegram, chatId, replyToId }) {
  console.log(`Resuming session ${pending.sessionId} for project "${pending.projectName}"`);

  const attachmentPath = await downloadAttachment(message, telegram);
  const replyText = attachmentPath
    ? `${messageText(message)}\n\nAttached file, read it first: ${attachmentPath}`
    : messageText(message);

  const result = await runClaudeTask({
    repoPath: pending.repoPath,
    prompt: replyText,
    sessionId: pending.sessionId,
    resume: true,
    claudeConfig: config.claude,
    addDir: attachmentPath ? inboxDir : null,
  });

  // Only drop the pending-question link once the resume actually
  // succeeded — if runClaudeTask above throws, the entry stays and a
  // follow-up reply to the same question can retry the resume.
  delete state.pendingQuestions[pendingKey(chatId, replyToId)];

  await reportResult({
    telegram,
    chatId,
    message,
    project: { name: pending.projectName, repoPath: pending.repoPath },
    result,
    state,
  });
}

async function reportResult({ telegram, chatId, message, project, result, state }) {
  const icon = { done: '✅', question: '❓', error: '⚠️' }[result.status] ?? 'ℹ️';
  const text = `${icon} [${project.name}] ${result.summary}`;

  const sent = await telegram.sendMessage(chatId, text, {
    messageThreadId: message.message_thread_id,
    replyToMessageId: message.message_id,
  });

  if (result.status === 'question') {
    state.pendingQuestions[pendingKey(chatId, sent.message_id)] = {
      sessionId: result.sessionId,
      repoPath: project.repoPath,
      projectName: project.name,
    };
  }
}

main().catch((err) => {
  console.error('Fatal error in poll run:', err);
  process.exit(1);
});
