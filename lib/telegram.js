const API_ROOT = 'https://api.telegram.org';

export class TelegramClient {
  constructor(botToken) {
    this.botToken = botToken;
    this.me = null;
  }

  async call(method, params = {}) {
    const res = await fetch(`${API_ROOT}/bot${this.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = await res.json();
    if (!body.ok) {
      throw new Error(`Telegram API ${method} failed: ${body.description}`);
    }
    return body.result;
  }

  async getMe() {
    if (!this.me) this.me = await this.call('getMe');
    return this.me;
  }

  // Long-poll for new updates since lastUpdateId (exclusive).
  async getUpdates(lastUpdateId, timeoutSeconds = 30) {
    return this.call('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: timeoutSeconds,
      allowed_updates: ['message'],
    });
  }

  async sendMessage(chatId, text, { messageThreadId, replyToMessageId } = {}) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      message_thread_id: messageThreadId,
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true,
    });
  }
}

// True if the message @mentions the bot, or replies to a message sent by the bot.
export function isAddressedToBot(message, botUsername, botId) {
  const mentionsUsername = (message.entities ?? []).some(
    (e) =>
      e.type === 'mention' &&
      message.text?.slice(e.offset, e.offset + e.length).toLowerCase() ===
        `@${botUsername.toLowerCase()}`
  );
  const repliesToBot = message.reply_to_message?.from?.id === botId;
  return mentionsUsername || repliesToBot;
}
