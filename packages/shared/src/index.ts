import { z } from 'zod';
import safeRegex from 'safe-regex2';

export const highRiskPatternMaxLength = 4_096;
export type RegexPatternValidation = { valid: true } | { valid: false; error: string };

export function validateHighRiskPattern(pattern: string): RegexPatternValidation {
  if (!pattern.trim()) return { valid: false, error: '请输入高危操作正则表达式' };
  if (pattern.length > highRiskPatternMaxLength) return { valid: false, error: `正则表达式不能超过 ${highRiskPatternMaxLength} 个字符` };
  try { new RegExp(pattern, 'i'); }
  catch (error) { return { valid: false, error: `正则表达式语法错误：${error instanceof Error ? error.message : String(error)}` }; }
  if (!safeRegex(pattern)) return { valid: false, error: '正则表达式可能造成灾难性回溯，请移除嵌套量词或拆分复杂表达式' };
  return { valid: true };
}

export const protocols = ['auto', 'acp', 'jsonl', 'pipe', 'pty'] as const;
export type Protocol = (typeof protocols)[number];
export const permissionModes = ['ask', 'approve-reads', 'deny-all', 'full-trust'] as const;
export type PermissionMode = (typeof permissionModes)[number];
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
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  version: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string()).default({}),
  systemPrompt: z.string().optional(),
  permissionMode: z.enum(permissionModes).default('full-trust'),
  timeout: z.number().positive().default(600),
  capabilities: z.object({ pause: z.boolean().default(false), resume: z.boolean().default(true) }).default({ pause: false, resume: true }),
  builtin: z.boolean().default(false)
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

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
}

export interface StartSessionInput { agentId: string; cwd?: string; model?: string; reasoningEffort?: string; permissionMode?: PermissionMode; source?: string; sourceId?: string }
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
export interface TaskRecord { id: string; sessionId: string; prompt: string; status: string; createdAt: string; updatedAt: string }
export interface TaskRepository { save(task: TaskRecord): Promise<void>; listBySession(sessionId: string): Promise<TaskRecord[]> }
export interface EventRepository { append(event: AgentEvent): Promise<void>; list(sessionId: string, afterSequence?: number): Promise<AgentEvent[]>; listRecent(sessionId: string, limit: number): Promise<AgentEvent[]> }
export interface ConfigRepository { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }
export interface ChannelMapping { id: string; channel: string; externalId: string; sessionId: string; extra?: string | null; createdAt: string }
export interface ChannelMappingRepository {
  get(channel: string, externalId: string): Promise<ChannelMapping | undefined>;
  list(channel: string): Promise<ChannelMapping[]>;
  save(mapping: ChannelMapping): Promise<void>;
}
export interface ArtifactRepository {
  ensureLocalProject(cwd: string): Promise<void>;
  saveToolCall(sessionId: string, data: ToolCallData): Promise<void>;
  savePermission(sessionId: string, data: PermissionRequestData): Promise<void>;
  saveError(sessionId: string, message: string, details?: unknown): Promise<void>;
}

export interface RepositoryBundle {
  agents: AgentRepository;
  sessions: SessionRepository;
  tasks: TaskRepository;
  events: EventRepository;
  config: ConfigRepository;
  channelMappings: ChannelMappingRepository;
  artifacts: ArtifactRepository;
  close(): void;
}

export const now = () => new Date().toISOString();
export const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export * from './driver.js';
