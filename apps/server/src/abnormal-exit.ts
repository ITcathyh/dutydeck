import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { redactCredentialText } from '@dutydeck/shared';
import { writeFileAtomicSync } from './atomic-file.js';

/**
 * 上一次异常退出的本地记录：放在本次 serve 打开的数据库所在目录，并记下数据库实路径。
 * 位置只按数据库取，不走 daemon 目录和 ~/.dutydeck/last-daemon-dir：那个回退可能指向另一个实例。
 * doctor 只认数据库路径与自己解析出的一致的记录。
 */
export const abnormalExitFileName = 'last-abnormal-exit.json';
export const abnormalExitWindowMs = 7 * 24 * 60 * 60_000;
const abnormalHistoryLimit = 10;

export type AbnormalExitKind = 'fatal' | 'startup';
export interface ServeRunLifecycle {
  runId: string;
  pid: number;
  startedAt: string;
  version: string;
  phase: 'starting' | 'running';
  unit?: string;
  boot?: string;
}
export interface CleanExitRecord {
  runId: string;
  at: string;
  reason: 'stopped' | 'planned-restart';
  signal?: string;
}
export interface AbnormalExitRecord {
  at: string;
  kind: AbnormalExitKind;
  exitCode: number;
  /** 错误首行，已脱敏、截断。 */
  error: string;
  version: string;
  database: string;
  runId?: string;
  pid?: number;
  startedAt?: string;
  unit?: string;
  boot?: string;
  phase?: ServeRunLifecycle['phase'];
  signal?: string;
  source?: 'lifecycle' | 'process' | 'systemd-journal';
}
interface AbnormalExitDocument extends Record<string, unknown> {
  history?: unknown;
  lifecycle?: unknown;
  'clean-exit'?: unknown;
}
export interface JournalQueryRequest { unit: string; boot: string; pid: number; startedAt: string; until: string }
export type JournalQuery = (request: JournalQueryRequest) => Promise<Array<Record<string, unknown>>>;

const errorChars = 300;
// 库文件可能还不存在（启动早期失败），就只解析所在目录的符号链接。
const canonical = (path: string) => {
  try { return realpathSync(path); } catch { /* 文件不存在 */ }
  try { return join(realpathSync(dirname(path)), basename(path)); } catch { return resolve(path); }
};
const usableDatabase = (databaseUrl: string | undefined): databaseUrl is string => Boolean(databaseUrl) && databaseUrl !== ':memory:' && !databaseUrl!.startsWith('file:');

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message || error.name : String(error);
  const line = text.split(/\r?\n/).find(item => item.trim())?.trim() ?? '';
  const redacted = redactCredentialText(line);
  return redacted.length > errorChars ? `${redacted.slice(0, errorChars)}…` : redacted;
}

function optionalMetadata(record: AbnormalExitRecord, value: Record<string, unknown>): void {
  for (const key of ['runId', 'startedAt', 'unit', 'boot', 'signal'] as const) {
    if (typeof value[key] === 'string') record[key] = value[key];
  }
  if (typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0) record.pid = value.pid;
  if (value.phase === 'starting' || value.phase === 'running') record.phase = value.phase;
  if (value.source === 'lifecycle' || value.source === 'process' || value.source === 'systemd-journal') record.source = value.source;
}

function asRecord(value: unknown): AbnormalExitRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const parsed = value as Record<string, unknown>;
  if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || (parsed.kind !== 'fatal' && parsed.kind !== 'startup')) return undefined;
  if (typeof parsed.database !== 'string') return undefined;
  const record: AbnormalExitRecord = {
    at: parsed.at, kind: parsed.kind, exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : 1,
    error: typeof parsed.error === 'string' ? parsed.error : '', version: typeof parsed.version === 'string' ? parsed.version : '', database: parsed.database
  };
  optionalMetadata(record, parsed);
  return record;
}

function asLifecycle(value: unknown): ServeRunLifecycle | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const parsed = value as Record<string, unknown>;
  if (typeof parsed.runId !== 'string' || !parsed.runId || typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return undefined;
  if (typeof parsed.startedAt !== 'string' || !Number.isFinite(Date.parse(parsed.startedAt))) return undefined;
  return {
    runId: parsed.runId, pid: parsed.pid, startedAt: parsed.startedAt,
    version: typeof parsed.version === 'string' ? parsed.version : '', phase: parsed.phase === 'running' ? 'running' : 'starting',
    ...(typeof parsed.unit === 'string' ? { unit: parsed.unit } : {}), ...(typeof parsed.boot === 'string' ? { boot: parsed.boot } : {})
  };
}

