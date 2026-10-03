import {
  type AnalyzeFilesResult,
  analyzeFilesResultSchema,
  type Metric,
  SESSION_INSIGHT_LIMITS
} from '@dutydeck/shared';
import { redactTraceText } from './lark/secret-redaction.js';

export interface RedactionContext {
  /**
   * 已知的私有路径 canary（如 dataRoot, temp 目录, cwd 等绝对私有路径）。
   * 将在普通文本中被替换为 pathPlaceholder，禁止在结构 identity 中出现。
   */
  canaryPaths?: string[];
  /** 路径脱敏占位符，默认为 '[REDACTED_PATH]' */
  pathPlaceholder?: string;
  /** 敏感凭据脱敏占位符，默认为 '[REDACTED]' */
  secretPlaceholder?: string;
}

export class SecurityRedactionError extends Error {
  constructor(public readonly field: string) {
    // 绝不把原始 identity 值或 canary 路径写进 message，避免错误被序列化进
    // 诊断或响应时二次泄露；调用方只应据 name/field 做安全拒绝。
    super(`Unsafe identity field '${field}': redaction would rewrite it`);
    this.name = 'SecurityRedactionError';
  }
}

/**
 * URL query 参数凭据正则：
 * 匹配 query 参数形如 ?token=xxx, &api_key=xxx, &password=xxx 等。
 */
const SENSITIVE_QUERY_KEY_REGEX =
  /(?<=[?&](?:token|api[_-]?key|access[_-]?key|access[_-]?token|auth(?:[_-]?token)?|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|key|sig|signature|auth|private[_-]?key)=)[^&\s"'#]+/gi;

/**
 * 对普通字符串执行完整的凭据和路径脱敏：
 * 1. 替换已知私有路径 canary（按长度降序优先匹配，防止前缀碎片截留）
 * 2. 复用 lark/secret-redaction 的凭据脱敏（PEM私钥、URL userinfo、authorization、CLI flags、变量赋值）
 * 3. 补足 URL query 参数凭据脱敏
 */
export function redactText(text: string, context?: RedactionContext): string {
  if (!text || typeof text !== 'string') return text;

  let redacted = text;

  // 1. 私有路径 canary 替换
  const canaryPaths = context?.canaryPaths;
  if (canaryPaths && canaryPaths.length > 0) {
    const placeholder = context?.pathPlaceholder ?? '[REDACTED_PATH]';
    // 过滤空串并按长度降序排序
    const sortedCanaries = Array.from(
      new Set(canaryPaths.map(p => p.trim()).filter(Boolean))
    ).sort((a, b) => b.length - a.length);

    for (const canary of sortedCanaries) {
      if (redacted.includes(canary)) {
        // 使用 split + join 进行全局安全替换，避免正则转义字符问题
        redacted = redacted.split(canary).join(placeholder);
      }
      // 如果路径带或者不带末尾斜杠，也一并处理
      const trimmedCanary = canary.replace(/\/+$/, '');
      if (trimmedCanary !== canary && trimmedCanary.length > 0 && redacted.includes(trimmedCanary)) {
        redacted = redacted.split(trimmedCanary).join(placeholder);
      }
    }
  }

  // 2. URL userinfo：贪婪吃到 host 前最后一个 @，覆盖密码本身含 @ 的情况
  //    （lark/secret-redaction 的非贪婪规则遇到 p@ss@host 会漏掉第二段）。
  redacted = redacted.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1[REDACTED]@');

  // 3. 复用现有 secret-redaction (PEM, authorization, bearer, flags, envs)
  redacted = redactTraceText(redacted);

  // 4. 补足 URL query 敏感凭据脱敏
  redacted = redacted.replace(SENSITIVE_QUERY_KEY_REGEX, context?.secretPlaceholder ?? '[REDACTED]');

  return redacted;
}

/**
 * UTF-8 安全多字节截断：
 * 保证截断后编码的 UTF-8 字节数 <= maxBytes，且绝不割裂多字节字符或产生乱码 �。
 */
export function truncateUtf8Bytes(
  text: string,
  maxBytes: number = SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes
): string {
  if (!text) return text;
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;

  // 回退越过落在截断边界上的多字节字符的 continuation 字节。
  let end = maxBytes;
  // UTF-8 continuation 字节最高两位是 10 (0x80 - 0xBF)
  while (end > 0 && (buf.readUInt8(end) & 0xc0) === 0x80) {
    end--;
  }

  // end 现在指向一个字符的起始字节；若该字符超出边界则整个舍弃。
  if (end > 0) {
    const leadByte = buf.readUInt8(end);
    let expectedLength = 1;
    if ((leadByte & 0xe0) === 0xc0) {
      expectedLength = 2;
    } else if ((leadByte & 0xf0) === 0xe0) {
      expectedLength = 3;
    } else if ((leadByte & 0xf8) === 0xf0) {
      expectedLength = 4;
    }
    if (maxBytes - end >= expectedLength) end += expectedLength;
  }

  return buf.subarray(0, end).toString('utf8');
}

/**
 * 先脱敏后截取，确保长 key 或敏感信息不会在截断后漏出。
 */
export function redactExcerpt(
  text: string | null | undefined,
  context?: RedactionContext,
  maxBytes: number = SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes
): string | null | undefined {
  if (text === null || text === undefined) return text;
  const redacted = redactText(text, context);
  return truncateUtf8Bytes(redacted, maxBytes);
}

/**
 * 结构 identity 允许的基础字符集（不允许任何空白、换行、引号或控制字符）。
 */
const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9_:.\-]+$/;

