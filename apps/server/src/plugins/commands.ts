import type { PluginCommand } from './manifest.js';
import { scopeApplies, type PluginScopeContext } from './scope.js';

export interface RegisteredPluginCommand extends PluginCommand {
  plugin: string;
  scope: string;
  /** `/<plugin>:<name>` 恒可用；无重名时 `/<name>` 也可用。 */
  qualifiedName: string;
  shortNameAvailable: boolean;
}

/** `/name 参数` 或 `/plugin:name 参数`；名字大小写不敏感。 */
const invocationPattern = /^\/(?:([a-z][a-z0-9]*(?:-[a-z0-9]+)*):)?([a-z][a-z0-9_-]*)(?=\s|$)/i;

/**
 * 插件斜杠命令。只做一件事：把命令换成 prompt 模板（`$ARGUMENTS` 替换为参数原文），
 * 之后照普通请求走授权与派发，不新开执行通道。内置命令名在安装时已拒绝。
 */
export class PluginCommandRegistry {
  readonly commands: RegisteredPluginCommand[];

  constructor(plugins: Array<{ name: string; scope: string; commands: PluginCommand[] }>) {
    const counts = new Map<string, number>();
    for (const plugin of plugins) for (const command of plugin.commands) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
    this.commands = plugins.flatMap(plugin => plugin.commands.map(command => ({
      ...command, plugin: plugin.name, scope: plugin.scope,
      qualifiedName: `${plugin.name}:${command.name}`,
      shortNameAvailable: counts.get(command.name) === 1
    })));
  }

  list(context: PluginScopeContext): RegisteredPluginCommand[] {
    return this.commands.filter(command => scopeApplies(command.scope, context));
  }

  resolve(text: string, context: PluginScopeContext): { command: RegisteredPluginCommand; args: string } | undefined {
    const trimmed = text.trim();
    const match = trimmed.match(invocationPattern);
    if (!match) return undefined;
    const plugin = match[1]?.toLowerCase();
    const name = match[2]!.toLowerCase();
    const command = this.list(context).find(candidate => candidate.name === name && (plugin ? candidate.plugin === plugin : candidate.shortNameAvailable));
    return command ? { command, args: trimmed.slice(match[0].length).trim() } : undefined;
  }

  /** 命中插件命令时返回展开后的 prompt，否则 undefined。 */
  expand(text: string, context: PluginScopeContext): string | undefined {
    const resolved = this.resolve(text, context);
    return resolved ? expandCommandTemplate(resolved.command.template, resolved.args) : undefined;
  }
}

export function expandCommandTemplate(template: string, args: string): string {
  if (template.includes('$ARGUMENTS')) return template.split('$ARGUMENTS').join(args);
  return args ? `${template}\n\nARGUMENTS: ${args}` : template;
}

/** /help 与 Web 命令面板用的展示形式。 */
export function describePluginCommand(command: RegisteredPluginCommand): { name: string; summary: string; usage: string } {
  const invocation = command.shortNameAvailable ? command.name : command.qualifiedName;
  return {
    name: invocation,
    summary: `${command.description ?? '插件提供的命令'}（插件 ${command.plugin}）`,
    usage: `/${invocation}${command.argumentHint ? ` ${command.argumentHint}` : ''}`
  };
}
