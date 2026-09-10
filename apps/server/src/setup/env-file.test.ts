import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MANAGED_KEYS,
  isSecretKey,
  maskSecret,
  mergeEnvContent,
  parseEnvFile,
  readExistingConfig,
  writeEnvFile,
  type WriteEnvResult
} from './env-file.js';

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-env-file-'));
  roots.push(root);
  return root;
}

/** 让两次写之间的 mtime 真的能区分开：否则「mtime 未变」可能只是时间戳精度不够。 */
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

const lines = (content: string) => content.split('\n');
const linesStartingWith = (content: string, prefix: string) => lines(content).filter(line => line.startsWith(prefix));
const stagingLeftovers = async (directory: string) => (await readdir(directory)).filter(name => name.startsWith('.dutydeck-env-'));

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('mergeEnvContent', () => {
  it('把改名前写下的 DOCKMUX_ 受管键就地升级，不在末尾追加第二份', () => {
    const legacy = [
      '# 由 dockmux setup 写入',
      'DOCKMUX_DEFAULT_CWD=/home/u',
      'DOCKMUX_PORT=4310',
      'DOCKMUX_HOST=10.0.0.1'
    ].join('\n');
    const merged = mergeEnvContent(legacy, { DUTYDECK_PORT: '4400' });
    expect(merged).toContain('DUTYDECK_PORT=4400');
    expect(merged).not.toContain('DOCKMUX_PORT');
    // 没有参与本次更新的旧键保持原样，交给运行时的 adoptLegacyEnv 兜底
    expect(merged).toContain('DOCKMUX_DEFAULT_CWD=/home/u');
    expect(merged).toContain('# 由 dutydeck setup 写入');
    expect(merged).not.toContain('# 由 dockmux setup 写入');
    expect(merged.match(/PORT=/g)).toHaveLength(1);
  });

  it('不碰名字里带 DOCKMUX_ 但不受管的键', () => {
    const merged = mergeEnvContent('DOCKMUX_CUSTOM_THING=keep\n', { DUTYDECK_PORT: '4400' });
    expect(merged).toContain('DOCKMUX_CUSTOM_THING=keep');
    expect(merged).toContain('DUTYDECK_PORT=4400');
  });

  const handwritten = [
    '# 用户自己的注释：不要被向导吃掉',
    'MY_OWN_KEY=keep-me',
    '',
    '# 端口',
    'DUTYDECK_PORT=4310',
    'UNRELATED_TOKEN="do not touch"',
    ''
  ].join('\n');

  it('only touches managed keys and updates an existing key in place', () => {
    const merged = mergeEnvContent(handwritten, { DUTYDECK_PORT: '4400' });

    // 注释与无关键原样保留。
    expect(merged).toContain('# 用户自己的注释：不要被向导吃掉');
    expect(merged).toContain('# 端口');
    expect(merged).toContain('MY_OWN_KEY=keep-me');
    expect(merged).toContain('UNRELATED_TOKEN="do not touch"');
    // 就地改值：只有一行 DUTYDECK_PORT，且仍在「# 端口」之后、UNRELATED_TOKEN 之前。
    expect(linesStartingWith(merged, 'DUTYDECK_PORT=')).toEqual(['DUTYDECK_PORT=4400']);
    expect(merged).not.toContain('4310');
    const position = lines(merged).indexOf('DUTYDECK_PORT=4400');
    expect(position).toBe(lines(handwritten).indexOf('DUTYDECK_PORT=4310'));
    expect(position).toBeLessThan(lines(merged).findIndex(line => line.startsWith('UNRELATED_TOKEN=')));
    // 没有追加重复键，所以也不该出现追加区的标记。
    expect(merged).not.toContain('由 dutydeck setup 写入');
  });

  it('appends new keys and drops the whole line for an undefined value', () => {
    const merged = mergeEnvContent(handwritten, { LARK_APP_ID: 'cli_new', MY_OWN_KEY: undefined });

    expect(linesStartingWith(merged, 'LARK_APP_ID=')).toEqual(['LARK_APP_ID=cli_new']);
    // 新键在末尾（原有内容之后）。
    expect(lines(merged).indexOf('LARK_APP_ID=cli_new')).toBeGreaterThan(lines(merged).indexOf('DUTYDECK_PORT=4310'));
    // undefined = 删除整行，连键名都不留。
    expect(merged).not.toContain('MY_OWN_KEY');
    expect(merged).not.toContain('keep-me');
    // 其余内容不受影响。
    expect(merged).toContain('# 端口');
    expect(parseEnvFile(merged).get('UNRELATED_TOKEN')).toBe('do not touch');
  });

  it('round-trips values containing a space or a hash through parseEnvFile', () => {
    for (const value of ['has space', 'has#hash', ' padded ', '']) {
      const merged = mergeEnvContent('', { LARK_APP_ID: value });
      expect(parseEnvFile(merged).get('LARK_APP_ID'), `value ${JSON.stringify(value)}`).toBe(value);
    }
  });

  // 已知缺陷：quoteIfNeeded 把 " 和 \ 转义成 \" / \\，但 parseEnvFile 只剥外层引号、
  // 不做反转义，于是读回的值多出反斜杠——含双引号或反斜杠的 app secret 会被静默改写。
  // 曾经的缺陷：quoteIfNeeded 转义了 " 和 \，parseEnvFile 却不反转义，导致读回值多出
  // 反斜杠。这会连带毁掉幂等性（writeEnvFile 以「读回值 != 待写值」判断是否有改动），
  // 且因为所有展示路径都过 maskSecret，损坏在 LARK_APP_SECRET 上完全不可见。已修复。
  it('round-trips a double quote and a backslash through write and read', () => {
    for (const value of ['he said "hi"', 'back\\slash', 'both "q" and \\b']) {
      const merged = mergeEnvContent('', { LARK_APP_SECRET: value });
      expect(parseEnvFile(merged).get('LARK_APP_SECRET'), `value ${JSON.stringify(value)}`).toBe(value);
    }
  });

  it('keeps such a value idempotent across a rewrite', async () => {
    // 回归防线：读回值必须等于待写值，否则 changedKeys 每次都非空，重跑永远报「已变更」。
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-env-quote-'));
    roots.push(root);
    const path = join(root, '.env');
    const secret = 'pa"ss\\word';
    expect(writeEnvFile(path, { LARK_APP_SECRET: secret })).toMatchObject({ changed: true });
    expect(writeEnvFile(path, { LARK_APP_SECRET: secret })).toEqual({ path, changed: false, changedKeys: [], created: false });
    expect(readExistingConfig(path).get('LARK_APP_SECRET')).toBe(secret);
  });
});

