import { describe, expect, it } from 'vitest';
import { validateHighRiskPattern } from '@dockmux/shared';

describe('high-risk pattern form validation', () => {
  it('accepts usable patterns and explains invalid or unsafe patterns', () => {
    expect(validateHighRiskPattern('rm\\b|git\\s+push')).toEqual({ valid: true });
    expect(validateHighRiskPattern('(unclosed')).toMatchObject({ valid: false, error: expect.stringContaining('语法错误') });
    expect(validateHighRiskPattern('^(a+)+$')).toMatchObject({ valid: false, error: expect.stringContaining('灾难性回溯') });
  });
});
