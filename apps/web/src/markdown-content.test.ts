import { describe, expect, it } from 'vitest';
import { isBlockCode, resolveCodeLanguage } from './MarkdownContent';

describe('stream-safe Markdown code rendering', () => {
  it('normalizes common fenced-code language aliases', () => {
    expect(resolveCodeLanguage('language-ts')).toEqual({ language: 'typescript', label: 'ts' });
    expect(resolveCodeLanguage('language-py')).toEqual({ language: 'python', label: 'py' });
  });

  it('falls back to plain text for an unknown grammar while retaining its label', () => {
    expect(resolveCodeLanguage('language-dockmux')).toEqual({ language: 'plain', label: 'dockmux' });
  });

  it('distinguishes inline code from fenced or multiline code', () => {
    expect(isBlockCode(undefined, 'const value = 1')).toBe(false);
    expect(isBlockCode('language-js', 'const value = 1')).toBe(true);
    expect(isBlockCode(undefined, 'line one\nline two\n')).toBe(true);
  });
});
