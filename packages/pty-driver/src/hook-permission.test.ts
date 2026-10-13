import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import type { AgentConfig, NormalizedDriverEvent, PermissionMode } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const directories: string[] = [];
const drivers: PtyCliDriver[] = [];
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.stop();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const backend = (): SessionBackend => ({ kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} });

function fixture(adapterId = 'claude-code', permissionMode: PermissionMode = 'ask') {
  const cwd = mkdtempSync(join(tmpdir(), 'dutydeck-hook-permission-'));
  directories.push(cwd);
  const events: NormalizedDriverEvent[] = [];
  const agent: AgentConfig = { id: adapterId, name: adapterId, command: 'unused', args: [], protocol: 'pty-cli', cwd, env: {},
    permissionMode, timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
  const driver = new PtyCliDriver({ agent, adapter: createCliAdapter(adapterId), backend: backend(), sessionId: `ses_${adapterId}_hook`,
    onEvent: event => events.push(event), onExit() {} });
  drivers.push(driver);
  const internals = driver as unknown as { turnActive: boolean; emitEvent(event: NormalizedDriverEvent): void; humanWaits: Set<string> };
  return { driver, events, internals };
}

const request = { title: 'Run tests', operation: { source: 'claude_permission_hook' as const, kind: 'execute', command: 'pnpm test' } };

describe('PTY permission hook bridge', () => {
  it('emits a pending permission request during a turn and hands the decision back to the hook', async () => {
    const { driver, events, internals } = fixture();
    internals.turnActive = true;
    const handle = driver.requestPermission!(request)!;
    expect(handle.id).toMatch(/^hook_/);
    expect(events).toEqual([{ type: 'permission_request', data: { ...request, id: handle.id, status: 'pending' } }]);
    // 等人裁决算作等待中，轮次空闲超时不会把它当成卡死。
    expect(internals.humanWaits.has(handle.id)).toBe(true);
    expect(await driver.resolvePermission!(handle.id, true)).toBe(true);
    expect(await handle.decision).toEqual({ approved: true });
    expect(internals.humanWaits.has(handle.id)).toBe(false);
    // 已裁决的请求不能再裁决第二次。
    expect(await driver.resolvePermission!(handle.id, false)).toBe(false);
  });

  it('passes the rejection reason to the hook', async () => {
    const { driver, internals } = fixture();
    internals.turnActive = true;
    const handle = driver.requestPermission!(request)!;
    await driver.resolvePermission!(handle.id, false, '超过 24 小时未处理，已自动拒绝');
    expect(await handle.decision).toEqual({ approved: false, reason: '超过 24 小时未处理，已自动拒绝' });
  });

  it('keeps the native terminal confirmation outside a turn', () => {
    const { driver, events } = fixture();
    expect(driver.requestPermission!(request)).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('rejects undecided requests when the turn completes or the driver stops', async () => {
    const { driver, internals } = fixture();
    internals.turnActive = true;
    const first = driver.requestPermission!(request)!;
    internals.emitEvent({ type: 'completed', data: { stopReason: 'end_turn' } });
    expect(await first.decision).toEqual({ approved: false, reason: '本轮任务已结束，这次操作没有执行。' });
    const second = driver.requestPermission!(request)!;
    await driver.stop();
    expect(await second.decision).toEqual({ approved: false, reason: '会话已停止，这次操作没有执行。' });
  });

  it('only offers hook approval for Claude family CLIs', () => {
    expect(fixture('codex').driver.requestPermission).toBeUndefined();
    expect(fixture('codex').driver.resolvePermission).toBeUndefined();
    for (const id of ['claude-code', 'seed', 'relay']) expect(fixture(id).driver.requestPermission).toBeTypeOf('function');
  });

  it('accepts approve-reads only for CLIs whose approvals go through the hook', async () => {
    await expect(fixture('claude-code', 'approve-reads').driver.start()).resolves.toBeUndefined();
    await expect(fixture('codex', 'approve-reads').driver.start()).rejects.toThrow('does not support permission mode approve-reads');
  });
});
