import { appendFileSync, existsSync, openSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [scope, action, unit] = process.argv.slice(2);
const root = process.env.TEST_RUNTIME_ROOT;
const expectedUnit = process.env.TEST_RUNTIME_UNIT;
appendFileSync(process.env.TEST_SYSTEMCTL_CALLS, JSON.stringify({ scope, action, unit }) + '\n');
if (scope !== '--user' || unit !== expectedUnit) throw new Error(`Unexpected systemctl target: ${unit}`);
const stateFile = join(root, '.dutydeck/daemon/dutydeck.state.json');
function state() {
  const text = existsSync(stateFile) ? readFileSync(stateFile, 'utf8').trim() : '';
  return text ? JSON.parse(text) : undefined;
}
if (action === 'show') {
  console.log([
    'LoadState=loaded',
    `SubState=${state()?.ready ? 'running' : 'dead'}`,
    `MainPID=${state()?.pid ?? 0}`,
    `Environment=DUTYDECK_SUPERVISOR=systemd DUTYDECK_SYSTEMD_UNIT=${expectedUnit}`,
    `WorkingDirectory=${root}`,
    `ExecStart={ path=${process.execPath} ; argv[]=${process.execPath} ${process.env.TEST_RUNTIME_CLI} start --foreground ; ignore_errors=no ; }`
  ].join('\n'));
} else if (action === 'start') {
  const log = openSync(join(root, 'fixture-server.log'), 'a');
  const child = spawn(process.execPath, ['--conditions=development', '--import', process.env.TEST_TSX_LOADER, process.env.TEST_RUNTIME_CLI, 'start', '--foreground'], {
    cwd: root,
    env: { ...process.env, DUTYDECK_SUPERVISOR: 'systemd' },
    detached: true,
    stdio: ['ignore', log, log]
  });
  child.unref();
} else if (action === 'stop') {
  const pid = state()?.pid;
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
} else throw new Error(`Unexpected systemctl action: ${action}`);
