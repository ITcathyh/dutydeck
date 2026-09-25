import { afterEach, expect, it, vi } from 'vitest';
import { __testOnly_resetLarkGate, executeWithLarkGate, LarkCircuitOpenError } from './api-gate.js';

afterEach(() => { __testOnly_resetLarkGate(); vi.useRealTimers(); });

it('preserves an uncertain send error when another request opens the circuit during retry backoff', async () => {
  vi.useFakeTimers();
  const env = { LARK_API_RETRY_MAX_ATTEMPTS: '1', LARK_API_RETRY_BASE_MS: '1000', LARK_API_CIRCUIT_FAILURE_THRESHOLD: '1' };
  const lostResponse = Object.assign(new Error('response lost after send'), { code: 'LARK_NETWORK_ERROR' });
  const send = vi.fn(async () => { throw lostResponse; });
  const result = executeWithLarkGate('same-app', 'message.send', send, { env }).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledOnce();
  await expect(executeWithLarkGate('same-app', 'card.patch', async () => { throw lostResponse; }, {
    env: { ...env, LARK_API_RETRY_MAX_ATTEMPTS: '0' },
  })).rejects.toBe(lostResponse);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await result).toBe(lostResponse);
  expect(send).toHaveBeenCalledOnce();
  const neverSent = vi.fn(async () => 'sent');
  await expect(executeWithLarkGate('same-app', 'message.send', neverSent, { env })).rejects.toBeInstanceOf(LarkCircuitOpenError);
  expect(neverSent).not.toHaveBeenCalled();
});
