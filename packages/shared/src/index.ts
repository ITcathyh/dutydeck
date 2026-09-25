import { z } from 'zod';
import {
  channelBotBrands,
  permissionModes,
  type ChannelBotBrand,
  type PermissionMode
} from './configuration-primitives.js';

export * from './configuration-primitives.js';

export const protocols = ['auto', 'acp', 'jsonl', 'pipe', 'pty', 'pty-cli'] as const;
export type Protocol = (typeof protocols)[number];
export const sessionStates = ['created', 'starting', 'idle', 'thinking', 'running_tool', 'waiting_for_permission', 'interrupting', 'interrupted', 'completed', 'failed', 'stopped'] as const;
export type SessionState = (typeof sessionStates)[number];
export const eventTypes = ['text', 'thinking', 'tool_call', 'tool_result', 'permission_request', 'status', 'error', 'completed', 'task', 'raw_terminal'] as const;
export type EventType = (typeof eventTypes)[number];

export const agentConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  protocol: z.enum(protocols).default('auto'),
  /** CLI behavior to reuse for a custom pty-cli command; defaults to id. */
  adapterId: z.string().min(1).optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  version: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).default({}),
  systemPrompt: z.string().optional(),
  permissionMode: z.enum(permissionModes).default('ask'),
  timeout: z.number().positive().default(600),
  capabilities: z.object({ pause: z.boolean().default(false), resume: z.boolean().default(true) }).default({ pause: false, resume: true }),
  builtin: z.boolean().default(false)
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/**
 * Browser-safe Agent projection. Keep this as an explicit allowlist: AgentConfig
 * also contains launch commands, paths, environment values and system prompts.
 */
export const publicAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().optional(),
  model: z.string().optional(),
  protocol: z.enum(protocols),
  permissionMode: z.enum(permissionModes)
}).strict();
export type PublicAgent = z.infer<typeof publicAgentSchema>;

export function toPublicAgent(agent: AgentConfig): PublicAgent {
  return publicAgentSchema.parse({
    id: agent.id,
    name: agent.name,
    version: agent.version,
    model: agent.model,
    protocol: agent.protocol,
    permissionMode: agent.permissionMode
  });
}

export const secretRefKinds = ['lark_app_secret', 'agent_env', 'generic'] as const;
export type SecretRefKind = (typeof secretRefKinds)[number];
export const secretRefStatuses = ['configured', 'invalid'] as const;
export type SecretRefStatus = (typeof secretRefStatuses)[number];

/** Provider metadata only. There is deliberately no value/secret/env field. */
export const secretRefMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  kind: z.enum(secretRefKinds),
  provider: z.string().min(1),
  referenceKey: z.string().min(1),
  status: z.enum(secretRefStatuses),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type SecretRefMetadata = z.infer<typeof secretRefMetadataSchema>;

export const createSecretRefInputSchema = secretRefMetadataSchema.pick({
  id: true,
  kind: true,
  provider: true,
  referenceKey: true,
  status: true
}).strict();
export type CreateSecretRefInput = z.infer<typeof createSecretRefInputSchema>;

export const updateSecretRefInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  kind: z.enum(secretRefKinds).optional(),
  provider: z.string().min(1).optional(),
  referenceKey: z.string().min(1).optional(),
  status: z.enum(secretRefStatuses).optional()
}).strict().refine(input => Object.keys(input).some(key => key !== 'expectedRevision'), { message: 'At least one field must be updated' });
export type UpdateSecretRefInput = z.infer<typeof updateSecretRefInputSchema>;

export const channelBotStates = ['staged', 'disabled'] as const;
export type ChannelBotState = (typeof channelBotStates)[number];

/**
 * WP0 cannot represent an enabled listener or confirmed full trust. Later work
 * must introduce those transitions deliberately instead of relaxing this type.
 */
export const channelBotFoundationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  revision: z.number().int().positive(),
  channel: z.literal('lark'),
  externalAppId: z.string().min(1),
  displayName: z.string().min(1),
  brand: z.enum(channelBotBrands),
  credentialRef: z.string().min(1).optional(),
  state: z.enum(channelBotStates),
  desiredListenerState: z.literal('disabled'),
  fullTrustConfirmed: z.literal(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type ChannelBotFoundation = z.infer<typeof channelBotFoundationSchema>;

export const createChannelBotInputSchema = channelBotFoundationSchema.pick({
  id: true,
  channel: true,
  externalAppId: true,
  displayName: true,
  brand: true,
  credentialRef: true,
  state: true
}).strict();
export type CreateChannelBotInput = z.infer<typeof createChannelBotInputSchema>;

export const updateChannelBotInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  externalAppId: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  brand: z.enum(channelBotBrands).optional(),
  credentialRef: z.string().min(1).nullable().optional(),
  state: z.enum(channelBotStates).optional()
}).strict().refine(input => Object.keys(input).some(key => key !== 'expectedRevision'), { message: 'At least one field must be updated' });
export type UpdateChannelBotInput = z.infer<typeof updateChannelBotInputSchema>;

