import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';
import { TerminalSnapshot } from '@dutydeck/terminal-renderer';
import { PtyCliDriver } from './driver.js';

const line = (entry: unknown) => JSON.stringify(entry) + '\n';
let cwd: string, driver: PtyCliDriver;
afterEach(async () => { await driver?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); if (cwd) rmSync(cwd, { recursive: true, force: true }); });

// 屏幕判空的 CLI（不发 OSC 7501）先画出最终输入框，transcript 的终止记录随后才被轮询读到。
// 读到终止记录会重置空闲检测；此时终端渲染还没跟上最终画面，若因此丢掉已看到的输入框，
// CLI 不再输出任何字节，这一轮就永远停在执行中。
it('completes a screen-idle turn whose native terminal is read after the final prompt was painted', async () => {
  vi.useFakeTimers(); cwd = mkdtempSync(join(tmpdir(), 'dd-screen-ready-race-'));
  const day = join(cwd, 'sessions', '2026', '11', '06'); mkdirSync(day, { recursive: true });
  const sid = '33333333-3333-4333-8333-333333333333';
  const rollout = join(day, `rollout-2026-11-06T09-00-00-${sid}.jsonl`);
  writeFileSync(rollout, line({ type: 'session_meta', payload: { id: sid, cwd } }));
  writeFileSync(join(cwd, 'history.jsonl'), line({ session_id: sid, ts: Date.now() / 1000, text: '<dutydeck_session_id>ses_screen_ready_race</dutydeck_session_id>' }));
  let output!: (data: string) => void;
  const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, interrupt() {}, onExit() {}, onData(cb) { output = cb; } };
  const events: NormalizedDriverEvent[] = [];
  driver = new PtyCliDriver({ agent: { id: 'codex', name: 'Codex', command: 'unused', args: [], protocol: 'pty-cli', cwd,
    env: { CODEX_HOME: cwd }, permissionMode: 'ask', timeout: 3600, capabilities: { pause: false, resume: false }, builtin: false },
    adapter: { ...createCliAdapter('codex'), prepareInput: undefined, writeInput(_backend, prompt) {
      appendFileSync(rollout, line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } })
        + line({ type: 'event_msg', payload: { type: 'user_message', turn_id: 'turn', message: prompt } }));
    } },
    backend, sessionId: 'ses_screen_ready_race', onEvent: event => events.push(event), onExit() {} });
  await driver.start();
  output('\x1b[2J\x1b[HOpenAI Codex\r\nContext 100% left\r\n› Ask Codex to do anything\r\n');
  const pending = driver.send('question'); void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(350);
  expect(events.some(event => event.type === 'status' && event.data.state === 'input_receipt' && event.data.phase === 'confirmed')).toBe(true);
  output('\x1b[2J\x1b[H' + Array.from({ length: 40 }, (_, index) => `pasted line ${index}`).join('\r\n') + '\r\n');
  await vi.advanceTimersByTimeAsync(100);

  // 终端渲染落后于字节流：最终输入框的字节已到达空闲检测，渲染器还没解析完。
  const write = TerminalSnapshot.prototype.writeAndFlush;
  let parseFinal!: () => void;
  const parsed = new Promise<void>(resolve => { parseFinal = resolve; });
  vi.spyOn(TerminalSnapshot.prototype, 'writeAndFlush').mockImplementationOnce(async function (this: TerminalSnapshot, data: string) {
    await parsed; return write.call(this, data);
  });
  output('\r\nCONTROLLED_TASK_DONE\r\nContext 99% left\r\n› Ask Codex to do anything\r\n');
  appendFileSync(rollout, line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: 'done' } }));
  await vi.advanceTimersByTimeAsync(400);
  parseFinal();
  // CLI 之后不再有任何输出；只靠已经看到的输入框完成这一轮。
  await vi.advanceTimersByTimeAsync(10_000);
  expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
  await pending;
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['done']);
});
