/** The public SDK has no dependency on Dutydeck's server, storage or private workspace packages. */
export const PLUGIN_API_VERSION = 1;
export interface PluginBindingContext {
  bindingId: string;
  revision: number;
  plugin: string;
  config: Readonly<Record<string, unknown>>;
  getSecret(key: string): Promise<string | undefined>;
}
export interface ScenarioMessage {
  messageId: string; chatId: string; threadId?: string; rootId?: string;
  senderKind: 'human' | 'bot'; senderAppId?: string; senderOpenId?: string;
  messageType: string; text: string; mentionsSelf: boolean; mentionsOther: boolean;
}
export interface ScenarioContextResult {
  items: Array<{ id: string; title: string; text: string; url?: string }>;
  missing: string[];
}
export interface ScenarioProvider {
  id: string;
  match?(input: { binding?: PluginBindingContext; message: ScenarioMessage; params: Readonly<Record<string, unknown>>; signal: AbortSignal }): { matched: boolean; dedupeKey?: string } | Promise<{ matched: boolean; dedupeKey?: string }>;
  context?(input: { binding?: PluginBindingContext; scope: { appId: string; chatId: string }; message: ScenarioMessage; params: Readonly<Record<string, unknown>>; maxChars: number; signal: AbortSignal }): Promise<ScenarioContextResult>;
  correlationKey?(input: { entries: Array<{ label: string; lines: string[] }> }): Record<string, string> | undefined;
}
export type PluginHookEvent = 'task.received' | 'task.beforeRun' | 'tool.beforeCall' | 'permission.request' | 'task.completed' | 'verification.completed' | 'delivery.completed' | 'notify';
export interface PluginHookInput {
  event: PluginHookEvent; plugin: string; eventId?: string; bindingRevision?: number;
  /** Host-resolved actor for events where the originating task/tool exposes one. */
  actor?: { kind: 'installation_owner'; id: 'installation_owner' } | { kind: 'channel'; id: string; appId: string } | { kind: 'unspecified' };
  botAppId?: string; chatId?: string; sessionId?: string; taskId?: string; attemptId?: string; cwd?: string; payload: Record<string, unknown>;
}
export interface PluginHookOutput { decision?: 'allow' | 'deny' | 'ask'; reason?: string; additionalContext?: string; updatedPrompt?: string }
export interface PluginApi {
  plugin: { name: string; version?: string; root: string; dataDir: string };
  /** Legacy installation configuration. New integrations use input.binding instead. */
  config: Readonly<Record<string, string>>;
  registerCiProvider(provider: CiProvider): void;
  registerResultTool(tool: PluginResultTool): void;
  registerQuery(query: PluginQuery): void;
  registerAction(action: PluginAction): void;
  registerScenarioProvider(provider: ScenarioProvider): void;
  registerHookHandler(event: PluginHookEvent, handler: (input: PluginHookInput) => PluginHookOutput | void | Promise<PluginHookOutput | void>, options?: { timeout?: number; matcher?: string }): void;
}
/** An identity helper for typed, self-contained provider entrypoints. */
export function definePlugin(register: (api: PluginApi) => void | Promise<void>) { return register; }

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** Deliberately small, serializable JSON Schema subset. Unknown keywords are rejected. */
export interface PluginToolSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, PluginToolSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: PluginToolSchema;
  enum?: Array<string | number | boolean>;
  minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number;
  minItems?: number; maxItems?: number;
}
export type PluginToolBinding = PluginBindingContext;
export interface PluginToolIdentity {
  sessionId: string; taskId: string; attemptId: string; runId: string;
  actor: { kind: 'installation_owner'; id: 'installation_owner' } | { kind: 'channel'; id: string; appId: string };
  channel: 'web' | 'lark'; botAppId?: string; chatId?: string; cwd: string; workspaceRoot: string;
}
export interface PluginToolContext {
  identity: Readonly<PluginToolIdentity>; binding: PluginToolBinding;
  signal: AbortSignal; actionId?: string;
}
interface ToolDefinition {
  name: string; description: string;
  /** Change whenever execution or reconciliation semantics become incompatible. */
  version: string;
  inputSchema: PluginToolSchema;
  /** Pure selector. Must return the exact resource on which execute operates. */
  resource(input: unknown, binding: PluginToolBinding): string;
}
export interface PluginQuery extends ToolDefinition {
  execute(input: unknown, context: PluginToolContext): Promise<JsonValue>;
}
export interface PluginAction extends ToolDefinition {
  execute(input: unknown, context: PluginToolContext & { actionId: string }): Promise<{ receipt: string }>;
  reconcile?(context: PluginToolContext & { original: Readonly<PluginToolAction>; actionId: string }): Promise<{ status: 'succeeded' | 'failed' | 'unknown'; receipt?: string }>;
}

