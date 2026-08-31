import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeWithLarkGate,
  isRetryableLarkError,
  LarkCircuitOpenError,
  resolveLarkGateConfig,
  setLarkGateLog,
  __testOnly_resetLarkGate,
  type LarkGateLog
} from './api-gate.js';

// 复刻 service.ts request() 抛出的 LarkServiceError 形态（不 import service.ts，
// 网关本身也不 import 它——反向依赖会成环）。注意 statusCode 恒为 502，真正的上游
// HTTP 状态在 details.upstreamHttpStatus。
const openApiError = (upstreamCode: number | undefined, upstreamHttpStatus: number, details: Record<string, unknown> = {}) =>
  Object.assign(new Error(`Lark OpenAPI request failed: boom (code: ${upstreamCode ?? 'HTTP_ERROR'})`), {
    name: 'LarkServiceError',
    code: 'LARK_OPENAPI_ERROR',
    statusCode: 502,
    details: { upstreamCode, upstreamHttpStatus, ...details }
  });

const networkError = () => Object.assign(new Error('Lark OpenAPI request failed: fetch failed'), {
  name: 'LarkServiceError',
  code: 'LARK_NETWORK_ERROR',
  statusCode: 502
});

const gateEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  LARK_API_QPS: '1000',
  LARK_API_RETRY_BASE_MS: '500',
  LARK_API_RETRY_MAX_MS: '8000',
  ...overrides
});

const recordingLog = () => {
  const entries: Array<{ level: keyof LarkGateLog; details: any; message?: string }> = [];
  const log: LarkGateLog = {
    info: (details, message) => { entries.push({ level: 'info', details, message }); },
    warn: (details, message) => { entries.push({ level: 'warn', details, message }); },
    error: (details, message) => { entries.push({ level: 'error', details, message }); }
  };
  return { log, entries };
};

afterEach(() => {
  __testOnly_resetLarkGate();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Lark api gate token bucket', () => {
  it('serializes a burst beyond capacity down to the configured QPS', async () => {
    // burst=1 / qps=25 → 每 40ms 一个令牌，4 个并发调用至少要 3 × 40ms。
    const env = gateEnv({ LARK_API_QPS: '25', LARK_API_BURST: '1' });
    const startedAt = Date.now();
    const invokedAt: number[] = [];
    await Promise.all(Array.from({ length: 4 }, () => executeWithLarkGate('cli_bucket', 'card.patch', async () => {
      invokedAt.push(Date.now() - startedAt);
      return 'ok';
    }, { env })));

    expect(invokedAt).toHaveLength(4);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(110); // 3 个令牌等待 ≈ 120ms，留一点时钟裕量
    expect(Math.max(...invokedAt)).toBeGreaterThanOrEqual(110);
  });

  it('keeps buckets per appId so a saturated app does not delay another', async () => {
    // burst=1 / qps=5 → A 的第 2、3 个调用要等 200ms / 400ms；B 必须立刻放行。
    const env = gateEnv({ LARK_API_QPS: '5', LARK_API_BURST: '1' });
    const saturating = Array.from({ length: 3 }, () => executeWithLarkGate('cli_app_a', 'card.patch', async () => 'a', { env }));

    const startedAt = Date.now();
    await expect(executeWithLarkGate('cli_app_b', 'card.patch', async () => 'b', { env })).resolves.toBe('b');
    expect(Date.now() - startedAt).toBeLessThan(100);

    await Promise.all(saturating);
  });

  it('warns with appId and op when a rate-limit wait exceeds 100ms', async () => {
    const env = gateEnv({ LARK_API_QPS: '2', LARK_API_BURST: '1' });
    const { log, entries } = recordingLog();
    const first = executeWithLarkGate('cli_warn', 'message.send', async () => 'first', { env, log });
    const second = executeWithLarkGate('cli_warn', 'card.patch', async () => 'second', { env, log });
    await Promise.all([first, second]);

    const waitWarn = entries.find(entry => entry.level === 'warn' && entry.message === '飞书 OpenAPI 限流等待');
    expect(waitWarn).toBeDefined();
    expect(waitWarn?.details).toMatchObject({ appId: 'cli_warn', op: 'card.patch' });
    expect(waitWarn?.details.waitMs).toBeGreaterThan(100);
  });
});

