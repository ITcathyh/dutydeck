import { readFileSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export interface ProcessIdentity {
  host: string;
  boot: string;
  namespace: string;
  pid: number;
  start: string;
}

export type ProcessObservation = 'alive' | 'dead' | 'unknown';

const DARWIN_NAMESPACE = 'darwin:host-v1';
const DARWIN_HOST_PREFIX = 'darwin:host-v1:';
const DARWIN_START_PREFIX = 'darwin:lstart-v1:';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function daysInMonth(year: number, monthIndex: number): number {
  switch (monthIndex) {
    case 0: return 31; // Jan
    case 1: return isLeapYear(year) ? 29 : 28; // Feb
    case 2: return 31; // Mar
    case 3: return 30; // Apr
    case 4: return 31; // May
    case 5: return 30; // Jun
    case 6: return 31; // Jul
    case 7: return 31; // Aug
    case 8: return 30; // Sep
    case 9: return 31; // Oct
    case 10: return 30; // Nov
    case 11: return 31; // Dec
    default: return 0;
  }
}

export function canonicalizeCDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  const match = trimmed.match(/^([A-Z][a-z]{2})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!match) return null;

  const weekday = match[1]!;
  const month = match[2]!;
  const dayStr = match[3]!;
  const hourStr = match[4]!;
  const minStr = match[5]!;
  const secStr = match[6]!;
  const yearStr = match[7]!;

  const weekdayIndex = WEEKDAYS.indexOf(weekday as any);
  if (weekdayIndex === -1) return null;

  const monthIndex = MONTHS.indexOf(month as any);
  if (monthIndex === -1) return null;

  const year = parseInt(yearStr, 10);
  if (year < 1970 || year > 9999) return null;

  const day = parseInt(dayStr, 10);
  if (day < 1 || day > daysInMonth(year, monthIndex)) return null;

  const hour = parseInt(hourStr, 10);
  if (hour < 0 || hour > 23) return null;

  const min = parseInt(minStr, 10);
  if (min < 0 || min > 59) return null;

  const sec = parseInt(secStr, 10);
  if (sec < 0 || sec > 60) return null;

  const expectedWeekday = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
  if (weekdayIndex !== expectedWeekday) return null;

  return `${weekday} ${month} ${String(day).padStart(2, ' ')} ${hourStr}:${minStr}:${secStr} ${yearStr}`;
}

export function canonicalizeUuid(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  if (!UUID_REGEX.test(trimmed)) return null;
  const canonical = trimmed.toLowerCase();
  if (canonical === NIL_UUID) return null;
  return canonical;
}

function execDarwinTool(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      env: {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
        TZ: 'UTC',
      },
    });
  } catch (error: any) {
    const code = error?.code || 'COMMAND_FAILED';
    const sanitizedError = new Error(`Command failed with code: ${code}`);
    (sanitizedError as any).code = code;
    throw sanitizedError;
  }
}

