import type { ChannelMappingRepository, ConfigRepository, PromptPart, Session } from '@dutydeck/shared';
import type { LarkTask } from '../coordinator.js';
import type { LarkGroupParticipation } from '../group-participation.js';
import type { LarkMemoryStore } from '../memory.js';
import type { LarkMemoryPipeline } from '../memory-pipeline.js';
import type { LarkCardInput } from '../service.js';
import type { ListenerLog } from '../listener.js';
import type { composeLarkDispatchPrompt } from '../prompt-contributors.js';
import type { LarkCardElement } from '../card-renderer.js';
import type { LarkCardCapabilities } from '../card-actions.js';
import type { TerminalState } from '../terminal-plan.js';

export type TurnReceipt = { id: string; replayed?: boolean };

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
  gitStatus?: LarkCardElement;
  diff?: LarkCardElement;
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
  options: {
    store: ConfigRepository;
    participation?: LarkGroupParticipation;
    memory?: { store: LarkMemoryStore; pipeline?: LarkMemoryPipeline };
  };
  verification: TurnVerification;
  cardMappings: ChannelMappingRepository;
  log: ListenerLog;
}

export type TurnPrompt = Pick<Parameters<typeof composeLarkDispatchPrompt>[0], 'groupContext' | 'groupInstructions' | 'memoryBlock' | 'scenarioRecall' | 'scenarioExecution' | 'scenarioAdoption'> & {
  groupInstructionsRevision?: number;
};

export interface TurnContributor {
  beforeCard?(card: Pick<LarkCardInput, 'scenarioRecall'>): Promise<void>;
  readContext?(): Promise<void>;
  preparePrompt?(): Promise<void>;
  captureWorkspace?(): Promise<void>;
  freezeRequest?(): Promise<void>;
  accepted?(receipt: TurnReceipt): Promise<void> | void;
  attached?(receipt: TurnReceipt): Promise<void>;
  settling?(state: TerminalState): Promise<void>;
  planDelivery?(state: TerminalState): Promise<void>;
  inspectResult?(state: TerminalState, result: TurnResult): Promise<void>;
  decorateResult?(state: TerminalState, result: TurnResult, workspace?: string): Promise<void>;
  afterDelivery?(state: TerminalState, runtimeTaskId?: string): void;
}
