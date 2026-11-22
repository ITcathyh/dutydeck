import type { PromptPart, Session } from '@dutydeck/shared';
import type { LarkMessageCoordinator, LarkTask } from '../coordinator.js';
import type { ListenerLog } from '../listener.js';
import type { composeLarkDispatchPrompt } from '../prompt-contributors.js';
import type { TerminalState } from '../terminal-plan.js';

type CoordinatorOptions = ConstructorParameters<typeof LarkMessageCoordinator>[10];

export interface TurnContext {
  task: LarkTask;
  config: LarkTask['config'];
  event: LarkTask['event'];
  session: Session;
  materialPrompt: string;
  materialParts?: PromptPart[];
  options: Pick<CoordinatorOptions, 'store' | 'participation'>;
  log: ListenerLog;
}

export type TurnPrompt = Pick<Parameters<typeof composeLarkDispatchPrompt>[0], 'groupContext' | 'groupInstructions'> & {
  groupInstructionsRevision?: number;
};

export interface TurnContributor {
  readContext?(): Promise<void>;
  onReplay?(): void;
  settling?(state: TerminalState): Promise<void>;
}
