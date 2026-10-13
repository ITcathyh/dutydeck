/**
 * 定位 `.env`：当前目录有 `.env` 就用它（与历史行为一致）；没有时回退到
 * `~/.dutydeck/last-daemon-dir` 记录的 daemon 根目录。
 *
 * 只用于体检这类「在别的目录里查 daemon 配置」的命令。serve / daemon 子进程不走回退：
 * 它们的工作目录就是各自的根目录，回退只会把别的根目录的配置混进来。
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveDaemonDir } from './daemon/daemon.js';

export interface EnvLocation {
  /** cwd：用当前目录的 .env；daemon-root：当前目录没有，改读 daemon 根目录的；none：两处都没有。 */
  source: 'cwd' | 'daemon-root' | 'none';
  /** 实际读取的 .env 路径；source 为 none 时缺省。 */
  file?: string;
  cwd: string;
  /** daemon 根目录（`<根>/.dutydeck/daemon` 的上两级）；daemon 目录没有记录时就是 cwd。 */
  daemonRoot: string;
}

export interface LocateEnvOptions {
  cwd?: string;
  home?: string;
  exists?: (path: string) => boolean;
  /** 注入点：默认 resolveDaemonDir（cwd 下有在跑的 daemon 用它，否则看 last-daemon-dir）。 */
  daemonDir?: (cwd: string, home?: string) => string;
}

export function locateEnvFile(options: LocateEnvOptions = {}): EnvLocation {
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const daemonDir = options.daemonDir ?? ((dir, home) => resolveDaemonDir(dir, home));
  const daemonRoot = resolve(daemonDir(cwd, options.home), '../..');
  const local = join(cwd, '.env');
  if (exists(local)) return { source: 'cwd', file: local, cwd, daemonRoot };
  const recorded = join(daemonRoot, '.env');
  if (daemonRoot !== cwd && exists(recorded)) return { source: 'daemon-root', file: recorded, cwd, daemonRoot };
  return { source: 'none', cwd, daemonRoot };
}
