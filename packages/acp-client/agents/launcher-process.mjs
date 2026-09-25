import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';

// Nested launchers stay in the outer launcher's group so escalation cannot
// kill an intermediate wrapper while leaving the actual Agent alive.
export function launchAgent(command, args, env) {
  const ownGroup = process.platform !== 'win32' && env.dutydeck_launcher_group !== '1';
  const child = spawn(command, args, {
    cwd: process.cwd(), stdio: 'inherit', detached: ownGroup,
    env: { ...env, dutydeck_launcher_group: '1' }
  });
  let escalation;
  const signalChild = signal => {
    if (!child.pid) return;
    try {
      if (ownGroup) process.kill(-child.pid, signal);
      else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') process.stderr.write(`Agent cleanup failed: ${error.code}\n`);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
    signalChild(signal);
    escalation ??= setTimeout(() => signalChild('SIGKILL'), 500);
  });
  child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.once('exit', async (code, signal) => {
    clearTimeout(escalation);
    if (ownGroup) {
      signalChild('SIGKILL');
      // A normal launcher exit certifies group cleanup. If this never becomes
      // provable, ACPX may kill the launcher; the adapter treats that as unknown.
      while (groupAlive(child.pid)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    process.exit(signal ? 128 + (constants.signals[signal] ?? 1) : code ?? 1);
  });
}

function groupAlive(group) {
  try {
    process.kill(-group, 0);
    if (process.platform !== 'linux') return true;
    for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === group && !['Z', 'X'].includes(fields[0])) return true;
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) return true;
      }
    }
    return false;
  } catch (error) { return error.code !== 'ESRCH'; }
}
