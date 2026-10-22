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
export type PluginHookEvent = 'task.received' | 'task.beforeRun' | 'permission.request' | 'task.completed' | 'verification.completed' | 'notify';
export interface PluginHookInput {
  event: PluginHookEvent; plugin: string; botAppId?: string; chatId?: string; sessionId?: string; taskId?: string; cwd?: string; payload: Record<string, unknown>;
}
export interface PluginHookOutput { decision?: 'allow' | 'deny' | 'ask'; reason?: string; additionalContext?: string; updatedPrompt?: string }
export interface PluginApi {
  plugin: { name: string; version?: string; root: string; dataDir: string };
  /** Legacy installation configuration. New integrations use input.binding instead. */
  config: Readonly<Record<string, string>>;
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

export interface PluginToolAction {
  id: string; plugin: string; tool: string; handlerVersion: string;
  bindingId: string; bindingRevision: number; scopeKey: string;
  original: PluginToolIdentity; input: JsonValue; inputDigest: string; resource: string;
  status: 'intent' | 'sending' | 'succeeded' | 'failed' | 'unknown' | 'suppressed'; revision: number; receipt?: string; error?: string;
  createdAt: string; updatedAt: string;
}
