import { createHash, randomUUID } from 'node:crypto';
import { canonicalExecutionJson, RuntimeError, type JsonValue, type PluginToolAction, type PluginToolBinding, type PluginToolIdentity } from '@dutydeck/shared';
import { PluginBusinessToolRegistry, validateToolInput, type BusinessToolEntry } from './business-tools.js';
import { PluginToolGrants } from './tool-grants.js';
import { PluginToolLedger } from './tool-ledger.js';
import type { PluginRuntimeHooks } from './integration.js';

export interface PluginToolAuthority { identity: PluginToolIdentity; assertCurrent(): Promise<void> }
export interface PluginToolAuthorityResolver { resolve(token?: string, turn?: string): Promise<PluginToolAuthority> }
export interface PluginToolHost {
  businessTools: PluginBusinessToolRegistry;
  resolveBinding(plugin: string, context: { botAppId?: string; chatId?: string; cwd?: string }): Promise<PluginToolBinding | undefined>;
}
const freezeJson = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeJson(child); Object.freeze(value); }
  return value;
};
const pluginIdentity = (identity: PluginToolIdentity) => freezeJson(structuredClone(identity));
const digest = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const scopeKey = (identity: PluginToolIdentity) => identity.channel === 'lark' ? `lark:${identity.botAppId}:${identity.chatId}` : `web:${identity.actor.id}:${identity.workspaceRoot}`;
const receipt = (action: PluginToolAction) => ({ actionId: action.id, status: action.status, ...(action.receipt ? { receipt: action.receipt } : {}), ...(action.error ? { error: action.error } : {}) });
export class PluginBusinessToolService {
  private readonly inFlight = new Set<string>();
  private readonly reconcileInFlight = new Set<string>();
  private readonly executionOwner = randomUUID();
  private readonly reconcileOwner = randomUUID();
  constructor(readonly host: PluginToolHost, readonly grants: PluginToolGrants, readonly ledger: PluginToolLedger, readonly authorities: PluginToolAuthorityResolver, private readonly timeoutMs = 30_000, private readonly runtimeHooks?: PluginRuntimeHooks) {}
  private async toolCompleted(identity: PluginToolIdentity, payload: Record<string, unknown>, bindingRevision: number) {
    try { await this.runtimeHooks?.deliveryCompleted(identity, payload, bindingRevision); } catch { /* hooks are observers and cannot alter the tool result */ }
  }
  async list(token?: string, turn?: string) {
    const authority = await this.authorities.resolve(token, turn);
    const tools = [];
    const snapshot = [];
    for (const [id, entry] of this.host.businessTools.list({ botAppId: authority.identity.botAppId, cwd: authority.identity.workspaceRoot })) {
      let binding: PluginToolBinding | undefined;
      try { binding = await this.host.resolveBinding(entry.plugin, { ...authority.identity, cwd: authority.identity.workspaceRoot }); }
      catch (error) {
        if (error instanceof RuntimeError && ['PLUGIN_UNAVAILABLE', 'PLUGIN_DISABLED', 'PLUGIN_BINDING_DISABLED', 'PLUGIN_TOOL_BINDING_REQUIRED'].includes(error.code)) continue;
        throw error;
      }
      if (binding && await this.grants.permits(authority.identity, id, binding.bindingId, entry.effect, 'invoke')) {
        tools.push({ id, description: entry.tool.description, inputSchema: entry.tool.inputSchema, effect: entry.effect, version: entry.tool.version });
        snapshot.push({ id, version: entry.tool.version, packageVersion: entry.packageVersion, effect: entry.effect, bindingId: binding.bindingId, bindingRevision: binding.revision });
      }
    }
    await authority.assertCurrent();
    const registryRevision = this.host.businessTools.revision;
    const revision = digest({ registryRevision, tools: snapshot });
    return { tools, revision, registryRevision };
  }
  private async select(id: string, authority: PluginToolAuthority) {
    const entry = this.host.businessTools.get(id, { botAppId: authority.identity.botAppId, cwd: authority.identity.workspaceRoot });
    if (!entry) throw new RuntimeError('PLUGIN_TOOL_NOT_FOUND', 'Tool not available in this scope', 404);
    const binding = await this.host.resolveBinding(entry.plugin, { ...authority.identity, cwd: authority.identity.workspaceRoot });
    if (!binding) throw new RuntimeError('PLUGIN_TOOL_BINDING_REQUIRED', 'This tool requires an enabled binding', 403);
    return { entry, binding };
  }
  private async guard(authority: PluginToolAuthority, id: string, entry: BusinessToolEntry, binding: PluginToolBinding, resource: string, operation: 'invoke' | 'reconcile') {
    await authority.assertCurrent();
    const current = await this.select(id, authority);
    if (current.entry !== entry || current.binding.bindingId !== binding.bindingId || current.binding.revision !== binding.revision) throw new RuntimeError('PLUGIN_TOOL_BINDING_CHANGED', 'Binding changed; start a new invocation', 409);
    await this.grants.assert(authority.identity, id, binding.bindingId, entry.effect, operation, resource);
    await authority.assertCurrent();
  }
  private async bounded<T>(work: (signal: AbortSignal) => Promise<T>, onUnderlyingSettled?: () => void) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const underlying = Promise.resolve().then(() => work(controller.signal));
      if (onUnderlyingSettled) void underlying.then(onUnderlyingSettled, onUnderlyingSettled);
      return await Promise.race([underlying, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('PLUGIN_TOOL_TIMEOUT')); }, this.timeoutMs);
        timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async call(id: string, input: unknown, callId: string, token?: string, turn?: string) {
    if (typeof callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(callId)) throw new RuntimeError('PLUGIN_TOOL_INVALID_CALL_ID', 'A stable callId is required', 400);
    const authority = await this.authorities.resolve(token, turn);
    const { entry, binding } = await this.select(id, authority);
    let encoded: string;
    try { encoded = canonicalExecutionJson(input); } catch { throw new RuntimeError('PLUGIN_TOOL_INVALID_INPUT', 'Input must be JSON', 400); }
    if (encoded.length > 64_000) throw new RuntimeError('PLUGIN_TOOL_INVALID_INPUT', 'Input exceeds 64 KB', 400);
    const frozenInput = freezeJson(JSON.parse(encoded) as JsonValue);
    validateToolInput(entry.tool.inputSchema, frozenInput);
    let resource: string;
    try { resource = entry.tool.resource(frozenInput, binding); } catch { throw new RuntimeError('PLUGIN_TOOL_INVALID_RESOURCE', 'Tool resource could not be resolved', 400); }
    if (typeof resource !== 'string' || !resource || resource.length > 1000) throw new RuntimeError('PLUGIN_TOOL_INVALID_RESOURCE', 'Invalid resource', 400);
    await this.guard(authority, id, entry, binding, resource, 'invoke');
    if (await this.runtimeHooks?.toolBeforeCall(authority.identity, { tool: id, input: frozenInput, resource, effect: entry.effect }, binding.revision) === 'deny') {
      await this.toolCompleted(authority.identity, { kind: 'tool', tool: id, status: 'denied' }, binding.revision);
      throw new RuntimeError('PLUGIN_TOOL_DENIED', 'Plugin hook denied this tool call', 403);
    }
    if (entry.kind === 'query') {
      let output: JsonValue;
      try {
        const result = await this.bounded(signal => entry.tool.execute(frozenInput, { identity: pluginIdentity(authority.identity), binding, signal }));
        const value = canonicalExecutionJson(result);
        if (value.length > 64_000) throw new Error();
        output = JSON.parse(value) as JsonValue;
      } catch {
        await this.toolCompleted(authority.identity, { kind: 'tool', tool: id, status: 'failed' }, binding.revision);
        throw new RuntimeError('PLUGIN_TOOL_QUERY_FAILED', 'Query failed or exceeded its output/time budget', 502);
      }
      await this.guard(authority, id, entry, binding, resource, 'invoke');
      await this.toolCompleted(authority.identity, { kind: 'tool', tool: id, status: 'succeeded' }, binding.revision);
      return { output };
    }
    const actionId = `pt_${digest({ tool: id, sessionId: authority.identity.sessionId, taskId: authority.identity.taskId, callId })}`;
    const begun = await this.ledger.begin({ id: actionId, plugin: entry.plugin, tool: entry.tool.name, handlerVersion: entry.tool.version, bindingId: binding.bindingId, bindingRevision: binding.revision, scopeKey: scopeKey(authority.identity), original: authority.identity, input: frozenInput, inputDigest: digest(frozenInput), resource });
    let action = begun.action;
    if (!begun.created) {
      this.compatible(action, entry, binding);
      if (action.status !== 'intent') return receipt(action);
    }
    await this.guard(authority, id, entry, binding, resource, 'invoke');
    const claimed = await this.ledger.claimExecution(action, this.executionOwner);
    // A failed CAS means another caller won the durable sender lease (or the
    // action changed while this call was reading it).  The fallback snapshot
    // is informational only; it must never authorize a second external
    // invocation just because it now says `sending`.
    if (!claimed) return receipt((await this.ledger.get(actionId)) ?? action);
    action = claimed;
    this.inFlight.add(actionId);
    let settled = false;
    let settleUnderlying!: () => void;
    const underlyingSettled = new Promise<void>(resolve => { settleUnderlying = resolve; });
    try {
      let result: { receipt: string };
      try {
        result = await this.bounded(signal => entry.tool.execute(frozenInput, { identity: pluginIdentity(authority.identity), binding, signal, actionId }), () => { settled = true; this.inFlight.delete(actionId); settleUnderlying(); });
        if (typeof result?.receipt !== 'string' || !result.receipt || result.receipt.length > 4000) throw new Error();
      } catch {
        action = await this.ledger.transition(action, 'unknown', undefined, 'PLUGIN_TOOL_EXECUTION_UNKNOWN');
        if (settled) await this.ledger.releaseExecution(actionId, this.executionOwner).catch(() => false);
        else void underlyingSettled.then(() => this.ledger.releaseExecution(actionId, this.executionOwner).catch(() => undefined));
        await this.toolCompleted(authority.identity, { kind: 'tool', tool: id, status: action.status, actionId: action.id }, binding.revision);
        return receipt(action);
      }
      action = await this.ledger.transition(action, 'succeeded', result.receipt);
      await underlyingSettled;
      await this.ledger.releaseExecution(actionId, this.executionOwner).catch(() => false);
      // An operation may have completed while authority was revoked; do not expose its receipt then.
      await this.guard(authority, id, entry, binding, resource, 'invoke');
      await this.toolCompleted(authority.identity, { kind: 'tool', tool: id, status: action.status, actionId: action.id }, binding.revision);
      return receipt(action);
    } finally { /* Keep inFlight until the underlying executor settles, including after timeout. */ }
  }
  private compatible(action: PluginToolAction, entry: BusinessToolEntry, binding: PluginToolBinding) {
    if (action.plugin !== entry.plugin || action.tool !== entry.tool.name || action.handlerVersion !== entry.tool.version || action.bindingId !== binding.bindingId || action.bindingRevision !== binding.revision) throw new RuntimeError('PLUGIN_TOOL_INCOMPATIBLE_ACTION', 'Original tool or binding contract changed; action remains unresolved', 409);
  }
  async reconcile(actionId: string, token?: string, turn?: string) {
    const authority = await this.authorities.resolve(token, turn);
    const action = await this.ledger.get(actionId);
    if (!action || action.scopeKey !== scopeKey(authority.identity)) throw new RuntimeError('PLUGIN_TOOL_ACTION_NOT_FOUND', 'Action not found in this scope', 404);
    const id = `${action.plugin}/${action.tool}`;
    const { entry, binding } = await this.select(id, authority);
    this.compatible(action, entry, binding);
    await this.guard(authority, id, entry, binding, action.resource, 'reconcile');
    await this.grants.assert(action.original, id, action.bindingId, entry.effect, 'invoke', action.resource);
    if (this.inFlight.has(actionId) || this.reconcileInFlight.has(actionId) || action.executionLease && action.executionLease.expiresAt > Date.now()) throw new RuntimeError('PLUGIN_TOOL_ACTION_BUSY', 'Operation is still executing', 409);
    // No executor can have started before the durable sending transition. CAS prevents a concurrent sender from being suppressed.
    if (action.status === 'intent') return receipt(await this.ledger.transition(action, 'suppressed', undefined, 'PLUGIN_TOOL_NOT_SENT'));
    if (!['sending', 'unknown'].includes(action.status)) return receipt(action);
    if (entry.kind !== 'action' || !entry.tool.reconcile) throw new RuntimeError('PLUGIN_TOOL_RECONCILE_UNSUPPORTED', 'The action requires external reconciliation', 409);
    const claimed = await this.ledger.claimReconcile(action, this.reconcileOwner);
    if (!claimed) throw new RuntimeError('PLUGIN_TOOL_ACTION_BUSY', 'Another process is reconciling this operation', 409);
    this.reconcileInFlight.add(actionId);
    let outcome: { status: 'succeeded' | 'failed' | 'unknown'; receipt?: string };
    try {
      outcome = await this.bounded(signal => entry.tool.reconcile!({ identity: pluginIdentity(authority.identity), binding, signal, actionId, original: freezeJson(structuredClone(action)) }), () => this.reconcileInFlight.delete(actionId));
      if (!['succeeded', 'failed', 'unknown'].includes(outcome?.status) || (outcome.receipt !== undefined && (typeof outcome.receipt !== 'string' || outcome.receipt.length > 4000))) throw new Error();
    } catch { return receipt(claimed); }
    await this.guard(authority, id, entry, binding, action.resource, 'reconcile');
    await this.grants.assert(action.original, id, action.bindingId, entry.effect, 'invoke', action.resource);
    return receipt(await this.ledger.transition(claimed, outcome.status, outcome.receipt, outcome.status === 'unknown' ? undefined : null, { clearLeases: true }));
  }
}
