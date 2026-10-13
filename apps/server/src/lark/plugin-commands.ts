import { describePluginCommand, type PluginCommandRegistry } from '../plugins/commands.js';
import type { LarkPluginCommandHelp } from './commands.js';

/**
 * 飞书侧的插件命令入口。插件宿主在 daemon 启动时登记一次（与分享链接签名同样的登记方式），
 * coordinator 按机器人与工作区取用；未登记时等于没有插件命令。
 */
let registry: PluginCommandRegistry | undefined;

export function setLarkPluginCommands(next: PluginCommandRegistry): () => void {
  registry = next;
  return () => { if (registry === next) registry = undefined; };
}

export function expandLarkPluginCommand(text: string, context: { botAppId: string; cwd?: string }): string | undefined {
  return registry?.expand(text, context);
}

export function larkPluginCommandHelp(context: { botAppId: string; cwd?: string }): LarkPluginCommandHelp[] {
  return registry?.list(context).map(describePluginCommand) ?? [];
}
