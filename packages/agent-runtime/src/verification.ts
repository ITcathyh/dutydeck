import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigRepository, VerificationCommandInput, VerificationRecord, VerificationResponse } from '@dutydeck/shared';
import { makeId, now, RuntimeError } from '@dutydeck/shared';
import { minimalToolEnvironment } from './process-environment.js';

const runFile = promisify(execFile);
const VERIFICATION_KEY_PREFIX = 'runtime_verification:';
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 900;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MIN_REDACTED_VALUE_BYTES = 8;
const SENSITIVE_ENVIRONMENT_KEY = /token|secret|password|api[_-]?key|authorization|cookie/i;
const REDACTION = Buffer.from('[REDACTED]');

interface VerificationProcessIdentity {
  platform: 'linux';
  pid: number;
  processGroupId: number;
  startTimeTicks: string;
  marker: string;
}

interface StoredVerificationRecord extends VerificationRecord {
  processStage?: 'awaiting_process' | 'command_started';
  processIdentity?: VerificationProcessIdentity;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await runFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...minimalToolEnvironment(), GIT_TERMINAL_PROMPT: '0' }
    });
    return stdout;
  } catch (error) {
    throw new RuntimeError('VERIFICATION_NOT_GIT', error instanceof Error ? error.message : String(error), 422);
  }
}

function included(path: string): boolean {
  return path.split('/').every(segment => segment !== '.dutydeck');
}

/** Hash HEAD plus every tracked and non-ignored untracked path and its current content. */
export async function repositoryFingerprint(cwd: string): Promise<string> {
  return fingerprintRepository(cwd, new Set());
}

