import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  SESSION_INSIGHT_LIMITS,
  type InsightClient,
  type StreamIdentity,
  type AnalyzeFileInput
} from '@dutydeck/shared';

export class SessionInsightSnapshotError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionInsightSnapshotError';
    this.code = code;
  }
}

/**
 * 宿主内部经过核验的日志来源对象。
 * 外部请求不可传入任意 path；此处接收宿主已核准的根与路径。
 */
export interface VerifiedInsightSource {
  sourceKey: string;
  client: InsightClient;
  approvedRoot: string;
  verifiedPath: string;
  expectedNativeSessionId: string;
  expectedStream: StreamIdentity;
  [key: string]: unknown;
}

export interface InsightFileCaptureInfo {
  sourceKey: string;
  client: InsightClient;
  sha256: string;
  capturedAt: string;
  readBytes: number;
  analyzedBytes: number;
  trailingBytes: number;
  fingerprint: string;
  isPartial: boolean;
}

export interface CreateInsightSnapshotOptions {
  dataDir: string;
  requestId: string;
  sources: VerifiedInsightSource[];
  signal?: AbortSignal;
  deadline?: number;
}

export interface InsightSnapshotResult {
  files: AnalyzeFileInput[];
  captures: InsightFileCaptureInfo[];
  cleanup: () => Promise<void>;
}

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function isUnderApprovedRoot(resolvedTarget: string, resolvedApprovedRoot: string): boolean {
  const normalizedRoot = resolvedApprovedRoot.endsWith(path.sep)
    ? resolvedApprovedRoot
    : resolvedApprovedRoot + path.sep;
  return resolvedTarget === resolvedApprovedRoot || resolvedTarget.startsWith(normalizedRoot);
}

/**
 * 为单个来源文件捕获快照。
 * 包含：O_NOFOLLOW | O_NONBLOCK 防 FIFO/特殊文件阻塞、realpath 核准根约束、
 * dev/ino/size/mtimeNs/ctimeNs 前后一致性对比、固定初始 size 复制不追尾、
 * 完整换行前缀提取。错误信息统一脱敏，不泄漏原始绝对路径。
 */
