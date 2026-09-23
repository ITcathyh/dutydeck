import { realpathSync } from 'node:fs';

/**
 * 将路径按 TOML basic string 规范进行转义并用双引号包裹。
 * 转义双引号、反斜杠及控制字符。
 */
export function escapeTomlBasicString(value: string): string {
  return JSON.stringify(value);
}

/**
 * 为完全信任模式构造工作目录预置信任参数（进程级 `-c` 配置覆盖）。
 * 若 realpath 与传入的 cwd 不同（如软链接），则将所有路径合并放入单条 `-c projects={...}` 内联表中，
 * 避免多个 `-c` 覆盖同名顶级表时可能发生的浅覆盖问题。
 */
export function buildCwdTrustArgs(cwd?: string): string[] {
  if (!cwd) return [];
  const paths = [cwd];
  try {
    const real = realpathSync(cwd);
    if (real && real !== cwd) {
      paths.push(real);
    }
  } catch {
    // 忽略 realpath 失败（例如目录尚未创建）
  }
  const tableEntries = paths
    .map(p => `${escapeTomlBasicString(p)}={trust_level="trusted"}`)
    .join(',');
  return ['-c', `projects={${tableEntries}}`];
}
