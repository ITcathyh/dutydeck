import { spawn } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const reportKey = 'dutydeck_launcher_report';
const cleanupUnknownExitCode = 120;
const cleanupProofTimeoutMs = 5000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Nested launchers stay in the outer launcher's group so escalation cannot
// kill an intermediate wrapper while leaving the actual Agent alive.
export function launchAgent(command, args, env, options = {}) {
  const ownGroup = process.platform !== 'win32' && env.dutydeck_launcher_group !== '1';
  const childEnv = { ...env, dutydeck_launcher_group: '1' };
  delete childEnv[reportKey];
  const child = spawn(command, args, {
    cwd: process.cwd(), stdio: options.stdio ?? ['inherit', 'pipe', 'pipe'], detached: ownGroup, env: childEnv
  });
  const report = ownGroup && child.pid ? reportGroup(process.env[reportKey], child.pid) : undefined;
  const cleanup = { sourcesClosed: false, destinationFlushed: false, groupExited: !ownGroup };
  const updateCleanup = () => {
    for (const stream of streams) stream.refresh();
    cleanup.sourcesClosed = streams.every(stream => stream.state.sourcesClosed);
    cleanup.destinationFlushed = streams.every(stream => stream.state.destinationFlushed);
  };
  let escalation;
  let finishing = false;
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
  // Source EOF and destination completion are separate: a slow destination is
  // normal backpressure, not evidence that an inherited source was left open.
  const streams = [[child.stdout, process.stdout], [child.stderr, process.stderr]]
    .filter(([source]) => source)
    .map(([source, target]) => forwardOutput(source, target));
  const output = Promise.all(streams.map(stream => stream.flushed));
  void output.catch(() => { if (!finishing) process.kill(process.pid, 'SIGTERM'); });

  child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.once('exit', async (code, signal) => {
    clearTimeout(escalation);
    const exit = () => signal ? 128 + (constants.signals[signal] ?? 1) : code ?? 1;
    try {
      // These proofs start together. Destination backpressure pauses only the
      // inherited-source budget; it never gets a five-second truncation budget.
      await Promise.all([proveGroupExit(), proveSourcesClosed()]);
      await output;
    } catch (error) {
      updateCleanup();
      if (error?.dutydeckCleanupUnknown || (report && !cleanup.groupExited)) {
        finishCleanupUnknown(Boolean(error?.dutydeckCleanupUnknown));
        return;
      }
      if (report && cleanup.groupExited) rmSync(report, { force: true });
      process.exit(signal ? exit() : 1);
      return;
    }
    updateCleanup();
    if (report && cleanup.groupExited) rmSync(report, { force: true });
    process.exit(exit());
  });

  function forwardOutput(source, target) {
    const state = { sourcesClosed: false, destinationFlushed: true, backpressure: false, failure: undefined, activity: 0 };
    let sourceSettled;
    const sourceDone = new Promise(resolve => { sourceSettled = resolve; });
    source.on('data', () => { state.activity++; });
    source.once('end', () => { state.sourcesClosed = true; sourceSettled(); });
    source.once('close', sourceSettled);
    const flushed = (async () => {
      try {
        await pipeline(source, target, { end: false });
        // With end:false the pipeline can finish while the destination still buffers.
        await new Promise((resolve, reject) => target.write('', error => error ? reject(error) : resolve()));
      } catch (error) {
        state.failure = error;
        sourceSettled();
        throw error;
      }
    })();
    const refresh = () => {
      state.backpressure = target.writableNeedDrain;
      state.destinationFlushed = !target.writableNeedDrain && target.writableLength === 0;
    };
    return { state, sourceDone, flushed, refresh };
  }

  async function proveSourcesClosed() {
    const remaining = streams.map(() => cleanupProofTimeoutMs);
    const activity = streams.map(() => 0);
    let previous = Date.now();
    for (;;) {
      const failed = streams.find(stream => stream.state.failure);
      if (failed) throw failed.state.failure;
      updateCleanup();
      if (cleanup.sourcesClosed) return;
      const now = Date.now();
      const elapsed = now - previous;
      previous = now;
      for (let index = 0; index < streams.length; index++) {
        const state = streams[index].state;
        if (activity[index] !== state.activity) {
          activity[index] = state.activity;
          remaining[index] = cleanupProofTimeoutMs;
        }
        if (state.sourcesClosed || state.failure || state.backpressure || !state.destinationFlushed) continue;
        remaining[index] -= elapsed;
        if (remaining[index] <= 0) throw cleanupUnknown();
      }
      await Promise.race([Promise.all(streams.map(stream => stream.sourceDone)), delay(25)]);
    }
  }

  async function proveGroupExit() {
    if (!ownGroup) return;
    signalChild('SIGKILL');
    const deadline = Date.now() + cleanupProofTimeoutMs;
    while (groupAlive(child.pid)) {
      if (Date.now() >= deadline) throw cleanupUnknown();
      await delay(10);
    }
    cleanup.groupExited = true;
  }

  function finishCleanupUnknown(timedOut) {
    finishing = true;
    // Only launcher-owned sources are destroyed. Shared output targets remain
    // writable for this diagnostic and for their other users.
    child.stdout?.destroy();
    child.stderr?.destroy();
    updateCleanup();
    const state = JSON.stringify(cleanup);
    if (report) {
      try { appendFileSync(report, `dutydeck_cleanup_unknown ${state}\n`, { mode: 0o600 }); }
      catch (error) { process.stderr.write(`Agent process report failed: ${error.code}\n`); }
    }
    // The reserved code alone is not enough: the adapter also requires this
    // exact report marker, so an ordinary Agent exit with the same number stays ordinary.
    process.stderr.write(`Agent post-exit cleanup ${timedOut ? `timed out after ${cleanupProofTimeoutMs}ms` : 'failed'}; sourcesClosed=${cleanup.sourcesClosed} destinationFlushed=${cleanup.destinationFlushed} groupExited=${cleanup.groupExited}\n`);
    process.exit(cleanupUnknownExitCode);
  }

  return child;
}

function cleanupUnknown() {
  return Object.assign(new Error('Agent post-exit cleanup proof timed out'), { dutydeckCleanupUnknown: true });
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
