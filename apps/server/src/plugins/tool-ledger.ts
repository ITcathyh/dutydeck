import { actionTransition, canonicalExecutionJson, pluginToolActionPrefix, RuntimeError, type ConfigRepository, type PluginToolAction } from '@dutydeck/shared';

/** Durable CAS records use a channel-neutral scope; no synthetic IM chat IDs. */
export class PluginToolLedger {
  constructor(private readonly config: ConfigRepository) {
    if (!config.compareAndSet) throw new Error('PLUGIN_TOOL_CAS_REQUIRED');
  }
  async get(id: string): Promise<PluginToolAction | undefined> {
    const raw = await this.config.get(pluginToolActionPrefix + id);
    return raw ? JSON.parse(raw) as PluginToolAction : undefined;
  }
  async begin(input: Omit<PluginToolAction, 'status' | 'revision' | 'createdAt' | 'updatedAt'>) {
    const time = new Date().toISOString();
    const action: PluginToolAction = { ...input, status: 'intent', revision: 1, createdAt: time, updatedAt: time };
    if (await this.config.compareAndSet!(pluginToolActionPrefix + input.id, undefined, JSON.stringify(action))) return { action, created: true };
    const existing = await this.get(input.id);
    if (!existing) throw new RuntimeError('PLUGIN_TOOL_LEDGER_UNAVAILABLE', 'Action ledger unavailable', 503);
    // Retries may occur in a new attempt; immutable execution identity remains that of the first call.
    if (existing.plugin !== input.plugin || existing.tool !== input.tool || existing.inputDigest !== input.inputDigest || existing.bindingId !== input.bindingId || existing.scopeKey !== input.scopeKey || canonicalExecutionJson(existing.original.actor) !== canonicalExecutionJson(input.original.actor)) throw new RuntimeError('PLUGIN_TOOL_CALL_CONFLICT', 'Call ID already names a different operation', 409);
    return { action: existing, created: false };
  }
  async transition(action: PluginToolAction, status: PluginToolAction['status'], receipt?: string, error?: string | null, options: { clearLeases?: boolean } = {}) {
    const update = actionTransition(action, { expectedRevision: action.revision, status, ...(receipt === undefined ? {} : { receipt }), ...(error === undefined ? {} : { error }) });
    if (!update) return action;
    const next = { ...action, ...update, ...(options.clearLeases ? { reconcileLease: undefined, executionLease: undefined } : {}), updatedAt: new Date().toISOString() };
    if (!await this.config.compareAndSet!(pluginToolActionPrefix + action.id, JSON.stringify(action), JSON.stringify(next))) throw new RuntimeError('PLUGIN_TOOL_REVISION_CONFLICT', 'Another caller updated the action', 409);
    return next;
  }

  /** Claim the original execute leg before invoking the external action. */
  async claimExecution(action: PluginToolAction, owner: string, now = Date.now(), leaseMs = 120_000): Promise<PluginToolAction | undefined> {
    if (action.status !== 'intent') return undefined;
    const next: PluginToolAction = {
      ...action,
      status: 'sending',
      revision: action.revision + 1,
      executionLease: { owner, expiresAt: now + leaseMs },
      updatedAt: new Date(now).toISOString()
    };
    const key = pluginToolActionPrefix + action.id;
    const current = await this.config.get(key);
    if (current !== JSON.stringify(action)) return undefined;
    if (!await this.config.compareAndSet!(key, current, JSON.stringify(next))) return undefined;
    return next;
  }

  /** Clear a sender lease only after its underlying promise has settled. */
  async releaseExecution(actionId: string, owner: string): Promise<boolean> {
    const key = pluginToolActionPrefix + actionId;
    const current = await this.config.get(key);
    if (!current) return false;
    let action: PluginToolAction;
    try { action = JSON.parse(current) as PluginToolAction; } catch { return false; }
    if (action.executionLease?.owner !== owner) return false;
    const next = { ...action, executionLease: undefined, revision: action.revision + 1, updatedAt: new Date().toISOString() };
    return this.config.compareAndSet!(key, current, JSON.stringify(next));
  }

  /** Claim external reconciliation before invoking a provider. A live claim
   * belongs to another process until its lease expires; the durable CAS keeps
   * two recovery workers from both repeating the same side effect. */
  async claimReconcile(action: PluginToolAction, owner: string, now = Date.now(), leaseMs = 60_000): Promise<PluginToolAction | undefined> {
    if (!['sending', 'unknown'].includes(action.status)) return action;
    if (action.executionLease && action.executionLease.expiresAt > now) return undefined;
    const live = action.reconcileLease;
    if (live && live.expiresAt > now) return undefined;
    const next: PluginToolAction = {
      ...action,
      reconcileLease: { owner, expiresAt: now + leaseMs },
      revision: action.revision + 1,
      updatedAt: new Date(now).toISOString()
    };
    const key = pluginToolActionPrefix + action.id;
    const current = await this.config.get(key);
    if (current !== JSON.stringify(action)) return undefined;
    if (!await this.config.compareAndSet!(key, current, JSON.stringify(next))) return undefined;
    return next;
  }
}
