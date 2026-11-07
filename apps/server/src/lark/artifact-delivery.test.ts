import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

const fsHook = vi.hoisted(() => ({ beforeOpen: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const beforeOpen = fsHook.beforeOpen; fsHook.beforeOpen = undefined;
      if (beforeOpen) await beforeOpen();
      return actual.open(...args);
    }
  };
});

import { artifactScratchDirectory, deliverArtifact, instancePrivatePaths, readArtifact } from './artifact-delivery.js';

function configs(values = new Map<string, string>()) { return { get: async (k: string) => values.get(k), set: async (k: string, v: string) => { values.set(k, v); }, compareAndSet: async (k: string, e: string | undefined, v: string) => { if (values.get(k) !== e) return false; values.set(k, v); return true; } }; }
const execFile = promisify(execFileCallback);

describe('artifact delivery', () => {
  // 「范围外」选一个既不在会话目录、也不在临时目录下的位置：仓库工作目录。
  const outsideDir = () => mkdtemp(join(process.cwd(), '.artifact-outside-'));

  it('reads original bytes only from the workspace and rejects escapes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-')); await mkdir(join(cwd, 'nested'));
    const outside = await outsideDir();
    try {
      const bytes = new Uint8Array([0, 255, 1, 2]); await writeFile(join(cwd, 'nested', 'a.bin'), bytes); await writeFile(join(outside, 'outside.bin'), 'x');
      await expect(readArtifact(cwd, 'nested/a.bin', false)).resolves.toMatchObject({ data: bytes, fingerprint: createHash('sha256').update(bytes).digest('hex') });
      await expect(readArtifact(cwd, join(outside, 'outside.bin'), false)).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUT_OF_SCOPE' });
      await symlink(join(outside, 'outside.bin'), join(cwd, 'escape'));
      await expect(readArtifact(cwd, 'escape', false)).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUT_OF_SCOPE' });
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('delivers from this session\'s own temp directory only, not other temp files or through a symlink that leaves it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-')); const sibling = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-sibling-'));
    const sessionId = `ses_scratch_${process.pid}_${Date.now()}`; const scratch = (await artifactScratchDirectory(sessionId))!; await mkdir(scratch, { recursive: true });
    const outside = await outsideDir();
    try {
      await writeFile(join(scratch, 'analysis.md'), '# 分析'); await writeFile(join(sibling, 'other-session.md'), 'other'); await writeFile(join(outside, 'secret.md'), 'secret');
      await expect(readArtifact(cwd, join(scratch, 'analysis.md'), false, { sessionId })).resolves.toMatchObject({ filename: 'analysis.md' });
      // 其他会话写在系统临时目录里的文件、别的会话的交付目录都不在范围内。
      await expect(readArtifact(cwd, join(sibling, 'other-session.md'), false, { sessionId })).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUT_OF_SCOPE' });
      await expect(readArtifact(cwd, join(scratch, 'analysis.md'), false, { sessionId: `${sessionId}_other` })).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUT_OF_SCOPE' });
      // 交付目录里的符号链接指向范围外时，按解析后的真实路径判断，仍然拒绝。
      await symlink(join(outside, 'secret.md'), join(scratch, 'leak.md'));
      await expect(readArtifact(cwd, join(scratch, 'leak.md'), false, { sessionId })).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUT_OF_SCOPE' });
      // 大小限制不变。
      await writeFile(join(scratch, 'big.bin'), new Uint8Array(10 * 1024 * 1024 + 1));
      await expect(readArtifact(cwd, join(scratch, 'big.bin'), true, { sessionId })).rejects.toMatchObject({ code: 'ARTIFACT_TOO_LARGE' });
    } finally { await Promise.all([outside, sibling, scratch].map(dir => rm(dir, { recursive: true, force: true }))); }
  });

  it('refuses credentials, agent transcripts, instance data and hard links inside the workspace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-'));
    try {
      await mkdir(join(cwd, '.dutydeck'), { recursive: true }); await mkdir(join(cwd, '.claude', 'projects', 'p'), { recursive: true });
      await writeFile(join(cwd, '.env'), 'TOKEN=x'); await writeFile(join(cwd, 'server.pem'), 'key'); await writeFile(join(cwd, '.dutydeck', 'feishu-open-platform-session.json'), '{}');
      await writeFile(join(cwd, '.claude', 'projects', 'p', 's.jsonl'), '{}'); await writeFile(join(cwd, 'report.md'), 'ok'); await writeFile(join(cwd, '.env.example'), 'TOKEN=');
      for (const path of ['.env', 'server.pem', '.dutydeck/feishu-open-platform-session.json', '.claude/projects/p/s.jsonl', join(cwd, '.env')])
        await expect(readArtifact(cwd, path, false), path).rejects.toMatchObject({ code: 'ARTIFACT_PROTECTED' });
      await expect(readArtifact(cwd, 'report.md', false)).resolves.toMatchObject({ filename: 'report.md' });
      await expect(readArtifact(cwd, '.env.example', false)).resolves.toMatchObject({ filename: '.env.example' });
      // 硬链接让范围外的文件换个名字出现在工作目录里，路径规则看不出来。
      await writeFile(join(cwd, 'linked.md'), 'x'); await link(join(cwd, 'linked.md'), join(cwd, 'alias.md'));
      await expect(readArtifact(cwd, 'alias.md', false)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_REGULAR_FILE' });

      // 数据库就放在会话工作目录里（临时调试实例）：数据库、密钥和实例内部目录不能发，其余文件照常。
      const database = join(cwd, 'dutydeck.db'); await writeFile(database, 'sqlite'); await writeFile(`${database}-wal`, 'wal');
      await mkdir(join(cwd, 'secrets')); await writeFile(join(cwd, 'secrets', 'bot.json'), '{}'); await mkdir(join(cwd, 'lark-resources')); await writeFile(join(cwd, 'lark-resources', 'a.png'), 'png');
      const privatePaths = instancePrivatePaths(database);
      for (const path of ['dutydeck.db', 'dutydeck.db-wal', 'secrets/bot.json', 'lark-resources/a.png'])
        await expect(readArtifact(cwd, path, false, { privatePaths }), path).rejects.toMatchObject({ code: 'ARTIFACT_PROTECTED' });
      await expect(readArtifact(cwd, 'report.md', false, { privatePaths })).resolves.toMatchObject({ filename: 'report.md' });

      // 默认 worktree 在实例数据目录下面：工作区文件照常可发；工作目录在家目录等上层时，整个数据目录都不能发。
      const worktree = join(cwd, 'workspaces', 'wt'); await mkdir(worktree, { recursive: true }); await writeFile(join(worktree, 'notes.md'), 'n');
      await expect(readArtifact(worktree, 'notes.md', false, { privatePaths })).resolves.toMatchObject({ filename: 'notes.md' });
      const parent = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-home-')); const dataDirectory = join(parent, 'instance'); await mkdir(dataDirectory); await writeFile(join(dataDirectory, 'state.json'), '{}');
      try {
        await expect(readArtifact(parent, 'instance/state.json', false, { privatePaths: instancePrivatePaths(join(dataDirectory, 'dutydeck.db')) })).rejects.toMatchObject({ code: 'ARTIFACT_PROTECTED' });
      } finally { await rm(parent, { recursive: true, force: true }); }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('rejects a swapped parent directory before upload can read an outside file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-')); const outside = await outsideDir();
    try {
      await mkdir(join(cwd, 'sub')); await writeFile(join(cwd, 'sub', 'report.txt'), 'inside'); await writeFile(join(outside, 'report.txt'), 'outside');
      const client = { uploadFile: vi.fn(), uploadImage: vi.fn(), sendFile: vi.fn(), sendImage: vi.fn() };
      // This hook is installed by the fs mock below immediately before open(),
      // after readArtifact has canonicalized cwd/sub/report.txt.
      fsHook.beforeOpen = async () => { await rename(join(cwd, 'sub'), join(cwd, 'kept')); await symlink(outside, join(cwd, 'sub')); };
      try {
        await expect(deliverArtifact({ configs: configs(), sessionId: 'ses_swap', cwd, client, path: 'sub/report.txt', target: { chatId: 'oc_group' }, image: false })).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUT_OF_SCOPE' });
        expect(client.uploadFile).not.toHaveBeenCalled();
      } finally { fsHook.beforeOpen = undefined; }
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it('uses a persisted upload key after send failure and never sends a duplicate success', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-')); await writeFile(join(cwd, 'report.txt'), 'hello'); await writeFile(join(cwd, 'other.txt'), 'other'); const config = configs();
    const client = { uploadFile: vi.fn(async () => 'file_key'), uploadImage: vi.fn(), sendImage: vi.fn(), sendFile: vi.fn().mockRejectedValueOnce(new Error('send failed')).mockResolvedValue({ messageId: 'om_done', chatId: 'oc_group' }) };
    const input = { configs: config, sessionId: 'ses_1', cwd, client, path: 'report.txt', target: { chatId: 'oc_group' }, image: false, idempotencyKey: 'delivery-1' };
    await expect(deliverArtifact(input)).rejects.toThrow('send failed');
    await expect(deliverArtifact(input)).resolves.toMatchObject({ messageId: 'om_done', replayed: false });
    await expect(deliverArtifact(input)).resolves.toMatchObject({ messageId: 'om_done', replayed: true });
    expect(client.uploadFile).toHaveBeenCalledTimes(1); expect(client.sendFile).toHaveBeenCalledTimes(2);
    await expect(deliverArtifact({ ...input, path: 'other.txt' })).rejects.toMatchObject({ code: 'ARTIFACT_IDEMPOTENCY_CONFLICT' });
  });

  it('dedupes an unkeyed delivery within one task attempt but sends the same file again in a later attempt or task', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-')); await writeFile(join(cwd, 'daily.md'), 'no new alerts'); const config = configs();
    let sequence = 0;
    const client = { uploadFile: vi.fn(async (_input: { idempotencyKey: string }) => 'file_key'), uploadImage: vi.fn(), sendImage: vi.fn(), sendFile: vi.fn(async () => ({ messageId: `om_${++sequence}`, chatId: 'oc_group' })) };
    const input = { configs: config, sessionId: 'ses_turns', cwd, client, path: 'daily.md', target: { chatId: 'oc_group' }, image: false };
    const first = await deliverArtifact({ ...input, turn: { taskId: 'task-one', attemptId: 'attempt-one' } });
    await expect(deliverArtifact({ ...input, turn: { taskId: 'task-one', attemptId: 'attempt-one' } })).resolves.toMatchObject({ messageId: first.messageId, replayed: true });
    await expect(deliverArtifact({ ...input, turn: { taskId: 'task-one', attemptId: 'attempt-two' } })).resolves.toMatchObject({ messageId: 'om_2', replayed: false });
    await expect(deliverArtifact({ ...input, turn: { taskId: 'task-two', attemptId: 'attempt-one' } })).resolves.toMatchObject({ messageId: 'om_3', replayed: false });
    expect(client.sendFile).toHaveBeenCalledTimes(3);
    expect(new Set(client.uploadFile.mock.calls.map(([call]) => call.idempotencyKey)).size).toBe(3);
  });

  it('rejects directories, FIFOs and an over-limit image without blocking or reading it all', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-')); await mkdir(join(cwd, 'directory')); await execFile('mkfifo', [join(cwd, 'pipe')]);
    await writeFile(join(cwd, 'image.bin'), new Uint8Array(10 * 1024 * 1024 + 1));
    await expect(readArtifact(cwd, 'directory', false)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_REGULAR_FILE' });
    await expect(readArtifact(cwd, 'pipe', false)).rejects.toMatchObject({ code: 'ARTIFACT_NOT_REGULAR_FILE' });
    await expect(readArtifact(cwd, 'image.bin', true)).rejects.toMatchObject({ code: 'ARTIFACT_TOO_LARGE' });
  });

  it('derives provider UUIDs per session and makes a second repository observe the active CAS lease', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-')); await writeFile(join(cwd, 'report.txt'), 'hello'); const values = new Map<string, string>(); const config = configs(values); const secondConfig = configs(values);
    let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
    const client = { uploadFile: vi.fn(async input => { await paused; return input.idempotencyKey; }), uploadImage: vi.fn(), sendImage: vi.fn(), sendFile: vi.fn(async input => ({ messageId: input.idempotencyKey, chatId: 'oc_group' })) };
    const base = { configs: config, cwd, client, path: 'report.txt', target: { chatId: 'oc_group' }, image: false, idempotencyKey: 'same-key' };
    const first = deliverArtifact({ ...base, sessionId: 'ses_one' });
    try {
      // Provider entry proves the first caller has acquired the persisted lease. A timer tick does not.
      await vi.waitFor(() => expect(client.uploadFile).toHaveBeenCalledOnce());
      await expect(deliverArtifact({ ...base, configs: secondConfig, sessionId: 'ses_one' })).rejects.toMatchObject({ code: 'ARTIFACT_DELIVERY_IN_PROGRESS' });
    } finally { release(); }
    await first;
    await deliverArtifact({ ...base, sessionId: 'ses_two' });
    expect(client.uploadFile.mock.calls[0]![0].idempotencyKey).not.toBe(client.uploadFile.mock.calls[1]![0].idempotencyKey);
    expect(client.uploadFile.mock.calls[0]![0].idempotencyKey).toMatch(/^dutydeck-.{40}$/);
  });
});