async function fingerprintRepository(cwd: string, seenRoots: Set<string>): Promise<string> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const canonicalRoot = await realpath(root);
  if (seenRoots.has(canonicalRoot)) throw new RuntimeError('VERIFICATION_FINGERPRINT_FAILED', `Recursive Git repository detected: ${canonicalRoot}`, 409);
  seenRoots.add(canonicalRoot);
  const head = (await git(canonicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const tracked = (await git(canonicalRoot, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const untracked = (await git(canonicalRoot, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const paths = [...new Set([...tracked, ...untracked].filter(included))].sort();
  const hash = createHash('sha256').update('dutydeck-code-v1\0').update(head).update('\0');
  for (const path of paths) {
    const absolute = join(canonicalRoot, path);
    let info;
    try { info = await lstat(absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        hash.update(path).update('\0missing\0');
        continue;
      }
      throw new RuntimeError('VERIFICATION_FINGERPRINT_FAILED', `Unable to fingerprint ${path}: ${error instanceof Error ? error.message : String(error)}`, 409);
    }
    hash.update(path).update('\0').update(String(info.mode & 0o7777)).update('\0');
    if (info.isSymbolicLink()) hash.update('link\0').update(await readlink(absolute));
    else if (info.isFile()) hash.update('file\0').update(await readFile(absolute));
    else if (info.isDirectory()) {
      // A tracked directory is a submodule. Recurse so dirty tracked and
      // untracked submodule content cannot retain a false-current fingerprint.
      hash.update('gitlink\0').update(await fingerprintRepository(absolute, seenRoots));
    } else throw new RuntimeError('VERIFICATION_FINGERPRINT_FAILED', `Unsupported repository entry: ${path}`, 409);
    hash.update('\0');
  }
  seenRoots.delete(canonicalRoot);
  return hash.digest('hex');
}

function key(sessionId: string, verificationId: string) {
  return `${VERIFICATION_KEY_PREFIX}${sessionId}:${verificationId}`;
}

function parse(raw: string): StoredVerificationRecord {
  try { return JSON.parse(raw) as StoredVerificationRecord; }
  catch { throw new RuntimeError('VERIFICATION_RECORD_INVALID', 'Verification record is invalid', 500); }
}

export class VerificationManager {
  private readonly controllers = new Set<AbortController>();
  private readonly runs = new Set<Promise<VerificationResponse>>();

  constructor(private readonly config: ConfigRepository) {}

  private async replace(record: StoredVerificationRecord, expected?: StoredVerificationRecord): Promise<void> {
    const storageKey = key(record.sessionId, record.id);
    const expectedRaw = expected ? JSON.stringify(expected) : undefined;
    if (this.config.compareAndSet) {
      if (!await this.config.compareAndSet(storageKey, expectedRaw, JSON.stringify(record))) {
        throw new RuntimeError('VERIFICATION_CONFLICT', 'Verification state changed concurrently', 409);
      }
      return;
    }
    if (await this.config.get(storageKey) !== expectedRaw) throw new RuntimeError('VERIFICATION_CONFLICT', 'Verification state changed concurrently', 409);
    await this.config.set(storageKey, JSON.stringify(record));
  }

  async interruptRunning(): Promise<Map<string, string>> {
    const blocked = new Map<string, string>();
    if (!this.config.list) return blocked;
    for (const { value } of await this.config.list(VERIFICATION_KEY_PREFIX)) {
      const record = parse(value);
      if (record.status !== 'running') continue;
      const recoveryError = await stopPersistedProcess(record);
      if (recoveryError) {
        blocked.set(record.sessionId, recoveryError);
        const retained = { ...record, revision: record.revision + 1, error: recoveryError };
        try { await this.replace(retained, record); } catch (error) {
          if (!(error instanceof RuntimeError && error.code === 'VERIFICATION_CONFLICT')) throw error;
        }
        continue;
      }
      const interrupted: VerificationRecord = {
        ...record, revision: record.revision + 1, status: 'interrupted', completedAt: now(),
        error: 'Dutydeck restarted while verification was running'
      };
      try { await this.replace(interrupted, record); } catch (error) {
        if (!(error instanceof RuntimeError && error.code === 'VERIFICATION_CONFLICT')) throw error;
      }
    }
    return blocked;
  }

  async list(sessionId: string, cwd: string): Promise<VerificationResponse[]> {
    if (!this.config.list) return [];
    const records = (await this.config.list(`${VERIFICATION_KEY_PREFIX}${sessionId}:`)).map(item => parse(item.value));
    let current: string | undefined;
    try { current = await repositoryFingerprint(cwd); } catch { /* Unknown code state is conservatively stale. */ }
    return records
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(record => {
        const { processStage: _processStage, processIdentity: _processIdentity, ...visible } = record;
        return {
        ...visible,
        stale: !current || !record.beforeFingerprint || !record.afterFingerprint
          || record.beforeFingerprint !== record.afterFingerprint
          || current !== record.afterFingerprint
      }; });
  }

  run(sessionId: string, cwd: string, input: VerificationCommandInput, actorId?: string, taskId?: string, beforeCommand?: () => Promise<void>): Promise<VerificationResponse> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const run = this.execute(sessionId, cwd, input, actorId, taskId, controller.signal, beforeCommand);
    this.runs.add(run);
    const cleanup = () => { this.controllers.delete(controller); this.runs.delete(run); };
    void run.then(cleanup, cleanup);
    return run;
  }

  async stop(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.runs]);
  }

  private async execute(sessionId: string, cwd: string, input: VerificationCommandInput, actorId: string | undefined, taskId: string | undefined, signal: AbortSignal, beforeCommand?: () => Promise<void>): Promise<VerificationResponse> {
    if (!input || typeof input !== 'object' || typeof input.command !== 'string') {
      throw new RuntimeError('VERIFICATION_COMMAND_REQUIRED', 'Verification command must be a string', 400);
    }
    const command = input.command.trim();
    if (!command) throw new RuntimeError('VERIFICATION_COMMAND_REQUIRED', 'Verification command must not be empty', 400);
    const requestedTimeout = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (!Number.isInteger(requestedTimeout) || requestedTimeout < 1 || requestedTimeout > MAX_TIMEOUT_SECONDS) {
      throw new RuntimeError('VERIFICATION_TIMEOUT_INVALID', `Verification timeout must be between 1 and ${MAX_TIMEOUT_SECONDS} seconds`, 400);
    }
    if (process.platform !== 'linux') throw new RuntimeError('VERIFICATION_PLATFORM_UNAVAILABLE', 'Verification process recovery currently requires Linux', 503);
    const timeoutSeconds = Math.trunc(requestedTimeout);
    const secrets = sensitiveProcessValues();
    const persistedCommand = redact(Buffer.from(command), secrets).toString('utf8');
    const beforeFingerprint = await repositoryFingerprint(cwd);
    // Recheck external authority after fingerprinting, immediately before the process can start.
    await beforeCommand?.();
    let active: StoredVerificationRecord = {
      schemaVersion: 1, revision: 1, id: makeId('verification'), sessionId, ...(taskId ? { taskId } : {}), command: persistedCommand, cwd,
      ...(actorId ? { actorId } : {}), status: 'running', startedAt: now(), output: '',
      outputTruncated: false, beforeFingerprint, processStage: 'awaiting_process'
    };
    await this.replace(active);

    let result: { exitCode?: number; output: string; outputTruncated: boolean; timedOut: boolean; interrupted: boolean; error?: string };
    try {
      result = await runCommand(command, cwd, timeoutSeconds * 1_000, signal, secrets, async identity => {
        const identified: StoredVerificationRecord = { ...active, revision: active.revision + 1, processStage: 'command_started', processIdentity: identity };
        await this.replace(identified, active);
        active = identified;
      });
    }
    catch (error) { result = { output: '', outputTruncated: false, timedOut: false, interrupted: signal.aborted, error: error instanceof Error ? error.message : String(error) }; }
    let afterFingerprint: string | undefined;
    let fingerprintError: string | undefined;
    try { afterFingerprint = await repositoryFingerprint(cwd); }
    catch (error) { fingerprintError = error instanceof Error ? error.message : String(error); }
    const changedDuringRun = Boolean(afterFingerprint && beforeFingerprint !== afterFingerprint);
    const evidenceError = fingerprintError ?? (changedDuringRun ? 'Repository content changed during verification' : undefined);
    const retainedError = evidenceError || result.error
      ? redact(Buffer.from(evidenceError ?? result.error!), secrets).toString('utf8')
      : undefined;
    const status = result.interrupted ? 'interrupted' as const
      : evidenceError ? 'unverified' as const
      : result.timedOut ? 'timed_out' as const
      : result.error || result.exitCode !== 0 ? 'failed' as const
      : 'passed' as const;
    const completed: StoredVerificationRecord = {
      ...active, revision: active.revision + 1, status, completedAt: now(),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      output: result.output, outputTruncated: result.outputTruncated,
      ...(afterFingerprint ? { afterFingerprint } : {}),
      ...(retainedError ? { error: retainedError } : {})
    };
    await this.replace(completed, active);
    const { processStage: _processStage, processIdentity: _processIdentity, ...visible } = completed;
    return { ...visible, stale: !afterFingerprint || beforeFingerprint !== afterFingerprint };
  }
}

function sensitiveProcessValues(): Buffer[] {
  const values = new Map<string, Buffer>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || !SENSITIVE_ENVIRONMENT_KEY.test(key)) continue;
    const encoded = Buffer.from(value);
    if (encoded.length < MIN_REDACTED_VALUE_BYTES) continue;
    values.set(encoded.toString('base64'), encoded);
  }
  return [...values.values()].sort((left, right) => right.length - left.length);
}

