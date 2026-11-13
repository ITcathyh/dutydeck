import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnvironment } from '@dutydeck/shared/child-environment';
import type {
  TerminalBackendCleanupIssue,
  TerminalBackendProbe,
  TerminalBackendProbeResult,
  TerminalBackendProbeStage
} from './types.js';

type TmuxRunResult =
  | { status: 'ok'; stdout: string; stderr: string }
  | { status: 'not_found' | 'failed' | 'timeout'; detail: string };

function firstLine(text: string): string | undefined {
  return text.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 300);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 每次调用都强制带同一个私有 socket 和空配置；shell:false 让 argv 不经过 shell 解释。 */
function runTmux(socketPath: string, args: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<TmuxRunResult> {
  return new Promise(resolve => {
    execFile('tmux', ['-S', socketPath, '-f', '/dev/null', ...args], {
      env,
      shell: false,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      windowsHide: true,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ status: 'ok', stdout, stderr });
        return;
      }
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      const output = firstLine(stderr) ?? firstLine(stdout);
      const suffix = output ? `：${output}` : '';
      if (failure.code === 'ENOENT') {
        resolve({ status: 'not_found', detail: `找不到 tmux 可执行文件${suffix}` });
      } else if (failure.killed || failure.code === 'ETIMEDOUT') {
        resolve({ status: 'timeout', detail: `超过 ${timeoutMs}ms，已终止该次 tmux 客户端${suffix}` });
      } else {
        const code = typeof failure.code === 'number' ? `退出码 ${failure.code}` : failure.code ?? failure.message;
        resolve({ status: 'failed', detail: `${code}${suffix}` });
      }
    });
  });
}

function failedProbe(run: Exclude<TmuxRunResult, { status: 'ok' }>, stage: Exclude<TerminalBackendProbeStage, 'prepare'>): TerminalBackendProbeResult {
  if (run.status === 'timeout') return { status: 'timeout', stage, detail: run.detail };
  return { status: 'failed', stage, detail: run.detail };
}

async function removeTemporaryDirectory(directory: string): Promise<TerminalBackendCleanupIssue | undefined> {
  try {
    await rm(directory, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return { status: 'failed', detail: `删除私有临时目录失败：${errorText(error)}` };
  }
}

/**
 * 真实 tmux smoke：版本、私有 socket 上创建精确会话、has-session 核验，最后 kill-server。
 *
 * 这是 doctor 中唯一允许有临时副作用的终端探针：它只接触新建 TMUX_TMPDIR 中的短 socket，
 * 不读取 /etc 或用户 tmux 配置，会话只运行受控存活命令，不连接用户默认 server。create 一旦开始，finally 就用同一 -S 路径清理；清理失败或超时时
 * server 可能仍活着，所以保留 socket 根，绝不为了“打扫干净”而 unlink 活 server 的入口。
 */
export const defaultTerminalBackendProbe: TerminalBackendProbe = async (timeoutMs, inheritedEnv = process.env) => {
  let directory: string;
  try {
    // Unix socket 路径长度有限；macOS 的 os.tmpdir() 往往过深，类 Unix 统一用短的 /tmp。
    directory = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ddtb-'));
  } catch (error) {
    return { status: 'failed', stage: 'prepare', detail: `创建私有临时目录失败：${errorText(error)}` };
  }

  const socketPath = join(directory, 's');
  const env = childEnvironment(inheritedEnv, {
    TMUX_TMPDIR: directory,
    HOME: directory,
    TMPDIR: directory,
    XDG_CONFIG_HOME: directory,
    NO_COLOR: '1'
  });
  const sessionName = `dd-doctor-${process.pid}-${randomBytes(4).toString('hex')}`;
  let serverMayExist = false;
  let primary: TerminalBackendProbeResult | undefined;
  let cleanup: TerminalBackendCleanupIssue | undefined;

  try {
    const version = await runTmux(socketPath, ['-V'], timeoutMs, env);
    if (version.status === 'not_found') {
      primary = { status: 'not_found' };
    } else if (version.status !== 'ok') {
      primary = failedProbe(version, 'version');
    } else {
      // new-session 即使在客户端报错或超时后也可能已经启动 server，因此先标记再执行。
      serverMayExist = true;
      const created = await runTmux(socketPath, ['new-session', '-d', '-s', sessionName, '/bin/sleep 30'], timeoutMs, env);
      if (created.status !== 'ok') {
        primary = failedProbe(created, 'create');
      } else {
        // tmux 的 = 前缀要求精确 session 名，不能把同前缀的别的会话当成创建成功。
        const verified = await runTmux(socketPath, ['has-session', '-t', `=${sessionName}`], timeoutMs, env);
        primary = verified.status === 'ok'
          ? { status: 'ok', version: firstLine(version.stdout) ?? firstLine(version.stderr) ?? '(无版本输出)' }
          : failedProbe(verified, 'verify');
      }
    }
  } finally {
    if (serverMayExist) {
      const stopped = await runTmux(socketPath, ['kill-server'], timeoutMs, env);
      if (stopped.status === 'ok') {
        // kill-server 成功才表示这个私有 server 已退出，此时才能删除它的 socket 根。
        cleanup = await removeTemporaryDirectory(directory);
      } else {
        cleanup = {
          status: stopped.status === 'timeout' ? 'timeout' : 'failed',
          detail: `${stopped.detail}；已保留 ${directory}，因为私有 server 可能仍在运行`
        };
      }
    } else {
      // -V 不会启动 server；此时删除的只是本次新建的临时目录。
      cleanup = await removeTemporaryDirectory(directory);
    }
  }

  let completed: TerminalBackendProbeResult = { ...primary!, ...(cleanup ? { cleanup } : {}) };
  if (completed.status === 'ok' && cleanup) {
    // 裸 ok 必须代表“探测和清理都完成”，让复用方只看 status 也不会漏报清理异常。
    completed = cleanup.status === 'timeout'
      ? { status: 'timeout', stage: 'cleanup', detail: cleanup.detail }
      : { status: 'failed', stage: 'cleanup', detail: cleanup.detail };
  }
  return { ...completed, tempDir: directory };
};