async function captureSingleSourceSnapshot(
  source: VerifiedInsightSource,
  targetFilePath: string,
  accumulatedBytesBefore: number,
  signal?: AbortSignal,
  deadline?: number
): Promise<{ capture: InsightFileCaptureInfo; readBytes: number; analyzedBytes: number }> {
  let attempts = 0;

  while (attempts < 2) {
    attempts++;

    if (signal?.aborted) {
      throw new SessionInsightSnapshotError('INSIGHT_INTERRUPTED', 'Operation aborted by signal');
    }
    if (deadline && Date.now() >= deadline) {
      throw new SessionInsightSnapshotError('INSIGHT_TIMEOUT', 'Snapshot deadline exceeded');
    }

    // 1. 验证核准根
    let realApprovedRoot: string;
    try {
      realApprovedRoot = await fsPromises.realpath(source.approvedRoot);
    } catch {
      throw new SessionInsightSnapshotError(
        'INSIGHT_NOT_FOUND',
        'Approved root does not exist or cannot be resolved'
      );
    }

    // 2. 检查原路径并以 O_NOFOLLOW | O_NONBLOCK 打开（防止遇到 FIFO 或特殊文件阻塞）
    let fileHandle: fsPromises.FileHandle | null = null;
    try {
      fileHandle = await fsPromises.open(
        source.verifiedPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ELOOP' || nodeErr.code === 'SYMLINK') {
        throw new SessionInsightSnapshotError(
          'INSIGHT_FORBIDDEN',
          'Source file is a symlink, which is prohibited'
        );
      }
      throw new SessionInsightSnapshotError(
        'INSIGHT_NOT_FOUND',
        'Failed to open source file securely'
      );
    }

    try {
      // 3. 读取初始 fd stat 并核验普通文件（必须在任何阻塞操作前确认）
      let initialStat: fs.BigIntStats;
      try {
        initialStat = await fileHandle.stat({ bigint: true });
      } catch {
        throw new SessionInsightSnapshotError('INSIGHT_NOT_FOUND', 'Failed to inspect source file');
      }

      if (!initialStat.isFile()) {
        throw new SessionInsightSnapshotError(
          'INSIGHT_FORBIDDEN',
          'Source path is not a regular file'
        );
      }

      // 4. 核对 realpath 是否在 approvedRoot 之下
      let realFilePath: string;
      try {
        realFilePath = await fsPromises.realpath(source.verifiedPath);
      } catch {
        throw new SessionInsightSnapshotError(
          'INSIGHT_NOT_FOUND',
          'Failed to resolve realpath of source file'
        );
      }

      if (!isUnderApprovedRoot(realFilePath, realApprovedRoot)) {
        throw new SessionInsightSnapshotError(
          'INSIGHT_FORBIDDEN',
          'Source file resolved outside approved root'
        );
      }

      const initialDev = initialStat.dev;
      const initialIno = initialStat.ino;
      const initialSizeBig = initialStat.size;
      const initialMtimeNs = initialStat.mtimeNs;
      const initialCtimeNs = initialStat.ctimeNs;

      if (initialSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new SessionInsightSnapshotError(
          'INSIGHT_INPUT_LIMIT',
          'Source file size exceeds safe integer limit'
        );
      }
      const initialSize = Number(initialSizeBig);

      // 输入总预算检查（基于已读取总量 + 初始大小，防止大半行绕过）
      if (
        accumulatedBytesBefore + initialSize >
        SESSION_INSIGHT_LIMITS.maxTotalSnapshotBytes
      ) {
        throw new SessionInsightSnapshotError(
          'INSIGHT_INPUT_LIMIT',
          'Total snapshot bytes budget exceeded'
        );
      }

      // 5. 固定初始 size 复制，从 offset 0 开始只读取最多 initialSize 字节（不追尾）
      const buffer = Buffer.alloc(initialSize);
      let totalBytesRead = 0;
      while (totalBytesRead < initialSize) {
        if (signal?.aborted) {
          throw new SessionInsightSnapshotError(
            'INSIGHT_INTERRUPTED',
            'Operation aborted by signal'
          );
        }
        if (deadline && Date.now() >= deadline) {
          throw new SessionInsightSnapshotError(
            'INSIGHT_TIMEOUT',
            'Snapshot deadline exceeded'
          );
        }

        const toRead = initialSize - totalBytesRead;
        let bytesRead = 0;
        try {
          const res = await fileHandle.read(buffer, totalBytesRead, toRead, totalBytesRead);
          bytesRead = res.bytesRead;
        } catch {
          throw new SessionInsightSnapshotError(
            'INSIGHT_NOT_FOUND',
            'Failed to read source file content'
          );
        }

        if (bytesRead === 0) {
          // 底层文件发生了截断
          break;
        }
        totalBytesRead += bytesRead;
      }

      // 6. 复制完成后复查 fd 元信息与原路径 inode
      let postFdStat: fs.BigIntStats;
      try {
        postFdStat = await fileHandle.stat({ bigint: true });
      } catch {
        throw new SessionInsightSnapshotError('INSIGHT_NOT_FOUND', 'Failed to inspect source file');
      }

      let postPathStat: fs.BigIntStats;
      try {
        postPathStat = await fsPromises.stat(source.verifiedPath, { bigint: true });
      } catch {
        // 文件在原路径已被删除或无法访问
        if (attempts >= 2) {
          throw new SessionInsightSnapshotError(
            'INSIGHT_SOURCE_CHANGED',
            'Source file replaced or removed during snapshot'
          );
        }
        continue;
      }

      const changed =
        postFdStat.dev !== initialDev ||
        postFdStat.ino !== initialIno ||
        postFdStat.size !== initialSizeBig ||
        postFdStat.mtimeNs !== initialMtimeNs ||
        postFdStat.ctimeNs !== initialCtimeNs ||
        postPathStat.dev !== initialDev ||
        postPathStat.ino !== initialIno ||
        totalBytesRead !== initialSize;

      if (changed) {
        if (attempts >= 2) {
          throw new SessionInsightSnapshotError(
            'INSIGHT_SOURCE_CHANGED',
            'Source file continuously changing during snapshot'
          );
        }
        // 第一次检测到变化，立即重试
        continue;
      }

      // 7. 计算完整换行前缀
      const actualRead = totalBytesRead;
      let lastNewlineIndex = -1;
      for (let i = actualRead - 1; i >= 0; i--) {
        if (buffer[i] === 0x0a) {
          lastNewlineIndex = i;
          break;
        }
      }

      const analyzedBytes = lastNewlineIndex >= 0 ? lastNewlineIndex + 1 : 0;
      const trailingBytes = actualRead - analyzedBytes;
      const isPartial = trailingBytes > 0;

      const completePrefix = buffer.subarray(0, analyzedBytes);

      // 8. 计算前缀 SHA256 并写入目标临时文件（普通文件 0600）
      const sha256 = crypto.createHash('sha256').update(completePrefix).digest('hex');

      try {
        await fsPromises.writeFile(targetFilePath, completePrefix, {
          mode: 0o600,
          flag: 'w'
        });
        await fsPromises.chmod(targetFilePath, 0o600);
      } catch {
        throw new SessionInsightSnapshotError(
          'INSIGHT_NOT_FOUND',
          'Failed to write snapshot output file securely'
        );
      }

      // 9. 构造可公开 fingerprint（只包含 fileSize、mtimeNs、ctimeNs，绝对不进私有 path/dev/ino）
      const fingerprint = `${initialSize}:${initialMtimeNs.toString()}:${initialCtimeNs.toString()}`;
      const capturedAt = new Date().toISOString();

      return {
        capture: {
          sourceKey: source.sourceKey,
          client: source.client,
          sha256,
          capturedAt,
          readBytes: actualRead,
          analyzedBytes,
          trailingBytes,
          fingerprint,
          isPartial
        },
        readBytes: actualRead,
        analyzedBytes
      };
    } finally {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
    }
  }

  throw new SessionInsightSnapshotError(
    'INSIGHT_SOURCE_CHANGED',
    'Source file continuously changing during snapshot'
  );
}