function readDocument(file: string): AbnormalExitDocument {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AbnormalExitDocument : {};
  } catch { return {}; }
}

function sameLegacyRecord(left: AbnormalExitRecord, right: AbnormalExitRecord): boolean {
  return left.at === right.at && left.kind === right.kind && left.error === right.error && left.database === right.database;
}

function appendRecord(document: AbnormalExitDocument, record: AbnormalExitRecord): void {
  const history = (Array.isArray(document.history) ? document.history.map(asRecord).filter((entry): entry is AbnormalExitRecord => Boolean(entry)) : []);
  const top = asRecord(document);
  if (top) {
    const index = history.findIndex(entry => top.runId ? entry.runId === top.runId : sameLegacyRecord(entry, top));
    if (index >= 0) history[index] = top;
    else history.push(top);
  }
  const deduplicated = history.filter(entry => !record.runId || entry.runId !== record.runId);
  deduplicated.push(record);
  Object.assign(document, record);
  document.history = deduplicated.slice(-abnormalHistoryLimit);
}

function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

const lockPause = new Int32Array(new SharedArrayBuffer(4));
/** 有界跨进程锁；读改写必须在同一临界区，不能两个 PID 各自 rename 覆盖历史。 */
function withRecordLock(file: string, action: () => void): boolean {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, 'owner'), String(process.pid), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const owner = Number(readFileSync(join(lock, 'owner'), 'utf8'));
        if (Date.now() - statSync(lock).mtimeMs > 1_000 && (!owner || !defaultPidAlive(owner))) rmSync(lock, { recursive: true, force: true });
      } catch { /* 锁正在创建或已被释放，下轮重试。 */ }
      if (Date.now() >= deadline) return false;
      Atomics.wait(lockPause, 0, 0, 10);
    }
  }
  try { action(); return true; } finally { rmSync(lock, { recursive: true, force: true }); }
}

function updateDocument(databaseUrl: string | undefined, action: (document: AbnormalExitDocument, file: string) => void): boolean {
  if (!usableDatabase(databaseUrl)) return false;
  try {
    const database = canonical(databaseUrl), file = join(dirname(database), abnormalExitFileName);
    return withRecordLock(file, () => {
      const document = readDocument(file);
      action(document, file);
      writeFileAtomicSync(file, `${JSON.stringify(document)}\n`);
    });
  } catch { return false; }
}

/** 同步写入（进程马上要退出）。没有数据库路径时不写；写失败静默，不能盖过原本的致命错误。 */
export function recordAbnormalExit(databaseUrl: string | undefined, input: {
  kind: AbnormalExitKind; exitCode: number; error: unknown; version: string; now?: Date;
  lifecycle?: ServeRunLifecycle; signal?: string; source?: AbnormalExitRecord['source'];
}): void {
  if (!usableDatabase(databaseUrl)) return;
  const database = canonical(databaseUrl);
  const lifecycle = input.lifecycle;
  const record: AbnormalExitRecord = {
    at: (input.now ?? new Date()).toISOString(), kind: input.kind, exitCode: input.exitCode,
    error: firstLine(input.error), version: input.version, database,
    ...(lifecycle ? {
      runId: lifecycle.runId, pid: lifecycle.pid, startedAt: lifecycle.startedAt, phase: lifecycle.phase,
      ...(lifecycle.unit ? { unit: lifecycle.unit } : {}), ...(lifecycle.boot ? { boot: lifecycle.boot } : {})
    } : {}),
    ...(input.signal ? { signal: input.signal } : {}), ...(input.source ? { source: input.source } : {})
  };
  updateDocument(database, document => { appendRecord(document, record); });
}

function readBootId(): string | undefined {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; } catch { return undefined; }
}

