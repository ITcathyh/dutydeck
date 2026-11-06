import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 进程内 providers 的代码目录 → 插件名。只用来给致命错误日志补上来源，不拦截、不恢复：
 * 未处理的异常仍按 Node 默认行为让 daemon 退出。
 */
const roots = new Map<string, string>();

const forms = (root: string) => {
  const paths = new Set([root]);
  try { paths.add(realpathSync(root)); } catch { /* 目录已不存在时只用原路径 */ }
  return [...paths].flatMap(path => [path.endsWith(sep) ? path : path + sep, pathToFileURL(path).href.replace(/\/?$/, '/')]);
};

/** 代码一旦载入就留在进程里，登记也保留到进程结束。 */
export function registerPluginCodeRoot(plugin: string, root: string): void {
  for (const key of forms(root)) roots.set(key, plugin);
}

/** 错误栈里出现过的插件代码目录对应的插件名，按出现顺序去重。 */
export function pluginsInStack(stack: string): string[] {
  const found: Array<{ at: number; plugin: string }> = [];
  for (const [prefix, plugin] of roots) {
    const at = stack.indexOf(prefix);
    if (at >= 0) found.push({ at, plugin });
  }
  return [...new Set(found.sort((left, right) => left.at - right.at).map(item => item.plugin))];
}
