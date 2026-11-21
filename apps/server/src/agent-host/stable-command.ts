import { realpathSync } from 'node:fs';

/**
 * 部署版本目录（releases/<时间戳>-<sha>）会被清理，旧会话里写死的命令会失效。
 * 命令指向 releases/<x>/dist/{cli,internal-agent-cli}.js，且同级 releases/current 指向同一个目录时，改写成 releases/current。
 */
export function stableMemoryCommand(command: string): string {
  const match = /(\/[^'"\s]*\/releases)\/([^/'"\s]+)\/dist\/(cli|internal-agent-cli)\.js/.exec(command);
  if (!match || match[2] === 'current') return command;
  try {
    if (realpathSync(`${match[1]}/current`) !== realpathSync(`${match[1]}/${match[2]}`)) return command;
  } catch { return command; }
  return command.replace(match[0], `${match[1]}/current/dist/${match[3]}.js`);
}
