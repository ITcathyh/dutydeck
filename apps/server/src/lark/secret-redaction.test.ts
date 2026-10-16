import { describe, expect, it } from 'vitest';
import { redactTraceText, rememberSecretValues } from './secret-redaction.js';

describe('secret redaction', () => {
  it.each([
    ['Anthropic key', 'key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['Claude OAuth token', 'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['OpenAI project key', 'OPENAI: sk-proj-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['GitHub token', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['Slack token', 'xoxb-1234567890-abcdefghij'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ])('removes a bare %s', (_name, text) => {
    expect(redactTraceText(text)).toContain('[REDACTED]');
    expect(redactTraceText(text)).not.toMatch(/AbCdEfGh|IOSFODNN|abcdefghij|dozjgNry/);
  });

  it('removes values Dutydeck knows are credentials wherever they appear', () => {
    rememberSecretValues({ PROXY_AUTH_TOKEN: 'opaque-proxy-value-123', PROXY_TOKEN_URL: 'https://auth.example/token', SHORT_TOKEN: 'abc', MODEL: 'opaque-model-name-123' });
    expect(redactTraceText('printed: opaque-proxy-value-123 done')).toBe('printed: [REDACTED] done');
    expect(redactTraceText('see https://auth.example/token')).toBe('see https://auth.example/token');
    expect(redactTraceText('model opaque-model-name-123')).toBe('model opaque-model-name-123');
  });

  it('keeps ordinary text', () => {
    for (const text of ['sk-learn 安装好了', 'branch feat/ghp-cleanup', 'eyJ 开头的字段', 'pnpm test 通过']) expect(redactTraceText(text)).toBe(text);
  });
});
