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
  async transition(action: PluginToolAction, status: PluginToolAction['status'], receipt?: string, error?: string | null) {
    const update = actionTransition(action, { expectedRevision: action.revision, status, ...(receipt === undefined ? {} : { receipt }), ...(error === undefined ? {} : { error }) });
    if (!update) return action;
    const next = { ...action, ...update, updatedAt: new Date().toISOString() };
    if (!await this.config.compareAndSet!(pluginToolActionPrefix + action.id, JSON.stringify(action), JSON.stringify(next))) throw new RuntimeError('PLUGIN_TOOL_REVISION_CONFLICT', 'Another caller updated the action', 409);
    return next;
  }
}
