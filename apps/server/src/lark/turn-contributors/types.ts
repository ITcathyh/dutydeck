import type { ChannelMappingRepository, PromptPart, Session } from '@dutydeck/shared';
import type { LarkMessageCoordinator, LarkTask } from '../coordinator.js';
import type { ListenerLog } from '../listener.js';
import type { composeLarkDispatchPrompt } from '../prompt-contributors.js';
import type { LarkCardElement } from '../card-renderer.js';
import type { LarkCardCapabilities } from '../card-actions.js';
import type { TerminalState } from '../terminal-plan.js';

type CoordinatorOptions = ConstructorParameters<typeof LarkMessageCoordinator>[10];

type VerificationCapabilities = Pick<LarkCardCapabilities, 'canVerify' | 'verificationSuggestion'>;
type VerificationPlan = { command: string; turn: number; recordId?: string };

export interface TurnVerification {
  fingerprint(task: LarkTask, session: Session): Promise<string | undefined>;
  plan(task: LarkTask, before?: string): Promise<VerificationPlan | undefined>;
  run(task: LarkTask, plan: VerificationPlan): Promise<void>;
  inFlight(taskId: string): boolean;
  settle(appId: string, taskId: string): Promise<void>;
  view(task: LarkTask, config: LarkTask['config'], state: TerminalState, changed: boolean): Promise<{
    element?: LarkCardElement; capabilities: VerificationCapabilities;
  }>;
}

export interface TurnResult {
  changedCode: boolean;
  verification?: LarkCardElement;
  capabilities: VerificationCapabilities;
}

export interface TurnContext {
  task: LarkTask;
  config: LarkTask['config'];
  event: LarkTask['event'];
  session: Session;
  botSender: boolean;
  currentTurn: number;
  reattaching: boolean;
  materialPrompt: string;
  materialParts?: PromptPart[];
  options: Pick<CoordinatorOptions, 'store' | 'participation' | 'memory'>;
  verification: TurnVerification;
  cardMappings: ChannelMappingRepository;
  log: ListenerLog;
}

export type TurnPrompt = Pick<Parameters<typeof composeLarkDispatchPrompt>[0], 'groupContext' | 'groupInstructions' | 'memoryBlock' | 'scenarioRecall' | 'scenarioExecution' | 'scenarioAdoption'> & {
  groupInstructionsRevision?: number;
};

export interface TurnContributor {
  captureWorkspace?(): Promise<void>;
  planDelivery?(state: TerminalState): Promise<void>;
  inspectResult?(state: TerminalState, result: TurnResult): Promise<void>;
  freezeRequest?(): Promise<void>;
  accepted?(receipt: { id: string; replayed?: boolean }): Promise<void>;
  beforeCard?(card: Pick<import('../service.js').LarkCardInput, 'scenarioRecall'>): Promise<void>;
  preparePrompt?(): Promise<void>;
  attached?(receipt: { id: string; replayed?: boolean }): Promise<void>;
  afterDelivery?(state: TerminalState, runtimeTaskId?: string): void;
  readContext?(): Promise<void>;
  onReplay?(): void;
  settling?(state: TerminalState): Promise<void>;
}