describe('Lark api gate error classification', () => {
  it('treats network errors, upstream 429 and upstream 5xx as retryable', () => {
    expect(isRetryableLarkError(networkError())).toBe(true);
    expect(isRetryableLarkError(openApiError(undefined, 429))).toBe(true);
    expect(isRetryableLarkError(openApiError(undefined, 500))).toBe(true);
    expect(isRetryableLarkError(openApiError(undefined, 503))).toBe(true);
  });

  it('treats transient business codes as retryable even on HTTP 4xx', () => {
    for (const code of [230049, 230020, 99991400]) {
      expect(isRetryableLarkError(openApiError(code, 400))).toBe(true);
    }
  });

  it('does not retry deterministic 4xx: bad param, bad secret, content rejected, unupdatable', () => {
    expect(isRetryableLarkError(openApiError(99992402, 400))).toBe(false);
    expect(isRetryableLarkError(openApiError(99991663, 401))).toBe(false);
    expect(isRetryableLarkError(openApiError(230028, 400))).toBe(false); // 内容被审核拒绝
    expect(isRetryableLarkError(openApiError(230012, 400))).toBe(false); // 消息不可更新
    expect(isRetryableLarkError(openApiError(230030, 400))).toBe(false);
  });

  it('does not treat non-transport errors as retryable', () => {
    expect(isRetryableLarkError(new Error('boom'))).toBe(false);
    expect(isRetryableLarkError(Object.assign(new Error('bad state'), { code: 'INVALID_CARD_STATE', statusCode: 400 }))).toBe(false);
    expect(isRetryableLarkError(undefined)).toBe(false);
    expect(isRetryableLarkError('nope')).toBe(false);
  });

  it('ignores LarkServiceError.statusCode 502 and reads details.upstreamHttpStatus instead', () => {
    // statusCode 是 Dockmux 回给自己客户端的状态，不是飞书返回的；若误读成 5xx，
    // 每一个确定性 OpenAPI 错误都会被无脑重试。
    const deterministic = openApiError(99992402, 400);
    expect(deterministic.statusCode).toBe(502);
    expect(isRetryableLarkError(deterministic)).toBe(false);
  });

  it('classifies axios-shaped SDK errors from contact lookups', () => {
    expect(isRetryableLarkError({ isAxiosError: true, response: { status: 429, data: { code: 99991400 } } })).toBe(true);
    expect(isRetryableLarkError({ isAxiosError: true, response: { status: 403, data: { code: 99991672 } } })).toBe(false);
    expect(isRetryableLarkError({ isAxiosError: true })).toBe(true); // 无 response = 网络错误
  });
});

