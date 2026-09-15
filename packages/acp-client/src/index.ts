import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertNativeContextRecord, createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpPermissionDecision, type AcpRuntime, type AcpRuntimeResourceScope, type AcpRuntimeHandle, type AcpRuntimeProcessEvent, type AcpRuntimeTurn, type AcpSessionStore } from 'acpx/runtime';
import type { AgentConfig, AgentDriver, NormalizedDriverEvent, PermissionMode, ToolRiskPolicy, DriverSubmission, DriverSubmissionInput, NativeContextIdentity, NativeContextExpected, NativeConfigurationRequest, NativeConfigurationProof, OperationPermit, ChildPermit } from '@dutydeck/shared';
import { permissionDisplayText, taskExecutionSchemas, canonicalExecutionJson } from '@dutydeck/shared';
import { testRegexWithTimeout } from './regex-timeout.js';

// 归一化事件类型统一从 @dutydeck/shared re-export，保证 ACP driver 与 PTY driver 用同一类型。
export type { NormalizedDriverEvent };
export interface AcpxBuiltinAgent { id: string; argv: string[] }

function claudeLauncherPath() {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const adjacent = join(moduleDirectory, 'agents', 'claude-acp.mjs');
  return existsSync(adjacent) ? adjacent : join(moduleDirectory, '..', 'agents', 'claude-acp.mjs');
}

function envLauncherPath() {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const adjacent = join(moduleDirectory, 'agents', 'env-launcher.mjs');
  return existsSync(adjacent) ? adjacent : join(moduleDirectory, '..', 'agents', 'env-launcher.mjs');
}

const persistedEnvKey = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const bridgedAgentEnvFileKey = 'dutydeck_agent_env_file';
const bridgedAgentEnvDigestKey = 'dutydeck_agent_env_digest';

function splitAgentEnvironment(env: Record<string, string>) {
  const persisted: Record<string, string> = {};
  const bridged: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (persistedEnvKey.test(key)) persisted[key] = value;
    else bridged[key] = value;
  }
  return { persisted, bridged };
}

export function acpxPermissionMode(permissionMode: PermissionMode) {
  return permissionMode === 'full-trust' ? 'approve-all' as const
    : permissionMode === 'approve-reads' ? 'approve-reads' as const
      : 'deny-all' as const;
}

export interface AcpxAgentLaunch {
  command: string[];
  sessionOptions: ReturnType<typeof buildAcpxSessionOptions>;
  cleanup(): void;
}

/** Prepare the ACPX boundary without persisting vendor env names or values. */
export function prepareAcpxAgentLaunch(agent: AgentConfig, options: { runtimeDirectory: string; sessionKey: string }): AcpxAgentLaunch {
  const { persisted, bridged } = splitAgentEnvironment(agent.env);
  const entries = Object.entries(bridged);
  if (entries.length === 0) {
    return { command: [agent.command, ...agent.args], sessionOptions: buildAcpxSessionOptions(agent), cleanup() {} };
  }

  mkdirSync(options.runtimeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(options.runtimeDirectory, 0o700);
  const identity = createHash('sha256').update(options.sessionKey).digest('hex');
  const payload = JSON.stringify(bridged);
  const environmentFile = join(options.runtimeDirectory, `${identity}.json`);
  writeFileSync(environmentFile, payload, { encoding: 'utf8', mode: 0o600 });
  chmodSync(environmentFile, 0o600);
  return {
    command: [process.execPath, envLauncherPath(), agent.command, ...agent.args],
    sessionOptions: {
      ...buildAcpxSessionOptions(agent),
      env: {
        ...persisted,
        [bridgedAgentEnvFileKey]: environmentFile,
        [bridgedAgentEnvDigestKey]: createHash('sha256').update(payload).digest('hex')
      }
    },
    cleanup() { rmSync(environmentFile, { force: true }); }
  };
}

const flattenRiskText = (value: unknown, output: string[] = []): string[] => {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) flattenRiskText(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) flattenRiskText(item, output);
  return output;
};
export function listAcpxBuiltinAgents(): AcpxBuiltinAgent[] {
  const registry = createAgentRegistry();
  return registry.list().map(id => {
    const command = registry.resolve(id);
    if (id === 'claude') return { id, argv: [process.execPath, claudeLauncherPath()] };
    return { id, argv: typeof command === 'string' ? [command] : [...command] };
  });
}
const statusMap: Record<string, 'pending' | 'running' | 'completed' | 'failed'> = { pending: 'pending', in_progress: 'running', running: 'running', completed: 'completed', failed: 'failed' };

