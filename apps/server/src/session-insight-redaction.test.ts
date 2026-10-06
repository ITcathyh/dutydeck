import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeFilesResultSchema, type AnalyzeFilesResult } from '@dutydeck/shared';
import {
  assertSafeIdentity,
  redactAnalyzeResult,
  redactExcerpt,
  redactText,
  SecurityRedactionError,
  truncateUtf8Bytes,
  type RedactionContext
} from './session-insight-redaction.js';

const GOLDEN_PATH = fileURLToPath(
  new URL('../../../tests/fixtures/session-insight/golden/analyze-result.golden.json', import.meta.url)
);
const PRIVATE_ROOT = '/home/huangyuhang.edu/.dutydeck/private-data';
const context: RedactionContext = { canaryPaths: [PRIVATE_ROOT] };

function loadGolden(): AnalyzeFilesResult {
  return analyzeFilesResultSchema.parse(
    JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as unknown
  );
}

describe('redactText 凭据与路径脱敏', () => {
  it('抹掉 authorization / bearer / token flag / 赋值', () => {
    expect(redactText('authorization: Bearer abc.def-secret')).not.toContain('abc.def-secret');
    expect(redactText('Authorization = "tok_live_12345"')).not.toContain('tok_live_12345');
    expect(redactText('cmd --token abc123secret run')).not.toContain('abc123secret');
    expect(redactText('cmd --api-key=xyz987secret')).not.toContain('xyz987secret');
    expect(redactText('API_KEY="sk-rawvalue999"')).not.toContain('sk-rawvalue999');
    expect(redactText('TOKEN: headerpayloadsignature')).not.toContain('headerpayloadsignature');
  });

  it('抹掉 PEM 私钥（含截断在 END 之前的情况）', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqh\nSECRETBODY123\n-----END PRIVATE KEY-----';
    const truncatedPem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef\nSECRETBODY';
    expect(redactText(pem)).not.toContain('SECRETBODY');
    expect(redactText(truncatedPem)).not.toContain('SECRETBODY');
  });

  it('抹掉 URL userinfo 与 query 凭据，保留目标地址', () => {
    expect(redactText('https://user:p@ssw0rd@api.example.com/path')).toContain(
      'api.example.com'
    );
    expect(redactText('https://user:p@ssw0rd@api.example.com/path')).not.toContain('ssw0rd');
    expect(redactText('https://api.example.com/v1?token=secretvalue123&q=ok')).not.toContain(
      'secretvalue123'
    );
    expect(redactText('https://api.example.com/v1?token=secretvalue123&q=ok')).toContain('q=ok');
    expect(redactText('curl "https://x.io?api_key=KEY123&refresh_token=RT456"')).not.toContain(
      'KEY123'
    );
    expect(redactText('curl "https://x.io?api_key=KEY123&refresh_token=RT456"')).not.toContain(
      'RT456'
    );
  });

  it('抹掉已知私有路径 canary，但保留非 canary 普通路径', () => {
    const text = `workspace ${PRIVATE_ROOT}/logs/a.jsonl and /tmp/public.txt`;
    const out = redactText(text, context);
    expect(out).not.toContain(PRIVATE_ROOT);
    expect(out).not.toContain('huangyuhang');
    expect(out).toContain('/tmp/public.txt');
  });

  it('嵌套 free text 中多种凭据全部不泄露', () => {
    const nested = [
      `outer authorization: Bearer nestedSecret`,
      `key=${PRIVATE_ROOT}/secret`,
      `?access_token=AT777`,
      `-----BEGIN PRIVATE KEY-----BODY-----END PRIVATE KEY-----`,
      `--password hunter2`
    ].join('\n');
    const out = redactText(nested, context);
    for (const leak of ['nestedSecret', 'AT777', 'BODY', 'hunter2', PRIVATE_ROOT]) {
      expect(out).not.toContain(leak);
    }
  });

  it('不处理非字符串输入', () => {
    expect(redactText('' as unknown as string)).toBe('');
  });
});

