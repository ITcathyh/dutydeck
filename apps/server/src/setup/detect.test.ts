import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, Protocol } from '@dockmux/shared';
import {
  InvalidWorkingDirectoryError,
  detectAgents,
  validateWorkingDirectory,
  type DetectedAgent,
  type DirectoryProblem
} from './detect.js';

const roots: string[] = [];
const savedHome = process.env.HOME;

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dockmux-detect-'));
  roots.push(root);
  return root;
}

/** 造一个完整的 AgentConfig：detect 只读其中几个字段，其余只为满足类型。 */
const agent = (overrides: Partial<AgentConfig> & Pick<AgentConfig, 'id'>): AgentConfig => ({
  name: `Agent ${overrides.id}`,
  command: overrides.id,
  args: [],
  protocol: 'auto',
  env: {},
  permissionMode: 'ask',
  timeout: 600,
  capabilities: { pause: false, resume: true },
  builtin: false,
  ...overrides
});

/** 断言校验失败，并返回错误本体供进一步检查。 */
function expectInvalid(input: string, problem: DirectoryProblem, options?: Parameters<typeof validateWorkingDirectory>[1]): InvalidWorkingDirectoryError {
  let caught: unknown;
  try { validateWorkingDirectory(input, options); }
  catch (error) { caught = error; }
  expect(caught, `expected ${JSON.stringify(input)} to be rejected`).toBeInstanceOf(InvalidWorkingDirectoryError);
  const error = caught as InvalidWorkingDirectoryError;
  expect(error.problem).toBe(problem);
  expect(error.code).toBe('SETUP_INVALID_CWD');
  // 中文提示 + 带上出错的路径，否则用户看不懂该改哪里。
  expect(error.message).toMatch(/[一-龥]/);
  expect(error.message).toContain(error.path);
  return error;
}

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('detectAgents', () => {
  it('maps the scan result onto DetectedAgent', () => {
    const detected = detectAgents({
      cwd: '/tmp/project',
      scan: () => [agent({ id: 'claude', name: 'Claude Code', command: '/usr/bin/claude', version: '1.2.3', protocol: 'acp', builtin: true })]
    });
    expect(detected).toEqual<DetectedAgent[]>([
      { id: 'claude', name: 'Claude Code', command: '/usr/bin/claude', version: '1.2.3', protocol: 'acp', builtin: true }
    ]);
  });

  it('keeps pty-cli and collapses every other protocol to acp', () => {
    const protocols: Protocol[] = ['auto', 'acp', 'jsonl', 'pipe', 'pty', 'pty-cli'];
    const detected = detectAgents({ scan: () => protocols.map(protocol => agent({ id: protocol, protocol })) });
    expect(detected.map(item => [item.id, item.protocol])).toEqual([
      ['auto', 'acp'],
      ['acp', 'acp'],
      ['jsonl', 'acp'],
      ['pipe', 'acp'],
      ['pty', 'acp'],
      ['pty-cli', 'pty-cli']
    ]);
  });

  it('reports builtin only when it is exactly true', () => {
    // scan 可能来自存储层的松散数据，所以用 cast 覆盖非布尔真值。
    const loose = [
      agent({ id: 'yes', builtin: true }),
      agent({ id: 'no', builtin: false }),
      agent({ id: 'truthy', builtin: 'true' as unknown as boolean }),
      agent({ id: 'absent', builtin: undefined as unknown as boolean })
    ];
    expect(detectAgents({ scan: () => loose }).map(item => [item.id, item.builtin])).toEqual([
      ['yes', true],
      ['no', false],
      ['truthy', false],
      ['absent', false]
    ]);
  });

  it('leaves version undefined when the scan has none', () => {
    const [only] = detectAgents({ scan: () => [agent({ id: 'codex' })] });
    expect(only?.version).toBeUndefined();
    expect(only).not.toHaveProperty('authenticated');
  });

  it('returns an empty list when nothing is installed', () => {
    expect(detectAgents({ scan: () => [] })).toEqual([]);
  });

  it('passes the resolved cwd through to the scan function', () => {
    const scan = vi.fn(() => []);
    detectAgents({ cwd: '/tmp/explicit', scan });
    expect(scan).toHaveBeenCalledExactlyOnceWith('/tmp/explicit');

    const fallback = vi.fn(() => []);
    detectAgents({ scan: fallback });
    expect(fallback).toHaveBeenCalledExactlyOnceWith(process.cwd());
  });
});

