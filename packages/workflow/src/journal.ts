/**
 * append-only NDJSON journal —— run 的审计真相。
 *
 * 移植自 botmux `src/workflows/v3/journal.ts`，保留了它最有价值的部分：
 * **崩溃时被写坏的最后一行的处理策略**。这段逻辑看着琐碎，但少了它就会在
 * 崩溃恢复时静默产生错误状态。
 *
 * 两条不同的容忍策略（关键）
 * ──────────────────────────
 * - **读**：容忍**物理上最后一段**没写完的记录（进程在 write 中途挂了），
 *   但任何**更早**的坏行一律抛错。中间少一个 `nodeSucceeded` 会让节点看起来
 *   永远 pending——静默跳过比崩掉危险得多，所以这里要吵。
 * - **写**：追加之前必须先**修复**没写完的尾巴。否则新 JSON 会被直接粘在半个
 *   旧 JSON 后面，两条记录一起永久损坏。修复分两种：尾巴本身是完整 JSON
 *   （崩在写 `\n` 之前）就补个换行保留它；不完整就截断丢弃。
 *
 * 与 botmux 的差异：不带 `withFileLockSync`（那是 1004 行的跨进程锁，服务的是
 * 多 daemon 抢同一个 run 的场景）。dockmux 的 workflow run 由单个进程驱动，
 * 这里用进程内串行化即可；torn-tail 修复本身与锁无关，照常生效。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { StoredEvent, WorkflowEvent } from './types.js';

/** 尽力而为地 fsync 目录项——部分文件系统不支持，这不该让写入失败。 */
function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // 只放过「本平台/本文件系统不支持目录 fsync」，真正的 IO/权限错误还是要抛。
    if (!code || !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code)) throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class JournalCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalCorruptionError';
  }
}

/**
 * 解析 NDJSON。`tolerateTornFinal` 只放过**物理最后一段且文件不以 \n 结尾**的行——
 * 一个坏行后面**跟着换行**说明它已经被完整提交过，那是真损坏，必须抛。
 */
function parseJournalText(raw: string, path: string, tolerateTornFinal: boolean): StoredEvent[] {
  const lines = raw.split('\n');
  const out: StoredEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as StoredEvent);
    } catch (err) {
      if (tolerateTornFinal && i === lines.length - 1 && !raw.endsWith('\n')) break;
      throw new JournalCorruptionError(
        `journal corrupted at line ${i + 1} of ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/**
 * 追加前修复没写完的尾巴。
 *
 * 快路径只读**一个字节**：文件以 `\n` 结尾就什么都不用做——这是绝大多数情况，
 * 不能为此付一次全文件读。
 */
function repairTornTail(path: string): void {
  if (!existsSync(path)) return;
  const probeFd = openSync(path, 'r');
  try {
    const size = fstatSync(probeFd).size;
    if (size === 0) return;
    const lastByte = Buffer.allocUnsafe(1);
    readSync(probeFd, lastByte, 0, 1, size - 1);
    if (lastByte[0] === 0x0a) return;
  } finally {
    closeSync(probeFd);
  }

  // 走到这里说明确实要修：先全量校验一遍，证明**除尾巴外**的历史都是好的。
  const raw = readFileSync(path);
  parseJournalText(raw.toString('utf-8'), path, true);
  const lastNewline = raw.lastIndexOf(0x0a);
  const tail = raw.subarray(lastNewline + 1).toString('utf-8');
  let tailIsCompleteJson = false;
  if (tail.trim()) {
    try {
      JSON.parse(tail.trim());
      tailIsCompleteJson = true;
    } catch {
      // 不完整——丢弃。
    }
  }

  if (tailIsCompleteJson) {
    // 记录本身写完了，只是没来得及写换行：补上，保住这条事件。
    appendFileSync(path, '\n');
    fsyncFile(path);
  } else {
    const fd = openSync(path, 'r+');
    try {
      ftruncateSync(fd, lastNewline + 1);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  fsyncDirectory(dirname(path));
}

/**
 * append-only journal 的句柄。
 *
 * 同步写是**刻意的**：调度循环必须能立刻观察到自己刚写的事件。异步 append 会
 * 打开一个窗口，让 `decideNext` 跑在过期状态上，从而重复派发同一个节点。
 */
export class Journal {
  constructor(readonly path: string) {}

  /** 追加一条事件，戳上写入时刻。`durable` 时额外 fsync。 */
  append(event: WorkflowEvent, options: { durable?: boolean } = {}): StoredEvent {
    const directory = dirname(this.path);
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    const created = !existsSync(this.path);
    repairTornTail(this.path);
    const stored: StoredEvent = { ts: Date.now(), ...event };
    appendFileSync(this.path, `${JSON.stringify(stored)}\n`);
    if (options.durable) {
      fsyncFile(this.path);
      if (created) fsyncDirectory(directory);
    }
    return stored;
  }

  /** 按写入顺序读回全部事件。文件不存在时返回 `[]`（run 还没开始）。 */
  read(): StoredEvent[] {
    return readJournal(this.path);
  }
}

export function readJournal(path: string): StoredEvent[] {
  if (!existsSync(path)) return [];
  return parseJournalText(readFileSync(path, 'utf-8'), path, true);
}

/**
 * 纯内存 journal，用于测试和不需要持久化的 run。
 *
 * 与 {@link Journal} 接口一致，因此 engine 对两者无感。
 */
export class MemoryJournal {
  private readonly events: StoredEvent[] = [];

  append(event: WorkflowEvent): StoredEvent {
    const stored: StoredEvent = { ts: Date.now(), ...event };
    this.events.push(stored);
    return stored;
  }

  read(): StoredEvent[] {
    return [...this.events];
  }
}

/** engine 只依赖这个最小接口——落盘与否是调用方的选择。 */
export interface JournalSink {
  append(event: WorkflowEvent, options?: { durable?: boolean }): StoredEvent;
  read(): StoredEvent[];
}