describe('Lark api gate retry', () => {
  it('retries an upstream 429 and eventually succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = executeWithLarkGate('cli_retry', 'card.patch', async () => {
      calls += 1;
      if (calls < 3) throw openApiError(undefined, 429);
      return 'done';
    }, { env: gateEnv() });

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(promise).resolves.toBe('done');
    expect(calls).toBe(3);
  });

  it('retries transient business codes 230049 / 230020 / 99991400 on HTTP 4xx', async () => {
    vi.useFakeTimers();
    for (const code of [230049, 230020, 99991400]) {
      let calls = 0;
      const promise = executeWithLarkGate(`cli_transient_${code}`, 'message.send', async () => {
        calls += 1;
        if (calls === 1) throw openApiError(code, 400);
        return 'ok';
      }, { env: gateEnv() });
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(promise).resolves.toBe('ok');
      expect(calls).toBe(2);
    }
  });

  it('retries network errors that carry no upstream status', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = executeWithLarkGate('cli_network', 'card.create', async () => {
      calls += 1;
      if (calls === 1) throw networkError();
      return 'ok';
    }, { env: gateEnv() });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(promise).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('honors details.retryAfterMs over the computed backoff', async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    let calls = 0;
    const promise = executeWithLarkGate('cli_after_ms', 'card.patch', async () => {
      at.push(Date.now());
      calls += 1;
      if (calls === 1) throw openApiError(undefined, 429, { retryAfterMs: 3_000 });
      return 'ok';
    }, { env: gateEnv() });

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(promise).resolves.toBe('ok');
    // 首次退避本来只有 500ms，服务端要求 3s 就必须等 3s。
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(3_000);
  });

  it('honors a Retry-After header bag (seconds) from details.retryAfterHeaders', async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    let calls = 0;
    const promise = executeWithLarkGate('cli_after_hdr', 'card.patch', async () => {
      at.push(Date.now());
      calls += 1;
      if (calls === 1) throw openApiError(undefined, 429, { retryAfterHeaders: { 'retry-after': '4' } });
      return 'ok';
    }, { env: gateEnv() });

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toBe('ok');
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(4_000);
  });

  it('honors x-ogw-ratelimit-reset and takes the max of both headers', async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    let calls = 0;
    const promise = executeWithLarkGate('cli_ogw', 'card.patch', async () => {
      at.push(Date.now());
      calls += 1;
      if (calls === 1) throw openApiError(230020, 400, { retryAfterHeaders: { 'retry-after': '2', 'x-ogw-ratelimit-reset': '5' } });
      return 'ok';
    }, { env: gateEnv() });

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toBe('ok');
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(5_000);
  });

  it('reads a fetch Headers instance passed as details.retryAfterHeaders', async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    let calls = 0;
    const promise = executeWithLarkGate('cli_hdr_instance', 'card.patch', async () => {
      at.push(Date.now());
      calls += 1;
      if (calls === 1) throw openApiError(undefined, 429, { retryAfterHeaders: new Headers({ 'x-ogw-ratelimit-reset': '3' }) });
      return 'ok';
    }, { env: gateEnv() });

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toBe('ok');
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(3_000);
  });

  it('caps an absurd Retry-After hint at retryMaxMs * 4', async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    let calls = 0;
    const promise = executeWithLarkGate('cli_absurd', 'card.patch', async () => {
      at.push(Date.now());
      calls += 1;
      if (calls === 1) throw openApiError(undefined, 429, { retryAfterMs: 3_600_000 });
      return 'ok';
    }, { env: gateEnv({ LARK_API_RETRY_MAX_MS: '8000' }) });

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toBe('ok');
    expect(at[1]! - at[0]!).toBe(32_000);
  });

  it('does not retry a non-retryable 4xx and rethrows the identical error object', async () => {
    const badParam = openApiError(99992402, 400);
    let calls = 0;
    await expect(executeWithLarkGate('cli_bad_param', 'card.patch', async () => {
      calls += 1;
      throw badParam;
    }, { env: gateEnv() })).rejects.toBe(badParam);
    expect(calls).toBe(1);
  });

  it('rethrows the original error after retries are exhausted', async () => {
    vi.useFakeTimers();
    const rateLimited = openApiError(230020, 400);
    let calls = 0;
    const promise = executeWithLarkGate('cli_exhausted', 'card.patch', async () => {
      calls += 1;
      throw rateLimited;
    }, { env: gateEnv({ LARK_API_RETRY_MAX_ATTEMPTS: '2' }) });
    const assertion = expect(promise).rejects.toBe(rateLimited);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(calls).toBe(3); // 首次 + 2 次重试
  });

  it('skips retries entirely when retryMaxAttempts is 0', async () => {
    const rateLimited = openApiError(230020, 400);
    let calls = 0;
    await expect(executeWithLarkGate('cli_no_retry', 'card.patch', async () => {
      calls += 1;
      throw rateLimited;
    }, { env: gateEnv({ LARK_API_RETRY_MAX_ATTEMPTS: '0' }) })).rejects.toBe(rateLimited);
    expect(calls).toBe(1);
  });
});