/** 开始一代 serve；只同步写本地生命周期，journal 富集由调用方异步启动，不阻塞就绪。 */
export function beginServeRun(databaseUrl: string | undefined, input: {
  version: string; runId?: string; pid?: number; startedAt?: string; unit?: string; boot?: string; now?: Date;
}, dependencies: { isProcessAlive?: (pid: number) => boolean } = {}): { lifecycle: ServeRunLifecycle; previousRun?: ServeRunLifecycle } {
  const now = input.now ?? new Date();
  const lifecycle: ServeRunLifecycle = {
    runId: input.runId ?? randomUUID(), pid: input.pid ?? process.pid, startedAt: input.startedAt ?? now.toISOString(), version: input.version, phase: 'starting',
    ...(input.unit ? { unit: input.unit } : {}), ...(input.boot ?? readBootId() ? { boot: input.boot ?? readBootId()! } : {})
  };
  let previousRun: ServeRunLifecycle | undefined;
  updateDocument(databaseUrl, document => {
    const previous = asLifecycle(document.lifecycle);
    const clean = document['clean-exit'];
    const cleanRunId = clean && typeof clean === 'object' && !Array.isArray(clean) ? (clean as Record<string, unknown>).runId : undefined;
    if (previous && cleanRunId !== previous.runId) {
      const sameBoot = !previous.boot || !lifecycle.boot || previous.boot === lifecycle.boot;
      const alive = sameBoot && (dependencies.isProcessAlive ?? defaultPidAlive)(previous.pid);
      if (!alive) {
        previousRun = previous;
        const history = Array.isArray(document.history) ? document.history.map(asRecord) : [];
        const top = asRecord(document);
        if (top) history.push(top);
        if (!history.some(record => record?.runId === previous.runId)) {
          appendRecord(document, {
            at: now.toISOString(), kind: previous.phase === 'starting' ? 'startup' : 'fatal', exitCode: 1,
            error: 'Process exited without a clean-exit marker; cause pending journal enrichment',
            version: previous.version || input.version, database: canonical(databaseUrl!), runId: previous.runId, pid: previous.pid,
            startedAt: previous.startedAt, phase: previous.phase, source: 'lifecycle',
            ...(previous.unit ? { unit: previous.unit } : {}), ...(previous.boot ? { boot: previous.boot } : {})
          });
        }
      }
    }
    document.lifecycle = lifecycle;
  });
  return { lifecycle, ...(previousRun ? { previousRun } : {}) };
}

export function markServeRunning(databaseUrl: string | undefined, lifecycle: ServeRunLifecycle): ServeRunLifecycle {
  const running = { ...lifecycle, phase: 'running' as const };
  updateDocument(databaseUrl, document => {
    if (asLifecycle(document.lifecycle)?.runId === lifecycle.runId) document.lifecycle = running;
  });
  return running;
}

/** 只有仍属于同一 runId 的当前代才能写干净标记；迟到的上一代关闭不能覆盖新代。 */
export function recordCleanExit(databaseUrl: string | undefined, lifecycle: ServeRunLifecycle, input: {
  reason: CleanExitRecord['reason']; signal?: string; now?: Date;
}): void {
  updateDocument(databaseUrl, document => {
    if (asLifecycle(document.lifecycle)?.runId !== lifecycle.runId) return;
    const record: CleanExitRecord = { runId: lifecycle.runId, at: (input.now ?? new Date()).toISOString(), reason: input.reason, ...(input.signal ? { signal: input.signal } : {}) };
    document['clean-exit'] = record;
  });
}

async function defaultJournalQuery(request: JournalQueryRequest): Promise<Array<Record<string, unknown>>> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('journalctl', ['--user', `--unit=${request.unit}`, '--output=json', '--no-pager', '--boot', request.boot,
      '--since', request.startedAt, '--until', request.until], { timeout: 2_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
    (error, output) => error ? reject(error) : resolve(output));
  });
  return stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { const value = JSON.parse(line) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string, unknown>] : []; } catch { return []; }
  });
}

function journalTimestamp(entry: Record<string, unknown>): number | undefined {
  const microseconds = Number(entry.__REALTIME_TIMESTAMP);
  if (!Number.isFinite(microseconds)) return undefined;
  return Math.floor(microseconds / 1_000);
}