describe('parseEnvFile', () => {
  it('parses plain and quoted values while ignoring non-assignments', () => {
    const entries = parseEnvFile([
      'PLAIN=value',
      'DOUBLE="quoted value"',
      "SINGLE='single value'",
      '# COMMENT=ignored',
      '',
      '   ',
      'NO_EQUALS_AT_ALL',
      '=leading-equals-has-no-key',
      '  SPACED  =  padded  ',
      'EMPTY='
    ].join('\n'));

    expect(entries.get('PLAIN')).toBe('value');
    expect(entries.get('DOUBLE')).toBe('quoted value');
    expect(entries.get('SINGLE')).toBe('single value');
    expect(entries.get('SPACED')).toBe('padded');
    expect(entries.get('EMPTY')).toBe('');
    expect(entries.has('COMMENT')).toBe(false);
    expect(entries.has('NO_EQUALS_AT_ALL')).toBe(false);
    expect(entries.has('')).toBe(false);
    expect([...entries.keys()]).toEqual(['PLAIN', 'DOUBLE', 'SINGLE', 'SPACED', 'EMPTY']);
  });

  it('accepts CRLF and an empty document', () => {
    expect(parseEnvFile('A=1\r\nB=2\r\n').get('B')).toBe('2');
    expect(parseEnvFile('').size).toBe(0);
  });
});