describe('Lark api gate circuit breaker', () => {
  const trippingEnv = gateEnv({
    LARK_API_RETRY_MAX_ATTEMPTS: '0',
    LARK_API_CIRCUIT_FAILURE_THRESHOLD: '5',
    LARK_API_CIRCUIT_WINDOW_MS: '30000',
    LARK_API_CIRCUIT_PROBE_INTERVAL_MS: '30000'
  });

  const failTimes = async (appId: string, count: number, error: () => Error, log?: LarkGateLog) => {
    for (let index = 0; index < count; index++) {
      await expect(executeWithLarkGate(appId, 'card.patch', async () => { throw error(); }, { env: trippingEnv, ...(log ? { log } : {}) }))
        .rejects.toBeInstanceOf(Error);
    }
  };

  it('trips after the threshold and then fails fast without invoking fn', async () => {
    await failTimes('cli_trip', 5, () => openApiError(undefined, 500));

    let invoked = false;
    await expect(executeWithLarkGate('cli_trip', 'card.patch', async () => {
      invoked = true;
      return 'never';
    }, { env: trippingEnv })).rejects.toBeInstanceOf(LarkCircuitOpenError);
    expect(invoked).toBe(false);
  });

  it('exposes appId and openedAt on the circuit-open error', async () => {
    await failTimes('cli_meta', 5, () => openApiError(undefined, 500));
    const error = await executeWithLarkGate('cli_meta', 'card.patch', async () => 'x', { env: trippingEnv }).catch(err => err);
    expect(error).toBeInstanceOf(LarkCircuitOpenError);
    expect(error.appId).toBe('cli_meta');
    expect(error.openedAt).toBeGreaterThan(0);
    expect(error.message).toContain('cli_meta');
  });

  it('keeps the circuit closed below the threshold', async () => {
    await failTimes('cli_below', 4, () => openApiError(undefined, 500));
    await expect(executeWithLarkGate('cli_below', 'card.patch', async () => 'ok', { env: trippingEnv })).resolves.toBe('ok');
  });

  it('trips one app without affecting another', async () => {
    await failTimes('cli_iso_a', 5, () => openApiError(undefined, 500));
    await expect(executeWithLarkGate('cli_iso_a', 'card.patch', async () => 'x', { env: trippingEnv }))
      .rejects.toBeInstanceOf(LarkCircuitOpenError);
    await expect(executeWithLarkGate('cli_iso_b', 'card.patch', async () => 'ok', { env: trippingEnv })).resolves.toBe('ok');
  });

  it('closes on a successful half-open probe after the probe interval', async () => {
    vi.useFakeTimers();
    const { log, entries } = recordingLog();
    await failTimes('cli_probe', 5, () => openApiError(undefined, 500), log);
    await expect(executeWithLarkGate('cli_probe', 'card.patch', async () => 'x', { env: trippingEnv, log }))
      .rejects.toBeInstanceOf(LarkCircuitOpenError);

    await vi.advanceTimersByTimeAsync(30_001);
    await expect(executeWithLarkGate('cli_probe', 'card.patch', async () => 'recovered', { env: trippingEnv, log })).resolves.toBe('recovered');
    expect(entries.some(entry => entry.level === 'info' && entry.message === '飞书 OpenAPI 熔断器已恢复闭合')).toBe(true);

    // 恢复后正常放行。
    await expect(executeWithLarkGate('cli_probe', 'card.patch', async () => 'ok', { env: trippingEnv, log })).resolves.toBe('ok');
  });

  it('re-trips when the half-open probe fails', async () => {
    vi.useFakeTimers();
    await failTimes('cli_reprobe', 5, () => openApiError(undefined, 500));
    await vi.advanceTimersByTimeAsync(30_001);

    const stillBroken = openApiError(undefined, 500);
    await expect(executeWithLarkGate('cli_reprobe', 'card.patch', async () => { throw stillBroken; }, { env: trippingEnv }))
      .rejects.toBe(stillBroken);

    let invoked = false;
    await expect(executeWithLarkGate('cli_reprobe', 'card.patch', async () => { invoked = true; return 'x'; }, { env: trippingEnv }))
      .rejects.toBeInstanceOf(LarkCircuitOpenError);
    expect(invoked).toBe(false);
  });

  it('does not trip on deterministic errors, however many arrive', async () => {
    // 一条内容违规的卡片连发 10 次不能把整个 app 熔断——否则一个坏请求毒死所有会话。
    await failTimes('cli_deterministic', 10, () => openApiError(230028, 400));
    await expect(executeWithLarkGate('cli_deterministic', 'card.patch', async () => 'ok', { env: trippingEnv })).resolves.toBe('ok');
  });

  it('does not trip on non-Lark errors thrown by the wrapped function', async () => {
    await failTimes('cli_plain', 8, () => new Error('programmer error'));
    await expect(executeWithLarkGate('cli_plain', 'card.patch', async () => 'ok', { env: trippingEnv })).resolves.toBe('ok');
  });

  it('does not count failures that fall outside the window', async () => {
    vi.useFakeTimers();
    await failTimes('cli_window', 4, () => openApiError(undefined, 500));
    await vi.advanceTimersByTimeAsync(30_001); // 窗口过期，旧失败作废
    await failTimes('cli_window', 4, () => openApiError(undefined, 500));
    await expect(executeWithLarkGate('cli_window', 'card.patch', async () => 'ok', { env: trippingEnv })).resolves.toBe('ok');
  });

  it('resets the failure count after a success', async () => {
    await failTimes('cli_reset', 4, () => openApiError(undefined, 500));
    await expect(executeWithLarkGate('cli_reset', 'card.patch', async () => 'ok', { env: trippingEnv })).resolves.toBe('ok');
    await failTimes('cli_reset', 4, () => openApiError(undefined, 500));
    await expect(executeWithLarkGate('cli_reset', 'card.patch', async () => 'ok', { env: trippingEnv })).resolves.toBe('ok');
  });
});

