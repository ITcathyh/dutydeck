import type { PluginCommand } from './manifest.js';
import { scopeApplies, type PluginScopeContext } from './scope.js';

export interface RegisteredPluginCommand extends PluginCommand {
  plugin: string;
  scope: string;
  /** `/<plugin>:<name>` 恒可用；无重名且不是 Agent 原生命令名时 `/<name>` 也可用。 */
  qualifiedName: string;
  shortNameAvailable: boolean;
}

/**
 * Agent（Claude Code、Codex、Gemini CLI）自带的斜杠命令。Dutydeck 不认识的 `/xxx` 会原样发给 Agent，
 * 插件用短名占了这些名字，用户输入的原生命令就会被改写成插件 prompt；所以它们只能用 `/<plugin>:<name>` 调用。
 */
export const AGENT_NATIVE_COMMANDS: ReadonlySet<string> = new Set([
  'compact', 'clear', 'init', 'review', 'cost', 'context', 'memory', 'mcp', 'resume', 'config', 'doctor', 'permissions', 'hooks',
  'login', 'logout', 'usage', 'add-dir', 'pr-comments', 'security-review', 'rewind', 'export', 'ide', 'output-style', 'statusline',
  'todos', 'plugin', 'plugins', 'release-notes', 'upgrade', 'install-github-app', 'theme', 'vim', 'bug', 'feedback', 'terminal-setup',
  'diff', 'mention', 'approvals', 'fork', 'undo', 'plan', 'quit', 'exit', 'compress', 'chat', 'restore', 'tools', 'stats', 'copy', 'auth', 'extensions', 'about'
]);

/** `/name 参数` 或 `/plugin:name 参数`；名字大小写不敏感。 */
const invocationPattern = /^\/(?:([a-z][a-z0-9]*(?:-[a-z0-9]+)*):)?([a-z][a-z0-9_-]*)(?=\s|$)/i;

/**
 * 插件斜杠命令注册与冲突处理。prompt 模板按普通任务派发；query 映射由宿主独立授权。
 * 内置命令名在安装时拒绝，Agent 原生命令保留短名。
 */
export class PluginCommandRegistry {
  readonly commands: RegisteredPluginCommand[];

  constructor(plugins: Array<{ name: string; scope: string; commands: PluginCommand[] }>) {
    const counts = new Map<string, number>();
    for (const plugin of plugins) for (const command of plugin.commands) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
    this.commands = plugins.flatMap(plugin => plugin.commands.map(command => ({
      ...command, plugin: plugin.name, scope: plugin.scope,
      qualifiedName: `${plugin.name}:${command.name}`,
      shortNameAvailable: counts.get(command.name) === 1 && !AGENT_NATIVE_COMMANDS.has(command.name)
    })));
  }

  list(context: PluginScopeContext): RegisteredPluginCommand[] {
    return this.commands.filter(command => scopeApplies(command.scope, context));
  }

  resolve(text: string, context: PluginScopeContext, includeUnavailable = false): { command: RegisteredPluginCommand; args: string } | undefined {
    const trimmed = text.trim();
    const match = trimmed.match(invocationPattern);
    if (!match) return undefined;
    const plugin = match[1]?.toLowerCase();
    const name = match[2]!.toLowerCase();
    const command = (includeUnavailable ? this.commands : this.list(context)).find(candidate => candidate.name === name && (plugin ? candidate.plugin === plugin : candidate.shortNameAvailable));
    return command ? { command, args: trimmed.slice(match[0].length).trim() } : undefined;
  }

  /** 命中插件命令时返回展开后的 prompt，否则 undefined。 */
  expand(text: string, context: PluginScopeContext): string | undefined {
    const resolved = this.resolve(text, context);
    return resolved && !resolved.command.query ? expandCommandTemplate(resolved.command.template, resolved.args) : undefined;
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
