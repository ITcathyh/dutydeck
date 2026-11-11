import { randomUUID } from 'node:crypto';
import { larkFailureKind } from './api-gate.js';
import Database from 'better-sqlite3';
import { readLarkConfig } from './config.js';
import { resolveCliDatabase } from '../daemon/command.js';
import { TaskCliError } from '../task-cli.js';
import { createLarkCardService, larkCardStates, larkReceiveIdTypes, type LarkBotConfigInput, type LarkCardInput, type LarkCardState, type LarkReceiveIdType } from './service.js';
import type { LarkCliOptions } from '../cli-program.js';

const numberOption = (value: string | undefined, name: string, fallback: number) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TaskCliError('invalid_argument', `${name} must be a non-negative number`);
  return parsed;
};

const stateOption = (value: string | undefined): LarkCardState => {
  const state = value ?? 'completed';
  if (!(larkCardStates as readonly string[]).includes(state)) throw new TaskCliError('invalid_argument', `state must be one of: ${larkCardStates.join(', ')}`);
  return state as LarkCardState;
};

export function cardInputFromCli(markdown: string | undefined, options: LarkCliOptions): LarkCardInput {
  const state = stateOption(options.state);
  return {
    agentName: options.agentName,
    state,
    readOnly: options.readOnly,
    taskName: options.taskName,
    taskId: options.taskId,
    elapsedSeconds: numberOption(options.elapsedSeconds, 'elapsed-seconds', 0),
    markdown
  };
}

export async function runLarkSend(markdown: string | undefined, options: LarkCliOptions, env: NodeJS.ProcessEnv = process.env) {
  if (options.chatId && options.receiveId) throw new TaskCliError('invalid_argument', 'chat-id and receive-id cannot be used together');
  let receiveIdType: LarkReceiveIdType | undefined;
  if (options.receiveIdType) {
    if (!(larkReceiveIdTypes as readonly string[]).includes(options.receiveIdType)) throw new TaskCliError('invalid_argument', `receive-id-type must be one of: ${larkReceiveIdTypes.join(', ')}`);
    receiveIdType = options.receiveIdType as LarkReceiveIdType;
  }
  if (options.inThread && !options.replyTo) throw new TaskCliError('invalid_argument', '--in-thread requires --reply-to');
  if (options.app && (options.appId || options.appSecret)) throw new TaskCliError('invalid_argument', '--app cannot be combined with explicit credentials');
  let bot: LarkBotConfigInput = { appId: options.appId, appSecret: options.appSecret, baseUrl: options.baseUrl };
  if (options.app) {
    const db = new Database(resolveCliDatabase(options.database, env), { readonly: true, fileMustExist: true });
    try {
      const saved = await readLarkConfig({ get: async (key: string) => (db.prepare('SELECT value FROM configs WHERE key=?').get(key) as { value?: string } | undefined)?.value } as any, options.app, { readOnly: true });
      if (!saved) throw new TaskCliError('not_found', 'Saved bot not found');
      bot = { appId: saved.appId, appSecret: saved.appSecret, baseUrl: options.baseUrl ?? (saved.brand === 'lark' ? 'https://open.larksuite.com' : undefined) };
    } finally { db.close(); }
  }
  const service = createLarkCardService(env, globalThis.fetch, bot);
  let deliveryUnknown = false;
  const input = { ...cardInputFromCli(markdown, options), idempotencyKey: randomUUID(),
    onDeliveryFailure: (error: unknown) => { if (larkFailureKind(error) === 'unknown') deliveryUnknown = true; }
  };
  let result;
  try {
    result = options.replyTo ? await service.reply({ ...input, messageId: options.replyTo, replyInThread: options.inThread })
      : await service.send({ ...input, chatId: options.chatId, receiveId: options.receiveId, receiveIdType });
  } catch (error) {
    if (deliveryUnknown || larkFailureKind(error) === 'unknown') throw new TaskCliError('unknown_outcome', 'Message delivery outcome is unknown; do not resend automatically');
    throw error;
  }
  if (!options.json) return result;
  // The message has been sent even if retrieving its link fails.
  try { return { message_id: result.messageId, url: await service.getMessageLink(result.messageId) }; }
  catch { throw new TaskCliError('unknown_outcome', `Message ${result.messageId} was sent, but its link could not be retrieved`); }
}

export async function runLarkUpdate(markdown: string | undefined, options: LarkCliOptions, env: NodeJS.ProcessEnv = process.env) {
  const bot: LarkBotConfigInput = { appId: options.appId, appSecret: options.appSecret, baseUrl: options.baseUrl };
  return createLarkCardService(env, globalThis.fetch, bot).update({ ...cardInputFromCli(markdown, options), messageId: options.messageId ?? '' });
}