describe('Lark api gate abort support', () => {
  it('rejects promptly during a token wait and never invokes fn', async () => {
    const env = gateEnv({ LARK_API_QPS: '1', LARK_API_BURST: '1' });
    // 第一个调用吃掉唯一的令牌，第二个必须等 1s。
    await executeWithLarkGate('cli_abort', 'card.patch', async () => 'first', { env });

    const controller = new AbortController();
    let invoked = false;
    const startedAt = Date.now();
    const promise = executeWithLarkGate('cli_abort', 'card.patch', async () => {
      invoked = true;
      return 'never';
    }, { env, signal: controller.signal });

    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoked).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(500); // 没有等满 1s 的令牌间隔
  });

  it('short-circuits an already-aborted signal without invoking fn', async () => {
    // 这是令牌等待后必须复查 signal.aborted 的原因：在已 aborted 的 signal 上
    // 注册监听永远不会触发，只靠监听器就会让 fn 里的请求永久挂起。
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    await expect(executeWithLarkGate('cli_pre_abort', 'card.patch', async () => {
      invoked = true;
      return 'never';
    }, { env: gateEnv(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoked).toBe(false);
  });

  it('propagates a custom abort reason but not the default DOMException', async () => {
    const custom = new Error('调用方取消');
    const withReason = new AbortController();
    withReason.abort(custom);
    await expect(executeWithLarkGate('cli_reason', 'card.patch', async () => 'x', { env: gateEnv(), signal: withReason.signal }))
      .rejects.toBe(custom);

    const plain = new AbortController();
    plain.abort();
    await expect(executeWithLarkGate('cli_plain_reason', 'card.patch', async () => 'x', { env: gateEnv(), signal: plain.signal }))
      .rejects.toMatchObject({ name: 'AbortError', message: '飞书 OpenAPI 网关操作已取消。' });
  });

  it('aborts a pending retry backoff', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let calls = 0;
    const promise = executeWithLarkGate('cli_abort_backoff', 'card.patch', async () => {
      calls += 1;
      throw openApiError(undefined, 429);
    }, { env: gateEnv(), signal: controller.signal });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await assertion;
    expect(calls).toBe(1);
  });
});

describe('resolveLarkGateConfig', () => {
  it('falls back to documented defaults on an empty env', () => {
    expect(resolveLarkGateConfig({})).toEqual({
      qps: 15,
      burst: 15,
      retryMaxAttempts: 3,
      retryBaseMs: 500,
      retryMaxMs: 8_000,
      circuitFailureThreshold: 5,
      circuitWindowMs: 30_000,
      circuitProbeIntervalMs: 30_000
    });
  });

  it('reads every LARK_API_* knob', () => {
    expect(resolveLarkGateConfig({
      LARK_API_QPS: '40',
      LARK_API_BURST: '80',
      LARK_API_RETRY_MAX_ATTEMPTS: '5',
      LARK_API_RETRY_BASE_MS: '200',
      LARK_API_RETRY_MAX_MS: '4000',
      LARK_API_CIRCUIT_FAILURE_THRESHOLD: '9',
      LARK_API_CIRCUIT_WINDOW_MS: '60000',
      LARK_API_CIRCUIT_PROBE_INTERVAL_MS: '15000'
    })).toEqual({
      qps: 40,
      burst: 80,
      retryMaxAttempts: 5,
      retryBaseMs: 200,
      retryMaxMs: 4_000,
      circuitFailureThreshold: 9,
      circuitWindowMs: 60_000,
      circuitProbeIntervalMs: 15_000
    });
  });

  it('defaults burst to qps when only qps is set', () => {
    expect(resolveLarkGateConfig({ LARK_API_QPS: '7' })).toMatchObject({ qps: 7, burst: 7 });
  });

  it('falls back to defaults for garbage, negative, zero and blank values', () => {
    const config = resolveLarkGateConfig({
      LARK_API_QPS: 'fast',
      LARK_API_BURST: '-3',
      LARK_API_RETRY_MAX_ATTEMPTS: 'many',
      LARK_API_RETRY_BASE_MS: '0',
      LARK_API_RETRY_MAX_MS: '   ',
      LARK_API_CIRCUIT_FAILURE_THRESHOLD: '0',
      LARK_API_CIRCUIT_WINDOW_MS: 'NaN',
      LARK_API_CIRCUIT_PROBE_INTERVAL_MS: '-1'
    });
    expect(config).toEqual({
      qps: 15,
      burst: 15,
      retryMaxAttempts: 3,
      retryBaseMs: 500,
      retryMaxMs: 8_000,
      circuitFailureThreshold: 5,
      circuitWindowMs: 30_000,
      circuitProbeIntervalMs: 30_000
    });
    // 绝不产出 NaN / 0 / 负数 —— 0 QPS 会让所有卡片更新永久挂死。
    for (const value of Object.values(config)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('accepts 0 retries but not a 0 threshold', () => {
    expect(resolveLarkGateConfig({ LARK_API_RETRY_MAX_ATTEMPTS: '0' }).retryMaxAttempts).toBe(0);
    expect(resolveLarkGateConfig({ LARK_API_CIRCUIT_FAILURE_THRESHOLD: '0' }).circuitFailureThreshold).toBe(5);
  });

  it('floors fractional integer knobs and keeps fractional qps', () => {
    const config = resolveLarkGateConfig({ LARK_API_QPS: '2.5', LARK_API_RETRY_MAX_ATTEMPTS: '3.9' });
    expect(config.qps).toBe(2.5);
    expect(config.retryMaxAttempts).toBe(3);
  });

  it('re-reads process.env live so QPS can be retuned without a restart', () => {
    vi.stubEnv('LARK_API_QPS', '11');
    expect(resolveLarkGateConfig().qps).toBe(11);
    vi.stubEnv('LARK_API_QPS', '22');
    expect(resolveLarkGateConfig().qps).toBe(22);
  });

  it('lets executeWithLarkGate pick up a live env change between calls', async () => {
    vi.stubEnv('LARK_API_CIRCUIT_FAILURE_THRESHOLD', '2');
    vi.stubEnv('LARK_API_RETRY_MAX_ATTEMPTS', '0');
    vi.stubEnv('LARK_API_QPS', '1000');
    for (let index = 0; index < 2; index++) {
      await expect(executeWithLarkGate('cli_live', 'card.patch', async () => { throw openApiError(undefined, 500); }))
        .rejects.toBeInstanceOf(Error);
    }
    await expect(executeWithLarkGate('cli_live', 'card.patch', async () => 'x')).rejects.toBeInstanceOf(LarkCircuitOpenError);
  });
});

describe('setLarkGateLog', () => {
  it('uses the module-level sink and stays silent when none is installed', async () => {
    const { log, entries } = recordingLog();
    setLarkGateLog(log);
    const env = gateEnv({ LARK_API_QPS: '5', LARK_API_BURST: '1' });
    await Promise.all([
      executeWithLarkGate('cli_sink', 'card.patch', async () => 'a', { env }),
      executeWithLarkGate('cli_sink', 'card.patch', async () => 'b', { env })
    ]);
    expect(entries.some(entry => entry.message === '飞书 OpenAPI 限流等待')).toBe(true);

    __testOnly_resetLarkGate();
    const before = entries.length;
    await Promise.all([
      executeWithLarkGate('cli_sink', 'card.patch', async () => 'a', { env }),
      executeWithLarkGate('cli_sink', 'card.patch', async () => 'b', { env })
    ]);
    expect(entries).toHaveLength(before);
  });

  it('never logs credentials', async () => {
    const { log, entries } = recordingLog();
    const env = gateEnv({ LARK_API_RETRY_MAX_ATTEMPTS: '0', LARK_API_CIRCUIT_FAILURE_THRESHOLD: '1' });
    await expect(executeWithLarkGate('cli_credential_check', 'card.patch', async () => { throw openApiError(undefined, 500); }, { env, log }))
      .rejects.toBeInstanceOf(Error);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('appSecret');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('Bearer');
    // 日志只带 appId（非凭据）与运维指标。
    expect(serialized).toContain('cli_credential_check');
  });
});
