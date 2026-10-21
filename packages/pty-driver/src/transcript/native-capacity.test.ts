import { expect, it } from 'vitest';
import { NativeTurn, nativeTaskError } from './native-turn.js';

it.each([{ codex_error_info: 'ServerOverloaded' }, { codex_error_info: 'server_overloaded' }, { codexErrorInfo: 'serverOverloaded' }, 'Selected model is at capacity. Please try a different model.'])('classifies exact Codex capacity: %j', error => {
  expect(nativeTaskError(error, true)?.data).toMatchObject({ code: 'codex_capacity', retryable: true, nativeSource: 'codex' });
  expect(nativeTaskError(error)?.data.code).not.toBe('codex_capacity');
});
it.each(['429 Too Many Requests', '503 Service Unavailable', 'Overloaded: please retry', { code: '401 Unauthorized', message: 'Selected model is at capacity. Please try a different model.' }, { code: '429', codex_error_info: 'ServerOverloaded' }, { code: 'usage_limit', codex_error_info: 'ServerOverloaded' }, { message: 'Selected model is at capacity, retry later.' }])('does not classify unrelated failure as capacity: %j', error => {
  expect(nativeTaskError(error, true)?.data.code).not.toBe('codex_capacity');
});
it('adds replay evidence only to a terminal bound to the accepted native input', () => {
  const turn = new NativeTurn(true); turn.arm(new AbortController().signal);
  turn.observe({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'current' } });
  turn.bind({ type: 'event_msg', payload: { type: 'user_message', turn_id: 'current', message: 'hello' } });
  turn.observe({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old', error: { code: 'ServerOverloaded' } } }); expect(turn.takeError()).toBeUndefined();
  turn.observe({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'current', error: { code: 'ServerOverloaded' } } });
  expect(turn.takeError()?.data).toMatchObject({ code: 'codex_capacity', nativeTerminal: true, nativeTurnId: 'current' });
});
