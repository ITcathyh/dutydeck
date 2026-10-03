import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  analyzeFilesRequestSchema,
  analyzeFilesResultSchema,
  engineVersionInfoSchema,
  SESSION_INSIGHT_LIMITS,
  type AnalyzeFilesRequest,
  type AnalyzeFilesResult,
  type AnalyzeFileInput,
  type EngineVersionInfo
} from '@dutydeck/shared';

export class SessionInsightProcessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionInsightProcessError';
    this.code = code;
  }
}

export interface RunInsightProcessOptions {
  binaryPath: string; // 必须是绝对路径
  request: AnalyzeFilesRequest; // entry 处深拷贝并校验
  expectedVersions: EngineVersionInfo; // 必须完整提供
  signal?: AbortSignal;
  deadline: number; // 必须是有限且大于当前时间的绝对时间戳
  tempDir: string; // 必须是绝对路径且非空
}

function getSanitizedEnv(tempDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/bin:/usr/bin',
    TMPDIR: tempDir,
    LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: tempDir,
    SYSTEMROOT: process.env.SYSTEMROOT
  };
}

/**
 * 校验并去重输入来源：
 * - 相同 sourceKey 必须哈希与身份（client, expectedNativeSessionId, stream）完全一致，否则抛出 INSIGHT_SOURCE_CONFLICT；
 * - 验证通过后按协议 dedup，返回去重后的 map。
 */
function dedupAndValidateRequestSources(
  files: AnalyzeFileInput[]
): Map<string, AnalyzeFileInput> {
  const map = new Map<string, AnalyzeFileInput>();

  for (const file of files) {
    const existing = map.get(file.sourceKey);
    if (!existing) {
      map.set(file.sourceKey, file);
    } else {
      if (existing.sha256 !== file.sha256) {
        throw new SessionInsightProcessError(
          'INSIGHT_SOURCE_CONFLICT',
          'Conflicting source hashes for the same sourceKey'
        );
      }
      if (
        existing.client !== file.client ||
        existing.expectedNativeSessionId !== file.expectedNativeSessionId ||
        existing.expectedStream.kind !== file.expectedStream.kind ||
        existing.expectedStream.nativeAgentId !== file.expectedStream.nativeAgentId
      ) {
        throw new SessionInsightProcessError(
          'INSIGHT_SOURCE_CONFLICT',
          'Conflicting source identity for duplicate sourceKey'
        );
      }
    }
  }

  return map;
}

/**
 * 验证解析后的引擎输出结果，全部采用固定错误文本，杜绝未授信内容泄漏。
 */
function validateEngineResult(
  result: AnalyzeFilesResult,
  expectedRequestId: string,
  expectedFilesMap: Map<string, AnalyzeFileInput>,
  expectedVersions: EngineVersionInfo,
  exitCode: number | null
): void {
  if (result.requestId !== expectedRequestId) {
    throw new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'Mismatched requestId in response');
  }

  if (result.schemaVersion !== 1) {
    throw new SessionInsightProcessError('INSIGHT_VERSION_MISMATCH', 'Mismatched schemaVersion');
  }

  if (
    result.engineVersion !== expectedVersions.engineVersion ||
    result.parserVersion !== expectedVersions.parserVersion ||
    result.metricVersion !== expectedVersions.metricVersion
  ) {
    throw new SessionInsightProcessError('INSIGHT_VERSION_MISMATCH', 'Engine version mismatch');
  }

  if (exitCode === 0 && result.files.some(f => f.status === 'error')) {
    throw new SessionInsightProcessError(
      'INSIGHT_PROCESS_ERROR',
      'Engine exited with 0 but returned files with error status'
    );
  }

  if (result.files.length !== expectedFilesMap.size) {
    throw new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'Files count mismatch in response');
  }

  const seenKeys = new Set<string>();

  for (const resFile of result.files) {
    if (seenKeys.has(resFile.sourceKey)) {
      throw new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'Duplicate sourceKey in response');
    }
    seenKeys.add(resFile.sourceKey);

    const expected = expectedFilesMap.get(resFile.sourceKey);
    if (!expected) {
      throw new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'Unknown sourceKey in response');
    }

    if (resFile.sha256 !== expected.sha256) {
      throw new SessionInsightProcessError('INSIGHT_SOURCE_CONFLICT', 'Source sha256 mismatch');
    }

    if (resFile.client !== expected.client) {
      throw new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'Client mismatch in response');
    }

    if (resFile.status !== 'error') {
      if (resFile.nativeSessionId !== expected.expectedNativeSessionId) {
        throw new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'nativeSessionId mismatch');
      }

      if (
        resFile.streamIdentity.kind !== expected.expectedStream.kind ||
        resFile.streamIdentity.nativeAgentId !== expected.expectedStream.nativeAgentId
      ) {
        throw new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'streamIdentity mismatch');
      }
    }
  }
}

