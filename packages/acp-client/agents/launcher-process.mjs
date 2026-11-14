import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const reportKey = 'dutydeck_launcher_report';

// Nested launchers stay in the outer launcher's group so escalation cannot
// kill an intermediate wrapper while leaving the actual Agent alive.
export function launchAgent(command, args, env, options = {}) {
  const ownGroup = process.platform !== 'win32' && env.dutydeck_launcher_group !== '1';
  const childEnv = { ...env, dutydeck_launcher_group: '1' };
  delete childEnv[reportKey];
  const child = spawn(command, args, {
    cwd: process.cwd(), stdio: options.stdio ?? 'inherit', detached: ownGroup, env: childEnv
  });
  const report = ownGroup && child.pid ? reportGroup(process.env[reportKey], child.pid) : undefined;
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
  // Pipe endpoints isolate native writers from Node's nonblocking output fd.
  // Forward with backpressure and keep the launcher alive until the tail drains.
  const output = Promise.all([
    [child.stdout, process.stdout], [child.stderr, process.stderr]
  ].map(async ([source, target]) => {
    if (!source) return;
    await pipeline(source, target, { end: false });
    // With end:false the pipeline can finish while the destination still buffers.
    await new Promise((resolve, reject) => target.write('', error => error ? reject(error) : resolve()));
  }));
  void output.catch(() => process.kill(process.pid, 'SIGTERM'));
  child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.once('exit', async (code, signal) => {
    clearTimeout(escalation);
    if (ownGroup) {
      signalChild('SIGKILL');
      // A normal launcher exit certifies group cleanup. If this never becomes
      // provable, ACPX may kill the launcher; the adapter treats that as unknown.
      while (groupAlive(child.pid)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const drained = await output.then(() => true, () => false);
    if (report) rmSync(report, { force: true });
    process.exit(signal ? 128 + (constants.signals[signal] ?? 1) : drained ? code ?? 1 : 1);
  });
  return child;
}

// The adapter samples this launcher's children only periodically. If ACPX kills
// the launcher first, this file is the only record of the detached Agent group.
// It is keyed by the launcher's PID and start time so a reused PID never reads it.
function reportGroup(directory, pid) {
  const self = startTime('self'), agent = startTime(pid);
  if (!directory || !self || !agent) return;
  const file = join(directory, `${process.pid}.${self}`);
  try {
    writeFileSync(file, `${pid} ${agent}\n`, { mode: 0o600 });
    return file;
  } catch (error) { process.stderr.write(`Agent process report failed: ${error.code}\n`); }
}

function startTime(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return undefined; }
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
