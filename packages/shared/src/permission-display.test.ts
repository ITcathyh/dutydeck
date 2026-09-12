import { describe, expect, it } from 'vitest';
import { permissionDisplayText } from './permission-display.js';

describe('permission display redaction', () => {
  it('redacts credentials before bounding output and preserves a useful command', () => {
    expect(permissionDisplayText('curl https://user:pass@example.test --api-key="a long secret" -H "Authorization: Bearer abcdefgh"')).not.toMatch(/user:pass|a long secret|abcdefgh/);
    expect(permissionDisplayText("curl -H 'Cookie: a=one; b=two'")).not.toMatch(/one|two/);
    expect(permissionDisplayText('TOKEN=' + 'x'.repeat(5000))).toBe('TOKEN=[REDACTED]');
    expect(permissionDisplayText('pnpm test')).toBe('pnpm test');
    expect(permissionDisplayText('x'.repeat(5000)).length).toBe(1201);
  });
});
