import { channelExecutionAppId, dutydeckSessionKinds, renderSessionNotice, RuntimeError, type AttemptRef, type ExecutionActor, type MatterSessionInput, type PromptPart, type PublicTaskRecord, type Session, type TaskExecutionContext, type TaskRecord, type TaskRequestV1, type VerificationResponse } from '@dutydeck/shared';
import type { RuntimeOptions, SessionNotice } from '../index.js';

export type ActiveTaskContext = { taskId: string; attemptId?: string; actorId?: string };

type Authorization =
  | { phase: 'start'; sessionId: string; actorId?: string }
  | { phase: 'prepare' | 'submit'; session: Session; task: TaskRecord }
  | { phase: 'control'; sessionId: string; actor: ExecutionActor; action: 'stop' };

export interface ExecutionPolicy {
  channelAppId?: (session: Session) => string | undefined;
  authorize(request: Authorization): Promise<void | (() => Promise<void>)>;
  admit?: RuntimeOptions['admitTask'];
  reviewPermission?: RuntimeOptions['reviewPermission'];
  riskPolicy?: RuntimeOptions['resolveRiskPolicy'];
}

export interface LaunchContext extends Pick<RuntimeOptions, 'configureAgent' | 'terminalBackend' | 'acpxCommand' | 'probe' | 'workspaceRoot' | 'ptyDriverFactory' | 'driverFactory' | 'ptyRetirement' | 'agentStatusCheck'> {
  environment?: RuntimeOptions['sessionEnvironment'];
}

type Version = NonNullable<TaskExecutionContext['promptPolicyVersion']>;
type Prepared = Awaited<ReturnType<NonNullable<RuntimeOptions['prepareTaskPrompt']>>>;
export interface PromptAssembler {
  atAccept(session: Session, request: TaskRequestV1, input: { agentPrompt: string; inheritedVersion?: Version; promptParts?: PromptPart[] }, checkCurrent: () => void): Promise<Prepared & { version: Version; diagnosticReason?: string }>;
  atExecute(session: Session, prompt: string, context?: TaskExecutionContext, active?: ActiveTaskContext): ReturnType<NonNullable<RuntimeOptions['sessionPrompt']>>;
}

/** Selection can wait on host I/O. Check ownership again before running preparation hooks. */
export function createAcceptPrompt(select?: RuntimeOptions['selectPromptPolicy'], prepare?: RuntimeOptions['prepareTaskPrompt']): PromptAssembler['atAccept'] {
  return async (session, request, input, checkCurrent) => {
    const selected = input.inheritedVersion ? { version: input.inheritedVersion } : await select?.(session, request) ?? { version: 'legacy-v1' as const };
    checkCurrent();
    if (request.skills.length && !prepare) throw new RuntimeError('SKILL_DELIVERY_UNAVAILABLE', 'This Runtime has no Skill delivery resolver', 503);
    const parts = input.promptParts ? { promptParts: input.promptParts } : {};
    const prepared = await prepare?.(session, input.agentPrompt, request.skills, { promptPolicyVersion: selected.version, ...parts }) ?? { agentPrompt: input.agentPrompt, ...parts };
    return { ...selected, ...prepared };
  };
}

export type RuntimeEvent =
  | { type: 'matter.session'; sessionId: string; input: MatterSessionInput }
  | { type: 'task.accepted'; session: Session; task: TaskRecord }
  | { type: 'turn.started' | 'turn.ended'; session: Session; taskId: string }
  | { type: 'usage.reading'; session: Session; attempt: AttemptRef; reading?: Record<string, unknown> }
  | { type: 'task.settled'; session: Session; task: PublicTaskRecord }
  | { type: 'verification.completed'; session: Session; result: VerificationResponse }
  | { type: 'notice'; session: Session; notice: SessionNotice };

type Listener = (event: RuntimeEvent) => void | Promise<void>;
export class RuntimeEventBus {
  private readonly listeners = { host: new Set<Listener>(), plugin: new Set<Listener>() };
  subscribe(role: 'host' | 'plugin', listener: Listener) {
    this.listeners[role].add(listener);
    return () => { this.listeners[role].delete(listener); };
  }
  get observed() { return this.listeners.host.size + this.listeners.plugin.size > 0; }
  async publish(event: RuntimeEvent) {
    const errors: unknown[] = [];
    for (const listener of [...this.listeners.host, ...this.listeners.plugin]) {
      try { await listener(event); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  }
}

export function runtimeHost(options: RuntimeOptions) {
  const events = options.events ?? new RuntimeEventBus();
  let unsubscribeLegacy: (() => void) | undefined;
  if (options.matterTracking || options.observeTurn || options.recordUsage || options.onTaskSettled || options.onVerificationCompleted || options.onSessionNotice) {
    unsubscribeLegacy = events.subscribe('host', event => {
      switch (event.type) {
        case 'matter.session': return options.matterTracking?.session(event.sessionId, event.input);
        case 'task.accepted': return options.matterTracking?.accepted(event.session, event.task);
        case 'turn.started': return options.observeTurn?.(event.session, event.taskId, 'start');
        case 'usage.reading': return options.recordUsage?.(event.session, event.attempt, event.reading);
        case 'task.settled': return options.onTaskSettled?.(event.session, event.task);
        case 'verification.completed': return options.onVerificationCompleted?.(event.session, event.result);
        case 'notice': return options.onSessionNotice?.(event.session, event.notice);
      }
    });
  }
  const policy: ExecutionPolicy = options.executionPolicy ?? {
    async authorize(request) {
      switch (request.phase) {
        case 'start': return options.authorizeExecution?.(request.sessionId, request.actorId);
        case 'control': return options.authorizeControl
          ? options.authorizeControl(request.sessionId, request.actor, request.action)
          : options.authorizeExecution?.(request.sessionId, request.actor.kind === 'unspecified' ? undefined : request.actor.id);
        default: return options.authorizeTask?.(request.session, request.task, request.phase);
      }
    },
    admit: options.admitTask, reviewPermission: options.reviewPermission,
    get riskPolicy() { return options.resolveRiskPolicy; }
  };
  const prompts: PromptAssembler = options.promptAssembler ?? {
    atAccept: createAcceptPrompt(options.selectPromptPolicy, options.prepareTaskPrompt),
    atExecute: (session, prompt, context) => options.sessionPrompt?.(session, prompt, context) ?? prompt
  };
  const launch: LaunchContext = options.launchContext ?? { ...options, environment: options.sessionEnvironment };
  return {
    events, policy, launch, prompts, unsubscribeLegacy,
    channelAppId: policy.channelAppId ?? channelExecutionAppId,
    sessionKinds: options.sessionKinds ?? dutydeckSessionKinds,
    renderNotice: options.renderNotice ?? renderSessionNotice,
    beforeSettlement: options.beforeSettlement ?? (options.observeTurn ? (session: Session, taskId: string) => options.observeTurn!(session, taskId, 'end') : undefined),
    matterSummary: options.matterSummary ?? options.matterTracking?.summary.bind(options.matterTracking),
    log: options.log, awaitingAnswer: options.awaitingAnswer, cleanupIntervalMs: options.cleanupIntervalMs,
    driverIdleTimeoutMs: options.driverIdleTimeoutMs, driverIdleCpuAction: options.driverIdleCpuAction
  };
}
export type RuntimeHost = ReturnType<typeof runtimeHost>;
