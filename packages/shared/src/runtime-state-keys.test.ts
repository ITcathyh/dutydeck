import { expect, it } from 'vitest';
import { runtimeStateKeys as keys } from './runtime-state-keys.js';

it.each([
  [keys.driverStopBlock, 'runtime_driver_stop_block:session'],
  [keys.driverConfiguration, 'runtime_driver_configuration:session'],
  [keys.workspace, 'runtime_workspace:session'],
  [keys.idleTerminal, 'runtime_idle_terminal:session'],
  [keys.executionWorkspace, 'runtime_execution_workspace:session'],
  [keys.legacyRetirement, 'legacy_retirement:session']
] as const)('preserves stored session key %#', (entry, expected) => {
  expect(entry.key('session')).toBe(expected);
  expect(entry.parse(expected)).toBe('session');
  expect(entry.parse('other:session')).toBeUndefined();
});

it.each([
  [keys.verification, 'session', 'check', 'runtime_verification:session:check'],
  [keys.ptyRetirement, 'session', 'decision', 'runtime_pty_retirement:session:decision'],
  [keys.notice, 'workspace_blocked', 'session', 'runtime_notice:workspace_blocked:session'],
  [keys.notice, 'stop_unverified', 'session', 'runtime_notice:stop_unverified:session'],
  [keys.notice, 'stop_unverifiable', 'session', 'runtime_notice:stop_unverifiable:session'],
  [keys.notice, 'unknown_task_abandoned', 'attempt', 'runtime_notice:unknown_task_abandoned:attempt'],
  [keys.notice, 'unknown_task_overdue', 'attempt', 'runtime_notice:unknown_task_overdue:attempt']
] as const)('preserves compound key %#', (entry, first, second, expected) => {
  expect(entry.key(first, second)).toBe(expected);
  expect(entry.parse(expected)).toEqual([first, second]);
  expect(entry.parse(entry.prefix + first)).toBeUndefined();
});

it('preserves the native selection, revision and session verification range', () => {
  expect(keys.nativeContext.key('session')).toBe('runtime_native_context:session');
  expect(keys.nativeContext.revisionKey('session')).toBe('runtime_native_context:session:revision');
  expect(keys.nativeContext.parse('runtime_native_context:session')).toEqual({ sessionId: 'session', revision: false });
  expect(keys.nativeContext.parse('runtime_native_context:session:revision')).toEqual({ sessionId: 'session', revision: true });
  expect(keys.verification.sessionPrefix('session')).toBe('runtime_verification:session:');
  expect(keys.verification.sessionUpperBound('session')).toBe('runtime_verification:session;');
});

it('resolves colon-bearing session and decision IDs using the known scope', () => {
  const key = keys.ptyRetirement.key('origin:tenant', 'decision:1');
  expect(key).toBe('runtime_pty_retirement:origin:tenant:decision:1');
  expect(keys.ptyRetirement.parse(key)).toBeUndefined();
  expect(keys.ptyRetirement.parse(key, 'origin:tenant')).toEqual(['origin:tenant', 'decision:1']);
  expect(keys.ptyRetirement.parse(key, 'unrelated')).toBeUndefined();
});

it('reads persisted values without reordering evidence used in compare-and-set', () => {
  const raw = '{"status":"running","id":"check","sessionId":"session","schemaVersion":1,"revision":1,"command":"true","cwd":"/workspace","startedAt":"2026-01-01T00:00:00Z","outputTruncated":false,"output":""}';
  expect(JSON.stringify(keys.verification.read(raw))).toBe(raw);
  expect(keys.verification.value.safeParse({ status: 'unexpected' }).success).toBe(false);
  expect(keys.executionWorkspace.read('{"version":1,"unverifiable":true}')).toEqual({ version: 1, unverifiable: true });
  expect(keys.notice.read('sent')).toBe('sent');
});