// claude-agent-acp 在上下文压缩时把进度横幅伪装成 agent_message_chunk 文本（"Compacting..." /
// "\n\nCompacting completed." / "\n\nCompacting failed: ..."）。这些不是 Agent 的回复内容，
// 归一化为 status 事件——Web 时间线与飞书卡片均跳过 status，避免把压缩进度渲染成一条消息。
const compactionPhase = (text: unknown): 'start' | 'completed' | 'failed' | undefined => {
  if (typeof text !== 'string') return undefined;
  if (text === 'Compacting...') return 'start';
  if (text === '\n\nCompacting completed.') return 'completed';
  if (text.startsWith('\n\nCompacting failed')) return 'failed';
  return undefined;
};

export function normalizeAcpxEvent(input: unknown): NormalizedDriverEvent | undefined {
  if (typeof input === 'string') { try { return normalizeAcpxEvent(JSON.parse(input)); } catch { return { type: 'raw_terminal', data: { text: input }, raw: input }; } }
  if (!input || typeof input !== 'object') return;
  const event = input as Record<string, any>; const update = event.params?.update ?? event.update ?? event.data?.update ?? event; const kind = update.sessionUpdate ?? event.tag ?? event.type;
  if (kind === 'text_delta') return { type: event.stream === 'thought' ? 'thinking' : 'text', data: { text: event.text ?? '' } };
  if (kind === 'agent_message_chunk') {
    const text = update.content?.text ?? event.text ?? event.message ?? '';
    const phase = compactionPhase(text);
    if (phase) return { type: 'status', data: { state: 'compaction', phase, ...(phase === 'failed' ? { detail: String(text).slice('\n\nCompacting failed'.length).replace(/^[:\s]+/, '').trim() || undefined } : {}) } };
    return { type: 'text', data: { text } };
  }
  if (kind === 'text') return { type: 'text', data: { text: update.content?.text ?? event.text ?? event.message ?? '' } };
  if (kind === 'agent_thought_chunk' || kind === 'thinking') return { type: 'thinking', data: { text: update.content?.text ?? event.text ?? '' } };
  if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'tool_result') { const complete = statusMap[update.status] ?? (kind === 'tool_result' ? 'completed' : 'running'); return { type: complete === 'completed' || complete === 'failed' ? 'tool_result' : 'tool_call', data: { id: update.toolCallId ?? event.toolCallId ?? event.id, name: update.title ?? event.title ?? event.name ?? 'tool', input: update.rawInput ?? event.rawInput ?? event.input, output: update.rawOutput ?? event.rawOutput ?? event.output, status: complete } }; }
  if (kind === 'permission_request' || kind === 'permission_escalation') return { type: 'permission_request', data: { id: event.requestId ?? event.id ?? update.toolCallId, toolCallId: update.toolCallId, ...permissionFacts({ ...update, title: update.title ?? event.toolTitle }), options: update.options ?? [], status: 'pending' } };
  if (kind === 'usage_update') return { type: 'status', data: { state: 'usage', used: event.used, size: event.size, breakdown: event.breakdown, cost: event.cost } };
  if (kind === 'available_commands_update') return { type: 'status', data: { state: 'commands', availableCommands: event.availableCommands ?? update.availableCommands ?? [] } };
  if (kind === 'error') return { type: 'error', data: { message: event.message ?? event.error?.message ?? 'Agent error', detail: event } };
  if (kind === 'done' || kind === 'completed' || kind === 'result' || event.result?.stopReason) return { type: 'completed', data: { stopReason: event.stopReason ?? event.result?.stopReason ?? 'end_turn' } };
  if (kind === 'status') return { type: 'status', data: { state: event.text ?? event.state ?? 'running', ...event } };
  return { type: 'raw_terminal', data: { text: JSON.stringify(input) }, raw: JSON.stringify(input) };
}

function permissionFacts(tool: any, secrets: string[] = []) {
  const input = tool?.rawInput ?? tool?.input;
  const fields = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const clean = (value: unknown) => permissionDisplayText(value, secrets);
  const cwd = clean(fields.cwd ?? fields.workdir ?? fields.working_directory);
  const resource = clean(fields.path ?? fields.file_path ?? fields.url ?? tool?.locations?.[0]?.path);
  const command = clean(fields.command ?? fields.cmd);
  return {
    title: clean(fields.description) || clean(tool?.title) || 'Agent 请求执行受控操作',
    ...(cwd || resource || command ? { operation: { source: 'acp_tool_call' as const, ...(cwd ? { cwd } : {}), ...(resource ? { resource } : {}), ...(command ? { command } : {}) } } : {})
  };
}