export const channelBotBlockerCodes = [
  'channel_bot_credential_required',
  'channel_bot_credential_invalid',
  'channel_bot_credential_unreadable',
  'channel_bot_activation_unavailable'
] as const;
export type ChannelBotBlockerCode = (typeof channelBotBlockerCodes)[number];
export interface ChannelBotFoundationReadiness {
  credentialStatus: 'missing' | 'configured' | 'invalid' | 'unreadable';
  listenerEligible: false;
  blockers: Array<{ code: ChannelBotBlockerCode; message: string }>;
}

export type SecretRefAvailability = 'available' | 'missing' | 'unreadable' | 'unchecked';

export function getChannelBotFoundationReadiness(bot: ChannelBotFoundation, secretRef?: SecretRefMetadata, availability: SecretRefAvailability = 'unchecked'): ChannelBotFoundationReadiness {
  const blockers: ChannelBotFoundationReadiness['blockers'] = [];
  let credentialStatus: ChannelBotFoundationReadiness['credentialStatus'];
  if (!bot.credentialRef || !secretRef || secretRef.id !== bot.credentialRef) {
    credentialStatus = 'missing';
    blockers.push({ code: 'channel_bot_credential_required', message: 'A configured SecretRef is required' });
  } else if (secretRef.status !== 'configured') {
    credentialStatus = 'invalid';
    blockers.push({ code: 'channel_bot_credential_invalid', message: 'The referenced credential metadata is invalid' });
  } else if (availability === 'missing' || availability === 'unreadable') {
    credentialStatus = 'unreadable';
    blockers.push({ code: 'channel_bot_credential_unreadable', message: 'The referenced credential value is missing or unreadable' });
  } else {
    credentialStatus = 'configured';
  }
  blockers.push({ code: 'channel_bot_activation_unavailable', message: 'WP0 ChannelBots cannot activate a listener' });
  return { credentialStatus, listenerEligible: false, blockers };
}

export const publicChannelBotFoundationSchema = channelBotFoundationSchema.omit({ credentialRef: true }).extend({
  selectedSecretRefId: z.string().min(1).optional(),
  credentialStatus: z.enum(['missing', 'configured', 'invalid', 'unreadable']),
  blockerCodes: z.array(z.enum(channelBotBlockerCodes))
}).strict();
export type PublicChannelBotFoundation = z.infer<typeof publicChannelBotFoundationSchema>;

export function toPublicChannelBotFoundation(bot: ChannelBotFoundation, secretRef?: SecretRefMetadata, availability: SecretRefAvailability = 'unchecked'): PublicChannelBotFoundation {
  const readiness = getChannelBotFoundationReadiness(bot, secretRef, availability);
  return publicChannelBotFoundationSchema.parse({
    schemaVersion: bot.schemaVersion,
    id: bot.id,
    revision: bot.revision,
    channel: bot.channel,
    externalAppId: bot.externalAppId,
    displayName: bot.displayName,
    brand: bot.brand,
    selectedSecretRefId: bot.credentialRef,
    state: bot.state,
    desiredListenerState: bot.desiredListenerState,
    fullTrustConfirmed: bot.fullTrustConfirmed,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    credentialStatus: readiness.credentialStatus,
    blockerCodes: readiness.blockers.map(blocker => blocker.code)
  });
}

export interface ToolCallData {
  id: string;
  name: string;
  input?: unknown;
  output?: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
}

export interface PermissionRequestData {
  id: string;
  toolCallId?: string;
  /** Bounded, redacted facts supplied by the ACP tool call; never raw input. */
  operation?: { source: 'acp_tool_call'; cwd?: string; resource?: string; command?: string };
  title: string;
  options?: Array<{ id: string; label: string; kind?: string }>;
  status: 'pending' | 'approved' | 'rejected';
}

export interface ToolRiskPolicy {
  enabled: boolean;
  authorized: boolean;
  pattern: string;
  actorEmail?: string;
  reason?: string;
}

export interface AgentEvent<T = unknown> {
  taskId?: string;
  attemptId?: string;
  settlementId?: string;
  id: string;
  sessionId: string;
  sequence: number;
  type: EventType;
  timestamp: string;
  data: T;
  raw?: string;
}

