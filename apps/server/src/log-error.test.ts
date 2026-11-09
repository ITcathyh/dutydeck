import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { appLoggerOptions } from './app-logger.js';

/** 用服务实际的 logger 选项写一条日志，取回解析后的 JSON。 */
function logged(details: Record<string, unknown>): Record<string, any> {
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
  pino(appLoggerOptions, sink).warn(details, 'Reconciling durable confirmation failed');
  return JSON.parse(lines[0]!);
}

describe('服务日志里的 { error } 字段', () => {
  it('Error 带上 message 与 stack，不再被记成 {}', () => {
    const entry = logged({ error: new Error('database is locked'), requestId: 'r-1' });
    expect(entry.error).toMatchObject({ type: 'Error', message: 'database is locked' });
    expect(entry.error.stack).toContain('database is locked');
    expect(entry.requestId).toBe('r-1');
  });

  it('只挑排障字段：不照搬 SDK 错误上的请求配置和响应体，message 里的凭据被脱敏', () => {
    const error = Object.assign(new Error('request failed: Authorization: Bearer t-abcdefghijklmnop'), {
      name: 'AxiosError', code: 'ECONNRESET',
      config: { headers: { Authorization: 'Bearer t-config-secret' } },
      response: { status: 503, data: { msg: 'upstream response body' } },
      details: { upstreamCode: 99991400, upstreamHttpStatus: 503, body: 'raw body' }
    });
    const entry = logged({ error });
    expect(entry.error).toMatchObject({ type: 'AxiosError', code: 'ECONNRESET', status: 503, upstreamCode: 99991400, upstreamHttpStatus: 503 });
    const text = JSON.stringify(entry);
    expect(text).not.toContain('t-config-secret');
    expect(text).not.toContain('upstream response body');
    expect(text).not.toContain('raw body');
    expect(text).not.toContain('t-abcdefghijklmnop');
  });

  it('cause 链与 AggregateError 的子错误一并展开；非 Error 值原样保留', () => {
    const entry = logged({ error: new AggregateError([new Error('runtime'), new Error('repos')], 'did not shut down cleanly', { cause: new Error('root') }) });
    expect(entry.error.errors.map((item: { message: string }) => item.message)).toEqual(['runtime', 'repos']);
    expect(entry.error.cause.message).toBe('root');
    expect(logged({ error: 'plain text reason' }).error).toBe('plain text reason');
    expect(logged({ error: { name: 'AbortError' } }).error).toEqual({ name: 'AbortError' });
  });
});