/**
 * 引擎派生身份（如 snapshot_local eventId）中固定末尾 `:token:<nonnegative integer>`
 * 片段的最窄匹配正则。例如真实 Codex ID 末尾的 `:token:0`、`:token:123`。
 */
const DERIVED_TOKEN_ROLE_SUFFIX = /:token:\d+$/;

function checkCanaryPaths(
  field: string,
  value: string,
  context?: RedactionContext
): void {
  const canaryPaths = context?.canaryPaths;
  if (canaryPaths && canaryPaths.length > 0) {
    for (const rawCanary of canaryPaths) {
      const canary = rawCanary.trim();
      const trimmed = canary.replace(/\/+$/, '');
      if (
        (canary && value.includes(canary)) ||
        (trimmed && trimmed !== canary && value.includes(trimmed))
      ) {
        throw new SecurityRedactionError(field);
      }
    }
  }
}

/**
 * 校验原生结构身份（nativeSessionId, nativeEventId, callId, taskId 等）。
 * 原生身份绝不豁免任何冒号或等号凭据：若 free-text 脱敏会改写其值，
 * 或包含私有路径 canary，或超出安全字符集，坚决抛 SecurityRedactionError 拒绝发布。
 */
export function assertSafeNativeIdentity(
  field: string,
  value: string | null | undefined,
  context?: RedactionContext
): void {
  if (!value || typeof value !== 'string') return;
  checkCanaryPaths(field, value, context);
  if (!SAFE_IDENTITY_PATTERN.test(value)) {
    throw new SecurityRedactionError(field);
  }
  if (redactText(value, context) !== value) {
    throw new SecurityRedactionError(field);
  }
}

/**
 * 校验引擎派生身份（Go 派生的 eventId, evidenceRefs, sourceKey）。
 * 仅对已知引擎派生的固定末尾 `:token:<nonnegative integer>` 做最窄豁免：
 * 完整检查 path canary（无豁免），剥离固定后缀后其余串仍必须满足 redactText 无改写。
 * 若其余串仍含凭据（如 `token:CANARY:token:0`），坚决拒绝。
 */
export function assertSafeDerivedIdentity(
  field: string,
  value: string | null | undefined,
  context?: RedactionContext
): void {
  if (!value || typeof value !== 'string') return;
  checkCanaryPaths(field, value, context);
  if (!SAFE_IDENTITY_PATTERN.test(value)) {
    throw new SecurityRedactionError(field);
  }
  const stripped = value.replace(DERIVED_TOKEN_ROLE_SUFFIX, '');
  if (redactText(stripped, context) !== stripped) {
    throw new SecurityRedactionError(field);
  }
}