export interface CiRepository { owner: string; name: string; slug: string }
export interface CiRun {
  id: number; name: string; attempt: number; headSha: string;
  status: 'queued' | 'running' | 'completed';
  result?: 'success' | 'failed' | 'cancelled' | 'skipped' | 'neutral';
  conclusion?: string; url: string;
}
export interface CiPipelineQuery { repository: CiRepository; sha: string; workflow?: string; completedOnly?: boolean }
export interface CiPipelineStatus { state: 'pending' | 'running' | 'success' | 'failed' | 'cancelled' | 'unknown'; runs: CiRun[] }
export interface CiFailureLog { job?: string; stage?: string; reason?: string; log?: string }
export interface CiPullRequestInput { title: string; body?: string; head: string; base: string; draft?: boolean }
export interface CiReviewComment {
  id: string; author?: string; body: string; path?: string; line?: number; url?: string; createdAt?: string;
  trusted?: boolean; isBot?: boolean; authorAssociation?: string;
}
export interface CiWebhookRequest { rawBody: Uint8Array; headers: Record<string, string | string[] | undefined>; query?: Record<string, string | undefined> }
export type CiWebhookVerification = boolean | { ok: true; signedAt?: number } | { ok: false; statusCode?: 400 | 401; code?: string; message?: string };
export interface CiWebhookEvent {
  kind: 'pipeline' | 'pull_request' | 'review' | 'other'; repository: string; branch?: string;
  pullRequest?: number; headSha?: string; state: string; runId?: string; url?: string; operator?: string;
  failures?: CiFailureLog[]; eventId?: string; occurredAt?: number; timeIsAdvisory?: boolean;
}
export interface CiProvider {
  id: string; displayName: string; changeRequestLabel?(number: number): string;
  matchRepository(remoteUrl: string): CiRepository | undefined;
  getPipelineStatus?(query: CiPipelineQuery): Promise<CiPipelineStatus>;
  getFailureLogs?(repository: CiRepository, runId: string): Promise<CiFailureLog[]>;
  createPullRequest?(repository: CiRepository, input: CiPullRequestInput): Promise<{ id: string; number: number; url: string }>;
  listReviewComments?(repository: CiRepository, pullRequest: number): Promise<CiReviewComment[]>;
  getPullRequest?(repository: CiRepository, pullRequest: number): Promise<{ state: 'open' | 'closed' | 'merged'; headSha?: string }>;
  postComment?(repository: CiRepository, pullRequest: number, body: string): Promise<{ id: string; url?: string }>;
  webhook?: {
    verify(request: CiWebhookRequest): CiWebhookVerification | Promise<CiWebhookVerification>;
    parse(request: CiWebhookRequest): CiWebhookEvent | undefined | Promise<CiWebhookEvent | undefined>;
  };
}

export interface PluginResultTool {
  name: string; description: string;
  inputSchema: { parse(input: unknown): unknown };
  execute(input: unknown, context: { invocationId: string; requester: Readonly<{ provider: string; tenant: string; subject: string }>; signal: AbortSignal }): Promise<{ files: Array<{ name: string; data: Uint8Array }> }>;
}

export interface PluginToolAction {
  id: string; plugin: string; tool: string; handlerVersion: string;
  bindingId: string; bindingRevision: number; scopeKey: string;
  original: PluginToolIdentity; input: JsonValue; inputDigest: string; resource: string;
  status: 'intent' | 'sending' | 'succeeded' | 'failed' | 'unknown' | 'suppressed'; revision: number; receipt?: string; error?: string;
  /** Host-owned lease used while reconciling an unknown external action. */
  reconcileLease?: { owner: string; expiresAt: number };
  /** Host-owned lease proving that the original execute call is no longer active. */
  executionLease?: { owner: string; expiresAt: number };
  createdAt: string; updatedAt: string;
}

export type PluginPermissionEffect = 'read' | 'write' | 'external_write';
export type PluginFilesystemPermission = 'workspace_read' | 'workspace_write' | 'plugin_data';
export interface PluginHostDeclaration { api: string; channels?: Array<'web' | 'lark' | 'cli' | 'mcp'> }
export type PluginDependencies = Readonly<Record<string, string>>;
export interface PluginPermissionsDeclaration {
  secrets?: string[];
  network?: string[];
  filesystem?: PluginFilesystemPermission[];
  effects?: PluginPermissionEffect[];
}

export type PluginWebSlotKind = 'settings' | 'command_palette' | 'task_panel' | 'result_card';
export type PluginWebSlotTarget =
  | { kind: 'command'; command: string }
  | { kind: 'tool'; tool: string };
export type PluginWebSlotElement =
  | { kind: 'text'; label?: string; text: string }
  | { kind: 'status'; label: string; tone?: 'neutral' | 'accent' | 'warning' | 'danger'; value: string }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'action'; label: string; target: PluginWebSlotTarget };
export interface PluginWebSlotDeclaration {
  id: string;
  slot: PluginWebSlotKind;
  title: string;
  description?: string;
  elements: PluginWebSlotElement[];
}
