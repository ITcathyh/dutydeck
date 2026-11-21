import type { LarkCardActionName, LarkCardActionValue } from '../card-actions.js';
import type { LarkTask } from '../coordinator.js';
import type { StoredLarkConfig } from '../config.js';
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

export type StoredButtonHandler = (ctx: ButtonDependencies, parsed: LarkCardActionValue, operator?: string, source?: ButtonSource) => Promise<ButtonResult>;
export type TaskButtonHandler = (ctx: ButtonDependencies, input: {
  task: LarkTask;
  taskId: string;
  action: LarkCardActionName;
  actionTurn: number;
  actionStale(): boolean;
  effectiveConfig: StoredLarkConfig;
  operatorOpenId?: string;
}) => Promise<ButtonResult>;