function redact(input: Buffer, secrets: Buffer[]): Buffer {
  let current = input;
  for (const secret of secrets) {
    const chunks: Buffer[] = [];
    let offset = 0;
    let match = current.indexOf(secret, offset);
    if (match < 0) continue;
    while (match >= 0) {
      chunks.push(current.subarray(offset, match), REDACTION);
      offset = match + secret.length;
      match = current.indexOf(secret, offset);
    }
    chunks.push(current.subarray(offset));
    current = Buffer.concat(chunks);
  }
  return current;
}

async function readLinuxProcessIdentity(pid: number, marker: string): Promise<VerificationProcessIdentity | undefined> {
  try {
    const [stat, cmdline] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`)
    ]);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const processGroupId = Number(fields[2]);
    const startTimeTicks = fields[19];
    if (!Number.isSafeInteger(processGroupId) || !startTimeTicks || !cmdline.includes(Buffer.from(marker))) return undefined;
    return { platform: 'linux', pid, processGroupId, startTimeTicks, marker };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function processGroupExists(processGroupId: number): boolean {
  try { process.kill(-processGroupId, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

async function stopPersistedProcess(record: StoredVerificationRecord): Promise<string | undefined> {
  if (record.processStage === 'awaiting_process' && !record.processIdentity) return undefined;
  const identity = record.processIdentity;
  if (!identity || identity.platform !== 'linux') return 'Verification process identity is missing; automatic recovery is unsafe';
  if (process.platform !== 'linux') return 'Verification process recovery currently requires Linux';
  if (!processGroupExists(identity.processGroupId)) return undefined;
  const actual = await readLinuxProcessIdentity(identity.pid, identity.marker);
  if (!actual || actual.processGroupId !== identity.processGroupId || actual.startTimeTicks !== identity.startTimeTicks) {
    return 'Verification process identity changed while its process group is still alive; refusing to kill an unverified process';
  }
  try { process.kill(-identity.processGroupId, 'SIGKILL'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return `Unable to stop the recovered verification process: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!await waitForProcessGroupExit(identity.processGroupId)) return 'Recovered verification process group did not exit; Session remains blocked';
  return undefined;
}

function runCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal, secrets: Buffer[], onIdentity: (identity: VerificationProcessIdentity) => Promise<void>): Promise<{ exitCode?: number; output: string; outputTruncated: boolean; timedOut: boolean; interrupted: boolean; error?: string }> {
  return new Promise(resolve => {
    const safetyMargin = Math.max(0, ...secrets.map(secret => secret.length - 1));
    const captureLimit = MAX_OUTPUT_BYTES + safetyMargin;
    const marker = makeId('dutydeck_verification_process');
    const child = spawn('/bin/sh', ['-s', '--', marker], { cwd, detached: true, env: minimalToolEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let interrupted = false;
    let terminated = false;
    let spawnError: string | undefined;
    const capture = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = captureLimit - bytes;
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        chunks.push(kept); bytes += kept.length;
      }
      if (buffer.length > remaining) outputTruncated = true;
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', error => { spawnError = error.message; });
    const terminate = () => {
      terminated = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Process already exited. */ }
    };
    const onAbort = () => { interrupted = true; terminate(); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref?.();
    child.once('spawn', () => {
      void (async () => {
        const identity = child.pid ? await readLinuxProcessIdentity(child.pid, marker) : undefined;
        if (!identity || identity.processGroupId !== child.pid) throw new Error('Unable to establish verification process identity');
        await onIdentity(identity);
        if (terminated || signal.aborted) { terminate(); return; }
        child.stdin?.end(command + '\n');
      })().catch(error => {
        spawnError = error instanceof Error ? error.message : String(error);
        child.stdin?.destroy();
        terminate();
      });
    });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const raw = Buffer.concat(chunks);
      const redacted = redact(raw, secrets);
      if (raw.length > MAX_OUTPUT_BYTES || redacted.length > MAX_OUTPUT_BYTES) outputTruncated = true;
      const output = redacted.subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
      resolve({ ...(code !== null ? { exitCode: code } : {}), output, outputTruncated, timedOut, interrupted, ...(spawnError ? { error: spawnError } : {}) });
    });
  });
}
