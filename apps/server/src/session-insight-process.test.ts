import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  runInsightProcess,
  SessionInsightProcessError
} from './session-insight-process.js';
import type {
  AnalyzeFilesRequest,
  AnalyzeFilesResult,
  EngineVersionInfo
} from '@dutydeck/shared';

const EXPECTED_VERSIONS: EngineVersionInfo = {
  schemaVersion: 1,
  engineVersion: '0.1.0',
  parserVersion: 'v3',
  metricVersion: 'v1'
};

describe('session-insight-process (T4a)', () => {
  let testRoot: string;
  let fakeEnginePath: string;
  let goldenResult: AnalyzeFilesResult;
  let validRequest: AnalyzeFilesRequest;

  async function setFakeEngineConfig(config: { mode: string; resultJson?: string }) {
    const configPath = path.join(testRoot, 'fake-engine-config.json');
    await fsPromises.writeFile(configPath, JSON.stringify(config), 'utf8');
  }

  beforeEach(async () => {
    testRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'dutydeck-process-test-'));

    const goldenReqPath = path.resolve(
      __dirname,
      '../../../tests/fixtures/session-insight/golden/analyze-request.golden.json'
    );
    const goldenResPath = path.resolve(
      __dirname,
      '../../../tests/fixtures/session-insight/golden/analyze-result.golden.json'
    );

    validRequest = JSON.parse(await fsPromises.readFile(goldenReqPath, 'utf8'));
    goldenResult = JSON.parse(await fsPromises.readFile(goldenResPath, 'utf8'));

    fakeEnginePath = path.join(testRoot, 'fake-session-insight.mjs');

    const fakeEngineCode = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'analyze' || args[1] !== '--format' || args[2] !== 'json') {
  console.error('Invalid arguments: ' + JSON.stringify(args));
  process.exit(2);
}

let config = {};
try {
  const configPath = path.join(process.cwd(), 'fake-engine-config.json');
  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {}

const mode = config.mode || 'success';

if (mode === 'success') {
  process.stdout.write(config.resultJson || '');
  process.exit(0);
} else if (mode === 'exit3') {
  process.stdout.write(config.resultJson || '');
  process.exit(3);
} else if (mode === 'exit2') {
  process.stderr.write('Invalid request or version mismatch\\n');
  process.exit(2);
} else if (mode === 'exit1') {
  process.stderr.write('Internal engine crash canary: SECRET_CANARY_STUFF\\n');
  process.exit(1);
} else if (mode === 'stdout_overflow') {
  const chunk = Buffer.alloc(1024 * 1024, 'a');
  const send = () => { try { while (process.stdout.write(chunk)) {} } catch {} };
  process.stdout.on('drain', send);
  send();
} else if (mode === 'stderr_overflow') {
  // 持续输出超过 64 KiB，直到被 runner 终止（process.exit 可能截断管道缓冲，故不退出）
  const chunk = Buffer.alloc(1024, 'e');
  const sendErr = () => { try { while (process.stderr.write(chunk)) {} } catch {} };
  process.stderr.on('drain', sendErr);
  sendErr();
} else if (mode === 'hang') {
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 10000);
} else if (mode === 'hang_ignore_sigterm') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 10000);
} else if (mode === 'concat_json') {
  process.stdout.write((config.resultJson || '') + (config.resultJson || ''));
  process.exit(0);
} else if (mode === 'stdin_closed') {
  // 显式关闭 stdin 的 OS fd 并继续存活（响应 SIGTERM）。
  // 宿主超过管道容量的阻塞写稳定收到 EPIPE；由 runner 发 SIGTERM 后在 close 结算。
  fs.closeSync(0);
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 100000);
} else {
  process.exit(1);
}
`;

    await fsPromises.writeFile(fakeEnginePath, fakeEngineCode, { mode: 0o755 });
  });

  afterEach(async () => {
    try {
      await fsPromises.rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  const baseOpts = (overrides: Record<string, unknown> = {}) => ({
    binaryPath: fakeEnginePath,
    request: validRequest,
    expectedVersions: EXPECTED_VERSIONS,
    deadline: Date.now() + 15000,
    tempDir: testRoot,
    ...overrides
  });

  it('rejects invalid required options before spawning', async () => {
    await expect(
      runInsightProcess(baseOpts({ binaryPath: 'relative/path/engine' }) as any)
    ).rejects.toMatchObject({ code: 'INSIGHT_INPUT_LIMIT' });

    await expect(
      runInsightProcess(baseOpts({ tempDir: 'relative/tmp' }) as any)
    ).rejects.toMatchObject({ code: 'INSIGHT_INPUT_LIMIT' });

    await expect(
      runInsightProcess(baseOpts({ tempDir: '' }) as any)
    ).rejects.toMatchObject({ code: 'INSIGHT_INPUT_LIMIT' });

    await expect(
      runInsightProcess(baseOpts({ deadline: Date.now() - 1000 }) as any)
    ).rejects.toMatchObject({ code: 'INSIGHT_TIMEOUT' });

    await expect(
      runInsightProcess(baseOpts({ deadline: Number.NaN }) as any)
    ).rejects.toMatchObject({ code: 'INSIGHT_TIMEOUT' });

    await expect(
      runInsightProcess(baseOpts({ expectedVersions: { schemaVersion: 1 } }) as any)
    ).rejects.toMatchObject({ code: 'INSIGHT_VERSION_MISMATCH' });

    await expect(
      runInsightProcess(baseOpts({ expectedVersions: undefined }) as any)
    ).rejects.toMatchObject({ code: 'INSIGHT_VERSION_MISMATCH' });
  });

  it('successfully analyzes files on exit code 0 with matching schema and identity', async () => {
    await setFakeEngineConfig({ mode: 'success', resultJson: JSON.stringify(goldenResult) });

    const result = await runInsightProcess(baseOpts() as any);

    expect(result.requestId).toBe(validRequest.requestId);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].sourceKey).toBe('src_claude_main_01');
    expect(result.files[0].sha256).toBe(validRequest.files[0].sha256);
  });

  it('accepts exit code 3 with partial error files', async () => {
    const partialResult: AnalyzeFilesResult = JSON.parse(JSON.stringify(goldenResult));
    partialResult.files[0].status = 'error';
    partialResult.files[0].errorCode = 'PARSER_FAILED';
    partialResult.files[0].nativeSessionId = null;

    await setFakeEngineConfig({ mode: 'exit3', resultJson: JSON.stringify(partialResult) });

    const result = await runInsightProcess(baseOpts() as any);
    expect(result.files[0].status).toBe('error');
    expect(result.files[0].errorCode).toBe('PARSER_FAILED');
  });

  it('rejects exit code 0 if any file has error status', async () => {
    const badResult: AnalyzeFilesResult = JSON.parse(JSON.stringify(goldenResult));
    badResult.files[0].status = 'error';
    badResult.files[0].errorCode = 'SOME_ERROR';
    badResult.files[0].nativeSessionId = null;

    await setFakeEngineConfig({ mode: 'success', resultJson: JSON.stringify(badResult) });

    await expect(runInsightProcess(baseOpts() as any)).rejects.toThrowError(
      /Engine exited with 0 but returned files with error/
    );
  });

  it('terminates and rejects INSIGHT_BUDGET_EXCEEDED when stdout exceeds 32 MiB', async () => {
    await setFakeEngineConfig({ mode: 'stdout_overflow' });

    try {
      await runInsightProcess(baseOpts({ deadline: Date.now() + 8000 }) as any);
      expect.fail('Should have failed on stdout overflow');
    } catch (err: unknown) {
      const procErr = err as SessionInsightProcessError;
      expect(procErr.code).toBe('INSIGHT_BUDGET_EXCEEDED');
      expect(procErr.message).not.toContain('aaaaa');
    }
  });

  it('terminates and rejects INSIGHT_BUDGET_EXCEEDED when stderr exceeds 64 KiB', async () => {
    await setFakeEngineConfig({ mode: 'stderr_overflow' });

    try {
      await runInsightProcess(baseOpts() as any);
      expect.fail('Should have failed on stderr overflow');
    } catch (err: unknown) {
      const procErr = err as SessionInsightProcessError;
      expect(procErr.code).toBe('INSIGHT_BUDGET_EXCEEDED');
      expect(procErr.message).not.toContain('eeeee');
    }
  });

  it('terminates hang with SIGTERM on deadline timeout and settles only after close', async () => {
    await setFakeEngineConfig({ mode: 'hang' });

    const start = Date.now();
    try {
      await runInsightProcess(baseOpts({ deadline: Date.now() + 200 }) as any);
      expect.fail('Should have timed out');
    } catch (err: unknown) {
      expect((err as SessionInsightProcessError).code).toBe('INSIGHT_TIMEOUT');
    }
    expect(Date.now() - start).toBeGreaterThanOrEqual(180);
  });

  it('escalates to SIGKILL when child ignores SIGTERM, without clearing escalation timer', async () => {
    await setFakeEngineConfig({ mode: 'hang_ignore_sigterm' });

    const start = Date.now();
    try {
      await runInsightProcess(baseOpts({ deadline: Date.now() + 100 }) as any);
      expect.fail('Should have timed out');
    } catch (err: unknown) {
      expect((err as SessionInsightProcessError).code).toBe('INSIGHT_TIMEOUT');
    }
    // SIGTERM 被忽略，必须靠 2s 宽限后的 SIGKILL 才在 close 终态返回
    expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
  });

  it('terminates on AbortSignal and rejects INSIGHT_INTERRUPTED', async () => {
    await setFakeEngineConfig({ mode: 'hang' });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    try {
      await runInsightProcess(baseOpts({ signal: controller.signal, deadline: Date.now() + 10000 }) as any);
      expect.fail('Should have been aborted');
    } catch (err: unknown) {
      expect((err as SessionInsightProcessError).code).toBe('INSIGHT_INTERRUPTED');
    }
  });

  it('rejects exit code 2 with INSIGHT_VERSION_MISMATCH', async () => {
    await setFakeEngineConfig({ mode: 'exit2' });
    try {
      await runInsightProcess(baseOpts() as any);
      expect.fail('Should have failed with exit 2');
    } catch (err: unknown) {
      expect((err as SessionInsightProcessError).code).toBe('INSIGHT_VERSION_MISMATCH');
    }
  });

  it('rejects exit code 1 with fixed code and hides stderr canary', async () => {
    await setFakeEngineConfig({ mode: 'exit1' });
    try {
      await runInsightProcess(baseOpts() as any);
      expect.fail('Should have failed with exit 1');
    } catch (err: unknown) {
      const procErr = err as SessionInsightProcessError;
      expect(procErr.code).toBe('INSIGHT_PROCESS_ERROR');
      expect(procErr.message).not.toContain('SECRET_CANARY_STUFF');
    }
  });

  it('rejects concatenated or corrupted JSON output', async () => {
    await setFakeEngineConfig({ mode: 'concat_json', resultJson: JSON.stringify(goldenResult) });
    try {
      await runInsightProcess(baseOpts() as any);
      expect.fail('Should have failed on concatenated JSON');
    } catch (err: unknown) {
      expect((err as SessionInsightProcessError).code).toBe('INSIGHT_PROCESS_ERROR');
    }
  });

  it('settles on close with fixed code when process fails to spawn, without leaking binary path', async () => {
    const canaryBinary = path.join(testRoot, 'CANARY_BINARY_4242', 'missing-engine');
    try {
      await runInsightProcess(baseOpts({ binaryPath: canaryBinary }) as any);
      expect.fail('Should have failed to spawn');
    } catch (err: unknown) {
      const procErr = err as SessionInsightProcessError;
      expect(procErr.code).toBe('INSIGHT_PROCESS_ERROR');
      // child 'error' 不得提前 reject；错误文本不得回显含 canary 的绝对路径
      expect(procErr.message).not.toContain('CANARY_BINARY_4242');
      expect(procErr.message).not.toContain('ENOENT');
    }
  });

  it('does not swallow stdin failure: fixed failure, terminate child, settle after close', async () => {
    await setFakeEngineConfig({ mode: 'stdin_closed' });

    // 构造约 4 MiB 的合法请求（32 文件、每文件超长 sourceKey）。
    // 远超 64 KiB 管道容量：子进程关闭 fd0 后，宿主阻塞写稳定收到 EPIPE，
    // 必须识别为固定 stdin 失败、发 SIGTERM 终止并在 close 结算，而不是静默空等超时。
    const bigFiles = Array.from({ length: 32 }, (_, i) => ({
      sourceKey: `key_${i}_${'x'.repeat(130000)}`,
      client: 'claude' as const,
      path: path.join(testRoot, `snapshot-${i}.jsonl`),
      sha256: validRequest.files[0].sha256,
      bytes: 0,
      expectedNativeSessionId: `sess-${i}`,
      expectedStream: { kind: 'main' as const, nativeAgentId: null }
    }));
    const bigRequest: AnalyzeFilesRequest = {
      schemaVersion: 1,
      requestId: validRequest.requestId,
      files: bigFiles,
      limits: { maxLineBytes: 4194304, maxTraceEvents: 20000 }
    };
    expect(Buffer.byteLength(JSON.stringify(bigRequest))).toBeGreaterThan(3 * 1024 * 1024);

    const start = Date.now();
    try {
      await runInsightProcess(baseOpts({ request: bigRequest, deadline: Date.now() + 10000 }) as any);
      expect.fail('Should have failed on stdin error');
    } catch (err: unknown) {
      const procErr = err as SessionInsightProcessError;
      expect(procErr.code).toBe('INSIGHT_PROCESS_ERROR');
      expect(procErr.message).toMatch(/stdin/i);
    }
    // 必须快速终止并在 close 返回，而不是空等到 10s deadline
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('dedups identical sourceKey+hash+identity, but rejects same key with inconsistent identity', async () => {
    await setFakeEngineConfig({ mode: 'success', resultJson: JSON.stringify(goldenResult) });

    // 同 key 同 hash 同身份 => dedup，引擎只收到 1 个文件，输出 1 个文件通过
    const dedupRequest: AnalyzeFilesRequest = {
      ...validRequest,
      files: [validRequest.files[0], { ...validRequest.files[0] }]
    };
    const result = await runInsightProcess(baseOpts({ request: dedupRequest }) as any);
    expect(result.files).toHaveLength(1);

    // 同 key 同 hash 但不同 nativeSessionId => 身份冲突
    const idConflict: AnalyzeFilesRequest = {
      ...validRequest,
      files: [
        validRequest.files[0],
        { ...validRequest.files[0], expectedNativeSessionId: 'different-session-id' }
      ]
    };
    await expect(
      runInsightProcess(baseOpts({ request: idConflict }) as any)
    ).rejects.toMatchObject({ code: 'INSIGHT_SOURCE_CONFLICT' });

    // 同 key 同 hash 但不同 stream => 身份冲突
    const streamConflict: AnalyzeFilesRequest = {
      ...validRequest,
      files: [
        validRequest.files[0],
        {
          ...validRequest.files[0],
          expectedStream: { kind: 'subagent', nativeAgentId: 'agent-x' }
        }
      ]
    };
    await expect(
      runInsightProcess(baseOpts({ request: streamConflict }) as any)
    ).rejects.toMatchObject({ code: 'INSIGHT_SOURCE_CONFLICT' });

    // 同 key 不同 hash => 哈希冲突
    const hashConflict: AnalyzeFilesRequest = {
      ...validRequest,
      files: [
        validRequest.files[0],
        {
          ...validRequest.files[0],
          sha256: '0000000000000000000000000000000000000000000000000000000000000000'
        }
      ]
    };
    await expect(
      runInsightProcess(baseOpts({ request: hashConflict }) as any)
    ).rejects.toMatchObject({ code: 'INSIGHT_SOURCE_CONFLICT' });
  });

  it('freezes request at entry: post-call mutation of the caller object cannot change expected set', async () => {
    await setFakeEngineConfig({ mode: 'success', resultJson: JSON.stringify(goldenResult) });

    const mutableRequest: AnalyzeFilesRequest = JSON.parse(JSON.stringify(validRequest));
    const promise = runInsightProcess(baseOpts({ request: mutableRequest }) as any);

    // 调用返回后立即外部篡改：改 hash、requestId、文件集合
    mutableRequest.files[0].sha256 = 'f'.repeat(64);
    mutableRequest.requestId = 'mutated-request-id';
    mutableRequest.files.push({ ...validRequest.files[0], sourceKey: 'extra_key' });

    // 仍按 entry 冻结的原始期望集合校验成功，不受后续 mutation 影响
    const result = await promise;
    expect(result.requestId).toBe(validRequest.requestId);
    expect(result.files[0].sha256).toBe(validRequest.files[0].sha256);
  });

  it('rejects mismatched sourceKey/sha/identity without echoing untrusted sourceKey', async () => {
    const unknownSourceResult: AnalyzeFilesResult = JSON.parse(JSON.stringify(goldenResult));
    unknownSourceResult.files[0].sourceKey = 'EVIL_CANARY_SOURCEKEY_99';
    await setFakeEngineConfig({ mode: 'success', resultJson: JSON.stringify(unknownSourceResult) });

    try {
      await runInsightProcess(baseOpts() as any);
      expect.fail('Should reject unknown sourceKey');
    } catch (err: unknown) {
      const procErr = err as SessionInsightProcessError;
      expect(procErr.code).toBe('INSIGHT_PROCESS_ERROR');
      expect(procErr.message).not.toContain('EVIL_CANARY_SOURCEKEY_99');
    }

    const shaMismatch = JSON.parse(JSON.stringify(goldenResult));
    shaMismatch.files[0].sha256 = '1'.repeat(64);
    await setFakeEngineConfig({ mode: 'success', resultJson: JSON.stringify(shaMismatch) });
    await expect(runInsightProcess(baseOpts() as any)).rejects.toMatchObject({
      code: 'INSIGHT_SOURCE_CONFLICT'
    });

    const idMismatch = JSON.parse(JSON.stringify(goldenResult));
    idMismatch.files[0].nativeSessionId = 'different_session_id';
    await setFakeEngineConfig({ mode: 'success', resultJson: JSON.stringify(idMismatch) });
    await expect(runInsightProcess(baseOpts() as any)).rejects.toThrowError(
      /nativeSessionId mismatch/
    );

    const streamMismatch = JSON.parse(JSON.stringify(goldenResult));
    streamMismatch.files[0].streamIdentity = { kind: 'subagent', nativeAgentId: 'agent_abc' };
    await setFakeEngineConfig({ mode: 'success', resultJson: JSON.stringify(streamMismatch) });
    await expect(runInsightProcess(baseOpts() as any)).rejects.toThrowError(
      /streamIdentity mismatch/
    );
  });
});
