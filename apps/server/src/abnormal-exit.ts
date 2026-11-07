import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { redactCredentialText } from '@dutydeck/shared';

/**
 * 上一次异常退出的本地记录：放在本次 serve 打开的数据库所在目录，并记下数据库实路径。
 * 位置只按数据库取，不走 daemon 目录和 ~/.dutydeck/last-daemon-dir：那个回退可能指向另一个实例。
 * doctor 只认数据库路径与自己解析出的一致的记录。
 */
export const abnormalExitFileName = 'last-abnormal-exit.json';
export const abnormalExitWindowMs = 7 * 24 * 60 * 60_000;

export type AbnormalExitKind = 'fatal' | 'startup';
export interface AbnormalExitRecord {
  at: string;
  kind: AbnormalExitKind;
  exitCode: number;
  /** 错误首行，已脱敏、截断。 */
  error: string;
  version: string;
  database: string;
}

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

/** 同步写入（进程马上要退出）。没有数据库路径时不写；写失败静默，不能盖过原本的致命错误。 */
export function recordAbnormalExit(databaseUrl: string | undefined, input: { kind: AbnormalExitKind; exitCode: number; error: unknown; version: string; now?: Date }): void {
  if (!usableDatabase(databaseUrl)) return;
  try {
    const database = canonical(databaseUrl);
    const record: AbnormalExitRecord = { at: (input.now ?? new Date()).toISOString(), kind: input.kind, exitCode: input.exitCode, error: firstLine(input.error), version: input.version, database };
    const file = join(dirname(database), abnormalExitFileName);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch { /* 记录只是诊断线索 */ }
}

/** 读取与 databaseUrl 同目录、且记录的就是这个数据库的异常退出；其他情况一律当作没有。 */
export function readAbnormalExit(databaseUrl: string | undefined): AbnormalExitRecord | undefined {
  if (!usableDatabase(databaseUrl)) return undefined;
  const database = canonical(databaseUrl);
  try {
    const parsed = JSON.parse(readFileSync(join(dirname(database), abnormalExitFileName), 'utf8')) as Partial<AbnormalExitRecord>;
    if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || (parsed.kind !== 'fatal' && parsed.kind !== 'startup')) return undefined;
    if (typeof parsed.database !== 'string' || canonical(parsed.database) !== database) return undefined;
    return { at: parsed.at, kind: parsed.kind, exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : 1, error: typeof parsed.error === 'string' ? parsed.error : '', version: typeof parsed.version === 'string' ? parsed.version : '', database: parsed.database };
  } catch { return undefined; }
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
  const cause = `${record.kind === 'startup' ? '启动失败' : '运行中崩溃'}${record.error ? `：${record.error}` : ''}`;
  return `${ago(elapsed)}异常退出（${cause}）${recovered ? '，已自动恢复' : '，详情看 journalctl'}`;
}
