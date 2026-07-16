#!/usr/bin/env node
// Entry point run periodically (by launchd/cron). Does exactly one pass:
// fetch new Telegram updates, dispatch/resume Claude Code sessions, reply
// with status, persist state, exit. No long-running process.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConfig } from '../lib/config.js';
import { loadState, saveState, pendingKey } from '../lib/state.js';
import { TelegramClient, isAddressedToBot } from '../lib/telegram.js';
import { buildTaskPrompt, runClaudeTask, newSessionId } from '../lib/dispatch.js';
import { loadDotEnv } from '../lib/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const configPath = process.env.HERMES_CLAUDE_BRIDGE_CONFIG ?? join(ROOT, 'config.json');
const statePath = process.env.HERMES_CLAUDE_BRIDGE_STATE ?? join(ROOT, 'state.json');

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
  const prompt = buildTaskPrompt(message.text ?? '', project.baseBranch ?? 'main');
  console.log(`Dispatching new task for project "${project.name}" (session ${sessionId})`);

  const result = await runClaudeTask({
    repoPath: project.repoPath,
    prompt,
    sessionId,
    resume: false,
    claudeConfig: config.claude,
  });

  await reportResult({ telegram, chatId, message, project, result, state });
}

async function resumeSession({ message, pending, config, state, telegram, chatId, replyToId }) {
  console.log(`Resuming session ${pending.sessionId} for project "${pending.projectName}"`);

  const result = await runClaudeTask({
    repoPath: pending.repoPath,
    prompt: message.text ?? '',
    sessionId: pending.sessionId,
    resume: true,
    claudeConfig: config.claude,
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
