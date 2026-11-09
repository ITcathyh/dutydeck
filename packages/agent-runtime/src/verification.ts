import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfigRepository, VerificationCommandInput, VerificationRecord, VerificationResponse } from '@dutydeck/shared';
import { makeId, mapLimit, now, RuntimeError, parseProcStat, procStatExited } from '@dutydeck/shared';
import { SAFE_GIT_CONFIG } from '@dutydeck/shared/safe-git';
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

interface CommandResult {
  exitCode?: number;
  output: string;
  outputTruncated: boolean;
  timedOut: boolean;
  interrupted: boolean;
  error?: string;
  cleanupError?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    // ls-files and rev-parse never run filter drivers; a command reading work tree content would need safeGitConfigFor.
    const { stdout } = await runFile('git', ['-C', cwd, ...SAFE_GIT_CONFIG, ...args], {
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
  return contentFingerprint(await scanRepository(cwd, new Set(), { latestChangeMs: 0 }));
}

/**
 * Files changed this close to a fingerprint may share a timestamp with a later
 * same-size rewrite, so their stat cannot prove the content is unchanged.
 */
const RACY_WINDOW_MS = 2_000;
let racyWindowMs = RACY_WINDOW_MS;
/** Test hook: shortens the racy window; call with no argument to restore it. */
export const setRacyWindowForTest = (ms = RACY_WINDOW_MS) => { racyWindowMs = ms; };
/** Entries are statted ENTRY_CHUNK at a time and their content read ENTRY_CONCURRENCY at a time, so a large tree is never held in memory at once. */
const ENTRY_CHUNK = 256;
const ENTRY_CONCURRENCY = 16;
/** Per-directory cache, least recently used first: worktrees and scratch directories come and go for the daemon's lifetime. */
const FINGERPRINT_CACHE_LIMIT = 256;
const fingerprintCache = new Map<string, { stamp: string; fingerprint: string }>();
function rememberFingerprint(cwd: string, entry: { stamp: string; fingerprint: string }) {
  fingerprintCache.delete(cwd); fingerprintCache.set(cwd, entry);
  while (fingerprintCache.size > FINGERPRINT_CACHE_LIMIT) fingerprintCache.delete(fingerprintCache.keys().next().value!);
}
const fingerprintRuns = new Map<string, Promise<string>>();
/** Test hook: how many directories the read-path cache currently holds. */
export const fingerprintCacheSizeForTest = () => fingerprintCache.size;

/**
 * repositoryFingerprint for read paths (record lists, turn-boundary comparisons).
 * One walk lists every repository and stats each entry (the stamp); while that
 * stamp matches the last cached one the content is not read again, otherwise the
 * same listing is read for content. Only results whose entries are all older than
 * the racy window are cached or shared with concurrent callers: their stamp
 * proves the content each caller would read is the content already being read.
 * Verification evidence (before/after a command) must keep calling
 * repositoryFingerprint directly.
 */
export async function cachedRepositoryFingerprint(cwd: string): Promise<string> {
  const startedAt = Date.now();
  const changes = { latestChangeMs: 0 };
  let scan: Awaited<ReturnType<typeof scanRepository>>;
  try { scan = await scanRepository(cwd, new Set(), changes); }
  catch (error) { fingerprintCache.delete(cwd); throw error; }
  const cached = fingerprintCache.get(cwd);
  if (cached?.stamp === scan.stamp) { rememberFingerprint(cwd, cached); return cached.fingerprint; }
  // Racily recent entries: a rewrite may keep the same stat, so neither cache nor share.
  if (changes.latestChangeMs >= startedAt - racyWindowMs) return contentFingerprint(scan);
  const runKey = `${cwd}\0${scan.stamp}`;
  const shared = fingerprintRuns.get(runKey);
  if (shared) return shared;
  // Content is read after the stat it is keyed by. Any later change moves ctime,
  // so this stamp cannot be observed again with different content.
  const run = contentFingerprint(scan).then(fingerprint => {
    rememberFingerprint(cwd, { stamp: scan.stamp, fingerprint });
    return fingerprint;
  });
  fingerprintRuns.set(runKey, run);
  const forget = () => { if (fingerprintRuns.get(runKey) === run) fingerprintRuns.delete(runKey); };
  void run.then(forget, forget);
  return run;
}

type ScannedEntry =
  | { kind: 'missing' }
  | { kind: 'file'; mode: number }
  | { kind: 'link'; mode: number }
  | { kind: 'uninitialized'; mode: number; commit: string }
  | { kind: 'repository'; mode: number; scan: RepositoryScan };

interface RepositoryScan { root: string; head: string; paths: string[]; entries: ScannedEntry[]; stamp: string }

/** Lists a repository (recursing into submodules) and hashes each entry's stat instead of its content. */
async function scanRepository(cwd: string, seenRoots: Set<string>, changes: { latestChangeMs: number }): Promise<RepositoryScan> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const canonicalRoot = await realpath(root);
  if (seenRoots.has(canonicalRoot)) throw new RuntimeError('VERIFICATION_FINGERPRINT_FAILED', `Recursive Git repository detected: ${canonicalRoot}`, 409);
  seenRoots.add(canonicalRoot);
  const [headOutput, staged, others] = await Promise.all([
    git(canonicalRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(canonicalRoot, ['ls-files', '-s', '-z']),
    git(canonicalRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
  ]);
  const head = headOutput.trim();
  const gitlinks = new Map<string, string>();
  const tracked = staged.split('\0').filter(Boolean).map(entry => {
    const separator = entry.indexOf('\t');
    const [mode, object] = entry.slice(0, separator).split(' ');
    const path = entry.slice(separator + 1);
    if (mode === '160000') gitlinks.set(path, object!);
    return path;
  });
  const untracked = others.split('\0').filter(Boolean);
  const paths = [...new Set([...tracked, ...untracked].filter(included))].sort();
  const stamp = createHash('sha256').update('dutydeck-stat-v2\0').update(canonicalRoot).update('\0').update(head).update('\0');
  const entries: ScannedEntry[] = [];
  for (let start = 0; start < paths.length; start += ENTRY_CHUNK) {
    const chunk = paths.slice(start, start + ENTRY_CHUNK);
    const stats = await mapSettled(chunk, path => lstat(join(canonicalRoot, path), { bigint: true }));
    for (const [offset, path] of chunk.entries()) {
      const info = stats[offset]!;
      if (info instanceof Error) {
        if ((info as NodeJS.ErrnoException).code !== 'ENOENT') throw new RuntimeError('VERIFICATION_FINGERPRINT_FAILED', `Unable to fingerprint ${path}: ${info.message}`, 409);
        stamp.update(path).update('\0missing\0');
        entries.push({ kind: 'missing' });
        continue;
      }
      const mode = Number(info.mode) & 0o7777;
      stamp.update(path).update('\0').update(String(mode)).update('\0');
      if (info.isSymbolicLink() || info.isFile()) {
        const kind = info.isFile() ? 'file' : 'link';
        changes.latestChangeMs = Math.max(changes.latestChangeMs, Number(info.mtimeMs), Number(info.ctimeMs));
        stamp.update(`${kind}\0${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
        entries.push({ kind, mode });
      } else if (info.isDirectory()) {
        const absolute = join(canonicalRoot, path);
        const commit = gitlinks.get(path);
        // An empty gitlink directory is an uninitialized submodule (plain clone
        // or new worktree); its recorded commit is its whole code state.
        if (commit && (await readdir(absolute)).length === 0) {
          stamp.update('gitlink-uninitialized\0').update(commit);
          entries.push({ kind: 'uninitialized', mode, commit });
        } else {
          // A tracked directory is a submodule. Recurse so dirty tracked and
          // untracked submodule content cannot retain a false-current fingerprint.
          const nested = await scanRepository(absolute, seenRoots, changes);
          stamp.update('gitlink\0').update(nested.stamp);
          entries.push({ kind: 'repository', mode, scan: nested });
        }
      } else throw new RuntimeError('VERIFICATION_FINGERPRINT_FAILED', `Unsupported repository entry: ${path}`, 409);
      stamp.update('\0');
    }
  }
  seenRoots.delete(canonicalRoot);
  return { root: canonicalRoot, head, paths, entries, stamp: stamp.digest('hex') };
}

/** Reads the scanned listing for content; the hash format is unchanged from the original single walk. */
async function contentFingerprint(scan: RepositoryScan): Promise<string> {
  const hash = createHash('sha256').update('dutydeck-code-v1\0').update(scan.head).update('\0');
  const read = async (entry: ScannedEntry, path: string): Promise<[mode: number, tag: string, body: string | Buffer] | undefined> => {
    switch (entry.kind) {
      case 'missing': return undefined;
      case 'link': return [entry.mode, 'link\0', await readlink(join(scan.root, path))];
      case 'file': return [entry.mode, 'file\0', await readFile(join(scan.root, path))];
      case 'uninitialized': return [entry.mode, 'gitlink-uninitialized\0', entry.commit];
      case 'repository': return [entry.mode, 'gitlink\0', await contentFingerprint(entry.scan)];
    }
  };
  for (let start = 0; start < scan.paths.length; start += ENTRY_CONCURRENCY) {
    const chunk = scan.paths.slice(start, start + ENTRY_CONCURRENCY);
    const bodies = await mapSettled(chunk, (path, offset) => read(scan.entries[start + offset]!, path));
    for (const [offset, path] of chunk.entries()) {
      const body = bodies[offset];
      // Deleted since the scan: hash it the way a walk that found it missing would.
      if (body instanceof Error && (body as NodeJS.ErrnoException).code !== 'ENOENT') throw body;
      if (!body || body instanceof Error) hash.update(path).update('\0missing\0');
      else hash.update(path).update('\0').update(String(body[0])).update('\0').update(body[1]).update(body[2]).update('\0');
    }
  }
  return hash.digest('hex');
}

const mapSettled = <T>(items: readonly string[], task: (item: string, index: number) => Promise<T>): Promise<(T | Error)[]> =>
  mapLimit(items, ENTRY_CONCURRENCY, (item, index) => task(item, index).catch(error => error as Error));

function key(sessionId: string, verificationId: string) {
  return `${VERIFICATION_KEY_PREFIX}${sessionId}:${verificationId}`;
}

function parse(raw: string): StoredVerificationRecord {
  try { return JSON.parse(raw) as StoredVerificationRecord; }
  catch { throw new RuntimeError('VERIFICATION_RECORD_INVALID', 'Verification record is invalid', 500); }
}

function verificationFreshness(record: VerificationRecord, current?: string): Pick<VerificationResponse, 'stale' | 'staleReason'> {
  const staleReason = record.beforeFingerprint && record.afterFingerprint && record.beforeFingerprint !== record.afterFingerprint ? 'changed_during_run'
    : current && record.afterFingerprint && current !== record.afterFingerprint ? 'code_changed'
    : !current ? 'current_fingerprint_unavailable'
    : !record.beforeFingerprint || !record.afterFingerprint ? 'record_fingerprint_missing'
    : undefined;
  return { stale: Boolean(staleReason), ...(staleReason ? { staleReason } : {}) };
}

export class VerificationManager {
  private readonly controllers = new Map<AbortController, string>();
  private readonly runs = new Map<Promise<VerificationResponse>, string>();

  constructor(private readonly config: ConfigRepository, private readonly commit?: (sessionId: string, operation: () => Promise<void>) => Promise<void>) {}

  private replace(record: StoredVerificationRecord, expected?: StoredVerificationRecord): Promise<void> {
    const write = () => this.replaceRecord(record, expected);
    return this.commit ? this.commit(record.sessionId, write) : write();
  }
  private async replaceRecord(record: StoredVerificationRecord, expected?: StoredVerificationRecord): Promise<void> {
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
    // No records means nothing to compare; skip the full-repository fingerprint.
    if (records.length === 0) return [];
    let current: string | undefined;
    try { current = await cachedRepositoryFingerprint(cwd); } catch { /* Unknown code state is conservatively stale. */ }
    return records
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(record => {
        const { processStage: _processStage, processIdentity: _processIdentity, ...visible } = record;
        return { ...visible, ...verificationFreshness(record, current) };
      });
  }

  run(sessionId: string, cwd: string, input: VerificationCommandInput, actorId?: string, taskId?: string, beforeCommand?: () => Promise<void>, admitHeld?: () => Promise<void>): Promise<VerificationResponse> {
    const controller = new AbortController();
    this.controllers.set(controller, sessionId);
    const run = this.execute(sessionId, cwd, input, actorId, taskId, controller.signal, beforeCommand, admitHeld);
    this.runs.set(run, sessionId);
    const cleanup = () => { this.controllers.delete(controller); this.runs.delete(run); };
    void run.then(cleanup, cleanup);
    return run;
  }

  async stop(): Promise<void> {
    for (const controller of this.controllers.keys()) controller.abort();
    await Promise.allSettled([...this.runs.keys()]);
  }

  async stopSession(sessionId: string): Promise<void> {
    for (const [controller, id] of this.controllers) if (id === sessionId) controller.abort();
    await Promise.allSettled([...this.runs].filter(([, id]) => id === sessionId).map(([run]) => run));
  }

  private async execute(sessionId: string, cwd: string, input: VerificationCommandInput, actorId: string | undefined, taskId: string | undefined, signal: AbortSignal, beforeCommand?: () => Promise<void>, admitHeld?: () => Promise<void>): Promise<VerificationResponse> {
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
    // The running record now holds the workspace against new task claims; recheck work admitted before it.
    try { await admitHeld?.(); }
    catch (error) {
      await this.replace({ ...active, revision: active.revision + 1, status: 'interrupted', completedAt: now(), error: error instanceof Error ? error.message : String(error) }, active);
      throw error;
    }

    let result: CommandResult;
    try {
      result = await runCommand(command, cwd, timeoutSeconds * 1_000, signal, secrets, async identity => {
        const identified: StoredVerificationRecord = { ...active, revision: active.revision + 1, processStage: 'command_started', processIdentity: identity };
        await this.replace(identified, active);
        active = identified;
      });
    }
    catch (error) { result = { output: '', outputTruncated: false, timedOut: false, interrupted: signal.aborted, error: error instanceof Error ? error.message : String(error) }; }
    if (result.cleanupError) {
      const error = redact(Buffer.from(result.cleanupError), secrets).toString('utf8');
      await this.replace({ ...active, revision: active.revision + 1, output: result.output, outputTruncated: result.outputTruncated, error }, active);
      throw new RuntimeError('VERIFICATION_RECOVERY_BLOCKED', error, 409);
    }
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
    return { ...visible, ...verificationFreshness(completed, afterFingerprint) };
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
    const { pgid: processGroupId, start: startTimeTicks } = parseProcStat(stat);
    if (!Number.isSafeInteger(processGroupId) || !startTimeTicks || !cmdline.includes(Buffer.from(marker))) return undefined;
    return { platform: 'linux', pid, processGroupId, startTimeTicks, marker };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

async function processGroupExists(processGroupId: number): Promise<boolean> {
  try { process.kill(-processGroupId, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; }
  // Orphaned zombies may await PID 1 indefinitely, but can no longer execute.
  const entries = (await readdir('/proc')).filter(entry => /^\d+$/.test(entry));
  const live = await Promise.all(entries.map(async pid => {
    try {
      const stat = parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
      return stat.pgid === processGroupId && !procStatExited(stat);
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  }));
  return live.some(Boolean);
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await processGroupExists(processGroupId)) {
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
  if (!await processGroupExists(identity.processGroupId)) return undefined;
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

export interface IsolatedCommandResult {
  exitCode?: number;
  /** stdout 与 stderr 合并、按宿主环境中的敏感值脱敏后截到 maxOutputBytes。 */
  output: string;
  outputTruncated: boolean;
  timedOut: boolean;
  interrupted: boolean;
  /** 无法启动等执行错误（已脱敏）。 */
  error?: string;
  /** 进程组没能确认退出（已脱敏）。 */
  cleanupError?: string;
}

/**
 * 与交付前验证同一个执行器：`/bin/sh` 在独立进程组里执行命令，环境只有 minimalToolEnvironment()，
 * 超时或中止时整组 SIGKILL，结束后也收掉后台子进程。不写验证记录、不计算仓库指纹。
 */
export async function runIsolatedCommand(command: string, cwd: string, options: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }): Promise<IsolatedCommandResult> {
  const secrets = sensitiveProcessValues();
  const scrub = (text: string | undefined) => text === undefined ? undefined : redact(Buffer.from(text), secrets).toString('utf8');
  let result: CommandResult;
  try { result = await runCommand(command, cwd, options.timeoutMs, options.signal ?? new AbortController().signal, secrets, undefined, options.maxOutputBytes); }
  catch (error) { result = { output: '', outputTruncated: false, timedOut: false, interrupted: Boolean(options.signal?.aborted), error: error instanceof Error ? error.message : String(error) }; }
  const error = scrub(result.error);
  const cleanupError = scrub(result.cleanupError);
  return { ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}), output: result.output, outputTruncated: result.outputTruncated,
    timedOut: result.timedOut, interrupted: result.interrupted, ...(error ? { error } : {}), ...(cleanupError ? { cleanupError } : {}) };
}

/** onIdentity 缺省时不记录进程身份，直接写入命令（不需要跨重启找回进程的调用方）。 */
function runCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal, secrets: Buffer[], onIdentity?: (identity: VerificationProcessIdentity) => Promise<void>, maxOutputBytes = MAX_OUTPUT_BYTES): Promise<CommandResult> {
  return new Promise(resolve => {
    const safetyMargin = Math.max(0, ...secrets.map(secret => secret.length - 1));
    const captureLimit = maxOutputBytes + safetyMargin;
    const marker = makeId('dutydeck_verification_process');
    const child = spawn('/bin/sh', ['-s', '--', marker], { cwd, detached: true, env: minimalToolEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let interrupted = false;
    let terminated = false;
    let closed = false;
    let finishing = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let exitCode: number | undefined;
    let identityRun: Promise<void> | undefined;
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
      if (closed) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Process already exited. */ }
      // Failed signalling must still return a durable resource blocker.
      if (!closed && !cleanupTimer) cleanupTimer = setTimeout(() => { void finish(); }, 3_000);
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
      identityRun = (async () => {
        if (!onIdentity) {
          if (terminated || signal.aborted) { terminate(); return; }
          child.stdin?.end(command + '\n');
          return;
        }
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
      exitCode = code ?? undefined;
      // Redirected background children can outlive the shell and its pipes.
      terminate();
      closed = true;
      void finish();
    });
    async function finish() {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal.removeEventListener('abort', onAbort);
      // Process exit can precede the identity read/commit. Keep that continuation
      // inside the tracked run so stop/shutdown cannot close storage ahead of it.
      await identityRun;
      let cleanupError: string | undefined;
      try {
        if (child.pid && !await waitForProcessGroupExit(child.pid)) cleanupError = 'Verification process group did not exit; Session remains blocked';
      } catch (error) {
        cleanupError = `Unable to verify process group exit: ${error instanceof Error ? error.message : String(error)}`;
      }
      const raw = Buffer.concat(chunks);
      const redacted = redact(raw, secrets);
      if (raw.length > maxOutputBytes || redacted.length > maxOutputBytes) outputTruncated = true;
      const output = redacted.subarray(0, maxOutputBytes).toString('utf8');
      resolve({ ...(exitCode !== undefined ? { exitCode } : {}), output, outputTruncated, timedOut, interrupted, ...(spawnError ? { error: spawnError } : {}), ...(cleanupError ? { cleanupError } : {}) });
    }
  });
}