function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
export function renderAgentCommand(agent: AgentConfig) { return [agent.command, ...agent.args].map(shellQuote).join(' '); }
export function buildAcpxSessionOptions(agent: AgentConfig) {
  return {
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}),
    // ACPX recursively validates persisted object keys. Keep native lowercase
    // runtime variables direct, and bridge vendor-style uppercase variables
    // through one snake_case string that the process launcher expands.
    env: splitAgentEnvironment(agent.env).persisted
  };
}

export interface AcpxAdapterOptions { context?: import('@dutydeck/shared').DriverContext; resolveRiskPolicy?: (fallback?: ToolRiskPolicy) => Promise<ToolRiskPolicy | undefined>; sessionKey?: string; onEvent(event: NormalizedDriverEvent): void; onExit?(code: number | null, signal: NodeJS.Signals | null): void }
type SessionAgentConfig = AgentConfig & { reasoningEffort?: string };

export class AgentIdleTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Agent 连续 ${Math.ceil(timeoutMs / 1_000)} 秒无任何活动，已取消本轮任务`);
    this.name = 'AgentIdleTimeoutError';
  }
}

class AcpxStoppedError extends Error {
  constructor() { super('ACP adapter is stopped'); this.name = 'AcpxStoppedError'; }
}

/** Read the first durable creation receipt without creating or connecting a client. */
export async function readNativeCreationRecord(expected: NativeContextExpected): Promise<NativeContextIdentity | undefined> {
  const store=createRuntimeStore({stateDir:join(expected.cwd,'.dutydeck','acpx')});
  const record=await store.load(expected.sessionKey);if(!record)return;
  const raw=record.acpx?.dutydeck_native_identity;if(!raw)return;
  const identity=taskExecutionSchemas.nativeIdentitySchema.parse(JSON.parse(raw));
  const {acpxRecordId,backendSessionId,agentSessionId,defaults,...saved}=identity;
  if(canonicalExecutionJson(saved)!==canonicalExecutionJson(expected))throw new Error('NATIVE_CONTEXT_IDENTITY_CONFLICT');
  assertNativeContextRecord(record,identity);
  return identity;
}
export class AcpxAdapter implements AgentDriver {
  private readonly runtime: AcpRuntime;
  private readonly sessionStore: AcpSessionStore;
  private handle?: AcpRuntimeHandle;
  private turn?: AcpRuntimeTurn;
  private readonly pendingPermissions = new Map<string, (decision: AcpPermissionDecision) => void>();
  private readonly sessionKey: string;
  private riskPolicy?: ToolRiskPolicy;
  private permissionMode: PermissionMode;
  private readonly launch: AcpxAgentLaunch;
  // An adapter owns one lifetime. interrupt/resume retain it; stop revokes it.
  private stopped = false;
  private readonly revocation = new AbortController();
  private stopping?: Promise<void>;
  private resourceTail: Promise<unknown> = Promise.resolve();
  private readonly resourceOperations = new Set<Promise<unknown>>();
  private readonly handles = new Set<AcpRuntimeHandle>();
  private readonly streams = new Set<Promise<void>>();
  private sending = false;
  private timedOutStream?: Promise<void>;
  private stopResourcesSettled = false;
  private readonly processes = new Map<ChildProcess, () => void>();
  private nativeIdentity?: NativeContextIdentity;
  private currentConfiguration?: {model?: string; reasoningEffort?: string};
  get resourceCapabilities() {const strict=this.options.context?.protocol==='controlled-v1';return {observe:true,originalObjectStop:true,identityBoundStop:false,nativeContextRestore:strict,activeTurnAttach:false,configurationAck:strict,creationDefaults:strict};}
  private readonly sdkCreations = new Map<object, { promise: Promise<void>; resolve(): void }>();

  constructor(readonly agent: SessionAgentConfig, private readonly options: AcpxAdapterOptions) {
    const cwd = agent.cwd ?? process.cwd(); this.sessionKey = options.context?.native?.sessionKey ?? options.sessionKey ?? `dutydeck-${agent.id}`;
    this.permissionMode = agent.permissionMode;
    this.sessionStore = createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') });
    this.launch = prepareAcpxAgentLaunch(agent, { runtimeDirectory: join(cwd, '.dutydeck', 'runtime-env'), sessionKey: this.sessionKey });
    this.runtime = createAcpRuntime({
      cwd,
      onProcess: event => this.observeProcess(event),
      sessionStore: this.sessionStore,
      agentRegistry: createAgentRegistry({ overrides: { [agent.id]: this.launch.command } }),
      // `ask` must not silently auto-approve direct read capabilities. ACP
      // permission requests still flow through onPermissionRequest below;
      // capabilities the host cannot intercept fail closed.
      permissionMode: acpxPermissionMode(agent.permissionMode),
      nonInteractivePermissions: 'fail', timeoutMs: agent.timeout * 1000,
      onPermissionRequest: async request => {
        if (this.stopped) return { outcome: 'reject_once' };
        const raw = request.raw as any; const id = raw.toolCall?.toolCallId ?? `permission-${Date.now()}`;
        const secrets = Object.entries({ ...process.env, ...this.agent.env }).filter(([key]) => /token|secret|password|api[_-]?key|authorization|cookie/i.test(key)).map(([, value]) => value).filter((value): value is string => Boolean(value));
        const facts = permissionFacts(raw.toolCall, secrets);
        const candidate = flattenRiskText({ title: raw.toolCall?.title, input: raw.toolCall?.rawInput ?? raw.toolCall?.input ?? raw }).join('\n');
        let riskPolicy = this.riskPolicy;
        if (this.options.resolveRiskPolicy) {
          try { riskPolicy = await this.whileActive(() => this.options.resolveRiskPolicy!(riskPolicy)); }
          catch { return { outcome: 'reject_once' }; }
        }
        if (this.stopped) return { outcome: 'reject_once' };
        if (riskPolicy?.enabled && !riskPolicy.authorized) {
          try {
            const matches = await this.whileActive(() => testRegexWithTimeout(riskPolicy!.pattern, candidate));
            if (this.stopped) return { outcome: 'reject_once' };
            if (matches) {
              this.options.onEvent({ type: 'permission_request', data: { id, toolCallId: raw.toolCall?.toolCallId, title: `高危操作已被 Dutydeck 拦截：${facts.title}`, options: [], status: 'rejected' } });
              return { outcome: 'reject_once' };
            }
          } catch (error) {
            if (this.stopped) return { outcome: 'reject_once' };
            this.options.onEvent({ type: 'permission_request', data: { id, toolCallId: raw.toolCall?.toolCallId, title: `安全正则匹配异常，已拒绝操作：${error instanceof Error ? error.message : String(error)}`, options: [], status: 'rejected' } });
            return { outcome: 'reject_once' };
          }
        }
        if (this.permissionMode === 'full-trust') return { outcome: 'allow_once' };
        if (this.permissionMode === 'deny-all') return { outcome: 'reject_once' };
        if (this.permissionMode === 'approve-reads' && /read|search|fetch/i.test(String(request.inferredKind ?? ''))) return { outcome: 'allow_once' };
        return new Promise<AcpPermissionDecision>(resolve => {
          this.pendingPermissions.set(id, resolve);
          try {
            this.options.onEvent({ type: 'permission_request', data: { id, toolCallId: raw.toolCall?.toolCallId, ...facts, options: (raw.options ?? []).map((option: any) => ({ id: option.optionId, label: permissionDisplayText(option.name, secrets, 100), kind: option.kind })), status: 'pending' } });
          } catch {
            this.pendingPermissions.delete(id);
            resolve({ outcome: 'reject_once' });
          }
        });
      }
    });
  }

  private observeProcess(event: AcpRuntimeProcessEvent) {
    if (event.phase === 'creation-started') {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      this.sdkCreations.set(event.creation, { promise, resolve });
      return;
    }
    if (event.phase === 'creation-finished') {
      this.sdkCreations.get(event.creation)?.resolve();
      this.sdkCreations.delete(event.creation);
      return;
    }
    const child = event.child;
    if (this.processes.has(child) || child.exitCode != null || child.signalCode != null) return;
    const exited = () => {
      this.processes.delete(child);
      child.off('exit', exited); child.off('error', failed);
    };
    const failed = () => { if (child.pid == null) exited(); };
    this.processes.set(child, exited);
    child.once('exit', exited); child.on('error', failed);
  }
  async isStopped(): Promise<boolean> {
    // Only SDK-direct agent/probe and host-terminal children are covered. This
    // does not establish containment of arbitrary detached agent descendants.
    for (const [child, exited] of this.processes) if (child.exitCode != null || child.signalCode != null) exited();
    return this.stopped && this.stopResourcesSettled && this.resourceOperations.size === 0 && this.streams.size === 0 && this.sdkCreations.size === 0 && this.processes.size === 0;
  }
  private assertActive() { if (this.stopped) throw new AcpxStoppedError(); }
  private async whileActive<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    let onStop!: () => void;
    const revoked = new Promise<never>((_resolve, reject) => {
      onStop = () => reject(new AcpxStoppedError());
      this.revocation.signal.addEventListener('abort', onStop, { once: true });
    });
    try { return await Promise.race([operation(), revoked]); }
    finally { this.revocation.signal.removeEventListener('abort', onStop); }
  }
  private resourceOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new AcpxStoppedError());
    const pending = this.resourceTail.then(() => { this.assertActive(); return operation(); });
    this.resourceOperations.add(pending);
    this.resourceTail = pending.then(() => { this.resourceOperations.delete(pending); }, () => { this.resourceOperations.delete(pending); });
    return pending;
  }
  private sessionInput() { return { sessionKey: this.sessionKey, agent: this.agent.id, mode: 'persistent' as const, cwd: this.agent.cwd, sessionOptions: this.launch.sessionOptions }; }
  private async resetPersistentState(discardOnStop = false) {
    const record = await this.sessionStore.load(this.sessionKey);
    if (!discardOnStop) this.assertActive();
    if (!record) return;
    record.acpx = { ...record.acpx, reset_on_next_ensure: true };
    await this.sessionStore.save(record);
  }
  private async resetWhenScopedEnvironmentChanged() {
    const desired = this.launch.sessionOptions.env ?? {};
    const scopedKeys = [
      'dutydeck_group_tools_url', 'dutydeck_group_tools_token',
      'dutydeck_relay_url', 'dutydeck_relay_token', 'dutydeck_relay_command',
      bridgedAgentEnvDigestKey
    ] as const;
    const record = await this.sessionStore.load(this.sessionKey);
    this.assertActive();
    if (!record) return;
    const stored = record.acpx?.session_options?.env ?? {};
    if (scopedKeys.every(key => stored[key] === desired[key])) return;
    record.acpx = { ...record.acpx, reset_on_next_ensure: true };
    await this.sessionStore.save(record);
  }
  private async applyReasoningEffort() {
    if (!this.handle || !this.agent.reasoningEffort) return;
    const status = await this.runtime.getStatus?.({ handle: this.handle });
    this.assertActive();
    const options = Array.isArray(status?.details?.configOptions) ? status.details.configOptions as Array<Record<string, any>> : [];
    const reasoning = options.find(option => option.category === 'thought_level' || option.id === 'reasoning_effort' || option.id === 'effort');
    if (!reasoning || typeof reasoning.id !== 'string') throw new Error(`Agent ${this.agent.id} does not support reasoning effort configuration`);
    const allowed = Array.isArray(reasoning.options) ? reasoning.options.some((option: any) => option?.value === this.agent.reasoningEffort) : true;
    if (!allowed) throw new Error(`Reasoning effort ${this.agent.reasoningEffort} is not supported by model ${this.agent.model ?? '(default)'}`);
    await this.runtime.setConfigOption?.({ handle: this.handle, key: reasoning.id, value: this.agent.reasoningEffort });
  }
  private scope(operation: OperationPermit): AcpRuntimeResourceScope {
    const context=this.options.context!;
    const permits=new Map<object,ChildPermit>();
    return {
      begin:()=>this.scope(context.resources.beginOperation(operation)),
      cleanup:()=>this.scope(context.resources.beginCleanup()),
      beforeSpawn:()=>{ const permit=context.resources.beforeCreate(operation,'process'); context.resources.assertCreation(permit); const token=Object.freeze({});permits.set(token,permit);return token; },
      spawned:(token,child)=>{ const permit=permits.get(token);if(!permit)throw new Error('RESOURCE_PERMIT_INVALID');this.observeProcess({phase:'spawned',kind:'agent',child});context.resources.spawned(permit,child); },
      notCreated:token=>{const permit=permits.get(token);if(!permit)throw new Error('RESOURCE_PERMIT_INVALID');context.resources.creationFinished(permit,'not_created');},
      finish:()=>context.resources.creationFinished(operation,'created')
    };
  }
  prepareSubmission(input: DriverSubmissionInput) {
    this.assertActive();
    if(!this.options.context||!this.nativeIdentity)throw new Error('NATIVE_CONTEXT_PROOF_REQUIRED');
    return this.options.context.prepareSubmission(input);
  }
  nativeConfiguration() { return this.currentConfiguration ? {...this.currentConfiguration} : {}; }
  async configureNative(request:NativeConfigurationRequest):Promise<NativeConfigurationProof> {
    return this.resourceOperation(async()=>{
      this.assertActive();
      const native=this.nativeIdentity,context=this.options.context;
      if(!native||!context||!this.handle||!this.runtime.setStrictConfigOption)throw new Error('NATIVE_CONTEXT_PROOF_REQUIRED');
      const evidence: Array<{configId:string;value:string}>=[];
      const target={model:request.target.model??native.defaults.model,reasoningEffort:request.target.reasoningEffort??native.defaults.reasoningEffort};
      for(const key of ['model','reasoningEffort'] as const) {
        const value=target[key];
        if(value===undefined) {if(this.currentConfiguration?.[key]!==undefined)throw new Error('NATIVE_DEFAULT_UNVERIFIABLE');continue;}
        if(value===this.currentConfiguration?.[key]){evidence.push({configId:key,value});continue;}
        const previous=this.currentConfiguration;this.currentConfiguration=undefined;
        const result=await this.runtime.setStrictConfigOption({handle:this.handle,key:key==='model'?'model':'reasoning_effort',value});
        this.assertActive();this.currentConfiguration={...previous,[key]:value};evidence.push({configId:result.configId,value:result.value});
      }
      this.currentConfiguration={...target};
      const prepared=context.prepareSubmission({taskId:'configuration',attemptId:'configuration',submissionId:request.operationId,prompt:'',executionOptions:{permissionMode:this.permissionMode}});
      if(!prepared.nativeContextRef)throw new Error('NATIVE_CONTEXT_PROOF_REQUIRED');
      return {context:prepared.nativeContextRef,driverInstanceId:context.driverInstanceId,operationId:request.operationId,target:request.target,evidence};
    });
  }
  private async ensureHandle() {
    this.assertActive();
    if (this.handle) return this.handle;
    const context=this.options.context;
    let handle:AcpRuntimeHandle;
    if(context?.protocol==='controlled-v1') {
      const native=context.native;
      if(!native||!this.runtime.createStrictSession||!this.runtime.restoreStrictSession)throw new Error('NATIVE_CONTEXT_PROTOCOL_UNSUPPORTED');
      const onPrepared=(identity:NativeContextIdentity,configuration:{model?:string;reasoningEffort?:string})=>{this.assertActive();native.confirmed(identity);this.nativeIdentity=identity;this.currentConfiguration={...configuration};};
      const input={...this.sessionInput(),resourceScope:this.scope(context.rootOperation),onPrepared};
      if(native.expected)handle=await this.runtime.restoreStrictSession({...input,expected:native.expected});
      else {
        const creation={nativeCreationId:crypto.randomUUID(),sessionKey:this.sessionKey,agent:this.agent.id,command:this.launch.command,cwd:this.agent.cwd??process.cwd(),executionDomain:context.executionDomain};
        native.reserve(creation);handle=await this.runtime.createStrictSession({...input,creation});
      }
    } else {
      await this.resetWhenScopedEnvironmentChanged();this.assertActive();
      handle=await this.runtime.ensureSession(this.sessionInput());
    }
    // Even a revoked creation belongs to this instance until stop closes it.
    this.handles.add(handle);
    this.assertActive();
    this.handle = handle;
    if(context?.protocol!=='controlled-v1')await this.applyReasoningEffort();
    this.assertActive();
    return handle;
  }
  async start() { await this.resourceOperation(async () => { await this.ensureHandle(); }); }
  private async sendTurn(prompt: string, submission?:DriverSubmission) {
    const { completion } = await this.resourceOperation(async () => {
      const handle = await this.ensureHandle();
      this.assertActive();
      if (this.turn) throw new Error('ACP turn already in progress');
      if(submission)this.options.context!.assertSubmission(submission);
      const turn = this.runtime.startTurn({ handle, text: prompt, mode: 'prompt', requestId: submission?.submissionId??`req-${crypto.randomUUID()}`, timeoutMs: 0,...(submission?{resourceScope:this.scope(submission.operation),beforePrompt:()=>{this.assertActive();this.options.context!.assertSubmission(submission);}}:{}) });
      this.turn = turn;
      // result can reject before its event stream closes. Observe it immediately.
      const result = turn.result;
      void result.catch(() => undefined);
      const idleTimeoutMs = this.agent.timeout * 1_000;
      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      let rejectIdle!: (error: Error) => void;
      const idle = new Promise<never>((_resolve, reject) => { rejectIdle = reject; });
      const resetIdle = () => {
        if (timer) clearTimeout(timer);
        if (timedOut || this.stopped) return;
        timer = setTimeout(() => {
          timedOut = true;
          this.timedOutStream = stream;
          const error = new AgentIdleTimeoutError(idleTimeoutMs);
          // Keep consuming the same stream: ACPX finalizes resources before it
          // closes the iterator, but after it resolves turn.result.
          void this.resourceOperation(() => turn.cancel({ reason: error.message })).catch(() => undefined);
          rejectIdle(error);
        }, idleTimeoutMs);
      };
      resetIdle();
      const stream = (async () => {
        let deliveryError: unknown;
        try {
          for await (const event of turn.events) {
            resetIdle();
            if (!this.stopped && !timedOut && !deliveryError) {
              const normalized = normalizeAcpxEvent(event);
              if (normalized) {
                try { this.options.onEvent(normalized); }
                catch (error) { deliveryError ??= error; }
              }
            }
          }
          const outcome = await result;
          if(outcome.status!=='failed'&&submission)submission.onAccepted({submissionId:submission.submissionId,kind:'provider_accepted',provider:'acp',receiptRef:`prompt-result:${submission.submissionId}`,digest:submission.inputDigest});
          if (deliveryError) throw deliveryError;
          if (outcome.status === 'failed') throw new Error(outcome.error.message);
          if (!this.stopped && !timedOut) this.options.onEvent({ type: 'completed', data: { stopReason: outcome.stopReason ?? outcome.status } });
        } finally {
          if (timer) clearTimeout(timer);
          if (this.turn === turn) this.turn = undefined;
        }
      })();
      this.streams.add(stream);
      const releaseStream = () => {
        this.streams.delete(stream);
        if (this.timedOutStream === stream) this.timedOutStream = undefined;
      };
      void stream.then(releaseStream, releaseStream);
      return { completion: Promise.race([stream, idle]) };
    });
    await completion;
  }
  async send(input: string|DriverSubmission) {
    const submission=typeof input==='string'?undefined:input;
    const prompt=typeof input==='string'?input:input.prompt;
    if(this.options.context?.protocol==='controlled-v1'&&!submission)throw new Error('DRIVER_SUBMISSION_REQUIRED');
    this.assertActive();
    if (this.sending) throw new Error('ACP turn already in progress');
    this.sending = true;
    try {
      // A timed-out public send has ended, but its SDK cleanup can still be in
      // progress. Wait without occupying the resource lane or resending its input.
      const previous = this.timedOutStream;
      if (previous) await this.whileActive(() => previous.catch(() => undefined));
      await this.sendTurn(prompt,submission);
    } finally { this.sending = false; }
  }
  async interrupt() {
    await this.resourceOperation(async () => {
      const turn = this.turn;
      if (turn) await turn.cancel({ reason: 'Dutydeck interrupt' });
      else if (this.handle) await this.runtime.cancel({ handle: this.handle, reason: 'Dutydeck interrupt' });
    });
  }
  async resume() { await this.start(); }
  stop(options: { discardSession?: boolean } = {}): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.revocation.abort();
    for (const resolve of this.pendingPermissions.values()) resolve({ outcome: 'reject_once' });
    this.pendingPermissions.clear();
    const turn = this.turn;
    const resources = [...this.resourceOperations];
    const streams = [...this.streams];
    let resolveStop!: () => void;
    let rejectStop!: (error: unknown) => void;
    this.stopping = new Promise<void>((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    // This task continues after a public stop rejection. It owns late resources
    // and SDK cleanup; the public promise only reports their success or first error.
    void (async () => {
      const errors: unknown[] = [];
      const observe = async (operation: () => Promise<unknown>) => {
        try { await operation(); }
        catch (error) {
          if (!(error instanceof AcpxStoppedError)) {
            errors.push(error);
            rejectStop(new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')));
          }
        }
      };
      // Cancel and resource creation are observed independently. Neither failure
      // skips closing handles that were produced by another pending operation.
      const cancelling = observe(async () => { if (turn) await turn.cancel({ reason: 'Dutydeck stop' }); });
      const closeHandles = async (handles = [...this.handles]) => {
        await Promise.all(handles.map(handle => observe(() => this.runtime.close({ handle, reason: 'Dutydeck stop' }))));
      };
      // An entered RPC can require connection closure to finish. Close known
      // handles immediately, then fence its writes and any late-created handle.
      const closingKnownHandles = closeHandles();
      await Promise.all([closingKnownHandles, ...resources.map(pending => observe(() => pending))]);
      if (resources.length) await closeHandles();
      await cancelling;
      await Promise.allSettled(streams);
      // ACPX's timeout can reject before its actual start continuation finishes.
      while (this.sdkCreations.size) await Promise.all([...this.sdkCreations.values()].map(creation => creation.promise));
      // A turn may retain its client during finalization after the first close.
      if (streams.length) await closeHandles();
      this.handle = undefined;
      if (options.discardSession && this.options.context?.protocol!=='controlled-v1' && !errors.length) await observe(() => this.resetPersistentState(true));
      // Failed resource cleanup must remain visible, and its env file must remain
      // available for diagnosis/recovery. No replacement instance is authorized.
      if (errors.length) return;
      this.handles.clear();
      if (this.processes.size === 0) this.launch.cleanup();
    })().finally(() => { this.stopResourcesSettled = true; }).then(resolveStop, rejectStop);
    return this.stopping;
  }
  async resolvePermission(id: string, approved: boolean) { const resolve = this.pendingPermissions.get(id); if (this.stopped || !resolve) return false; this.pendingPermissions.delete(id); resolve({ outcome: approved ? 'allow_once' : 'reject_once' }); return true; }
  async setModel(model: string) {
    if(this.options.context?.protocol==='controlled-v1')throw new Error('NATIVE_CONFIGURATION_INTENT_REQUIRED');
    await this.resourceOperation(async () => {
      await this.ensureHandle();
      this.assertActive();
      const status = await this.runtime.getStatus?.({ handle: this.handle! });
      this.assertActive();
      const options = Array.isArray(status?.details?.configOptions) ? status.details.configOptions as Array<Record<string, any>> : [];
      const modelOption = options.find(option => option.id === 'model' || option.category === 'model');
      if (!modelOption || typeof modelOption.id !== 'string') throw new Error(`Agent ${this.agent.id} does not support runtime model switching`);
      const allowed = Array.isArray(modelOption.options) ? modelOption.options.some((option: any) => option?.value === model) : true;
      if (!allowed) throw new Error(`Model ${model} is not supported by Agent ${this.agent.id}`);
      await this.runtime.setConfigOption?.({ handle: this.handle!, key: modelOption.id, value: model });
      this.assertActive();
      this.agent.model = model;
    });
  }
  async setReasoningEffort(reasoningEffort: string) {
    if(this.options.context?.protocol==='controlled-v1')throw new Error('NATIVE_CONFIGURATION_INTENT_REQUIRED');
    await this.resourceOperation(async () => {
      await this.ensureHandle();
      this.assertActive();
      const status = await this.runtime.getStatus?.({ handle: this.handle! });
      this.assertActive();
      const options = Array.isArray(status?.details?.configOptions) ? status.details.configOptions as Array<Record<string, any>> : [];
      const reasoning = options.find(option => option.category === 'thought_level' || option.id === 'reasoning_effort' || option.id === 'effort');
      if (!reasoning || typeof reasoning.id !== 'string') throw new Error(`Agent ${this.agent.id} does not support runtime reasoning effort switching`);
      const allowed = Array.isArray(reasoning.options) ? reasoning.options.some((option: any) => option?.value === reasoningEffort) : true;
      if (!allowed) throw new Error(`Reasoning effort ${reasoningEffort} is not supported by model ${this.agent.model ?? '(default)'}`);
      await this.runtime.setConfigOption?.({ handle: this.handle!, key: reasoning.id, value: reasoningEffort });
      this.assertActive();
      this.agent.reasoningEffort = reasoningEffort;
    });
  }
  setRiskPolicy(policy?: ToolRiskPolicy) { this.riskPolicy = policy; }
  killActive() { void this.interrupt().catch(() => undefined); }
}
