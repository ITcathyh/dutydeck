import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpPermissionDecision, type AcpRuntime, type AcpRuntimeEvent, type AcpRuntimeHandle, type AcpRuntimeTurn, type AcpSessionStore } from 'acpx/runtime';
import type { AgentConfig, AgentDriver, NormalizedDriverEvent, PermissionMode, ToolRiskPolicy } from '@dockmux/shared';
import { testRegexWithTimeout } from './regex-timeout.js';

// 归一化事件类型统一从 @dockmux/shared re-export，保证 ACP driver 与 PTY driver 用同一类型。
export type { NormalizedDriverEvent };
export interface AcpxBuiltinAgent { id: string; argv: string[] }

function claudeLauncherPath() {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const adjacent = join(moduleDirectory, 'agents', 'claude-acp.mjs');
  return existsSync(adjacent) ? adjacent : join(moduleDirectory, '..', 'agents', 'claude-acp.mjs');
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
  if (kind === 'permission_request' || kind === 'permission_escalation') return { type: 'permission_request', data: { id: event.requestId ?? event.id ?? update.toolCallId, toolCallId: update.toolCallId, title: update.title ?? event.toolTitle ?? 'Permission required', options: update.options ?? [], status: 'pending' } };
  if (kind === 'usage_update') return { type: 'status', data: { state: 'usage', used: event.used, size: event.size, breakdown: event.breakdown, cost: event.cost } };
  if (kind === 'available_commands_update') return { type: 'status', data: { state: 'commands', availableCommands: event.availableCommands ?? update.availableCommands ?? [] } };
  if (kind === 'error') return { type: 'error', data: { message: event.message ?? event.error?.message ?? 'Agent error', detail: event } };
  if (kind === 'done' || kind === 'completed' || kind === 'result' || event.result?.stopReason) return { type: 'completed', data: { stopReason: event.stopReason ?? event.result?.stopReason ?? 'end_turn' } };
  if (kind === 'status') return { type: 'status', data: { state: event.text ?? event.state ?? 'running', ...event } };
  return { type: 'raw_terminal', data: { text: JSON.stringify(input) }, raw: JSON.stringify(input) };
}

function shellQuote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
export function renderAgentCommand(agent: AgentConfig) { return [agent.command, ...agent.args].map(shellQuote).join(' '); }
export function buildAcpxSessionOptions(agent: AgentConfig) {
  return {
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}),
    env: agent.env
  };
}

export interface AcpxAdapterOptions { sessionKey?: string; onEvent(event: NormalizedDriverEvent): void; onExit?(code: number | null, signal: NodeJS.Signals | null): void }
type SessionAgentConfig = AgentConfig & { reasoningEffort?: string };

