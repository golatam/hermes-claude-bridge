import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// state.pendingQuestions is keyed by "<chatId>:<botQuestionMessageId>" — the
// id of the bot's own message that asked a clarifying question. A user reply
// to that exact message resumes the matching Claude Code session.
const EMPTY_STATE = { lastUpdateId: 0, pendingQuestions: {} };

export function loadState(statePath) {
  if (!existsSync(statePath)) return structuredClone(EMPTY_STATE);
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

export function saveState(statePath, state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function pendingKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}