export interface Session {
  id: string;
  agentId: string;
  state: SessionState;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: PermissionMode;
  source?: string;
  sourceId?: string;
  archivedAt?: string;
  protocol?: Exclude<Protocol, 'auto'>;
  runId: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  systemPrompt?: string;
  workspaceMode?: import('./workspace.js').WorkspaceMode;
  /** Canonical cwd requested before an optional managed worktree was allocated. */
  workspaceSourceCwd?: string;
  name?: string;
}

export interface StartSessionInput { agentId: string; cwd?: string; model?: string; reasoningEffort?: string; permissionMode?: PermissionMode; source?: string; sourceId?: string; workspaceMode?: import('./workspace.js').WorkspaceMode }
export interface SendInput { prompt: string }
export interface AgentCapabilities { protocol: Exclude<Protocol, 'auto'>; available: boolean; detail?: string; pause: boolean; resume: boolean }

export class RuntimeError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); this.name = 'RuntimeError'; }
}

export interface AgentRepository {
  list(): Promise<AgentConfig[]>;
  get(id: string): Promise<AgentConfig | undefined>;
  save(agent: AgentConfig): Promise<void>;
  delete(id: string): Promise<void>;
}
export interface SessionRepository {
  list(): Promise<Session[]>;
  get(id: string): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
}
export const installationOwnerTaskActor = 'installation_owner';
export interface TaskExecutionContext {
  /** Trusted channel actor captured at enqueue time; activated only when this task runs. */
  actorId?: string;
  /** 实际发送给 Agent 的 prompt；可能包含来源通道补充的上下文。 */
  agentPrompt: string;
  /** Metadata for the immutable Skill content already included in agentPrompt. */
  skillDeliveries?: SkillDeliveryMetadata[];
  riskPolicy?: ToolRiskPolicy;
  /** Original turn's output boundary; never exposed in public task responses. */
  recovery?: import('./driver.js').DriverTurnRecovery;
}
export interface SkillDeliveryMetadata {
  name: string;
  path: string;
  source: 'workspace' | 'user';
  digest: string;
  mode: 'prompt';
}
export interface TaskRecord {
  revision?: number;
  digestVersion?: 'v1' | 'legacy_unverifiable';
  currentAttemptId?: string;
  id: string;
  sessionId: string;
  prompt: string;
  status: string;
  executionContext?: TaskExecutionContext;
  createdAt: string;
  updatedAt: string;
  /** 中断操作者的通道身份（如飞书 open_id）；与任务发起人 executionContext.actorId 语义不同，仅在被中断时落库。 */
  interruptedByActor?: string;
  /** 内部队列排序序号，仅对 status=queued 有序排列，不向 PublicTaskRecord 暴露。 */
  queuePosition?: number;
}
export type PublicTaskRecord = Omit<TaskRecord, 'executionContext' | 'queuePosition'> & { skillDeliveries?: SkillDeliveryMetadata[] };
export interface TaskRepository {
  save(task: TaskRecord): Promise<void>;
  listBySession(sessionId: string): Promise<TaskRecord[]>;
  get?(id: string): Promise<TaskRecord | undefined>;
  create?(task: TaskRecord): Promise<boolean>;
  enqueue?(task: TaskRecord, position: 'front' | 'back'): Promise<{ task: TaskRecord; created: boolean }>;
  promoteQueued?(sessionId: string, taskId: string): Promise<TaskRecord | undefined>;
  listQueued?(sessionId: string): Promise<TaskRecord[]>;
}
export interface EventWindowOptions {
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
  direction?: 'forward' | 'backward';
}
export interface EventRepository {
  highWaterMark(sessionId: string): number;
  append(event: AgentEvent): Promise<void>;
  list(sessionId: string, afterSequence?: number): Promise<AgentEvent[]>;
  listRecent(sessionId: string, limit: number): Promise<AgentEvent[]>;
  /** 有硬上限的游标窗口；无论查询方向如何，结果均按 sequence 升序。 */
  listWindow(sessionId: string, options?: EventWindowOptions): Promise<AgentEvent[]>;
}
export interface ConfigRepository {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  compareAndSet?(key: string, expected: string | undefined, value: string): Promise<boolean>;
  list?(prefix: string): Promise<Array<{ key: string; value: string }>>;
}
export interface ChannelMapping { id: string; channel: string; externalId: string; sessionId: string; extra?: string | null; createdAt: string }
export interface ChannelMappingRepository {
  get(channel: string, externalId: string): Promise<ChannelMapping | undefined>;
  list(channel: string): Promise<ChannelMapping[]>;
  save(mapping: ChannelMapping): Promise<void>;
  compareAndSetExtra(id: string, expectedExtra: string | null | undefined, extra: string): Promise<boolean>;
}
export interface ArtifactRepository {
  ensureLocalProject(cwd: string): Promise<void>;
  saveToolCall(sessionId: string, data: ToolCallData): Promise<void>;
  savePermission(sessionId: string, data: PermissionRequestData): Promise<void>;
  saveError(sessionId: string, message: string, details?: unknown): Promise<void>;
}