describe('writeEnvFile', () => {
  it('creates the file atomically with 0600 and reports created only on the first write', async () => {
    const root = await fixture();
    const path = join(root, '.env');
    const updates = { DUTYDECK_PORT: '4400', LARK_APP_SECRET: 'sec ret#1' };

    const first: WriteEnvResult = writeEnvFile(path, updates);
    expect(first).toMatchObject({ path, changed: true, created: true });
    expect(first.changedKeys.sort()).toEqual(['DUTYDECK_PORT', 'LARK_APP_SECRET']);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await stagingLeftovers(root)).toEqual([]);
    expect(await readdir(root)).toEqual(['.env']);

    const second = writeEnvFile(path, { DUTYDECK_PORT: '4500' });
    expect(second).toMatchObject({ changed: true, created: false, changedKeys: ['DUTYDECK_PORT'] });
    // 原子替换不留暂存目录，值也真的落了盘。
    expect(await stagingLeftovers(root)).toEqual([]);
    expect(parseEnvFile(await readFile(path, 'utf8')).get('DUTYDECK_PORT')).toBe('4500');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('is idempotent: a second identical write reports no change and leaves mtime untouched', async () => {
    const root = await fixture();
    const path = join(root, '.env');
    const updates = { DUTYDECK_DEFAULT_CWD: root, LARK_APP_ID: 'cli_idempotent' };

    expect(writeEnvFile(path, updates).changed).toBe(true);
    const before = await stat(path);
    const contentBefore = await readFile(path, 'utf8');
    await tick();

    const again = writeEnvFile(path, updates);
    expect(again).toEqual({ path, changed: false, changedKeys: [], created: false });
    const after = await stat(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path, 'utf8')).toBe(contentBefore);
    expect(await stagingLeftovers(root)).toEqual([]);
  });

  it('creates missing parent directories and removes a key idempotently', async () => {
    const root = await fixture();
    const path = join(root, 'nested', 'deeper', '.env');
    expect(writeEnvFile(path, { DUTYDECK_HOST: '127.0.0.1' })).toMatchObject({ changed: true, created: true });

    const removed = writeEnvFile(path, { DUTYDECK_HOST: undefined });
    expect(removed).toMatchObject({ changed: true, created: false, changedKeys: ['DUTYDECK_HOST'] });
    const afterRemoval = await readFile(path, 'utf8');
    expect(afterRemoval).not.toContain('DUTYDECK_HOST');
    expect(afterRemoval).not.toContain('127.0.0.1');
    expect(parseEnvFile(afterRemoval).size).toBe(0);

    const removedAgain = writeEnvFile(path, { DUTYDECK_HOST: undefined });
    expect(removedAgain).toEqual({ path, changed: false, changedKeys: [], created: false });
    expect(await stagingLeftovers(join(root, 'nested', 'deeper'))).toEqual([]);
  });

  it('preserves handwritten content across a rewrite', async () => {
    const root = await fixture();
    const path = join(root, '.env');
    await writeFile(path, '# 手写注释\nMY_OWN_KEY=keep-me\nDUTYDECK_PORT=4310\n');

    writeEnvFile(path, { DUTYDECK_PORT: '4400' });
    const content = await readFile(path, 'utf8');
    expect(content).toContain('# 手写注释');
    expect(content).toContain('MY_OWN_KEY=keep-me');
    expect(linesStartingWith(content, 'DUTYDECK_PORT=')).toEqual(['DUTYDECK_PORT=4400']);
  });
});

describe('readExistingConfig', () => {
  it('returns an empty map for a nonexistent path and the parsed entries otherwise', async () => {
    const root = await fixture();
    const missing = join(root, 'never-written', '.env');
    expect(readExistingConfig(missing)).toBeInstanceOf(Map);
    expect(readExistingConfig(missing).size).toBe(0);

    const path = join(root, '.env');
    await writeFile(path, '# note\nLARK_APP_ID=cli_read\nLARK_APP_SECRET="sec ret"\n');
    const existing = readExistingConfig(path);
    expect(existing.get('LARK_APP_ID')).toBe('cli_read');
    expect(existing.get('LARK_APP_SECRET')).toBe('sec ret');
    expect(existing.size).toBe(2);
  });
});

describe('secret handling', () => {
  it('never reveals more than the last four characters', () => {
    expect(maskSecret('0123456789')).toBe('****6789');
    expect(maskSecret('0123456789')).not.toContain('012345');
    expect(maskSecret('abcde')).toBe('****bcde');
    // 长度不足则完全隐藏，一个字符都不给。
    for (const short of ['a', 'ab', 'abc', 'abcd']) {
      expect(maskSecret(short)).toBe('****');
      expect(maskSecret(short)).not.toContain(short.slice(-1));
    }
    // 未设置有独立标记，不能和「空密钥」混为一谈。
    expect(maskSecret(undefined)).toBe('(未设置)');
    expect(maskSecret('')).toBe('(未设置)');
  });

  it('classifies only the app secret as secret', () => {
    expect(isSecretKey('LARK_APP_SECRET')).toBe(true);
    expect(isSecretKey('LARK_APP_ID')).toBe(false);
    expect(isSecretKey('DUTYDECK_DEFAULT_CWD')).toBe(false);
  });

  it('manages both the default cwd and the app secret', () => {
    expect(MANAGED_KEYS).toContain('LARK_APP_SECRET');
    expect(MANAGED_KEYS).toContain('DUTYDECK_DEFAULT_CWD');
    expect(new Set(MANAGED_KEYS).size).toBe(MANAGED_KEYS.length);
  });
});
