import type { PluginRuntimeHooks } from './integration.js';
import { canonicalExecutionJson, RuntimeError, type PluginCommandIdentity, type JsonValue } from '@dutydeck/shared';
import { validateToolInput } from './business-tools.js';
import type { RegisteredPluginCommand } from './commands.js';
import type { PluginToolHost } from './tool-service.js';
import type { PluginToolGrants } from './tool-grants.js';

export interface PluginCommandAuthority {
  identity: PluginCommandIdentity;
  assertCurrent(): Promise<void>;
}

/** Only the authenticated inbound coordinator can supply this authority; it is not an HTTP tool API. */
export class PluginCommandQueryService {
  constructor(private readonly host: PluginToolHost, private readonly grants: PluginToolGrants, private readonly timeoutMs = 30_000, private readonly hooks?: Pick<PluginRuntimeHooks, 'toolBeforeCall'>) {}

  async call(command: RegisteredPluginCommand, args: string, authority: PluginCommandAuthority, deliver?: (output: JsonValue, beforeSend: () => Promise<void>) => Promise<void>): Promise<JsonValue> {
    if (!command.query) throw new RuntimeError('PLUGIN_COMMAND_QUERY_REQUIRED', 'Query command required', 400);
    const identity = Object.freeze({ ...authority.identity, actor: Object.freeze({ ...authority.identity.actor }) });
    const id = `${command.plugin}/${command.query.tool}`;
    const entry = this.host.businessTools.get(id, identity);
    if (!entry || entry.kind !== 'query' || entry.tool.commandOutput !== 'chat') throw new RuntimeError('PLUGIN_COMMAND_QUERY_UNAVAILABLE', 'Query is not available for chat output', 403);
    const tool = entry.tool;
    const binding = await this.host.resolveBinding(command.plugin, identity);
    if (!binding) throw new RuntimeError('PLUGIN_TOOL_BINDING_REQUIRED', 'Enabled binding required', 403);
    const input = Object.freeze({ [command.query.argument]: args });
    if (Buffer.byteLength(canonicalExecutionJson(input), 'utf8') > 64_000) throw new RuntimeError('PLUGIN_TOOL_INVALID_INPUT', 'Input exceeds budget', 400);
    validateToolInput(entry.tool.inputSchema, input);
    const resource = entry.tool.resource(input, binding);
    if (typeof resource !== 'string' || !resource || resource.length > 1000) throw new RuntimeError('PLUGIN_TOOL_INVALID_RESOURCE', 'Invalid resource', 400);
    const guard = async () => {
      await authority.assertCurrent();
      const current = await this.host.resolveBinding(command.plugin, identity);
      if (this.host.businessTools.get(id, identity) !== entry || !current || current.bindingId !== binding.bindingId || current.revision !== binding.revision) throw new RuntimeError('PLUGIN_TOOL_BINDING_CHANGED', 'Query or binding changed', 409);
      await this.grants.assert(identity, id, binding.bindingId, 'read', 'invoke', resource);
      await authority.assertCurrent();
    };
    await guard();
    if (await this.hooks?.toolBeforeCall(identity, { tool: id, input, resource, effect: 'read' }, binding.revision) === 'deny') throw new RuntimeError('PLUGIN_TOOL_DENIED', 'Plugin hook denied this query', 403);
    await guard();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let output: JsonValue;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => tool.execute(input, { identity, binding, signal: controller.signal })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.timeoutMs); timer.unref(); })
      ]);
      const encoded = canonicalExecutionJson(result);
      if (Buffer.byteLength(encoded, 'utf8') > 64_000) throw new Error('output budget');
      output = JSON.parse(encoded) as JsonValue;
    } catch { throw new RuntimeError('PLUGIN_TOOL_QUERY_FAILED', 'Query failed or exceeded its output/time budget', 502); }
    finally { if (timer) clearTimeout(timer); }
    await guard();
    await deliver?.(output, guard);
    return output;
  }
}
