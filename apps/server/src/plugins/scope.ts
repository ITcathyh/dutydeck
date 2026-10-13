import { isAbsolute, resolve } from 'node:path';
import { isPathInside } from '../skill-catalog.js';

/** 插件作用域：global、bot:<appId>、workspace:<绝对路径>。 */
export type PluginScope = string;
export interface PluginScopeContext { botAppId?: string; cwd?: string }

export function parsePluginScope(input: string | undefined): PluginScope {
  const value = (input ?? 'global').trim();
  if (value === 'global') return value;
  if (value.startsWith('bot:') && /^bot:[A-Za-z0-9_-]+$/.test(value)) return value;
  if (value.startsWith('workspace:')) {
    const path = value.slice('workspace:'.length);
    if (!path) throw new Error('workspace 作用域需要目录路径，例如 workspace:/path/to/repo');
    return `workspace:${isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path)}`;
  }
  throw new Error(`作用域 ${value} 无效：只能是 global、bot:<appId> 或 workspace:<目录>`);
}

/** 上下文缺少作用域需要的那一维（例如不知道机器人）时，限定作用域的插件不生效。 */
export function scopeApplies(scope: PluginScope, context: PluginScopeContext): boolean {
  if (scope === 'global') return true;
  if (scope.startsWith('bot:')) return context.botAppId === scope.slice(4);
  if (scope.startsWith('workspace:')) return Boolean(context.cwd) && isPathInside(resolve(context.cwd!), scope.slice('workspace:'.length));
  return false;
}
