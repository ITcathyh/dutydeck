import { realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 部署把每个版本放在 `releases/<版本>/` 下、由 `releases/current` 指过去，Node 又会把入口解析成真实目录。
 * 启动器路径会写进 ACP 会话记录、恢复时逐字比对，用真实目录的话每部署一次旧会话就都恢复不了。
 * 所以本进程就是 current 指向的那个版本时，改用经过 current 的路径；其余情况原样返回。
 */
export function currentReleasePath(path: string): string {
  const match = /^(.*[\\/]releases)[\\/][^\\/]+([\\/].+)$/.exec(path);
  if (!match) return path;
  const current = join(match[1]!, 'current', match[2]!);
  try { return realpathSync(current) === realpathSync(path) ? current : path; }
  catch { return path; }
}
