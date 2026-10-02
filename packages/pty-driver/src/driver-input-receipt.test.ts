import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { DriverRecoveryError } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

let directory: string, transcript: string, driver: PtyCliDriver;
let output: (data: string) => void, exit: (code: number) => void;
let events: NormalizedDriverEvent[], prompts: string[];
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const screen = (text: string) => `\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`;
const finalScreen = 'fixture answer\n✻ Cooked for 1s\n❯\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const receipt = (text: string) => appendFileSync(transcript, line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } }));
const answer = () => appendFileSync(transcript, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }], stop_reason: 'end_turn' } }));
const phases = () => events.filter(event => event.type === 'status' && event.data.state === 'input_receipt').map(event => event.data.phase);
const arm = async (text = 'ok') => {
  const pending = driver.send(text); void pending.catch(() => {});
  for (let i = 0; i < 50 && !prompts.length; i++) await Promise.resolve();
  expect(prompts).toHaveLength(1); await vi.advanceTimersByTimeAsync(1);
  expect(phases()).toEqual(['pending']); return { pending };
};
beforeEach(async () => {
  vi.useFakeTimers(); directory = mkdtempSync(join(tmpdir(), 'dd-driver-receipt-'));
  const project = join(directory, 'projects', realpathSync(directory).replace(/[^A-Za-z0-9-]/g, '-')); mkdirSync(project, { recursive: true });
  transcript = join(project, `${pinnedSessionUuid('ses_native-receipt')}.jsonl`); writeFileSync(transcript, '');
  events = []; prompts = [];
  const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {},
    onData(callback) { output = callback; }, onExit(callback) { exit = callback; }, interrupt() {} };
  const adapter = createCliAdapter('claude-code'); expect(adapter.capabilities.nativeInputReceipt).toBe(true);
  driver = new PtyCliDriver({
    agent: { id: 'claude-code', name: 'fixture', command: 'unused', args: [], protocol: 'pty-cli', cwd: directory,
      env: { CLAUDE_CONFIG_DIR: directory }, permissionMode: 'full-trust', timeout: 0, capabilities: { pause: false, resume: true }, builtin: false },
    adapter: { ...adapter, prepareInput: undefined, writeInput(_backend, prompt) { prompts.push(prompt); } },
    backend, sessionId: 'ses_native-receipt', onEvent(event) { events.push(event); }, onExit() {},
  });
  await driver.start();
});
afterEach(async () => { await driver.stop(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });

it('holds completion ahead of receipt and rechecks the final screen without another PTY redraw', async () => {
  const { pending } = await arm('中文👩‍💻\r\nsecond'); let done = false; void pending.then(() => { done = true; });
  answer(); output(screen(finalScreen)); await vi.advanceTimersByTimeAsync(4_000);
  expect(events.some(event => event.type === 'text')).toBe(true);
  expect(events.filter(event => event.type === 'completed')).toHaveLength(0); expect(done).toBe(false);
  receipt(prompts[0]!.replace(/\r\n?/g, '\n')); await vi.advanceTimersByTimeAsync(1_000); await pending;
  expect(phases()).toEqual(['pending', 'confirmed']); expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
  expect(events.findIndex(event => event.data?.phase === 'confirmed')).toBeLessThan(events.findIndex(event => event.type === 'completed'));
});

it('keeps a stale ready composer open when receipt arrives before the CLI answer', async () => {
  output(screen('Claude Code v2.1.267\n❯'));
  await vi.advanceTimersByTimeAsync(250);
  const { pending } = await arm(); let done = false; void pending.then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(16_000);
  // Matches the live mock: its fresh activity has no composer redraw, while
  // the old startup prompt remains in the rendered viewport.
  output('\r\nworking'); receipt(prompts[0]!);
  await vi.advanceTimersByTimeAsync(300);
  expect(phases()).toEqual(['pending', 'confirmed']);
  expect(done).toBe(false); expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  appendFileSync(transcript, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'intermediate commentary' }] } }));
  await vi.advanceTimersByTimeAsync(300);
  expect(done).toBe(false); expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  answer(); output(screen(finalScreen)); await vi.advanceTimersByTimeAsync(1_000); await pending;
  expect(events.filter(event => ['text', 'completed'].includes(event.type)).map(event => [event.type, event.data.text]))
    .toEqual([['text', 'intermediate commentary'], ['text', 'fixture answer'], ['completed', undefined]]);
});

