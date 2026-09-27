import { afterEach, expect, it, vi } from 'vitest';
import { __testOnly_resetLarkGate, executeWithLarkGate } from './api-gate.js';

afterEach(() => { __testOnly_resetLarkGate(); vi.useRealTimers(); });

it.each([undefined, '0.25'])('permits requests at 0.5 QPS with burst=%s', async burst => {
  vi.useFakeTimers();
  const started = Date.now();
  const sent: number[] = [];
  const env = { LARK_API_QPS: '0.5', ...(burst ? { LARK_API_BURST: burst } : {}) };
  const requests = Array.from({ length: 3 }, () => executeWithLarkGate('fractional', 'message.send', async () => {
    sent.push(Date.now() - started);
    return 'sent';
  }, { env }));
  await vi.advanceTimersByTimeAsync(0);
  expect(sent).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(sent).toEqual([0]);
  await vi.advanceTimersByTimeAsync(1);
  expect(sent).toEqual([0, 2_000]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(sent).toEqual([0, 2_000, 4_000]);
  await expect(Promise.all(requests)).resolves.toEqual(['sent', 'sent', 'sent']);
});
