import { afterEach, expect, it, vi } from 'vitest';
import { requestId } from './request-id';

afterEach(() => vi.restoreAllMocks());

it('creates distinct UUID v4 values without crypto.randomUUID, as on a plain HTTP LAN address', () => {
  const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    const ids = Array.from({ length: 64 }, requestId);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(ids.length);
  } finally {
    if (original) Object.defineProperty(crypto, 'randomUUID', original); else delete (crypto as { randomUUID?: unknown }).randomUUID;
  }
});