/**
 * 运行 Go session-insight 分析引擎。
 * 强约束：
 * - 必须接收绝对 binaryPath、绝对 tempDir、有限未来 deadline 与完整 expectedVersions。
 * - 请求在 entry 处使用 frozen Zod 深拷贝，去重后序列化送往 stdin。
 * - 直接 spawn argv 固定 ['analyze', '--format', 'json']，无 shell，最小环境白名单。
 * - stdin 失败或 child error 不提前 settle，统一向子进程发送终止信号并在 close 终态结算。
 * - 错误输出只给固定 code 与 safe text，不回显未校验来源键或引擎原始输出。
 */
export async function runInsightProcess(
  options: RunInsightProcessOptions
): Promise<AnalyzeFilesResult> {
  const { binaryPath, request, expectedVersions, signal, deadline, tempDir } = options;

  if (!path.isAbsolute(binaryPath)) {
    throw new SessionInsightProcessError('INSIGHT_INPUT_LIMIT', 'binaryPath must be an absolute path');
  }

  if (!tempDir || typeof tempDir !== 'string' || !path.isAbsolute(tempDir)) {
    throw new SessionInsightProcessError('INSIGHT_INPUT_LIMIT', 'tempDir must be an absolute path');
  }

  if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= Date.now()) {
    throw new SessionInsightProcessError('INSIGHT_TIMEOUT', 'deadline must be a finite timestamp in the future');
  }

  // 完整校验 expectedVersions（必须是完整 EngineVersionInfo）
  try {
    engineVersionInfoSchema.parse(expectedVersions);
  } catch {
    throw new SessionInsightProcessError(
      'INSIGHT_VERSION_MISMATCH',
      'expectedVersions must be a complete engine version descriptor'
    );
  }

  if (signal?.aborted) {
    throw new SessionInsightProcessError('INSIGHT_INTERRUPTED', 'Process execution aborted by signal');
  }

  // 深拷贝并冻结请求，防止外部调用者随后篡改
  let clonedRequest: AnalyzeFilesRequest;
  try {
    clonedRequest = analyzeFilesRequestSchema.parse(JSON.parse(JSON.stringify(request)));
  } catch {
    throw new SessionInsightProcessError('INSIGHT_INPUT_LIMIT', 'Invalid analyze request');
  }
  const expectedFilesMap = dedupAndValidateRequestSources(clonedRequest.files);

  // 构造送往 stdin 的真正去重后请求
  const requestPayload: AnalyzeFilesRequest = {
    ...clonedRequest,
    files: Array.from(expectedFilesMap.values())
  };
  const requestJson = JSON.stringify(requestPayload);

  return new Promise<AnalyzeFilesResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binaryPath, ['analyze', '--format', 'json'], {
        shell: false,
        cwd: tempDir,
        env: getSanitizedEnv(tempDir),
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      return reject(
        new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'Failed to spawn insight engine binary')
      );
    }

    let killed = false;
    let killReason:
      | 'timeout'
      | 'abort'
      | 'budget_stdout'
      | 'budget_stderr'
      | 'stdin_error'
      | 'child_error'
      | null = null;

    let childError: Error | null = null;
    let stdinError: Error | null = null;

    let forceKillTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const terminateChild = (
      reason:
        | 'timeout'
        | 'abort'
        | 'budget_stdout'
        | 'budget_stderr'
        | 'stdin_error'
        | 'child_error'
    ) => {
      if (killed) return;
      killed = true;
      killReason = reason;

      try {
        child.kill('SIGTERM');
      } catch {}

      forceKillTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        } catch {}
      }, SESSION_INSIGHT_LIMITS.jobGracePeriodMs);
    };

    // 超时管理
    timeoutTimer = setTimeout(() => {
      terminateChild('timeout');
    }, Math.max(0, deadline - Date.now()));

    // 中断信号管理
    const abortListener = () => {
      terminateChild('abort');
    };
    if (signal) {
      if (signal.aborted) {
        terminateChild('abort');
      } else {
        signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    // 收集标准输出与错误输出
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (killed) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > SESSION_INSIGHT_LIMITS.maxStdoutBytes) {
        terminateChild('budget_stdout');
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (killed) return;
      stderrBytes += chunk.length;
      if (stderrBytes > SESSION_INSIGHT_LIMITS.maxStderrBytes) {
        terminateChild('budget_stderr');
        return;
      }
      stderrChunks.push(chunk);
    });

    // 处理 stdin 写入与写入错误，绝不静默吞掉，统一触发终止并等待 close
    child.stdin?.on('error', err => {
      stdinError = err;
      terminateChild('stdin_error');
    });

    try {
      child.stdin?.write(requestJson, 'utf8', err => {
        if (err) {
          stdinError = err;
          terminateChild('stdin_error');
        } else {
          try {
            child.stdin?.end();
          } catch {}
        }
      });
    } catch (err: unknown) {
      stdinError = err instanceof Error ? err : new Error(String(err));
      terminateChild('stdin_error');
    }

    // 处理进程错误：绝不提前 reject，不清除 SIGKILL 升级 timer，统一等待 close
    child.on('error', err => {
      childError = err;
      terminateChild('child_error');
    });

    // 唯一的终态结算点：保证子进程彻底退出且所有 stdio 流已关闭
    child.on('close', (code, signalCode) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (signal) signal.removeEventListener('abort', abortListener);

      if (killReason === 'timeout') {
        return reject(
          new SessionInsightProcessError('INSIGHT_TIMEOUT', 'Process execution deadline exceeded')
        );
      }
      if (killReason === 'abort') {
        return reject(
          new SessionInsightProcessError('INSIGHT_INTERRUPTED', 'Process execution aborted by signal')
        );
      }
      if (killReason === 'budget_stdout') {
        return reject(
          new SessionInsightProcessError('INSIGHT_BUDGET_EXCEEDED', 'Process stdout limit exceeded')
        );
      }
      if (killReason === 'budget_stderr') {
        return reject(
          new SessionInsightProcessError('INSIGHT_BUDGET_EXCEEDED', 'Process stderr limit exceeded')
        );
      }
      if (killReason === 'stdin_error' || stdinError) {
        return reject(
          new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'Failed to write request into process stdin')
        );
      }
      if (killReason === 'child_error' || childError) {
        return reject(
          new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'Insight engine process emitted an error')
        );
      }

      // 仅接受 exit 0 或 exit 3
      if (code !== 0 && code !== 3) {
        if (code === 2) {
          return reject(
            new SessionInsightProcessError(
              'INSIGHT_VERSION_MISMATCH',
              'Engine reported invalid request or version mismatch'
            )
          );
        }
        return reject(
          new SessionInsightProcessError(
            'INSIGHT_PROCESS_ERROR',
            `Process terminated with exit code ${code ?? signalCode}`
          )
        );
      }

      const stdoutRaw = Buffer.concat(stdoutChunks).toString('utf8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdoutRaw);
      } catch {
        return reject(
          new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'Failed to parse engine output as valid JSON')
        );
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return reject(
          new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'Engine output is not a JSON object')
        );
      }

      let result: AnalyzeFilesResult;
      try {
        result = analyzeFilesResultSchema.parse(parsed);
      } catch {
        return reject(
          new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'Engine output failed schema validation')
        );
      }

      try {
        validateEngineResult(result, clonedRequest.requestId, expectedFilesMap, expectedVersions, code);
      } catch (err: unknown) {
        return reject(err);
      }

      return resolve(result);
    });
  });
}
