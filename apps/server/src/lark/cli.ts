import { createLarkCardService, larkCardStates, larkReceiveIdTypes, type LarkBotConfigInput, type LarkCardInput, type LarkCardState, type LarkReceiveIdType } from './service.js';
import type { LarkCliOptions } from '../cli-program.js';

const numberOption = (value: string | undefined, name: string, fallback: number) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
};

const stateOption = (value: string | undefined): LarkCardState => {
  const state = value ?? 'completed';
  if (!(larkCardStates as readonly string[]).includes(state)) throw new Error(`state must be one of: ${larkCardStates.join(', ')}`);
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
  if (options.chatId && options.receiveId) throw new Error('chat-id and receive-id cannot be used together');
  let receiveIdType: LarkReceiveIdType | undefined;
  if (options.receiveIdType) {
    if (!(larkReceiveIdTypes as readonly string[]).includes(options.receiveIdType)) throw new Error(`receive-id-type must be one of: ${larkReceiveIdTypes.join(', ')}`);
    receiveIdType = options.receiveIdType as LarkReceiveIdType;
  }
  const bot: LarkBotConfigInput = { appId: options.appId, appSecret: options.appSecret, baseUrl: options.baseUrl };
  return createLarkCardService(env, globalThis.fetch, bot).send({ ...cardInputFromCli(markdown, options), chatId: options.chatId, receiveId: options.receiveId, receiveIdType });
}

export async function runLarkUpdate(markdown: string | undefined, options: LarkCliOptions, env: NodeJS.ProcessEnv = process.env) {
  const bot: LarkBotConfigInput = { appId: options.appId, appSecret: options.appSecret, baseUrl: options.baseUrl };
  return createLarkCardService(env, globalThis.fetch, bot).update({ ...cardInputFromCli(markdown, options), messageId: options.messageId ?? '' });
}
