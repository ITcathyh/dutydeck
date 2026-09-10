/**
 * setup 的配置落盘层。
 *
 * 选择 `.env` 而不是数据库：`cli.ts` 启动时就调用 `loadEnvFile()`，`.env` 是本仓库
 * 已经文档化的唯一入口（README 的「cp .env.example .env」）。向导要做的正是把那一步
 * 从「手工编辑」变成「自动写好」，所以必须写同一个文件，而不是另开一套真相来源。
 *
 * 两条规则：
 *   1. **只改我们拥有的键**。用户手写的注释、空行、无关变量原样保留——
 *      向导不是格式化工具，重写整个文件会毁掉用户的注释。
 *   2. **要么全写成功，要么什么都不写**。先在内存里算出完整内容，再一次性
 *      原子替换（临时文件 + rename）。凭据校验失败或用户中途放弃时，
 *      磁盘上不能留下半份配置。
 */
import { mkdtempSync, readFileSync, renameSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 向导管理的键。不在此列的键一律不碰。 */
export const MANAGED_KEYS = [
  'DUTYDECK_DEFAULT_CWD',
  'DUTYDECK_PORT',
  'DUTYDECK_HOST',
  'DUTYDECK_LOCAL_ONLY',
  'LARK_APP_ID',
  'LARK_APP_SECRET'
] as const;
export type ManagedKey = typeof MANAGED_KEYS[number];

/** 视为机密、任何回显/JSON 里都要掩码的键。 */
const SECRET_KEYS = new Set<string>(['LARK_APP_SECRET']);

export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key);
}

/** 掩码展示：只保留末 4 位，长度不足则完全隐藏。 */
export function maskSecret(value: string | undefined): string {
  if (!value) return '(未设置)';
  return value.length <= 4 ? '****' : `****${value.slice(-4)}`;
}

export interface EnvFileEntry { key: string; value: string }

/**
 * 解析 .env。只做 setup 需要的最小解析：`KEY=VALUE`，忽略注释与空行，
 * 去掉包裹的引号。不实现变量展开——那是运行时 loadEnvFile 的职责。
 */
export function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // 双引号分支必须反转 quoteIfNeeded 的转义，否则含 " 或 \ 的值读回来会多出
      // 反斜杠。这不只是显示问题：writeEnvFile 用「读回值 != 待写值」判断是否有改动，
      // 值一旦读不回原样，每次重跑都会被判为「已变更」，幂等性直接失效。
      value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      // 单引号我们从不写出，也就没有转义可反转，按字面处理。
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

/** 含空格/引号/#/前后空白时加引号，保证写出去的值能被原样读回。 */
function quoteIfNeeded(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./:@,+-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

const MANAGED_BANNER = '# 由 dutydeck setup 写入';

/**
 * 把 updates 合并进原文件内容，返回新内容。
 *
 * 已存在的键就地改值（保住它在文件里的位置和上下文注释）；
 * 新键追加到末尾；值为 undefined 表示删除该键。
 */
export function mergeEnvContent(original: string, updates: Record<string, string | undefined>): string {
  const pending = new Map(Object.entries(updates));
  const lines = original === '' ? [] : original.split(/\r?\n/);
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf('=');
    if (trimmed === '' || trimmed.startsWith('#') || separator <= 0) {
      output.push(line);
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (!pending.has(key)) {
      output.push(line);
      continue;
    }
    const value = pending.get(key);
    pending.delete(key);
    // undefined = 删除：整行丢弃。
    if (value !== undefined) output.push(`${key}=${quoteIfNeeded(value)}`);
  }

  const additions = [...pending.entries()].filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (additions.length > 0) {
    // 与既有内容之间留一个空行，但不制造连续空行。
    while (output.length > 0 && output[output.length - 1]!.trim() === '') output.pop();
    if (output.length > 0) output.push('');
    output.push(MANAGED_BANNER);
    for (const [key, value] of additions) output.push(`${key}=${quoteIfNeeded(value)}`);
  }

  // 删掉最后一个受管键后，我们自己写的 banner 会变成孤儿注释。它是本模块生成的、
  // 不是用户手写的，所以后面没有任何键时要一并清掉——否则反复增删会攒出一串空标题。
  for (let index = output.length - 1; index >= 0; index -= 1) {
    if (output[index]!.trim() !== MANAGED_BANNER) continue;
    const hasFollowingAssignment = output.slice(index + 1).some(line => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('#') && trimmed.indexOf('=') > 0;
    });
    if (!hasFollowingAssignment) output.splice(index, 1);
  }

  while (output.length > 0 && output[output.length - 1]!.trim() === '') output.pop();
  return output.length === 0 ? '' : `${output.join('\n')}\n`;
}

export interface WriteEnvResult {
  path: string;
  /** 是否真的落了盘。内容与磁盘一致时为 false（幂等重跑的关键信号）。 */
  changed: boolean;
  /** 本次实际改动的键名（不含值）。 */
  changedKeys: string[];
  created: boolean;
}

/**
 * 原子写入 .env。
 *
 * 内容无变化时直接返回 changed:false，不触碰 mtime——重跑向导不应制造
 * 「好像做了什么」的假象。文件权限固定 0600：里面可能有 app secret。
 */
export function writeEnvFile(path: string, updates: Record<string, string | undefined>): WriteEnvResult {
  const existed = existsSync(path);
  const original = existed ? readFileSync(path, 'utf8') : '';
  const before = parseEnvFile(original);
  const next = mergeEnvContent(original, updates);

  const changedKeys = Object.entries(updates)
    .filter(([key, value]) => before.get(key) !== value)
    .map(([key]) => key);

  if (existed && next === original) return { path, changed: false, changedKeys: [], created: false };

  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  // 同目录临时文件 + rename：跨设备 rename 会失败，所以不能用 tmpdir()。
  const staging = mkdtempSync(join(directory, '.dutydeck-env-'));
  const stagedFile = join(staging, 'env');
  try {
    writeFileSync(stagedFile, next, { mode: 0o600 });
    renameSync(stagedFile, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { path, changed: true, changedKeys, created: !existed };
}

/** 读取现有配置，供向导判断「已配置，是否更新」。 */
export function readExistingConfig(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  return parseEnvFile(readFileSync(path, 'utf8'));
}