/** 仅接受同一 unit、boot、MAIN_PID，且时间落在该代启动之后的一条明确 SIGKILL 退出记录。 */
function exactSigkill(entries: Array<Record<string, unknown>>, run: ServeRunLifecycle, untilMs: number): number | undefined {
  if (!run.unit || !run.boot) return undefined;
  const matches = new Map<string, number>();
  for (const entry of entries) {
    const units = [entry._SYSTEMD_UNIT, entry._SYSTEMD_USER_UNIT, entry.UNIT];
    if (!units.includes(run.unit)) continue;
    if (entry._BOOT_ID !== run.boot || Number(entry.MAIN_PID) !== run.pid) continue;
    if (entry.EXIT_CODE !== 'killed' || Number(entry.EXIT_STATUS) !== 9) continue;
    const at = journalTimestamp(entry), started = Date.parse(run.startedAt);
    if (at === undefined || at < started || at > untilMs) continue;
    matches.set(`${at}:${run.pid}:SIGKILL`, at);
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

/** 迟到的富集只更新同 runId 的历史项，绝不覆盖更新一代的顶层异常。 */
export async function enrichAbnormalExitFromJournal(databaseUrl: string | undefined, run: ServeRunLifecycle, dependencies: {
  queryJournal?: JournalQuery; now?: Date;
} = {}): Promise<void> {
  if (!usableDatabase(databaseUrl) || !run.unit || !run.boot) return;
  const now = dependencies.now ?? new Date();
  try {
    const entries = await (dependencies.queryJournal ?? defaultJournalQuery)({ unit: run.unit, boot: run.boot, pid: run.pid, startedAt: run.startedAt, until: now.toISOString() });
    const at = exactSigkill(entries, run, now.getTime());
    if (at === undefined) return;
    updateDocument(databaseUrl, document => {
      const clean = document['clean-exit'];
      if (clean && typeof clean === 'object' && (clean as Record<string, unknown>).runId === run.runId) return;
      const enrich = (record: AbnormalExitRecord): AbnormalExitRecord => record.runId === run.runId
        ? { ...record, at: new Date(at).toISOString(), error: 'Process was killed by SIGKILL (matched systemd journal exit record)', signal: 'SIGKILL', source: 'systemd-journal' }
        : record;
      if (Array.isArray(document.history)) document.history = document.history.map(entry => { const record = asRecord(entry); return record ? enrich(record) : entry; });
      const top = asRecord(document);
      if (top?.runId === run.runId) Object.assign(document, enrich(top));
    });
  } catch { /* 无 journal、权限不足或超时时保留基础记录。 */ }
}

/** 读取与 databaseUrl 同目录、且记录的就是这个数据库的异常退出；其他情况一律当作没有。 */
export function readAbnormalExit(databaseUrl: string | undefined): AbnormalExitRecord | undefined {
  if (!usableDatabase(databaseUrl)) return undefined;
  const database = canonical(databaseUrl);
  const parsed = asRecord(readDocument(join(dirname(database), abnormalExitFileName)));
  if (!parsed || canonical(parsed.database) !== database) return undefined;
  return parsed;
}

function ago(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
}

/**
 * doctor 的 daemon.status detail 后面要接的一句。7 天以外或没有记录时为 undefined（输出逐字不变）。
 * 只有当前实例已就绪、且启动时间晚于异常时间，才说「已自动恢复」。
 */
export function abnormalExitNote(record: AbnormalExitRecord | undefined, daemon: { running: boolean; ready?: boolean; startedAt?: string }, now = new Date()): string | undefined {
  if (!record) return undefined;
  const at = Date.parse(record.at);
  const elapsed = now.getTime() - at;
  if (!Number.isFinite(at) || elapsed < 0 || elapsed > abnormalExitWindowMs) return undefined;
  const startedAt = daemon.startedAt ? Date.parse(daemon.startedAt) : Number.NaN;
  const recovered = daemon.running && daemon.ready !== false && Number.isFinite(startedAt) && startedAt > at;
  const cause = `${record.kind === 'startup' ? '启动失败' : '运行中崩溃'}${record.error ? `：${record.error}` : ''}${record.signal ? `（${record.signal}${record.source ? `，${record.source}` : ''}）` : ''}`;
  return `${ago(elapsed)}异常退出（${cause}）${recovered ? '，已自动恢复' : '，详情看 journalctl'}`;
}
