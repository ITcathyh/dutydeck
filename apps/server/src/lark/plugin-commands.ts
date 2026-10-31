import type { PluginCommandQueryService, PluginCommandAuthority } from '../plugins/command-query.js';
import { describePluginCommand, type PluginCommandRegistry } from '../plugins/commands.js';
import type { LarkPluginCommandHelp } from './commands.js';

/**
 * 飞书侧的插件命令入口。插件宿主在 daemon 启动时登记一次（与分享链接签名同样的登记方式），
 * coordinator 按机器人与工作区取用；未登记时等于没有插件命令。
 */
let registry: PluginCommandRegistry | undefined;
let queries: PluginCommandQueryService | undefined;

export function setLarkPluginCommands(next: PluginCommandRegistry, queryService?: PluginCommandQueryService): () => void {
  registry = next;
  queries = queryService;
  return () => { if (registry === next) { registry = undefined; queries = undefined; } };
}

export function expandLarkPluginCommand(text: string, context: { botAppId: string; cwd?: string }): string | undefined {
  return registry?.expand(text, context);
}

export function larkPluginCommandHelp(context: { botAppId: string; cwd?: string }): LarkPluginCommandHelp[] {
  return registry?.list(context).map(describePluginCommand) ?? [];
}

export function resolveLarkPluginQuery(text: string, context: { botAppId: string; cwd?: string }) {
  const resolved = registry?.resolve(text, context, true);
  return resolved?.command.query ? resolved : undefined;
}

export async function callLarkPluginQuery(resolved: NonNullable<ReturnType<typeof resolveLarkPluginQuery>>, authority: PluginCommandAuthority, deliver: (output: import('@dutydeck/shared').JsonValue, beforeSend: () => Promise<void>) => Promise<void>) {
  if (!queries) throw new Error('PLUGIN_COMMAND_QUERY_UNAVAILABLE');
  return queries.call(resolved.command, resolved.args, authority, deliver);
}

/** Bound the serialized text payload to 16 KB; do not split an event into retryable partial replies. */
export function pluginQueryReplyText(text: string): string {
  const suffix = '\n[结果过长，已截断；请缩小查询范围。]';
  if (!text.trim()) return '查询完成，未返回内容。';
  if (Buffer.byteLength(JSON.stringify({ text }), 'utf8') <= 16_000) return text;
  let output = '';
  let bytes = Buffer.byteLength(JSON.stringify({ text: suffix }), 'utf8');
  for (const character of text) {
    const size = Buffer.byteLength(JSON.stringify(character).slice(1, -1), 'utf8');
    if (bytes + size > 16_000) break;
    output += character; bytes += size;
  }
  return output + suffix;
}
