import { describe, expect, it } from 'vitest';
import { RegexMatchTimeoutError, testRegexWithTimeout } from './regex-timeout.js';

describe('isolated regular-expression matching', () => {
  it('returns ordinary matches from the worker', async () => {
    await expect(testRegexWithTimeout('rm\\b', 'rm example')).resolves.toBe(true);
    await expect(testRegexWithTimeout('rm\\b', 'pwd')).resolves.toBe(false);
  });

  it('terminates a catastrophic match at the configured timeout', async () => {
    await expect(testRegexWithTimeout('^(a+)+$', `${'a'.repeat(50_000)}!`, 50)).rejects.toBeInstanceOf(RegexMatchTimeoutError);
  });
});