/**
 * 宿主不可变文件快照创建。
 * 独占创建 0700 临时目录并在其中生成 0600 的只含完整换行前缀的日志副本。
 */
export async function createInsightFileSnapshots(
  options: CreateInsightSnapshotOptions
): Promise<InsightSnapshotResult> {
  const { dataDir, requestId, sources, signal, deadline } = options;

  if (!requestId || !SAFE_ID_PATTERN.test(requestId)) {
    throw new SessionInsightSnapshotError('INSIGHT_INPUT_LIMIT', 'Invalid requestId');
  }

  if (sources.length === 0) {
    throw new SessionInsightSnapshotError('INSIGHT_INPUT_LIMIT', 'Sources cannot be empty');
  }

  if (sources.length > SESSION_INSIGHT_LIMITS.maxSnapshotsPerJob) {
    throw new SessionInsightSnapshotError(
      'INSIGHT_INPUT_LIMIT',
      `Exceeded max snapshots per job: ${sources.length} > ${SESSION_INSIGHT_LIMITS.maxSnapshotsPerJob}`
    );
  }

  const tmpBase = path.resolve(dataDir, 'insight-tmp');
  try {
    await fsPromises.mkdir(tmpBase, { recursive: true, mode: 0o700 });
  } catch {
    throw new SessionInsightSnapshotError('INSIGHT_NOT_FOUND', 'Failed to prepare base temp directory');
  }

  const tempDir = path.join(tmpBase, requestId);
  // 独占创建（recursive: false），已存在则抛 EEXIST 拒绝，防止目录重用或越权清理
  try {
    await fsPromises.mkdir(tempDir, { recursive: false, mode: 0o700 });
    await fsPromises.chmod(tempDir, 0o700);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'EEXIST') {
      throw new SessionInsightSnapshotError(
        'INSIGHT_INPUT_LIMIT',
        'Temporary directory for request already exists'
      );
    }
    throw new SessionInsightSnapshotError('INSIGHT_NOT_FOUND', 'Failed to create request temp directory');
  }

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    try {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
      cleanedUp = true;
    } catch {
      throw new SessionInsightSnapshotError('INSIGHT_CLEANUP_FAILED', 'Failed to remove temporary directory');
    }
  };

  const files: AnalyzeFileInput[] = [];
  const captures: InsightFileCaptureInfo[] = [];
  let totalInputBytes = 0;

  try {
    for (const [i, source] of sources.entries()) {
      // 使用索引编号构建临时文件，防止 sourceKey 过长或包含特殊路径字符
      const snapshotFileName = `snapshot-${i}.jsonl`;
      const snapshotFilePath = path.join(tempDir, snapshotFileName);

      const { capture, readBytes } = await captureSingleSourceSnapshot(
        source,
        snapshotFilePath,
        totalInputBytes,
        signal,
        deadline
      );

      totalInputBytes += readBytes;
      if (totalInputBytes > SESSION_INSIGHT_LIMITS.maxTotalSnapshotBytes) {
        throw new SessionInsightSnapshotError(
          'INSIGHT_INPUT_LIMIT',
          'Total snapshot bytes exceeded limit of 128 MiB'
        );
      }

      captures.push(capture);
      files.push({
        sourceKey: source.sourceKey,
        client: source.client,
        path: snapshotFilePath,
        sha256: capture.sha256,
        bytes: capture.analyzedBytes,
        expectedNativeSessionId: source.expectedNativeSessionId,
        expectedStream: source.expectedStream
      });
    }

    // 最终返回前复核 deadline 与中止信号
    if (signal?.aborted) {
      throw new SessionInsightSnapshotError('INSIGHT_INTERRUPTED', 'Operation aborted by signal');
    }
    if (deadline && Date.now() >= deadline) {
      throw new SessionInsightSnapshotError('INSIGHT_TIMEOUT', 'Snapshot deadline exceeded');
    }

    return {
      files,
      captures,
      cleanup
    };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

/**
 * 启动或定期清理残留临时目录安全 Helper。
 * 仅清理 dataDir/insight-tmp 下且不在 activeRequestIds 中的目录，不跨目录扫描，不触碰 HOME。
 */
export async function cleanupStaleInsightTempDirs(
  dataDir: string,
  activeRequestIds: Set<string>
): Promise<void> {
  const tmpBase = path.resolve(dataDir, 'insight-tmp');
  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(tmpBase, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const dirName = entry.name;
      if (!activeRequestIds.has(dirName) && SAFE_ID_PATTERN.test(dirName)) {
        const dirPath = path.join(tmpBase, dirName);
        try {
          await fsPromises.rm(dirPath, { recursive: true, force: true });
        } catch {}
      }
    }
  }
}
