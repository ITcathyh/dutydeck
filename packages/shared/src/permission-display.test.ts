import { describe, expect, it } from 'vitest';
import { freeTextInputMaxBytes, freeTextInputMaxLength, freeTextInputViolation, permissionDisplayText, permissionRejectReasonMaxLength } from './permission-display.js';

describe('permission display redaction', () => {
  it.each([
    ['curl --access-key CANARYVALUE', 'CANARYVALUE'],
    ['echo xoxb-1234567890-canaryvalue', 'canaryvalue'],
    ['curl https://user:canary@tail@example.test/a?signature=SIGNEDVALUE', 'tail'],
    ['curl https://example.test/a?signature=SIGNEDVALUE', 'SIGNEDVALUE'],
    [JSON.stringify({ command: 'export API_KEY="opaque credential with spaces"; echo done' }), 'credential with spaces']
  ])('uses credential rules for permission text: %s', (text, secret) => {
    expect(permissionDisplayText(text)).not.toContain(secret);
    expect(permissionDisplayText(text)).toContain('[REDACTED]');
  });

  it.each(['--turn scoped_turn_secret', '--turn=scoped_turn_secret', '--turn "scoped_turn_secret"', "--turn='scoped_turn_secret'"])('hides collaboration capability %s', flag => {
    const shown = permissionDisplayText(`dutydeck collaborate ${flag} status`);
    expect(shown).not.toContain('scoped_turn_secret');
    expect(shown).toContain('[REDACTED]');
    expect(shown).toContain(' status');
  });
  it('redacts credentials before bounding output and preserves a useful command', () => {
    expect(permissionDisplayText('curl https://user:pass@example.test --api-key="a long secret" -H "Authorization: Bearer abcdefgh"')).not.toMatch(/user:pass|a long secret|abcdefgh/);
    expect(permissionDisplayText("curl -H 'Cookie: a=one; b=two'")).not.toMatch(/one|two/);
    expect(permissionDisplayText('TOKEN=' + 'x'.repeat(5000))).toBe('TOKEN=[REDACTED]');
    expect(permissionDisplayText('pnpm test')).toBe('pnpm test');
    expect(permissionDisplayText('x'.repeat(5000)).length).toBe(1201);
  });

  it('keeps the keyword assignment rule for spaced, quoted and unterminated values', () => {
    expect(permissionDisplayText('my-api-key  "a b" next')).toBe('my-api-key  [REDACTED] next');
    expect(permissionDisplayText("x_cookie_y = 'a b'tail")).toBe("x_cookie_y = [REDACTED]tail");
    expect(permissionDisplayText('session-token "open quote; rest')).toBe('session-token [REDACTED] quote; rest');
    expect(permissionDisplayText('mytoken :;after')).toBe('mytoken [REDACTED];after');
    expect(permissionDisplayText('token= ;')).toBe('token= ;');
  });

  it('scans agent text in linear time', () => {
    for (const input of ['access_token_'.repeat(400), 'token'.repeat(1000), `echo ${'aB3-_'.repeat(6400)} | base64 -d`, 'token="open '.repeat(5000)]) {
      const started = performance.now();
      permissionDisplayText(input);
      // 原实现在这些输入上要数秒到数十秒；线性扫描在毫秒级，上限只防负载抖动。
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it('hides the run cut by the redaction bound instead of showing a clipped credential', () => {
    const shown = permissionDisplayText(`${'safe '.repeat(1100)}ghp_${'a'.repeat(40)}`, [], 100);
    expect(shown).toBe(`${'safe '.repeat(20).slice(0, 100)}…`);
    expect(permissionDisplayText(`run ${'z'.repeat(20000)}`)).toBe('run [REDACTED]…');
  });
});

describe('free text input limit', () => {
  it('按字素计数，另按 UTF-8 字节封顶', () => {
    expect(permissionRejectReasonMaxLength).toBe(freeTextInputMaxLength);
    // 组合 emoji 是 1 个字素、11 个 UTF-16 码元、25 个字节：1000 个仍在两道上限内。
    expect(freeTextInputViolation('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'.repeat(freeTextInputMaxLength))).toBeUndefined();
    expect(freeTextInputViolation('长'.repeat(freeTextInputMaxLength))).toBeUndefined();
    // 带肤色的亲吻组合约 35 字节，是最长的标准 emoji 之一。
    expect(freeTextInputViolation('\u{1F468}\u{1F3FB}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}\u{1F3FC}'.repeat(freeTextInputMaxLength))).toBeUndefined();
    expect(freeTextInputViolation('长'.repeat(freeTextInputMaxLength + 1))).toBe('length');
    // 伪造回调：只有 1 个字素，但超过字节上限。
    const forged = `e${'\u0301'.repeat(40000)}`;
    expect(new TextEncoder().encode(forged).length).toBeGreaterThan(freeTextInputMaxBytes);
    expect(freeTextInputViolation(forged)).toBe('bytes');
    expect(freeTextInputViolation('x'.repeat(freeTextInputMaxBytes + 1))).toBe('bytes');
    expect(freeTextInputViolation('x'.repeat(10), 5)).toBe('length');
  });
});