it.each(['', 'Interrupted · What should Claude do instead?\n'])('waits for delayed transcript output after a confirmed receipt and a final screen with old status %j', async oldStatus => {
  const { pending } = await arm(); let done = false; void pending.then(() => { done = true; });
  receipt(prompts[0]!); await vi.advanceTimersByTimeAsync(350);
  expect(phases()).toEqual(['pending', 'confirmed']);
  output(screen(oldStatus + finalScreen)); await vi.advanceTimersByTimeAsync(1_000);
  expect(done).toBe(false); expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  appendFileSync(transcript, line({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: 'tool commentary' },
    { type: 'thinking', thinking: 'fixture reasoning' },
    { type: 'tool_use', id: 'fixture-call', name: 'fixture', input: {} },
  ] } }));
  appendFileSync(transcript, line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture-call', content: 'fixture result' }] } }));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(events.filter(event => ['thinking', 'tool_call', 'tool_result'].includes(event.type)).map(event => event.type)).toEqual(['thinking', 'tool_call', 'tool_result']);
  expect(done).toBe(false); expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  answer(); await vi.advanceTimersByTimeAsync(1_000); await pending;
  expect(events.filter(event => ['text', 'completed'].includes(event.type)).map(event => [event.type, event.data.text]))
    .toEqual([['text', 'tool commentary'], ['text', 'fixture answer'], ['completed', undefined]]);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
});

it('settles a held API error appended after the final screen without another PTY redraw', async () => {
  const { pending } = await arm(); receipt(prompts[0]!); await vi.advanceTimersByTimeAsync(350);
  output(screen(finalScreen)); await vi.advanceTimersByTimeAsync(1_000);
  expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  appendFileSync(transcript, line({ type: 'assistant', uuid: 'late-api-error', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] } }));
  await vi.advanceTimersByTimeAsync(1_000); await pending;
  expect(events.filter(event => ['error', 'completed'].includes(event.type)).map(event => event.type)).toEqual(['error', 'completed']);
  expect(events.filter(event => event.type === 'text')).toHaveLength(0);
});

it('keeps a successful transport with no receipt unknown even when the assistant and final screen have arrived', async () => {
  const { pending } = await arm(); answer(); output(screen(finalScreen));
  await vi.advanceTimersByTimeAsync(90_001);
  await expect(pending).rejects.toBeInstanceOf(DriverRecoveryError);
  expect(phases()).toEqual(['pending', 'unknown']); expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  expect((driver as unknown as { firstPromptSent: boolean }).firstPromptSent).toBe(false); expect(prompts).toHaveLength(1);
});

it.each(['interrupt', 'stop', 'exit'] as const)('cancels a pending receipt on %s without accepting late output', async action => {
  const { pending } = await arm();
  if (action === 'exit') exit(7); else await driver[action]();
  await expect(pending).rejects.toThrow();
  receipt(prompts[0]!); answer(); output(screen(finalScreen)); await vi.advanceTimersByTimeAsync(4_000);
  expect(phases()).not.toContain('confirmed'); expect(events.filter(event => event.type === 'completed')).toHaveLength(0); expect(prompts).toHaveLength(1);
});

it('does not let a late receipt from a cancelled generation release the next submission', async () => {
  const first = await arm('old'); await driver.interrupt(); await expect(first.pending).rejects.toThrow();
  prompts = []; events = [];
  const second = await arm('new');
  receipt('old'); answer(); output(screen(finalScreen)); await vi.advanceTimersByTimeAsync(4_000);
  expect(phases()).toEqual(['pending']); expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  receipt(prompts[0]!); await vi.advanceTimersByTimeAsync(1_000); await second.pending;
  expect(phases()).toEqual(['pending', 'confirmed']); expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
});

it('cancels send while a metadata reply is delayed and invalidates the stamp after that reply', async () => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const writes: [string, string][] = [];
  const persistent = { setDutydeckMetadata(key: string, value: string) { writes.push([key, value]); return key === 'first_prompt_sent' ? delayed : Promise.resolve(); } };
  const access = driver as unknown as { persistentBackend(): unknown; preparedTurnId: string; firstPromptSent: boolean };
  vi.spyOn(access, 'persistentBackend').mockReturnValue(persistent);
  access.preparedTurnId = 'native-turn';
  const { pending } = await arm(); receipt(prompts[0]!); await vi.advanceTimersByTimeAsync(350);
  expect(writes).toEqual([['first_prompt_sent', 'true']]);
  const interrupted = driver.interrupt(); await expect(pending).rejects.toThrow('Driver interrupted');
  expect(access.firstPromptSent).toBe(false); release(); await interrupted;
  expect(writes).toEqual([['first_prompt_sent', 'true'], ['turn_id', 'interrupted']]);
  expect(access.preparedTurnId).toBeUndefined();
});
