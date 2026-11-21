import type { LarkCommandRoute } from '../commands.js';
import type { LarkGroup, LarkTask } from '../coordinator.js';
import type { LarkCommandPrompt } from '../coordinator-core.js';
import type { CommandServices } from './service-context.js';
import type { LarkMessageEvent } from '../listener.js';
import type { StoredLarkConfig } from '../config.js';
import type { LarkCardElement } from '../card-renderer.js';

export interface CommandContext extends CommandServices {
  route: Extract<LarkCommandRoute, { kind: 'intent' }>;
  event: LarkMessageEvent;
  config: StoredLarkConfig;
  group: LarkGroup;
  scopeId: string;
  sessionId?: string;
  latestTask?: LarkTask;
  acknowledgement?: LarkTask['acknowledgement'];
  replyCard(title: string, markdown: string, options?: { elements?: LarkCardElement[]; failed?: boolean }): Promise<{ messageId: string } | undefined>;
}

export type ChatCommandHandler = (ctx: CommandContext) => Promise<string | LarkCommandPrompt>;