describe('truncateUtf8Bytes 多字节安全边界', () => {
  it('不超过 4 KiB 时原样返回', () => {
    const text = 'a'.repeat(4096);
    expect(truncateUtf8Bytes(text)).toBe(text);
  });

  it('在边界割裂多字节字符时整字符舍弃，不产生乱码', () => {
    // あ 占 3 字节。
    const char = 'あ';
    const caseBeforeComplete = 'a'.repeat(4095) + char; // 4098 字节，字符跨 4096 边界
    const out1 = truncateUtf8Bytes(caseBeforeComplete);
    expect(Buffer.byteLength(out1, 'utf8')).toBeLessThanOrEqual(4096);
    expect(out1).not.toContain('�');
    expect(caseBeforeComplete.startsWith(out1)).toBe(true);
    expect(out1.endsWith(char)).toBe(false);

    const casePartial = 'a'.repeat(4094) + char; // 4097 字节，字符仍跨边界
    const out2 = truncateUtf8Bytes(casePartial);
    expect(Buffer.byteLength(out2, 'utf8')).toBeLessThanOrEqual(4096);
    expect(out2).not.toContain('�');
    expect(casePartial.startsWith(out2)).toBe(true);

    const caseFits = 'a'.repeat(4093) + char; // 恰好 4096 字节，字符完整
    const out3 = truncateUtf8Bytes(caseFits);
    expect(Buffer.byteLength(out3, 'utf8')).toBe(4096);
    expect(out3.endsWith(char)).toBe(true);
  });

  it('对纯多字节长串截断后仍是合法 UTF-8 前缀', () => {
    const text = '中'.repeat(5000);
    const out = truncateUtf8Bytes(text);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4096);
    expect(text.startsWith(out)).toBe(true);
    // 4096 不能被 3 整除，最多保留 1365 个完整字符 = 4095 字节。
    expect(Buffer.byteLength(out, 'utf8')).toBe(4095);
  });
});

describe('redactExcerpt 先脱敏后截取', () => {
  it('长敏感值截断后不泄露尾部密钥片段', () => {
    const longBearer = 'authorization: Bearer ' + 'k'.repeat(5000);
    const out = redactExcerpt(longBearer, context)!;
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4096);
    expect(out).not.toContain('k'.repeat(100));
  });

  it('null/undefined 原样透传', () => {
    expect(redactExcerpt(null)).toBeNull();
    expect(redactExcerpt(undefined)).toBeUndefined();
  });
});

describe('assertSafeIdentity 结构 identity 保护', () => {
  it('含私有绝对路径 canary 的 identity 被拒绝', () => {
    expect(() => assertSafeIdentity('eventId', `${PRIVATE_ROOT}/leak`, context)).toThrow(
      SecurityRedactionError
    );
    expect(() => assertSafeIdentity('x', `x${PRIVATE_ROOT}`, context)).toThrow(/would rewrite/);
  });

  it('错误 message 不回显私有路径或原始 identity 值', () => {
    try {
      assertSafeIdentity('eventId', `${PRIVATE_ROOT}/leak`, context);
      throw new Error('expected SecurityRedactionError');
    } catch (error) {
      expect(error).toBeInstanceOf(SecurityRedactionError);
      expect((error as SecurityRedactionError).message).not.toContain(PRIVATE_ROOT);
      expect((error as SecurityRedactionError).message).not.toContain('leak');
      expect((error as SecurityRedactionError).field).toBe('eventId');
    }
  });

  it('正常 hash / UUID / sourceKey 放行', () => {
    expect(() =>
      assertSafeIdentity('sha256', 'a'.repeat(64), context)
    ).not.toThrow();
    expect(() => assertSafeIdentity('id', '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', context)).not.toThrow();
  });

  it('null/undefined 放行', () => {
    expect(() => assertSafeIdentity('x', null, context)).not.toThrow();
  });
});

