import type { LarkCoordinatorInbound } from '../coordinator-inbound.js';

export type ButtonDependencies = ReturnType<LarkCoordinatorInbound['buttonDependencies']>;
export type ButtonSource = { messageId?: string; chatId?: string; actionTag?: string; option?: string };
export type ButtonResult = { type: string; content: string };
export type CallbackHandler = (ctx: ButtonDependencies, input: {
  key: string;
  workflow: Record<string, unknown>;
  operatorOpenId?: string;
  context?: ButtonSource;
}) => Promise<ButtonResult>;
