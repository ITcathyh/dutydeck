import { describe, expect, it } from 'vitest';
import {
  SESSION_NAME_MAX_LENGTH,
  sessionNameConfigKey,
  normalizeSessionName,
  RuntimeError
} from './index.js';

describe('session-name helpers', () => {
  it('generates expected config key', () => {
    expect(sessionNameConfigKey('ses_123')).toBe('session_name:ses_123');
  });

  it('handles null as clear signal', () => {
    expect(normalizeSessionName(null)).toBeNull();
  });

  it('trims valid session names', () => {
    expect(normalizeSessionName('  Feature Auth Refactor  ')).toBe('Feature Auth Refactor');
    expect(normalizeSessionName('a'.repeat(80))).toBe('a'.repeat(80));
  });

  it('rejects empty and whitespace-only strings', () => {
    expect(() => normalizeSessionName('')).toThrowError(RuntimeError);
    expect(() => normalizeSessionName('   ')).toThrowError(RuntimeError);
    try {
      normalizeSessionName('   ');
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      expect((err as RuntimeError).code).toBe('INVALID_SESSION_NAME');
      expect((err as RuntimeError).statusCode).toBe(400);
    }
  });

  it('rejects strings exceeding 80 characters', () => {
    expect(() => normalizeSessionName('a'.repeat(81))).toThrowError(RuntimeError);
    try {
      normalizeSessionName('a'.repeat(81));
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      expect((err as RuntimeError).code).toBe('INVALID_SESSION_NAME');
      expect((err as RuntimeError).statusCode).toBe(400);
    }
  });

  it('rejects strings containing newlines', () => {
    expect(() => normalizeSessionName('Line 1\nLine 2')).toThrowError(RuntimeError);
    expect(() => normalizeSessionName('Line 1\rLine 2')).toThrowError(RuntimeError);
    expect(() => normalizeSessionName('Line 1\r\nLine 2')).toThrowError(RuntimeError);
    try {
      normalizeSessionName('Line 1\nLine 2');
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      expect((err as RuntimeError).code).toBe('INVALID_SESSION_NAME');
      expect((err as RuntimeError).statusCode).toBe(400);
    }
  });

  it('rejects non-string non-null values', () => {
    expect(() => normalizeSessionName(undefined as any)).toThrowError(RuntimeError);
    expect(() => normalizeSessionName(123 as any)).toThrowError(RuntimeError);
    expect(() => normalizeSessionName({} as any)).toThrowError(RuntimeError);
  });
});
