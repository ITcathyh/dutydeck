import * as lark from '@larksuiteoapi/node-sdk';
import { pathToFileURL } from 'node:url';
import { buildAgentCard, LarkCardClient } from './lark-agent-card.mjs';

const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

export function extractP2pText(event) {
  const { sender, message } = event ?? {};
  if (!message?.message_id || message.chat_type !== 'p2p' || message.message_type !== 'text') return undefined;
  if (sender?.sender_type !== 'user') return undefined;

  try {
    const text = JSON.parse(message.content)?.text?.trim();
    if (!text) return undefined;
    return { messageId: message.message_id, chatId: message.chat_id, text };
  } catch {
    return undefined;
  }
}

export class MessageDedupe {
  constructor({ ttlMs = 24 * 60 * 60 * 1000, maxSize = 10_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.now = now;
    this.pending = new Set();
    this.completed = new Map();
  }

  begin(messageId) {
    this.prune();
    if (this.pending.has(messageId) || this.completed.has(messageId)) return false;
    this.pending.add(messageId);
    return true;
  }

  finish(messageId, succeeded) {
    this.pending.delete(messageId);
    if (succeeded) this.completed.set(messageId, this.now() + this.ttlMs);
    this.prune();
  }

  prune() {
    const now = this.now();
    for (const [messageId, expiresAt] of this.completed) {
      if (expiresAt <= now) this.completed.delete(messageId);
    }
    while (this.completed.size > this.maxSize) {
      this.completed.delete(this.completed.keys().next().value);
    }
  }

  close() {
    this.pending.clear();
    this.completed.clear();
  }
}

export function createEchoHandler({ cardClient, dedupe, now = () => Date.now(), log = console }) {
  return async event => {
    const input = extractP2pText(event);
    if (!input || !dedupe.begin(input.messageId)) return;

    const startedAt = now();
    try {
      const card = buildAgentCard({
        state: 'completed',
        taskName: '消息回复',
        taskId: input.messageId,
        elapsedSeconds: (now() - startedAt) / 1000,
        markdown: input.text
      });
      const reply = await cardClient.replyCard(input.messageId, card);
      dedupe.finish(input.messageId, true);
      log.info?.(`[lark-echo] replied ${input.messageId} -> ${reply.messageId ?? 'unknown'}`);
      return reply;
    } catch (error) {
      dedupe.finish(input.messageId, false);
      log.error?.(`[lark-echo] reply failed for ${input.messageId}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
}

export async function startEchoBot({ appId, appSecret, log = console } = {}) {
  const resolvedAppId = appId ?? required('LARK_APP_ID');
  const resolvedAppSecret = appSecret ?? required('LARK_APP_SECRET');
  const cardClient = new LarkCardClient({ appId: resolvedAppId, appSecret: resolvedAppSecret });
  const dedupe = new MessageDedupe();
  const cleanupTimer = setInterval(() => dedupe.prune(), 5 * 60 * 1000);
  cleanupTimer.unref?.();

  const eventDispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
    'im.message.receive_v1': createEchoHandler({ cardClient, dedupe, log })
  });
  const wsClient = new lark.WSClient({
    appId: resolvedAppId,
    appSecret: resolvedAppSecret,
    loggerLevel: lark.LoggerLevel.warn,
    autoReconnect: true,
    onReady: () => log.info?.('[lark-echo] 长连接已就绪，等待单聊文本消息'),
    onReconnecting: () => log.warn?.('[lark-echo] 连接断开，正在重连'),
    onReconnected: () => log.info?.('[lark-echo] 已重新连接'),
    onError: error => log.error?.(`[lark-echo] 长连接失败: ${error.message}`)
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(cleanupTimer);
    dedupe.close();
    wsClient.close({ force: true });
    log.info?.('[lark-echo] 已停止');
  };

  await wsClient.start({ eventDispatcher });
  return { wsClient, close };
}

async function main() {
  const bot = await startEchoBot();
  const stop = signal => {
    console.info(`[lark-echo] 收到 ${signal}`);
    bot.close();
    process.exit(0);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(`[lark-echo] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