export class AgentIdleTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Agent 连续 ${Math.ceil(timeoutMs / 1_000)} 秒无任何活动，已取消本轮任务`);
    this.name = 'AgentIdleTimeoutError';
  }
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

  constructor(readonly agent: SessionAgentConfig, private readonly options: AcpxAdapterOptions) {
    const cwd = agent.cwd ?? process.cwd(); this.sessionKey = options.sessionKey ?? `dockmux-${agent.id}`;
    this.permissionMode = agent.permissionMode;
    this.sessionStore = createRuntimeStore({ stateDir: join(cwd, '.dockmux', 'acpx') });
    this.runtime = createAcpRuntime({
      cwd,
      sessionStore: this.sessionStore,
      agentRegistry: createAgentRegistry({ overrides: { [agent.id]: [agent.command, ...agent.args] } }),
      permissionMode: agent.permissionMode === 'full-trust' ? 'approve-all' : agent.permissionMode === 'deny-all' ? 'deny-all' : 'approve-reads',
      nonInteractivePermissions: 'fail', timeoutMs: agent.timeout * 1000,
      onPermissionRequest: async request => {
        const raw = request.raw as any; const id = raw.toolCall?.toolCallId ?? `permission-${Date.now()}`;
        const candidate = flattenRiskText({ title: raw.toolCall?.title, input: raw.toolCall?.rawInput ?? raw.toolCall?.input ?? raw }).join('\n');
        if (this.riskPolicy?.enabled && !this.riskPolicy.authorized) {
          try {
            if (await testRegexWithTimeout(this.riskPolicy.pattern, candidate)) {
              this.options.onEvent({ type: 'permission_request', data: { id, toolCallId: raw.toolCall?.toolCallId, title: `高危操作已被 Dockmux 拦截：${raw.toolCall?.title ?? 'tool'}`, options: [], status: 'rejected' } });
              return { outcome: 'reject_once' };
            }
          } catch (error) {
            this.options.onEvent({ type: 'permission_request', data: { id, toolCallId: raw.toolCall?.toolCallId, title: `安全正则匹配异常，已拒绝操作：${error instanceof Error ? error.message : String(error)}`, options: [], status: 'rejected' } });
            return { outcome: 'reject_once' };
          }
        }
        if (this.permissionMode === 'full-trust') return { outcome: 'allow_once' };
        if (this.permissionMode === 'deny-all') return { outcome: 'reject_once' };
        if (this.permissionMode === 'approve-reads' && /read|search|fetch/i.test(String(request.inferredKind ?? ''))) return { outcome: 'allow_once' };
        this.options.onEvent({ type: 'permission_request', data: { id, toolCallId: raw.toolCall?.toolCallId, title: raw.toolCall?.title ?? 'Permission required', options: raw.options ?? [], status: 'pending' } });
        return new Promise<AcpPermissionDecision>(resolve => this.pendingPermissions.set(id, resolve));
      }
    });
  }

  private sessionInput() { return { sessionKey: this.sessionKey, agent: this.agent.id, mode: 'persistent' as const, cwd: this.agent.cwd, sessionOptions: buildAcpxSessionOptions(this.agent) }; }
  private isMissingPersistentSession(error: unknown): boolean {
    for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
      const message = current instanceof Error ? current.message : String(current);
      if (/could not be resumed|resource not found/i.test(message)) return true;
      current = current instanceof Error ? current.cause : undefined;
    }
    return false;
  }
  private async resetPersistentState() {
    const record = await this.sessionStore.load(this.sessionKey);
    if (!record) return;
    record.acpx = { ...record.acpx, reset_on_next_ensure: true };
    await this.sessionStore.save(record);
  }
  private async resetWhenScopedEnvironmentChanged() {
    const desired = buildAcpxSessionOptions(this.agent).env ?? {};
    const scopedKeys = ['dockmux_group_tools_url', 'dockmux_group_tools_token'] as const;
    if (!scopedKeys.some(key => desired[key])) return;
    const record = await this.sessionStore.load(this.sessionKey);
    if (!record) return;
    const stored = record.acpx?.session_options?.env ?? {};
    if (scopedKeys.every(key => stored[key] === desired[key])) return;
    record.acpx = { ...record.acpx, reset_on_next_ensure: true };
    await this.sessionStore.save(record);
  }
  private async applyReasoningEffort() {
    if (!this.handle || !this.agent.reasoningEffort) return;
    const status = await this.runtime.getStatus?.({ handle: this.handle });
    const options = Array.isArray(status?.details?.configOptions) ? status.details.configOptions as Array<Record<string, any>> : [];
    const reasoning = options.find(option => option.category === 'thought_level' || option.id === 'reasoning_effort' || option.id === 'effort');
    if (!reasoning || typeof reasoning.id !== 'string') throw new Error(`Agent ${this.agent.id} does not support reasoning effort configuration`);
    const allowed = Array.isArray(reasoning.options) ? reasoning.options.some((option: any) => option?.value === this.agent.reasoningEffort) : true;
    if (!allowed) throw new Error(`Reasoning effort ${this.agent.reasoningEffort} is not supported by model ${this.agent.model ?? '(default)'}`);
    await this.runtime.setConfigOption?.({ handle: this.handle, key: reasoning.id, value: this.agent.reasoningEffort });
  }
  async start() {
    await this.resetWhenScopedEnvironmentChanged();
    this.handle = await this.runtime.ensureSession(this.sessionInput());
    await this.applyReasoningEffort();
  }
  private async sendTurn(prompt: string) {
    if (!this.handle) await this.start(); const requestId = `req-${crypto.randomUUID()}`;
    // ACPX 的 timeoutMs 是整轮墙钟超时，流式事件和工具调用都不会续期。
    // 禁用它，在 Dockmux 边界按每个 ACP 事件重置“无活动”计时，避免正常长任务被固定时长误杀。
    const idleTimeoutMs = this.agent.timeout * 1_000;
    const turn = this.runtime.startTurn({ handle: this.handle!, text: prompt, mode: 'prompt', requestId, timeoutMs: 0 });
    this.turn = turn;
    try {
      const iterator = turn.events[Symbol.asyncIterator]();
      while (true) {
        let timer: NodeJS.Timeout | undefined;
        const idle = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new AgentIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs);
        });
        let next: IteratorResult<AcpRuntimeEvent>;
        try { next = await Promise.race([iterator.next(), idle]); }
        catch (error) {
          if (error instanceof AgentIdleTimeoutError) {
            await turn.cancel({ reason: error.message }).catch(() => undefined);
            // The event iterator won the race, so this caller no longer awaits the
            // result promise. Observe it explicitly to avoid a late rejection.
            void turn.result.catch(() => undefined);
          }
          throw error;
        } finally { if (timer) clearTimeout(timer); }
        if (next.done) break;
        const normalized = normalizeAcpxEvent(next.value);
        if (normalized) this.options.onEvent(normalized);
      }
      const result = await turn.result;
      if (result.status === 'failed') throw new Error(result.error.message);
      this.options.onEvent({ type: 'completed', data: { stopReason: result.stopReason ?? result.status } });
    } finally {
      if (this.turn === turn) this.turn = undefined;
    }
  }
  async send(prompt: string) {
    try { await this.sendTurn(prompt); }
    catch (error) {
      if (!this.isMissingPersistentSession(error)) throw error;
      await this.resetPersistentState();
      this.handle = await this.runtime.ensureSession(this.sessionInput());
      await this.applyReasoningEffort();
      await this.sendTurn(prompt);
    }
  }
  async interrupt() { if (this.turn) await this.turn.cancel({ reason: 'Dockmux interrupt' }); else if (this.handle) await this.runtime.cancel({ handle: this.handle, reason: 'Dockmux interrupt' }); }
  async resume() { await this.start(); }
  async stop(options: { discardSession?: boolean } = {}) {
    for (const resolve of this.pendingPermissions.values()) resolve({ outcome: 'reject_once' });
    this.pendingPermissions.clear();
    const turn = this.turn;
    if (turn) {
      try { await turn.cancel({ reason: 'Dockmux stop' }); }
      finally { if (this.turn === turn) this.turn = undefined; }
    }
    if (this.handle) await this.runtime.close({ handle: this.handle, reason: 'Dockmux stop' });
    this.handle = undefined;
    if (options.discardSession) await this.resetPersistentState();
  }
  async resolvePermission(id: string, approved: boolean) { const resolve = this.pendingPermissions.get(id); if (!resolve) return false; this.pendingPermissions.delete(id); resolve({ outcome: approved ? 'allow_once' : 'reject_once' }); return true; }
  async setModel(model: string) {
    if (!this.handle) await this.start();
    const status = await this.runtime.getStatus?.({ handle: this.handle! });
    const options = Array.isArray(status?.details?.configOptions) ? status.details.configOptions as Array<Record<string, any>> : [];
    const modelOption = options.find(option => option.id === 'model' || option.category === 'model');
    if (!modelOption || typeof modelOption.id !== 'string') throw new Error(`Agent ${this.agent.id} does not support runtime model switching`);
    const allowed = Array.isArray(modelOption.options) ? modelOption.options.some((option: any) => option?.value === model) : true;
    if (!allowed) throw new Error(`Model ${model} is not supported by Agent ${this.agent.id}`);
    await this.runtime.setConfigOption?.({ handle: this.handle!, key: modelOption.id, value: model });
    this.agent.model = model;
  }
  async setReasoningEffort(reasoningEffort: string) {
    if (!this.handle) await this.start();
    const status = await this.runtime.getStatus?.({ handle: this.handle! });
    const options = Array.isArray(status?.details?.configOptions) ? status.details.configOptions as Array<Record<string, any>> : [];
    const reasoning = options.find(option => option.category === 'thought_level' || option.id === 'reasoning_effort' || option.id === 'effort');
    if (!reasoning || typeof reasoning.id !== 'string') throw new Error(`Agent ${this.agent.id} does not support runtime reasoning effort switching`);
    const allowed = Array.isArray(reasoning.options) ? reasoning.options.some((option: any) => option?.value === reasoningEffort) : true;
    if (!allowed) throw new Error(`Reasoning effort ${reasoningEffort} is not supported by model ${this.agent.model ?? '(default)'}`);
    await this.runtime.setConfigOption?.({ handle: this.handle!, key: reasoning.id, value: reasoningEffort });
    this.agent.reasoningEffort = reasoningEffort;
  }
  setRiskPolicy(policy?: ToolRiskPolicy) { this.riskPolicy = policy; }
  setPermissionMode(mode: PermissionMode) { this.permissionMode = mode; }
  killActive() { void this.interrupt(); }
}