/**
 * 校验结构 identity，默认采用最严格的原生身份规则。
 */
export function assertSafeIdentity(
  field: string,
  value: string | null | undefined,
  context?: RedactionContext
): void {
  assertSafeNativeIdentity(field, value, context);
}

/** 对一组自由字符串 code（reasonCodes 等）先脱敏后限长，保持条数不变。 */
function redactCodeList(codes: readonly string[], context?: RedactionContext): string[] {
  return codes.map(
    code => truncateUtf8Bytes(redactText(code, context), SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes)
  );
}

/**
 * Metric（Count/Continuous）携带的 reasonCodes 是 native/host 可控自由字符串，
 * 必须脱敏限长；value/质量等数值与枚举字段不动。返回新对象，不修改入参。
 */
function redactMetric(metric: Metric, context?: RedactionContext): Metric {
  return { ...metric, reasonCodes: redactCodeList(metric.reasonCodes ?? [], context) };
}

/** 对 FileMetrics 的每个指标做纯映射脱敏。 */
function redactMetrics<M extends Record<string, Metric>>(
  metrics: M,
  context?: RedactionContext
): M {
  const projected: Record<string, Metric> = {};
  for (const [key, metric] of Object.entries(metrics)) {
    projected[key] = redactMetric(metric, context);
  }
  return projected as M;
}

/**
 * 对 {code: count} 这类以 code 为键的记录做键脱敏：若键含敏感串，用脱敏后键
 * 合并计数，既不泄露也不丢分母；正常结构化 code（枚举类）脱敏前后不变。
 */
function redactCodeCountRecord(
  record: Readonly<Record<string, number>>,
  context?: RedactionContext
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const [code, count] of Object.entries(record)) {
    const safeCode = truncateUtf8Bytes(
      redactText(code, context),
      SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes
    );
    merged[safeCode] = (merged[safeCode] ?? 0) + count;
  }
  return merged;
}

/**
 * 对 Go 分析进程返回的 AnalyzeFilesResult 进行脱敏与公开投影：
 * - 纯函数，不修改传入的原始对象
 * - 结构 identity 严格校验并保留用于关联
 * - free text（inputExcerpt, outputExcerpt, errorExcerpt, warning samples）先脱敏后安全截断
 * - 原始未知字段和环境不复制
 * - 输出结果经过 analyzeFilesResultSchema 校验
 */
