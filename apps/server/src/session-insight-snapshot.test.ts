import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  createInsightFileSnapshots,
  cleanupStaleInsightTempDirs,
  SessionInsightSnapshotError,
  type VerifiedInsightSource
} from './session-insight-snapshot.js';

describe('session-insight-snapshot (T4a)', () => {
  let testRoot: string;
  let dataDir: string;
  let approvedLogRoot: string;

  beforeEach(async () => {
    testRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'dutydeck-snapshot-test-'));
    dataDir = path.join(testRoot, 'data');
    approvedLogRoot = path.join(testRoot, 'logs');
    await fsPromises.mkdir(dataDir, { recursive: true });
    await fsPromises.mkdir(approvedLogRoot, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fsPromises.rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  it('creates 0700 temp directory and 0600 snapshot files with exact prefix SHA256', async () => {
    const logFile = path.join(approvedLogRoot, 'test.jsonl');
    const line1 = '{"type":"user","message":"hello"}\n';
    const line2 = '{"type":"assistant","message":"world"}\n';
    const content = line1 + line2;
    await fsPromises.writeFile(logFile, content, { mode: 0o644 });

    const source: VerifiedInsightSource = {
      sourceKey: 'test_source_01',
      client: 'claude',
      approvedRoot: approvedLogRoot,
      verifiedPath: logFile,
      expectedNativeSessionId: 'native_sess_01',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    const requestId = 'req-snapshot-01';
    const result = await createInsightFileSnapshots({
      dataDir,
      requestId,
      sources: [source]
    });

    expect(result.files).toHaveLength(1);
    expect(result.captures).toHaveLength(1);

    const snapshotFile = result.files[0];
    const capture = result.captures[0];

    // 检查目录权限 0700
    const tempDir = path.join(dataDir, 'insight-tmp', requestId);
    const dirStat = await fsPromises.stat(tempDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    // 检查文件权限 0600
    const fileStat = await fsPromises.stat(snapshotFile.path);
    expect(fileStat.mode & 0o777).toBe(0o600);

    // 检查内容与换行完整性
    const completePrefixBytes = Buffer.byteLength(content);
    expect(capture.readBytes).toBe(completePrefixBytes);
    expect(capture.analyzedBytes).toBe(completePrefixBytes);
    expect(capture.trailingBytes).toBe(0);
    expect(capture.isPartial).toBe(false);

    const expectedSha = crypto.createHash('sha256').update(content).digest('hex');
    expect(snapshotFile.sha256).toBe(expectedSha);
    expect(capture.sha256).toBe(expectedSha);

    // 检查可公开 fingerprint：只包含 fileSize:mtimeNs:ctimeNs，不包含路径或 dev/ino
    expect(capture.fingerprint).not.toContain(logFile);
    expect(capture.fingerprint).not.toContain(tempDir);
    expect(capture.fingerprint).toMatch(/^\d+:\d+:\d+$/);

    // 幂等清理
    await result.cleanup();
    expect(fs.existsSync(tempDir)).toBe(false);
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it('handles partial trailing bytes without newline and publishes partial snapshot', async () => {
    const logFile = path.join(approvedLogRoot, 'partial.jsonl');
    const line1 = '{"type":"user"}\n';
    const trailingPartial = '{"type":"assistant","incomplete":tr';
    const content = line1 + trailingPartial;
    await fsPromises.writeFile(logFile, content, { mode: 0o644 });

    const source: VerifiedInsightSource = {
      sourceKey: 'test_partial_source',
      client: 'traex',
      approvedRoot: approvedLogRoot,
      verifiedPath: logFile,
      expectedNativeSessionId: 'native_sess_partial',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    const requestId = 'req-snapshot-partial';
    const result = await createInsightFileSnapshots({
      dataDir,
      requestId,
      sources: [source]
    });

    const capture = result.captures[0];
    const snapshotFile = result.files[0];

    const line1Bytes = Buffer.byteLength(line1);
    const trailingBytes = Buffer.byteLength(trailingPartial);
    expect(capture.readBytes).toBe(line1Bytes + trailingBytes);
    expect(capture.analyzedBytes).toBe(line1Bytes);
    expect(capture.trailingBytes).toBe(trailingBytes);
    expect(capture.isPartial).toBe(true);

    const writtenContent = await fsPromises.readFile(snapshotFile.path, 'utf8');
    expect(writtenContent).toBe(line1);
    expect(writtenContent).not.toContain('incomplete');

    const expectedSha = crypto.createHash('sha256').update(line1).digest('hex');
    expect(snapshotFile.sha256).toBe(expectedSha);

    await result.cleanup();
  });

  it('handles file without any newline by giving 0 analyzedBytes and empty complete prefix', async () => {
    const logFile = path.join(approvedLogRoot, 'no-newline.jsonl');
    const content = 'no new line at all';
    await fsPromises.writeFile(logFile, content, { mode: 0o644 });

    const source: VerifiedInsightSource = {
      sourceKey: 'test_no_newline',
      client: 'codex',
      approvedRoot: approvedLogRoot,
      verifiedPath: logFile,
      expectedNativeSessionId: 'native_sess_02',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    const result = await createInsightFileSnapshots({
      dataDir,
      requestId: 'req-no-newline',
      sources: [source]
    });

    const capture = result.captures[0];
    const snapshotFile = result.files[0];

    expect(capture.readBytes).toBe(Buffer.byteLength(content));
    expect(capture.analyzedBytes).toBe(0);
    expect(capture.trailingBytes).toBe(Buffer.byteLength(content));
    expect(capture.isPartial).toBe(true);

    const writtenContent = await fsPromises.readFile(snapshotFile.path);
    expect(writtenContent.length).toBe(0);

    const emptySha = crypto.createHash('sha256').update('').digest('hex');
    expect(snapshotFile.sha256).toBe(emptySha);

    await result.cleanup();
  });

  it('detects concurrent growth/modification, retries once, and succeeds if stable on retry', async () => {
    const logFile = path.join(approvedLogRoot, 'growing.jsonl');
    await fsPromises.writeFile(logFile, 'line1\n', { mode: 0o644 });

    const source: VerifiedInsightSource = {
      sourceKey: 'test_retry_growth',
      client: 'claude',
      approvedRoot: approvedLogRoot,
      verifiedPath: logFile,
      expectedNativeSessionId: 'native_sess_03',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    let readCount = 0;
    const originalOpen = fsPromises.open;
    const openSpy = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      const origRead = handle.read.bind(handle);
      handle.read = (async (...readArgs: any[]) => {
        readCount++;
        if (readCount === 1) {
          await fsPromises.appendFile(logFile, 'line2_concurrent\n');
        }
        return (origRead as any)(...readArgs);
      }) as any;
      return handle;
    }) as typeof originalOpen;

    fsPromises.open = openSpy;

    try {
      const result = await createInsightFileSnapshots({
        dataDir,
        requestId: 'req-retry-success',
        sources: [source]
      });

      expect(readCount).toBe(2);
      expect(result.captures[0].analyzedBytes).toBe(Buffer.byteLength('line1\nline2_concurrent\n'));
      await result.cleanup();
    } finally {
      fsPromises.open = originalOpen;
    }
  });

  it('fails with INSIGHT_SOURCE_CHANGED if file continuously changes on retry', async () => {
    const logFile = path.join(approvedLogRoot, 'continuous-growing.jsonl');
    await fsPromises.writeFile(logFile, 'line1\n', { mode: 0o644 });

    const source: VerifiedInsightSource = {
      sourceKey: 'test_continuous_change',
      client: 'claude',
      approvedRoot: approvedLogRoot,
      verifiedPath: logFile,
      expectedNativeSessionId: 'native_sess_04',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    const originalOpen = fsPromises.open;
    let readCount = 0;
    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      const origRead = handle.read.bind(handle);
      handle.read = (async (...readArgs: any[]) => {
        readCount++;
        await fsPromises.appendFile(logFile, `line_change_${readCount}\n`);
        return (origRead as any)(...readArgs);
      }) as any;
      return handle;
    }) as typeof originalOpen;

    try {
      await expect(
        createInsightFileSnapshots({
          dataDir,
          requestId: 'req-continuous-change',
          sources: [source]
        })
      ).rejects.toThrowError(SessionInsightSnapshotError);

      const tempDir = path.join(dataDir, 'insight-tmp', 'req-continuous-change');
      expect(fs.existsSync(tempDir)).toBe(false);
    } finally {
      fsPromises.open = originalOpen;
    }
  });

  it('fails if target file is replaced by a different inode during capture', async () => {
    const logFile = path.join(approvedLogRoot, 'replaced.jsonl');
    await fsPromises.writeFile(logFile, 'initial\n', { mode: 0o644 });

    const source: VerifiedInsightSource = {
      sourceKey: 'test_inode_replaced',
      client: 'claude',
      approvedRoot: approvedLogRoot,
      verifiedPath: logFile,
      expectedNativeSessionId: 'native_sess_05',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    const originalOpen = fsPromises.open;
    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      await fsPromises.unlink(logFile);
      await fsPromises.writeFile(logFile, 'initial\n', { mode: 0o644 });
      return handle;
    }) as typeof originalOpen;

    try {
      await expect(
        createInsightFileSnapshots({
          dataDir,
          requestId: 'req-inode-replaced',
          sources: [source]
        })
      ).rejects.toThrowError(SessionInsightSnapshotError);
    } finally {
      fsPromises.open = originalOpen;
    }
  });

  it('invalidates snapshot on same-size in-place content modification', async () => {
    const logFile = path.join(approvedLogRoot, 'same-size-modified.jsonl');
    await fsPromises.writeFile(logFile, 'AAAA\n', { mode: 0o644 });

    const source: VerifiedInsightSource = {
      sourceKey: 'test_same_size_modify',
      client: 'claude',
      approvedRoot: approvedLogRoot,
      verifiedPath: logFile,
      expectedNativeSessionId: 'native_sess_samesize',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    const originalOpen = fsPromises.open;
    const baseSec = fs.statSync(logFile).mtimeMs / 1000;
    let tick = 0;
    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      const origRead = handle.read.bind(handle);
      handle.read = (async (...readArgs: any[]) => {
        tick++;
        const payload = tick % 2 === 1 ? 'BBBB\n' : 'CCCC\n';
        await fsPromises.writeFile(logFile, payload, { mode: 0o644 });
        // 显式设置严格单调递增的 mtime，使复制前后 stat 在任意调度/时钟粒度下都确定可区分
        const t = baseSec + tick;
        fs.utimesSync(logFile, t, t);
        return (origRead as any)(...readArgs);
      }) as any;
      return handle;
    }) as typeof originalOpen;

    try {
      await expect(
        createInsightFileSnapshots({
          dataDir,
          requestId: 'req-same-size-modified',
          sources: [source]
        })
      ).rejects.toThrowError(SessionInsightSnapshotError);
    } finally {
      fsPromises.open = originalOpen;
    }
  });

  it('refuses symlink target or target resolving outside approved root', async () => {
    const outsideFile = path.join(testRoot, 'outside.jsonl');
    await fsPromises.writeFile(outsideFile, 'secret\n', { mode: 0o644 });

    const outsideSource: VerifiedInsightSource = {
      sourceKey: 'test_outside',
      client: 'codex',
      approvedRoot: approvedLogRoot,
      verifiedPath: outsideFile,
      expectedNativeSessionId: 'sess_out',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    await expect(
      createInsightFileSnapshots({
        dataDir,
        requestId: 'req-outside',
        sources: [outsideSource]
      })
    ).rejects.toThrow();

    const symlinkTarget = path.join(approvedLogRoot, 'symlink-target.jsonl');
    await fsPromises.writeFile(symlinkTarget, 'hello\n', { mode: 0o644 });
    const symlinkFile = path.join(approvedLogRoot, 'symlink.jsonl');
    await fsPromises.symlink(symlinkTarget, symlinkFile);

    const symlinkSource: VerifiedInsightSource = {
      sourceKey: 'test_symlink',
      client: 'codex',
      approvedRoot: approvedLogRoot,
      verifiedPath: symlinkFile,
      expectedNativeSessionId: 'sess_sym',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    await expect(
      createInsightFileSnapshots({
        dataDir,
        requestId: 'req-symlink',
        sources: [symlinkSource]
      })
    ).rejects.toThrow();
  });

  it('refuses non-regular file (FIFO) without indefinite blocking', async () => {
    const fifoPath = path.join(approvedLogRoot, 'test.fifo');
    try {
      execSync(`mkfifo "${fifoPath}"`);
    } catch {
      // 若平台不支持 mkfifo，则跳过
      return;
    }

    const fifoSource: VerifiedInsightSource = {
      sourceKey: 'test_fifo',
      client: 'claude',
      approvedRoot: approvedLogRoot,
      verifiedPath: fifoPath,
      expectedNativeSessionId: 'sess_fifo',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    // 验证不会 hang 住，而是由 O_NONBLOCK + isFile() 检查立即拒绝
    const startTime = Date.now();
    await expect(
      createInsightFileSnapshots({
        dataDir,
        requestId: 'req-fifo',
        sources: [fifoSource]
      })
    ).rejects.toThrowError(SessionInsightSnapshotError);

    expect(Date.now() - startTime).toBeLessThan(1000);
  });

  it('blocks budget bypass: sparse half-line files count by read bytes, not analyzed bytes', async () => {
    const logFile1 = path.join(approvedLogRoot, 'sparse-100.jsonl');
    const logFile2 = path.join(approvedLogRoot, 'sparse-40.jsonl');

    // 稀疏文件：stat size 分别 100 MiB / 40 MiB，内容全为零字节（无换行）。
    // 不占实际磁盘块；analyzedBytes 均为 0，但 readBytes 必须计入 128 MiB 总输入预算。
    const hundredMiB = 100 * 1024 * 1024;
    const fortyMiB = 40 * 1024 * 1024;
    fs.writeFileSync(logFile1, '');
    fs.writeFileSync(logFile2, '');
    fs.truncateSync(logFile1, hundredMiB);
    fs.truncateSync(logFile2, fortyMiB);

    const mkSource = (key: string, p: string, sess: string): VerifiedInsightSource => ({
      sourceKey: key,
      client: 'claude',
      approvedRoot: approvedLogRoot,
      verifiedPath: p,
      expectedNativeSessionId: sess,
      expectedStream: { kind: 'main', nativeAgentId: null }
    });

    // 第一个 100 MiB 半行文件应成功捕获（analyzed=0, read=100MiB）；
    // 第二个 40 MiB 在捕获前按 initialSize 预判：100+40=140 > 128 MiB，必须拒绝。
    await expect(
      createInsightFileSnapshots({
        dataDir,
        requestId: 'req-halfline-budget',
        sources: [
          mkSource('src_sparse_1', logFile1, 'sess_sp1'),
          mkSource('src_sparse_2', logFile2, 'sess_sp2')
        ]
      })
    ).rejects.toMatchObject({ code: 'INSIGHT_INPUT_LIMIT' });
  });

  it('refuses to reuse existing temp directory and does not delete pre-existing directory', async () => {
    const existingReqId = 'req-exclusive-test';
    const existingDir = path.join(dataDir, 'insight-tmp', existingReqId);
    await fsPromises.mkdir(existingDir, { recursive: true });
    const canaryPreExistingFile = path.join(existingDir, 'owned-by-someone-else.txt');
    await fsPromises.writeFile(canaryPreExistingFile, 'do-not-delete');

    const logFile = path.join(approvedLogRoot, 'ok.jsonl');
    await fsPromises.writeFile(logFile, 'line\n', { mode: 0o644 });

    const source: VerifiedInsightSource = {
      sourceKey: 'test_exclusive',
      client: 'claude',
      approvedRoot: approvedLogRoot,
      verifiedPath: logFile,
      expectedNativeSessionId: 'sess_ex',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    // 应该因为 EEXIST 拒绝创建，抛出 INSIGHT_INPUT_LIMIT
    await expect(
      createInsightFileSnapshots({
        dataDir,
        requestId: existingReqId,
        sources: [source]
      })
    ).rejects.toThrowError(SessionInsightSnapshotError);

    // 验证既有目录与其文件安然无恙，未被越权删除
    expect(fs.existsSync(canaryPreExistingFile)).toBe(true);
    expect(await fsPromises.readFile(canaryPreExistingFile, 'utf8')).toBe('do-not-delete');
  });

  it('does not leak private absolute path or credential canary in error messages on raw fs failure', async () => {
    const secretCanary = 'SUPER_SECRET_CANARY_XYZ987';
    const privateCanaryPath = path.join(approvedLogRoot, `dir_${secretCanary}`, 'missing.jsonl');

    const source: VerifiedInsightSource = {
      sourceKey: 'test_canary',
      client: 'claude',
      approvedRoot: approvedLogRoot,
      verifiedPath: privateCanaryPath,
      expectedNativeSessionId: 'canary_sess',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    try {
      await createInsightFileSnapshots({
        dataDir,
        requestId: 'req-canary',
        sources: [source]
      });
      expect.fail('Should have thrown error');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(secretCanary);
      expect(msg).not.toContain(privateCanaryPath);
    }
  });

  it('aborts on signal and cleans up newly created temp directory', async () => {
    const logFile = path.join(approvedLogRoot, 'abort.jsonl');
    await fsPromises.writeFile(logFile, 'line\n', { mode: 0o644 });

    const source: VerifiedInsightSource = {
      sourceKey: 'test_abort',
      client: 'claude',
      approvedRoot: approvedLogRoot,
      verifiedPath: logFile,
      expectedNativeSessionId: 'abort_sess',
      expectedStream: { kind: 'main', nativeAgentId: null }
    };

    const controller = new AbortController();
    controller.abort();

    const requestId = 'req-aborted-job';
    await expect(
      createInsightFileSnapshots({
        dataDir,
        requestId,
        sources: [source],
        signal: controller.signal
      })
    ).rejects.toThrowError(SessionInsightSnapshotError);

    const tempDir = path.join(dataDir, 'insight-tmp', requestId);
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it('cleanupStaleInsightTempDirs cleans only stale dirs under insight-tmp and preserves active ones', async () => {
    const tmpBase = path.join(dataDir, 'insight-tmp');
    const activeReqId = 'req-active-01';
    const staleReqId1 = 'req-stale-01';
    const staleReqId2 = 'req-stale-02';

    await fsPromises.mkdir(path.join(tmpBase, activeReqId), { recursive: true });
    await fsPromises.mkdir(path.join(tmpBase, staleReqId1), { recursive: true });
    await fsPromises.mkdir(path.join(tmpBase, staleReqId2), { recursive: true });

    await fsPromises.writeFile(path.join(tmpBase, activeReqId, 'f.txt'), 'keep');
    await fsPromises.writeFile(path.join(tmpBase, staleReqId1, 'f.txt'), 'delete');

    await cleanupStaleInsightTempDirs(dataDir, new Set([activeReqId]));

    expect(fs.existsSync(path.join(tmpBase, activeReqId))).toBe(true);
    expect(fs.existsSync(path.join(tmpBase, staleReqId1))).toBe(false);
    expect(fs.existsSync(path.join(tmpBase, staleReqId2))).toBe(false);
  });
});
