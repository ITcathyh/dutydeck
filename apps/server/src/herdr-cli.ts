import { isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { RelayCliError, RelayHttpClient, type RelayClientOptions } from '@dutydeck/relay';
import { withoutHerdrEnvironment, type HerdrScope } from './herdr.js';

/** Pass ordinary Herdr CLI operations through one fixed, authenticated session. */
export function validateHerdrArguments(args: string[]) {
  if ((args[0] === 'prepare' || args[0] === 'stop') && args.length === 1) return;
  const options = args;
  if (options.some(arg => /^(?:--session|--remote(?:-keybindings)?|--machine|--current)(?:=|$)/.test(arg))) {
    throw new RelayCliError('Herdr 入口固定路由，禁止会话切换和 --current；请使用显式目标 ID。', 2, 'HERDR_SCOPE_OVERRIDE');
  }
  if (!['workspace', 'tab', 'pane', 'agent'].includes(args[0] ?? '') || !args[1] || args[1].startsWith('-')) {
    throw new RelayCliError('用法：session herdr prepare|stop，或 workspace|tab|pane|agent <子命令> [参数]。', 2, 'HERDR_INVALID_COMMAND');
  }
  if (options.some(arg => /^(?:--env=)?HERDR_/i.test(arg))) throw new RelayCliError('不能通过 --env 伪造 Herdr 身份或路由。', 2, 'HERDR_SCOPE_OVERRIDE');
  const [group, action, target] = args;
  if (group === 'pane' && action !== 'list' && (!target || target.startsWith('-')) && !options.includes('--pane')) {
    throw new RelayCliError('pane 操作必须显式指定 pane ID 或 --pane ID。', 2, 'HERDR_TARGET_REQUIRED');
  }
  if (group === 'tab' && action === 'create' && !options.includes('--workspace')) {
    throw new RelayCliError('tab create 必须显式指定 --workspace ID。', 2, 'HERDR_TARGET_REQUIRED');
  }
}

export async function runHerdrCli(args: string[], options: RelayClientOptions = {}): Promise<void> {
  validateHerdrArguments(args);
  const client = new RelayHttpClient(options);
  const action = args[0] === 'stop' ? 'stop' : 'prepare';
  const scope = await client.post('/sessions/self/herdr', { action }) as unknown as HerdrScope;
  if (args[0] === 'prepare' || args[0] === 'stop') { process.stdout.write(`${JSON.stringify(scope)}\n`); return; }
  // Session name and executable come from the host, never CLI arguments or HERDR_*.
  if (!/^dutydeck-[a-f0-9]{32}$/.test(scope.session_name) || !scope.binary || typeof scope.socket_path !== 'string' || !isAbsolute(scope.socket_path)) throw new RelayCliError('Dutydeck 返回了无效的 Herdr 路由。', 3, 'HERDR_INVALID_SCOPE');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(scope.binary, args, { env: { ...withoutHerdrEnvironment(options.env ?? process.env), HERDR_SOCKET_PATH: scope.socket_path }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => { if (signal) reject(new RelayCliError(`Herdr 被信号 ${signal} 终止。`, 3, 'HERDR_INTERRUPTED')); else { process.exitCode = code ?? 1; resolve(); } });
  });
}