export interface SecretRefRepository {
  list(): Promise<SecretRefMetadata[]>;
  get(id: string): Promise<SecretRefMetadata | undefined>;
  create(input: CreateSecretRefInput): Promise<SecretRefMetadata>;
  update(id: string, input: UpdateSecretRefInput): Promise<SecretRefMetadata>;
  remove(id: string, expectedRevision: number): Promise<SecretRefMetadata>;
}

export interface ChannelBotFoundationRepository {
  list(): Promise<ChannelBotFoundation[]>;
  get(id: string): Promise<ChannelBotFoundation | undefined>;
  create(input: CreateChannelBotInput): Promise<ChannelBotFoundation>;
  update(id: string, input: UpdateChannelBotInput): Promise<ChannelBotFoundation>;
  readiness(id: string): Promise<ChannelBotFoundationReadiness>;
}

/** Synchronous by design so better-sqlite3 can keep one transaction open. */
export interface FoundationTransactionContext {
  secretRefs: {
    get(id: string): SecretRefMetadata | undefined;
    create(input: CreateSecretRefInput): SecretRefMetadata;
    update(id: string, input: UpdateSecretRefInput): SecretRefMetadata;
    remove(id: string, expectedRevision: number): SecretRefMetadata;
  };
  channelBots: {
    get(id: string): ChannelBotFoundation | undefined;
    create(input: CreateChannelBotInput): ChannelBotFoundation;
    update(id: string, input: UpdateChannelBotInput): ChannelBotFoundation;
  };
}

export type FoundationEntityKind = 'secret_ref' | 'channel_bot';
export type FoundationRollbackResult =
  | { entityKind: FoundationEntityKind; entityId: string; action: 'restored'; revision: number }
  | { entityKind: FoundationEntityKind; entityId: string; action: 'deleted'; deletedRevision: number };

export interface FoundationRepository {
  transact<T>(work: (repositories: FoundationTransactionContext) => T): Promise<T>;
  rollbackLast(entityKind: FoundationEntityKind, entityId: string, expectedRevision: number): Promise<FoundationRollbackResult>;
}

export interface RepositoryBundle {
  collaboration: import('./collaboration.js').CollaborationRepository;
  ciWebhook: import('./ci-webhook.js').CiWebhookRepository;
  control: import('./database-control.js').DatabaseControl;
  execution: import('./task-execution.js').ExecutionRepository;
  agents: AgentRepository;
  sessions: SessionRepository;
  tasks: TaskRepository;
  events: EventRepository;
  config: ConfigRepository;
  channelMappings: ChannelMappingRepository;
  artifacts: ArtifactRepository;
  secretRefs: SecretRefRepository;
  channelBots: ChannelBotFoundationRepository;
  foundation: FoundationRepository;
  groupBindings: import('./group-policy.js').GroupBindingRepository;
  channelBotPolicies: import('./group-policy.js').ChannelBotGroupPolicyRepository;
  remoteChatFacts: import('./group-policy.js').RemoteChatFactRepository;
  remoteIdentityFacts: import('./group-policy.js').RemoteIdentityFactRepository;
  remoteFacts: import('./group-policy.js').RemoteFactRepository;
  roleAssignments: import('./group-policy.js').RoleAssignmentRepository;
  groupPolicy: import('./group-policy.js').GroupPolicyRepository;
  scheduleDefinitions: import('./schedule-foundation.js').ScheduleDefinitionRepository;
  scheduleGenerations: import('./schedule-foundation.js').ScheduleGenerationRepository;
  scheduleOccurrences: import('./schedule-foundation.js').ScheduleOccurrenceRepository;
  scheduleWatermarks: import('./schedule-foundation.js').ScheduleWatermarkRepository;
  scheduleLeases: import('./schedule-foundation.js').ScheduleLeaseRepository;
  archivedHammerIntegrations: import('./schedule-foundation.js').ArchivedHammerIntegrationRepository;
  close(): void;
}

export const now = () => new Date().toISOString();
export const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export * from './driver.js';
export * from './group-policy.js';
export * from './schedule-foundation.js';
export * from './workspace.js';
export * from './workspace-organization.js';
export * from './verification.js';

export * from './session-automation.js';
export * from './work-items.js';

export * from './permission-display.js';

export * from './database-control.js';

export * from './task-execution.js';

export * from './bot-configuration.js';
export * from './bot-configuration-scope.js';

export * from './driver-resources.js';

export * from './collaboration.js';
export * from './ci-webhook.js';

export * from './execution-recovery.js';

export * from './session-name.js';
