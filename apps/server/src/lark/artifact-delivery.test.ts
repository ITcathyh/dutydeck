import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
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

import { deliverArtifact, readArtifact } from './artifact-delivery.js';

function configs(values = new Map<string, string>()) { return { get: async (k: string) => values.get(k), set: async (k: string, v: string) => { values.set(k, v); }, compareAndSet: async (k: string, e: string | undefined, v: string) => { if (values.get(k) !== e) return false; values.set(k, v); return true; } }; }
const execFile = promisify(execFileCallback);

describe('artifact delivery', () => {
  it('reads original bytes only from the canonical workspace and rejects escapes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-')); await mkdir(join(cwd, 'nested'));
    const bytes = new Uint8Array([0, 255, 1, 2]); await writeFile(join(cwd, 'nested', 'a.bin'), bytes); await writeFile(join(tmpdir(), 'dutydeck-outside.bin'), 'x');
    await expect(readArtifact(cwd, 'nested/a.bin', false)).resolves.toMatchObject({ data: bytes, fingerprint: createHash('sha256').update(bytes).digest('hex') });
    await expect(readArtifact(cwd, '../dutydeck-outside.bin', false)).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUT_OF_SCOPE' });
    await symlink(join(tmpdir(), 'dutydeck-outside.bin'), join(cwd, 'escape'));
    await expect(readArtifact(cwd, 'escape', false)).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUT_OF_SCOPE' });
  });

  it('rejects a swapped parent directory before upload can read an outside file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-')); const outside = await mkdtemp(join(tmpdir(), 'dutydeck-artifact-outside-'));
    await mkdir(join(cwd, 'sub')); await writeFile(join(cwd, 'sub', 'report.txt'), 'inside'); await writeFile(join(outside, 'report.txt'), 'outside');
    const client = { uploadFile: vi.fn(), uploadImage: vi.fn(), sendFile: vi.fn(), sendImage: vi.fn() };
    // This hook is installed by the fs mock below immediately before open(),
    // after readArtifact has canonicalized cwd/sub/report.txt.
    fsHook.beforeOpen = async () => { await rename(join(cwd, 'sub'), join(cwd, 'kept')); await symlink(outside, join(cwd, 'sub')); };
    try {
      await expect(deliverArtifact({ configs: configs(), sessionId: 'ses_swap', cwd, client, path: 'sub/report.txt', target: { chatId: 'oc_group' }, image: false })).rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUT_OF_SCOPE' });
      expect(client.uploadFile).not.toHaveBeenCalled();
    } finally { fsHook.beforeOpen = undefined; }
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
    await new Promise(resolve => setTimeout(resolve, 0));
    await expect(deliverArtifact({ ...base, configs: secondConfig, sessionId: 'ses_one' })).rejects.toMatchObject({ code: 'ARTIFACT_DELIVERY_IN_PROGRESS' });
    release(); await first;
    await deliverArtifact({ ...base, sessionId: 'ses_two' });
    expect(client.uploadFile.mock.calls[0]![0].idempotencyKey).not.toBe(client.uploadFile.mock.calls[1]![0].idempotencyKey);
    expect(client.uploadFile.mock.calls[0]![0].idempotencyKey).toMatch(/^dutydeck-.{40}$/);
  });
});
