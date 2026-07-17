import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API_ROOT = 'https://api.telegram.org';
const FILE_ROOT = 'https://api.telegram.org/file';

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

  // Bots can only fetch files up to 20MB this way (Bot API limit).
  async downloadFile(fileId, destPath) {
    const { file_path: filePath } = await this.call('getFile', { file_id: fileId });
    const res = await fetch(`${FILE_ROOT}/bot${this.botToken}/${filePath}`);
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download Telegram file ${fileId}: HTTP ${res.status}`);
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
  }
}

// Text and mention entities live either on the message itself, or on
// .caption/.caption_entities when the message is a photo/document with a
// caption instead of a plain text message.
export function messageText(message) {
  return message.text ?? message.caption ?? '';
}

function messageEntities(message) {
  return message.entities ?? message.caption_entities ?? [];
}

// True if the message @mentions the bot, or replies to a message sent by the bot.
export function isAddressedToBot(message, botUsername, botId) {
  const text = messageText(message);
  const mentionsUsername = messageEntities(message).some(
    (e) =>
      e.type === 'mention' &&
      text.slice(e.offset, e.offset + e.length).toLowerCase() ===
        `@${botUsername.toLowerCase()}`
  );
  const repliesToBot = message.reply_to_message?.from?.id === botId;
  return mentionsUsername || repliesToBot;
}

// A document, or the highest-resolution photo, attached to the message.
export function pickAttachment(message) {
  if (message.document) {
    return {
      fileId: message.document.file_id,
      fileName: message.document.file_name ?? `document-${message.message_id}`,
    };
  }
  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1];
    return { fileId: largest.file_id, fileName: `photo-${message.message_id}.jpg` };
  }
  return null;
}