function getDarwinHost(): string {
  const output = execDarwinTool('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
  const matches = [...output.matchAll(/"IOPlatformUUID"\s*=\s*"([^"]+)"/g)];
  if (matches.length !== 1) throw new Error('DATABASE_IDENTITY_UNAVAILABLE');
  const canonicalUuid = canonicalizeUuid(matches[0]![1]!);
  if (!canonicalUuid) throw new Error('DATABASE_IDENTITY_UNAVAILABLE');
  const digest = createHash('sha256').update(canonicalUuid).digest('hex');
  return `${DARWIN_HOST_PREFIX}${digest}`;
}

function getDarwinBoot(): string {
  const output = execDarwinTool('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
  const canonicalUuid = canonicalizeUuid(output);
  if (!canonicalUuid) throw new Error('DATABASE_IDENTITY_UNAVAILABLE');
  return canonicalUuid;
}

function getDarwinProcessStart(pid: number): string | null {
  try {
    const output = execDarwinTool('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
    const canonicalDate = canonicalizeCDate(output);
    if (!canonicalDate) return null;
    return `${DARWIN_START_PREFIX}${canonicalDate}`;
  } catch {
    return null;
  }
}

function machineLinux() {
  if (process.platform !== 'linux') throw new Error('DATABASE_IDENTITY_UNSUPPORTED: persistent database control requires Linux process identity');
  return {
    host: readFileSync('/etc/machine-id', 'utf8').trim(),
    boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    namespace: readlinkSync('/proc/self/ns/pid'),
  };
}

function processStartLinux(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('Invalid process start identity');
  return fields[19]!;
}

/** Capture a child identity without authorizing signals to a future PID occupant. */
export function childProcessIdentity(pid: number): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
  if (process.platform === 'linux') {
    const local = machineLinux();
    if (readlinkSync(`/proc/${pid}/ns/pid`) !== local.namespace) throw new Error('PROCESS_NAMESPACE_UNSUPPORTED');
    return {...local,pid,start:processStartLinux(pid)};
  }
  if (process.platform === 'darwin') {
    const local = currentProcessIdentity(),start=getDarwinProcessStart(pid);
    if (!start) throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
    return {...local,pid,start};
  }
  throw new Error('PROCESS_IDENTITY_UNSUPPORTED');
}

export function currentProcessIdentity(): ProcessIdentity {
  if (process.platform === 'linux') {
    const identity = { ...machineLinux(), pid: process.pid, start: processStartLinux(process.pid) };
    if (!identity.host || !identity.boot) throw new Error('DATABASE_IDENTITY_UNAVAILABLE');
    return identity;
  }
  if (process.platform === 'darwin') {
    try {
      const host = getDarwinHost();
      const boot = getDarwinBoot();
      const start = getDarwinProcessStart(process.pid);
      if (!start) throw new Error('DATABASE_IDENTITY_UNAVAILABLE');
      return { host, boot, namespace: DARWIN_NAMESPACE, pid: process.pid, start };
    } catch (error: any) {
      if (error?.message === 'DATABASE_IDENTITY_UNAVAILABLE') throw error;
      throw new Error('DATABASE_IDENTITY_UNAVAILABLE');
    }
  }
  throw new Error('DATABASE_IDENTITY_UNSUPPORTED: persistent database control requires Linux or Darwin process identity');
}

/** Unknown observations never authorize reclamation. No signals are sent. */
export function observeProcess(identity: ProcessIdentity): ProcessObservation {
  try {
    if (!identity || typeof identity !== 'object') return 'unknown';
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) return 'unknown';
    if (!identity.host || !identity.boot || !identity.start || !identity.namespace) return 'unknown';

    if (process.platform === 'linux') {
      const local = machineLinux();
      if (local.host !== identity.host) return 'unknown';
      if (local.boot !== identity.boot) return 'dead';
      if (local.namespace !== identity.namespace) return 'unknown';
      try { return processStartLinux(identity.pid) === identity.start ? 'alive' : 'dead'; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown'; }
    }

    if (process.platform === 'darwin') {
      // 1. 拒绝 malformed identity、非正安全整数 PID、错误 namespace/start 格式
      if (identity.namespace !== DARWIN_NAMESPACE) return 'unknown';
      if (!new RegExp(`^${DARWIN_HOST_PREFIX}[0-9a-f]{64}$`).test(identity.host)) return 'unknown';
      const canonicalSavedBoot = canonicalizeUuid(identity.boot);
      if (!canonicalSavedBoot) return 'unknown';
      if (!identity.start.startsWith(DARWIN_START_PREFIX)) return 'unknown';
      const savedCanonicalDate = canonicalizeCDate(identity.start.slice(DARWIN_START_PREFIX.length));
      if (!savedCanonicalDate) return 'unknown';
      const canonicalSavedStart = `${DARWIN_START_PREFIX}${savedCanonicalDate}`;

      // 2. 本机身份读取失败或 host 不同返回 unknown；同 host 的 boot 不同返回 dead
      let localHost: string;
      let localBoot: string;
      try {
        localHost = getDarwinHost();
        localBoot = getDarwinBoot();
      } catch {
        return 'unknown';
      }
      if (localHost !== identity.host) return 'unknown';
      if (localBoot !== canonicalSavedBoot) return 'dead';

      // 3. 同 host/boot 下读取目标 PID 的 ps 开始时间
      const currentStart = getDarwinProcessStart(identity.pid);
      if (currentStart) {
        if (currentStart !== canonicalSavedStart) {
          return 'dead';
        }
        return 'unknown';
      }

      // 4. ps 无结果、失败、超时或 malformed 时只允许用 process.kill(pid, 0) 的 ESRCH 证明当前 PID 不存在
      try {
        process.kill(identity.pid, 0);
        return 'unknown';
      } catch (killError: any) {
        if (killError?.code === 'ESRCH') {
          return 'dead';
        }
        return 'unknown';
      }
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}