export function redactAnalyzeResult(
  result: AnalyzeFilesResult,
  context?: RedactionContext
): AnalyzeFilesResult {
  assertSafeNativeIdentity('requestId', result.requestId, context);

  const projectedFiles = result.files.map(file => {
    assertSafeDerivedIdentity('sourceKey', file.sourceKey, context);
    assertSafeNativeIdentity('sha256', file.sha256, context);
    if (file.nativeSessionId) {
      assertSafeNativeIdentity('nativeSessionId', file.nativeSessionId, context);
    }
    if (file.nativeRunId) {
      assertSafeNativeIdentity('nativeRunId', file.nativeRunId, context);
    }
    if (file.parentNativeSessionId) {
      assertSafeNativeIdentity('parentNativeSessionId', file.parentNativeSessionId, context);
    }
    if (file.streamIdentity.kind === 'subagent') {
      assertSafeNativeIdentity('streamIdentity.nativeAgentId', file.streamIdentity.nativeAgentId, context);
    }

    const projectedErrorCode = file.errorCode ? redactText(file.errorCode, context) : file.errorCode;

    const projectedModels = file.models.map(model =>
      truncateUtf8Bytes(redactText(model, context), SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes)
    );

    const projectedTrace = file.trace.map(event => {
      assertSafeDerivedIdentity('trace.eventId', event.eventId, context);
      assertSafeDerivedIdentity('trace.sourceKey', event.sourceKey, context);
      assertSafeNativeIdentity('trace.nativeSessionId', event.nativeSessionId, context);
      if (event.nativeRunId) {
        assertSafeNativeIdentity('trace.nativeRunId', event.nativeRunId, context);
      }
      if (event.nativeEventId) {
        assertSafeNativeIdentity('trace.nativeEventId', event.nativeEventId, context);
      }
      if (event.callId) {
        assertSafeNativeIdentity('trace.callId', event.callId, context);
      }
      if (event.parentCallId) {
        assertSafeNativeIdentity('trace.parentCallId', event.parentCallId, context);
      }
      if (event.hostEventRef) {
        assertSafeNativeIdentity('trace.hostEventRef.sessionId', event.hostEventRef.sessionId, context);
        assertSafeNativeIdentity('trace.hostEventRef.eventId', event.hostEventRef.eventId, context);
      }
      if (event.evidenceRefs && event.evidenceRefs.length > 0) {
        for (const ref of event.evidenceRefs) {
          assertSafeDerivedIdentity('trace.evidenceRefs', ref, context);
        }
      }

      const toolName = event.toolName
        ? truncateUtf8Bytes(redactText(event.toolName, context), SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes)
        : event.toolName;

      const inputExcerpt = redactExcerpt(event.inputExcerpt, context);
      const outputExcerpt = redactExcerpt(event.outputExcerpt, context);
      const errorExcerpt = redactExcerpt(event.errorExcerpt, context);

      // durationMs 是 ContinuousMetric，reasonCodes 同样可控，需脱敏。
      const durationMs = event.durationMs ? redactMetric(event.durationMs, context) : event.durationMs;

      return {
        ...event,
        toolName,
        inputExcerpt,
        outputExcerpt,
        errorExcerpt,
        durationMs
      };
    });

    const projectedRelationship = {
      ...file.relationship,
      parentNativeSessionId: file.relationship.parentNativeSessionId,
      parentNativeAgentId: file.relationship.parentNativeAgentId,
      evidenceRefs: [...file.relationship.evidenceRefs]
    };
    if (projectedRelationship.parentNativeSessionId) {
      assertSafeNativeIdentity('relationship.parentNativeSessionId', projectedRelationship.parentNativeSessionId, context);
    }
    if (projectedRelationship.parentNativeAgentId) {
      assertSafeNativeIdentity('relationship.parentNativeAgentId', projectedRelationship.parentNativeAgentId, context);
    }
    for (const ref of projectedRelationship.evidenceRefs) {
      assertSafeDerivedIdentity('relationship.evidenceRefs', ref, context);
    }

    return {
      sourceKey: file.sourceKey,
      client: file.client,
      sha256: file.sha256,
      nativeSessionId: file.nativeSessionId,
      streamIdentity: { ...file.streamIdentity },
      nativeRunId: file.nativeRunId,
      parentNativeSessionId: file.parentNativeSessionId,
      status: file.status,
      errorCode: projectedErrorCode,
      metrics: redactMetrics(file.metrics, context),
      models: projectedModels,
      trace: projectedTrace,
      pulseBuckets: file.pulseBuckets.map(bucket => ({
        startAt: bucket.startAt,
        endAt: bucket.endAt,
        tokens: redactMetrics(bucket.tokens, context),
        sampleCount: bucket.sampleCount,
        missingCount: bucket.missingCount
      })),
      coverage: {
        ...file.coverage,
        timeRange: { ...file.coverage.timeRange },
        // category code 是 native 可控自由串，键也要脱敏并合并计数。
        omittedTraceByCategory: redactCodeCountRecord(file.coverage.omittedTraceByCategory, context)
      },
      relationship: projectedRelationship,
      aggregation: {
        ...file.aggregation,
        reasonCodes: redactCodeList(file.aggregation.reasonCodes, context)
      }
    };
  });

  const projectedWarnings = result.warnings.map(warning => ({
    code: redactText(warning.code, context),
    count: warning.count,
    samples: warning.samples.map(sample =>
      truncateUtf8Bytes(redactText(sample, context), SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes)
    )
  }));

  const projected: AnalyzeFilesResult = {
    schemaVersion: result.schemaVersion,
    requestId: result.requestId,
    engineVersion: result.engineVersion,
    parserVersion: result.parserVersion,
    metricVersion: result.metricVersion,
    files: projectedFiles,
    warnings: projectedWarnings
  };

  return analyzeFilesResultSchema.parse(projected);
}