describe('redactAnalyzeResult 公开投影', () => {
  it('free text 脱敏、结构 identity 保留、源对象不变', () => {
    const golden = loadGolden();
    // 深拷贝后注入敏感内容。
    const injected: AnalyzeFilesResult = structuredClone(golden);
    const file = injected.files[0]!;
    const event = file.trace[0]!;
    event.inputExcerpt = `run --token leakyToken123 at ${PRIVATE_ROOT}/a`;
    event.outputExcerpt = 'https://u:pw@host.io?api_key=QUERYSECRET';
    event.errorExcerpt = '-----BEGIN PRIVATE KEY-----\nBODY-----END PRIVATE KEY-----';
    event.toolName = 'Shell';
    file.models = ['gpt-x?token=modelsecret'];

    const projected = redactAnalyzeResult(injected, context);

    // 结构 identity 原样保留用于关联。
    expect(projected.files[0]!.sourceKey).toBe(file.sourceKey);
    expect(projected.files[0]!.sha256).toBe(file.sha256);
    expect(projected.files[0]!.nativeSessionId).toBe(file.nativeSessionId);
    const projectedEvent = projected.files[0]!.trace[0]!;
    expect(projectedEvent.eventId).toBe(event.eventId);
    expect(projectedEvent.sourceKey).toBe(event.sourceKey);
    expect(projectedEvent.hostEventRef).toEqual(event.hostEventRef);
    expect(projectedEvent.evidenceRefs).toEqual(event.evidenceRefs);

    // 敏感内容全部消失。
    const serialized = JSON.stringify(projected);
    for (const leak of [
      'leakyToken123',
      'QUERYSECRET',
      'BODY',
      'modelsecret',
      PRIVATE_ROOT
    ]) {
      expect(serialized).not.toContain(leak);
    }

    // 源 DTO 不被修改。
    expect(injected.files[0]!.trace[0]!.inputExcerpt).toContain('leakyToken123');
    expect(injected.files[0]!.models[0]).toContain('modelsecret');
  });

  it('identity 含路径 canary 时拒绝发布而非静默改写', () => {
    const golden = loadGolden();
    const injected: AnalyzeFilesResult = structuredClone(golden);
    injected.files[0]!.trace[0]!.eventId = `${PRIVATE_ROOT}/evt`;
    expect(() => redactAnalyzeResult(injected, context)).toThrow(SecurityRedactionError);
  });

  it('warning samples 与 errorCode 同样脱敏限长，结果通过 schema', () => {
    const golden = loadGolden();
    const injected: AnalyzeFilesResult = structuredClone(golden);
    injected.warnings = [
      {
        code: 'PARSE_ERROR',
        count: 2,
        samples: [`auth: Bearer warnSecret at ${PRIVATE_ROOT}`]
      }
    ];
    injected.files[0]!.status = 'error';
    injected.files[0]!.errorCode = `failed at ${PRIVATE_ROOT}/x token=abcSecret`;

    const projected = redactAnalyzeResult(injected, context);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('warnSecret');
    expect(serialized).not.toContain('abcSecret');
    expect(serialized).not.toContain(PRIVATE_ROOT);
    expect(() => analyzeFilesResultSchema.parse(projected)).not.toThrow();
  });

  it('metrics / pulse tokens / durationMs / aggregation 的 reasonCodes 自由串全部脱敏', () => {
    const injected = structuredClone(loadGolden());
    const file = injected.files[0]!;

    // file metrics：每个指标的 reasonCodes。
    for (const metric of Object.values(file.metrics)) {
      metric.reasonCodes = ['token=METRIC_CANARY'];
    }
    // pulse bucket tokens 的 reasonCodes（golden 若有 bucket）。
    if (file.pulseBuckets[0]) {
      for (const metric of Object.values(file.pulseBuckets[0].tokens)) {
        metric.reasonCodes = ['token=PULSE_CANARY'];
      }
    }
    // trace.durationMs 是 ContinuousMetric。
    file.trace[0]!.durationMs = {
      value: 1,
      quality: 'exact',
      status: 'available',
      evidenceCount: 1,
      missingCount: 0,
      reasonCodes: ['token=DURATION_CANARY']
    };
    // aggregation.reasonCodes。
    file.aggregation.reasonCodes.push('token=AGG_CANARY');

    const projected = redactAnalyzeResult(injected, context);
    const serialized = JSON.stringify(projected);
    for (const leak of ['METRIC_CANARY', 'PULSE_CANARY', 'DURATION_CANARY', 'AGG_CANARY']) {
      expect(serialized).not.toContain(leak);
    }
    expect(() => analyzeFilesResultSchema.parse(projected)).not.toThrow();

    // 源 DTO 不被修改。
    expect(JSON.stringify(injected)).toContain('METRIC_CANARY');
  });

  it('coverage.omittedTraceByCategory 的键含凭据时键脱敏且计数保留', () => {
    const injected = structuredClone(loadGolden());
    injected.files[0]!.coverage.omittedTraceByCategory = {
      'token=CAT_CANARY': 3,
      NORMAL_CATEGORY: 2
    };
    const projected = redactAnalyzeResult(injected, context);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('CAT_CANARY');
    // 正常结构化 code 保留，计数不丢。
    const categories = projected.files[0]!.coverage.omittedTraceByCategory;
    expect(categories.NORMAL_CATEGORY).toBe(2);
    expect(Object.values(categories).some(v => v === 3)).toBe(true);
  });

  it('结构 identity 含凭据（非路径）时同样拒绝而非改写', () => {
    const injected = structuredClone(loadGolden());
    injected.files[0]!.trace[0]!.nativeEventId = 'token=IDENTITY_CANARY';
    expect(() => redactAnalyzeResult(injected, context)).toThrow(SecurityRedactionError);

    const callIdCase = structuredClone(loadGolden());
    callIdCase.files[0]!.trace[0]!.callId = 'authorization: Bearer x';
    expect(() => redactAnalyzeResult(callIdCase, context)).toThrow(SecurityRedactionError);

    const sourceKeyCase = structuredClone(loadGolden());
    sourceKeyCase.files[0]!.sourceKey = 'https://u:pw@host.io/x';
    expect(() => redactAnalyzeResult(sourceKeyCase, context)).toThrow(SecurityRedactionError);
  });

  it('合法原生身份（u-main-1 / hex / UUID / sourceKey）不被误拒且原样保留', () => {
    const projected = redactAnalyzeResult(loadGolden(), context);
    const file = projected.files[0]!;
    expect(file.trace[0]!.nativeEventId).toBe('u-main-1');
    expect(file.trace[1]!.nativeEventId).toBe('a-main-1');
    expect(file.trace[1]!.evidenceRefs).toEqual(['tool-sub-1']);
    expect(projected.requestId).toBe('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d');
    expect(file.sourceKey).toBe('src_claude_main_01');
  });

  it('真实 codex snapshot_local eventId 含 :token:0 序号标签时不误拒（回归）', () => {
    // 真实引擎对无原生 ID 的 token_sample 生成 source:hash:Ln:Bm:token:0 形式身份；
    // `:token:0` 是事件标签+序号，最窄豁免必须放行。
    const injected = structuredClone(loadGolden());
    injected.files[0]!.trace[0]!.eventId = 'probe:cbc896a50367:L3:B268:token:0';
    injected.files[0]!.trace[0]!.nativeEventId = null;
    injected.files[0]!.trace[0]!.isSnapshotLocalId = true;
    const projected = redactAnalyzeResult(injected, context);
    expect(projected.files[0]!.trace[0]!.eventId).toBe(
      'probe:cbc896a50367:L3:B268:token:0'
    );
  });

  it('夹带 free-text 信号（=、空格、/、@、?、&）的身份拒绝，即使无 canary 路径', () => {
    for (const bad of [
      'token=IDENTITY_CANARY',
      'Bearer abc.def',
      '/abs/path/evt',
      'id?token=x',
      'a&b=c',
      'u:p@host'
    ]) {
      expect(() => assertSafeIdentity('f', bad, context)).toThrow(SecurityRedactionError);
    }
  });

  it('原生身份含冒号凭据（token:/password:/authorization:）坚决拒绝，绝不豁免', () => {
    // 对应 t4e-colon-probe.mts：nativeEventId 包含冒号凭据
    const colonCases = [
      'token:COLON_ID_CANARY',
      'password:SECRET_PASSWORD',
      'authorization:BearerSecret',
      'api_key:KEY12345',
      'secret:SHH'
    ];
    for (const val of colonCases) {
      const injected = structuredClone(loadGolden());
      injected.files[0]!.trace[0]!.nativeEventId = val;
      expect(() => redactAnalyzeResult(injected, context)).toThrow(SecurityRedactionError);

      const injectedCallId = structuredClone(loadGolden());
      injectedCallId.files[0]!.trace[0]!.callId = val;
      expect(() => redactAnalyzeResult(injectedCallId, context)).toThrow(SecurityRedactionError);

      const injectedSessionId = structuredClone(loadGolden());
      injectedSessionId.files[0]!.nativeSessionId = val;
      expect(() => redactAnalyzeResult(injectedSessionId, context)).toThrow(SecurityRedactionError);
    }
  });

  it('派生身份前缀含凭据时（即使末尾有 :token:0）也坚决拒绝', () => {
    // inbox 点名要求：token:CANARY:token:0 也应拒绝
    const injected = structuredClone(loadGolden());
    injected.files[0]!.trace[0]!.eventId = 'token:CANARY:token:0';
    expect(() => redactAnalyzeResult(injected, context)).toThrow(SecurityRedactionError);

    const pwCase = structuredClone(loadGolden());
    pwCase.files[0]!.trace[0]!.eventId = 'password:CANARY:token:1';
    expect(() => redactAnalyzeResult(pwCase, context)).toThrow(SecurityRedactionError);
  });

  it('primitive 数值、布尔、时间与合法枚举字段原样保留', () => {
    const golden = loadGolden();
    const projected = redactAnalyzeResult(golden, context);
    const gFile = golden.files[0]!;
    const pFile = projected.files[0]!;
    expect(pFile.client).toBe(gFile.client);
    expect(pFile.status).toBe(gFile.status);
    expect(pFile.streamIdentity).toEqual(gFile.streamIdentity);
    expect(pFile.metrics.inputUncached).toEqual(gFile.metrics.inputUncached);
    expect(pFile.metrics.output).toEqual(gFile.metrics.output);
    expect(pFile.coverage.rawLines).toBe(gFile.coverage.rawLines);
    expect(pFile.trace[0]!.lineNumber).toBe(gFile.trace[0]!.lineNumber);
    expect(pFile.trace[0]!.byteOffset).toBe(gFile.trace[0]!.byteOffset);
    expect(pFile.trace[0]!.timeQuality).toBe(gFile.trace[0]!.timeQuality);
    expect(pFile.trace[0]!.isSnapshotLocalId).toBe(gFile.trace[0]!.isSnapshotLocalId);
  });
});
