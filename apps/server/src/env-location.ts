/**
 * 定位 `.env`：当前目录有 `.env` 就用它（与历史行为一致）；没有时回退到
 * `~/.dutydeck/last-daemon-dir` 记录的 daemon 根目录。
 *
 * 只用于体检这类「在别的目录里查 daemon 配置」的命令。serve / daemon 子进程不走回退：
 * 它们的工作目录就是各自的根目录，回退只会把别的根目录的配置混进来。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
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
  /** 与状态目录使用同一份环境，避免显式 DUTYDECK_DAEMON_DIR 被全局 process.env 覆盖。 */
  env?: NodeJS.ProcessEnv;
}

export function locateEnvFile(options: LocateEnvOptions = {}): EnvLocation {
  const cwd = options.cwd ?? process.cwd();
  const exists = options.exists ?? existsSync;
  const daemonDir = options.daemonDir ?? ((dir, home) => resolveDaemonDir(dir, home, options.env ?? process.env));
  const daemonRoot = resolve(daemonDir(cwd, options.home), '../..');
  const local = join(cwd, '.env');
  if (exists(local)) return { source: 'cwd', file: local, cwd, daemonRoot };
  const recorded = join(daemonRoot, '.env');
  if (daemonRoot !== cwd && exists(recorded)) return { source: 'daemon-root', file: recorded, cwd, daemonRoot };
  return { source: 'none', cwd, daemonRoot };
}

export interface ServiceRootEnvironment {
  env: NodeJS.ProcessEnv;
  location: EnvLocation;
  readError?: string;
}

/**
 * CLI 启动时已读取当前目录 .env；这里只在它不存在时补读同一个实例服务根的 .env。
 * 显式进程环境与 CLI flags 转换来的值最后展开，始终覆盖文件，不把两份 .env 拼在一起。
 */
export function environmentWithServiceRoot(
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; daemonDir?: string; location?: EnvLocation } = {}
): ServiceRootEnvironment {
  const location = options.location ?? locateEnvFile({
    cwd: options.cwd,
    home: env.HOME,
    env,
    ...(options.daemonDir ? { daemonDir: () => options.daemonDir! } : {})
  });
  if (location.source !== 'daemon-root' || !location.file) return { env, location };
  try {
    return { env: { ...parseEnv(readFileSync(location.file, 'utf8')), ...env }, location };
  } catch (error) {
    return { env, location, readError: error instanceof Error ? error.message : String(error) };
  }
}