describe('validateWorkingDirectory', () => {
  it('accepts an existing directory and returns its absolute path', async () => {
    const root = await fixture();
    expect(validateWorkingDirectory(root)).toBe(root);
    // 前后空白只是输入噪音，不该让校验失败。
    expect(validateWorkingDirectory(`  ${root}  `)).toBe(root);
  });

  it('rejects a relative path as not_absolute', () => {
    const error = expectInvalid('relative/dir', 'not_absolute');
    expect(error.path).toBe('relative/dir');
    expect(error.message).toContain('relative/dir');
  });

  it('rejects a nonexistent absolute path as missing', async () => {
    const root = await fixture();
    const absent = join(root, 'never-created');
    const error = expectInvalid(absent, 'missing');
    expect(error.path).toBe(absent);
    expect(error.message).toContain(absent);
  });

  it('rejects a file as not_a_directory', async () => {
    const root = await fixture();
    const file = join(root, 'project.txt');
    await writeFile(file, 'not a directory');
    const error = expectInvalid(file, 'not_a_directory');
    expect(error.path).toBe(file);
    expect(error.message).toContain(file);
  });

  it('rejects an unreadable directory as not_readable', async () => {
    const root = await fixture();
    // 注入 access 而不是 chmod 000：测试可能以 root 运行，root 读得动任何目录。
    const access = vi.fn(() => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });
    const error = expectInvalid(root, 'not_readable', { access });
    expect(access).toHaveBeenCalledOnce();
    expect(error.message).toContain(root);
  });

  it('treats empty and whitespace-only input as missing', () => {
    for (const blank of ['', '   ', '\t', '\n  ']) {
      const error = expectInvalid(blank, 'missing');
      expect(error.path).toBe('');
      expect(error.message).toContain('不能为空');
    }
  });

  it('expands ~ and ~/sub beneath HOME', async () => {
    const home = await fixture();
    const sub = join(home, 'sub');
    process.env.HOME = home;

    expect(validateWorkingDirectory('~', { stat: () => ({ isDirectory: () => true }), access: () => {} })).toBe(home);
    expect(validateWorkingDirectory('~/sub', { stat: () => ({ isDirectory: () => true }), access: () => {} })).toBe(sub);
    // 展开后的路径确实落在 HOME 之下，而不是变成字面的 "~/sub"。
    expect(sub.startsWith(home)).toBe(true);
    expect(validateWorkingDirectory('~/sub', { stat: () => ({ isDirectory: () => true }), access: () => {} })).not.toContain('~');
  });

  it('reports the expanded path when a ~ target does not exist', async () => {
    const home = await fixture();
    process.env.HOME = home;
    const error = expectInvalid('~/never-created', 'missing');
    expect(error.path).toBe(join(home, 'never-created'));
    expect(error.message).toContain(home);
    expect(error.message).not.toContain('~');
  });

  it('uses the injected stat and access instead of the real filesystem', () => {
    const target = resolve('/tmp/injected-only');
    const stat = vi.fn(() => ({ isDirectory: () => true }));
    const access = vi.fn(() => {});
    expect(validateWorkingDirectory(target, { stat, access })).toBe(target);
    expect(stat).toHaveBeenCalledExactlyOnceWith(target);
    expect(access).toHaveBeenCalledOnce();
    expect(access.mock.calls[0]?.[0]).toBe(target);
  });
});
