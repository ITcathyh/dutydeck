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
/** hook 子进程从 stdin 读到的 JSON。 */
export interface PluginHookInput {
  event: PluginHookEvent;
  plugin: string;
  /** Host-generated immutable event identity; plugin input cannot override it. */
  eventId?: string;
  /** Binding revision used for this event when the event is binding-scoped. */
  bindingRevision?: number;
  /** Host-resolved actor for events where the originating task/tool exposes one. */
  actor?: { kind: 'installation_owner'; id: 'installation_owner' } | { kind: 'channel'; id: string; appId: string } | { kind: 'unspecified' };
  botAppId?: string;
  chatId?: string;
  sessionId?: string;
  taskId?: string;
  attemptId?: string;
  cwd?: string;
  payload: Record<string, unknown>;
}

/** hook exit 0 时 stdout 可选的 JSON；各字段在哪些事件生效见 server 的 hooks.ts。 */
export interface PluginHookOutput {
  decision?: 'allow' | 'deny' | 'ask';
  reason?: string;
  additionalContext?: string;
  updatedPrompt?: string;
}

export interface PluginApi {
  plugin: { name: string; version?: string; root: string; dataDir: string };
  /** Legacy installation configuration. New integrations use input.binding instead. */
  config: Readonly<Record<string, string>>;
  registerCiProvider(provider: CiProvider): void;
  registerResultTool(tool: PluginResultTool): void;
  registerQuery(query: PluginQuery | PluginChatQuery): void;
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
/** Authenticated inbound message; never a fabricated task or session. */
export interface PluginCommandIdentity {
  kind: 'command'; eventId: string;
  actor: { kind: 'channel'; id: string; appId: string };
  channel: 'lark'; botAppId: string; chatId: string; cwd: string; workspaceRoot: string;
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
  commandOutput?: never;
  execute(input: unknown, context: PluginToolContext): Promise<JsonValue>;
}
export interface PluginChatQuery extends ToolDefinition {
  /** Explicit consent to expose this query output in the originating chat. Private results must omit this. */
  commandOutput: 'chat';
  execute(input: unknown, context: Omit<PluginToolContext, 'identity'> & { identity: Readonly<PluginToolIdentity | PluginCommandIdentity> }): Promise<JsonValue>;
}
export interface PluginAction extends ToolDefinition {
  execute(input: unknown, context: PluginToolContext & { actionId: string }): Promise<{ receipt: string }>;
  reconcile?(context: PluginToolContext & { original: Readonly<PluginToolAction>; actionId: string }): Promise<{ status: 'succeeded' | 'failed' | 'unknown'; receipt?: string }>;
}

/** 提供方从远端地址解析出的仓库；slug 是平台上的完整路径，例如 `owner/repo` 或 `group/sub/repo`。 */
export interface CiRepository { owner: string; name: string; slug: string }

/** 一次构建（工作流运行、流水线）。id 在同一仓库内唯一；attempt 是同一 id 的重跑次数，从 1 开始。 */
export interface CiRun {
  id: number;
  name: string;
  attempt: number;
  headSha: string;
  status: 'queued' | 'running' | 'completed';
  /** 已完成时的归一化结果；`failed` 用于「出现新的失败构建」判断。 */
  result?: 'success' | 'failed' | 'cancelled' | 'skipped' | 'neutral';
  /** 平台原始结论，只用于展示。 */
  conclusion?: string;
  url: string;
}

export interface CiPipelineQuery {
  repository: CiRepository;
  sha: string;
  /** 平台上的工作流名、文件名或 ID；不传表示这个提交上的全部构建。 */
  workflow?: string;
  /** 只返回已完成的构建。 */
  completedOnly?: boolean;
}

export interface CiPipelineStatus {
  /** 汇总状态：有未完成的为 running，全部完成且有失败为 failed，全部成功为 success，没有构建为 unknown。 */
  state: 'pending' | 'running' | 'success' | 'failed' | 'cancelled' | 'unknown';
  runs: CiRun[];
}
export interface CiFailureLog { job?: string; stage?: string; reason?: string; log?: string }
export interface CiPullRequestInput { title: string; body?: string; head: string; base: string; draft?: boolean }
export interface CiReviewComment {
  id: string; author?: string; body: string; path?: string; line?: number; url?: string; createdAt?: string;
  /** 作者是仓库所有者、成员或协作者，且不是机器人；由 provider 判定。不是 true 的评论不会被自动交给 Agent 修改，只发卡片问人。 */
  trusted?: boolean;
  /** 作者是机器人账号（例如覆盖率、依赖更新机器人）。 */
  isBot?: boolean;
  /** 平台给出的作者与仓库的关系（例如 GitHub 的 OWNER、MEMBER、COLLABORATOR、CONTRIBUTOR、NONE），卡片上展示用。 */
  authorAssociation?: string;
}
export interface CiWebhookRequest { rawBody: Uint8Array; headers: Record<string, string | string[] | undefined>; query?: Record<string, string | undefined> }
/** `signedAt`：签名覆盖的时间（毫秒），宿主据此做 5 分钟重放窗口。失败默认 401。 */
export type CiWebhookVerification = boolean | { ok: true; signedAt?: number } | { ok: false; statusCode?: 400 | 401; code?: string; message?: string };
export interface CiWebhookEvent {
  /** pipeline：构建结果；pull_request：合并请求的打开、更新、合入、关闭；review 留给 PR 闭环。 */
  kind: 'pipeline' | 'pull_request' | 'review' | 'other';
  /** 与 matchRepository 返回的 slug 同一写法。 */
  repository: string;
  branch?: string;
  /** 合并请求编号（PR number、MR iid）。 */
  pullRequest?: number;
  headSha?: string;
  /** pipeline：success、failed（其余值宿主忽略）；pull_request：open、reopen、update、merge、close。 */
  state: string;
  runId?: string;
  url?: string;
  /** 事件里的操作人只做记录，任务身份不随它切换。 */
  operator?: string;
  failures?: CiFailureLog[];
  /** 用于去重；不给时宿主按请求体哈希去重。 */
  eventId?: string;
  /** 事件发生时间（毫秒）；给了就做 5 分钟重放窗口检查（`timeIsAdvisory` 除外）。 */
  occurredAt?: number;
  /** 事件时间不是投递时间（例如 GitHub 的 updated_at，排队、停机后重投会很旧）：只用来排序，不做重放窗口检查，重放靠 eventId 去重。 */
  timeIsAdvisory?: boolean;
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

/** Optional reference text, never included in required skillResources or task snapshots. */
export interface PluginToolManual { description: string; path: string; maxBytes: number }
/** Manifest toolManuals: tool name -> logical manual ID -> bounded package text. */
export type PluginToolManuals = Record<string, Record<string, PluginToolManual>>;
