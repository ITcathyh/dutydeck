import { execFile, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { RelayError } from '@dutydeck/relay';
import type { Session } from '@dutydeck/shared';

const execute = promisify(execFile);
export const herdrSessionEnvKey = 'dutydeck_herdr_session';
export const herdrCommandEnvKey = 'dutydeck_herdr_command';

export function withoutHerdrEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^HERDR_/i.test(key)));
}

function findHerdr(environment: NodeJS.ProcessEnv): string | undefined {
  for (const directory of (environment.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, process.platform === 'win32' ? 'herdr.exe' : 'herdr');
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

export interface HerdrScope { session_name: string; binary: string; socket_path: string; workspace_id: string; root_pane_id: string }
interface Workspace { workspace_id: string }
interface Pane { pane_id: string }
interface HerdrResult { sessions?: Array<{ name: string; default: boolean; running: boolean; socket_path: string }>; workspaces?: Workspace[]; panes?: Pane[]; workspace?: Workspace; root_pane?: Pane }

/** Owns only named side workspaces; it never attaches the main ACP/tmux agent. */
export class HerdrSessions {
  private readonly binary?: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly installation: string;
  private readonly tails = new Map<string, Promise<unknown>>();
  constructor(private readonly options: { database: string; signingSecret: string; botAppId?: string; command: string; env?: NodeJS.ProcessEnv }) {
    this.environment = withoutHerdrEnvironment(options.env ?? process.env);
    this.binary = findHerdr(this.environment);
    let database = resolve(options.database);
    try { database = realpathSync(database); } catch { /* In-memory/test databases have no physical path. */ }
    this.installation = JSON.stringify([database, options.botAppId ?? '']);
  }
  nameFor(sessionId: string): string {
    return `dutydeck-${createHmac('sha256', this.options.signingSecret).update(JSON.stringify([this.installation, sessionId])).digest('hex').slice(0, 32)}`;
  }
  environmentFor(sessionId: string): Record<string, string> {
    return { [herdrSessionEnvKey]: this.nameFor(sessionId), [herdrCommandEnvKey]: `${this.options.command} session herdr --` };
  }
  prompt(): string {
    const command = `${this.options.command} session herdr --`;
    if (!this.binary) return 'Herdr 未安装，本会话的侧边子任务工作空间不可用；继续使用现有 Agent 完成普通任务。';
    return `Herdr 侧边子任务工作空间：先执行 ${command} prepare，按需创建或复用本会话专属 named session，返回真实 session_name/workspace_id/root_pane_id。\n后续使用 ${command} <workspace|tab|pane|agent> <子命令>，沿用 Herdr CLI 参数，并显式指定返回的目标 ID；例如 ${command} pane split <root_pane_id> --direction right --cwd <工作目录> --no-focus。\n你是外部 ACP/tmux 主 Agent，不是 Herdr pane：不要设置 HERDR_ENV/HERDR_PANE_ID，不用 --current，不绑定或操作用户的 default session。子任务使用上述专属入口和显式目标流程。\n此入口固定会话路由，禁止 --session/--remote/--machine；必须原样使用完整命令前缀，不能改用 PATH 中的其它 dutydeck。daemon 退出不会停止侧边任务。确认侧边任务可中断后，用 ${command} stop 停止本专属 server（保留状态）。`;
  }
  private serial<T>(name: string, work: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(name) ?? Promise.resolve()).catch(() => {}).then(work);
    this.tails.set(name, result);
    void result.finally(() => { if (this.tails.get(name) === result) this.tails.delete(name); }).catch(() => {});
    return result;
  }
  private async call(name: string, args: string[]): Promise<HerdrResult> {
    if (!this.binary) throw new RelayError('HERDR_UNAVAILABLE', 'Herdr 未安装；普通 Dutydeck 任务不受影响。', 503);
    try {
      const { stdout } = await execute(this.binary, ['--session', name, ...args], { env: this.environment, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      const payload = JSON.parse(stdout);
      return payload.result ?? payload;
    } catch (error) {
      let code = 'HERDR_REQUEST_FAILED';
      let message = error instanceof Error ? error.message : String(error);
      try { const body = JSON.parse((error as { stderr: string }).stderr).error; code = body.code; message = body.message; } catch { /* Preserve executable/transport failures. */ }
      throw new RelayError(code, message, 503);
    }
  }
  private async socketPath(name: string): Promise<string> {
    const listing = await this.call(name, ['session', 'list', '--json']);
    const matches = listing.sessions?.filter(session => session.name === name && !session.default && session.running) ?? [];
    if (matches.length !== 1 || !isAbsolute(matches[0]!.socket_path)) throw new RelayError('HERDR_SCOPE_UNAVAILABLE', '无法核实专属 Herdr session 的绝对 socket 路径。', 503);
    return matches[0]!.socket_path;
  }
  async prepare(session: Pick<Session, 'id' | 'cwd'>): Promise<HerdrScope> {
    const name = this.nameFor(session.id);
    return this.serial(name, async () => {
      let listing: HerdrResult;
      try { listing = await this.call(name, ['workspace', 'list']); }
      catch (error) {
        if (!(error instanceof RelayError) || error.code !== 'server_not_running') throw error;
        // Detached server and panes intentionally outlive the Dutydeck daemon.
        const child = spawn(this.binary!, ['--session', name, 'server'], {
          cwd: session.cwd, env: Object.fromEntries(Object.entries(this.environment).filter(([key]) => !/^dutydeck_/i.test(key))),
          detached: true, stdio: 'ignore'
        });
        let launchError: Error | undefined;
        child.on('error', error => { launchError = error; });
        child.unref();
        const deadline = Date.now() + 10_000;
        while (true) {
          if (launchError) throw new RelayError('HERDR_START_FAILED', launchError.message, 503);
          try { listing = await this.call(name, ['workspace', 'list']); break; }
          catch (pending) {
            if (!(pending instanceof RelayError) || pending.code !== 'server_not_running') throw pending;
            if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) throw new RelayError('HERDR_START_FAILED', '专属 Herdr server 未就绪；未回退到 default。', 503);
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }
      const workspace = listing.workspaces?.[0];
      if (workspace) {
        const panes = await this.call(name, ['pane', 'list', '--workspace', workspace.workspace_id]);
        if (!panes.panes?.[0]) throw new RelayError('HERDR_WORKSPACE_EMPTY', '专属工作空间没有可用 pane。', 503);
        return { session_name: name, binary: this.binary!, socket_path: await this.socketPath(name), workspace_id: workspace.workspace_id, root_pane_id: panes.panes[0].pane_id };
      }
      const created = await this.call(name, ['workspace', 'create', '--cwd', session.cwd, '--label', 'DutyDeck', '--no-focus']);
      if (!created.workspace || !created.root_pane) throw new RelayError('HERDR_INVALID_RESPONSE', 'Herdr 未返回工作空间和 root pane。', 503);
      return { session_name: name, binary: this.binary!, socket_path: await this.socketPath(name), workspace_id: created.workspace.workspace_id, root_pane_id: created.root_pane.pane_id };
    });
  }
  async stop(sessionId: string) {
    const name = this.nameFor(sessionId);
    return this.serial(name, async () => { await this.call(name, ['session', 'stop', name, '--json']); return { session_name: name, stopped: true }; });
  }
}
