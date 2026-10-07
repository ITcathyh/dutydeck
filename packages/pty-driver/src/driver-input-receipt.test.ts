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

it('publishes a final written 400ms after the completion check before its only completed event', async () => {
  const { pending } = await arm();
  receipt(prompts[0]!);
  appendFileSync(transcript, line({ type: 'assistant', message: { role: 'assistant', stop_reason: null,
    content: [{ type: 'text', text: 'intermediate commentary' }] } }));
  await vi.advanceTimersByTimeAsync(350);
  output(screen(finalScreen));
  await vi.advanceTimersByTimeAsync(600);
  expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  // Independent of send resolving: the real late-final reproduction waited
  // 400ms after the premature completion at roughly 500ms from this screen.
  await vi.advanceTimersByTimeAsync(300);
  answer();
  await vi.advanceTimersByTimeAsync(1_000); await pending;
  expect(events.filter(event => ['text', 'completed'].includes(event.type)).map(event => [event.type, event.data.text]))
    .toEqual([['text', 'intermediate commentary'], ['text', 'fixture answer'], ['completed', undefined]]);
});

it('bounds markerless legacy completion even with agent timeout disabled', async () => {
  const { pending } = await arm(); receipt(prompts[0]!);
  appendFileSync(transcript, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'legacy answer' }] } }));
  await vi.advanceTimersByTimeAsync(350); output(screen(finalScreen));
  await vi.advanceTimersByTimeAsync(600); expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(3_000); await pending;
  expect(events.filter(event => ['text', 'completed'].includes(event.type)).map(event => event.type)).toEqual(['text', 'completed']);
});

it('accepts a duration-only terminal as soon as it arrives after commentary', async () => {
  const { pending } = await arm(); receipt(prompts[0]!);
  appendFileSync(transcript, line({ type: 'assistant', message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'answer' }] } }));
  await vi.advanceTimersByTimeAsync(350); output(screen(finalScreen));
  await vi.advanceTimersByTimeAsync(600); expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  appendFileSync(transcript, line({ type: 'system', subtype: 'turn_duration' }));
  await vi.advanceTimersByTimeAsync(800); await pending;
  expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
});

it('does not let a stopped terminal wait complete from a late final', async () => {
  const { pending } = await arm(); receipt(prompts[0]!);
  appendFileSync(transcript, line({ type: 'assistant', message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'commentary' }] } }));
  await vi.advanceTimersByTimeAsync(350); output(screen(finalScreen)); await vi.advanceTimersByTimeAsync(600);
  await driver.stop(); await expect(pending).rejects.toThrow('Driver stopped');
  answer(); await vi.advanceTimersByTimeAsync(4_000);
  expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
});

it('preserves synthetic provider failure without the compatibility wait', async () => {
  const { pending } = await arm(); receipt(prompts[0]!);
  appendFileSync(transcript, line({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No model reply' }] } }));
  await vi.advanceTimersByTimeAsync(350); output(screen(finalScreen));
  await vi.advanceTimersByTimeAsync(600); await pending;
  expect(events.filter(event => ['text', 'error', 'completed'].includes(event.type)).map(event => event.type)).toEqual(['error', 'completed']);
});

it('holds completion ahead of receipt and rechecks the final screen without another PTY redraw', async () => {
  const { pending } = await arm('中文👩‍💻\r\nsecond'); let done = false; void pending.then(() => { done = true; });
  answer(); output(screen(finalScreen)); await vi.advanceTimersByTimeAsync(4_000);
  expect(events.some(event => event.type === 'text')).toBe(true);
  expect(events.filter(event => event.type === 'completed')).toHaveLength(0); expect(done).toBe(false);
  // The terminal predates the exact receipt, so only the bounded legacy
  // compatibility path can close this intentionally reordered dialect.
  receipt(prompts[0]!.replace(/\r\n?/g, '\n')); await vi.advanceTimersByTimeAsync(3_000); await pending;
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
  receipt(prompts[0]!); await vi.advanceTimersByTimeAsync(3_000); await second.pending;
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

// Sanitized shape from both 2026-10-02 incidents: a pasted user record,
// attachment ancestry, then Claude's native authentication_failed record.
it.each(['3cff', 'edcb'])('immediately fails the bound native paste %s without a duration record or terminal footer', async id => {
  const { pending } = await arm('sanitized incident input'); let done = false; void pending.then(() => { done = true; }, () => {});
  appendFileSync(transcript, [
    { type: 'user', uuid: 'incident-input', isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: `\n\n<pasted_content id="${id}">\n${prompts[0]}\n</pasted_content id="${id}">\n` } },
    { type: 'attachment', uuid: 'incident-attachment', parentUuid: 'incident-input', isSidechain: false },
    { type: 'assistant', uuid: 'incident-error', parentUuid: 'incident-attachment', isSidechain: false, isApiErrorMessage: true, error: 'authentication_failed',
      message: { role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } },
  ].map(line).join(''));
  await vi.advanceTimersByTimeAsync(500);
  expect(done).toBe(true); await pending;
  expect(phases()).toEqual(['pending', 'confirmed']);
  expect(events.filter(event => ['error', 'completed'].includes(event.type)).map(event => event.type)).toEqual(['error', 'completed']);
  expect(events.find(event => event.type === 'error')?.data).toMatchObject({ code: 'claude_api_authentication_failed', message: expect.stringContaining('Not logged in · Please run /login') });
  await vi.advanceTimersByTimeAsync(90_000);
  expect(phases()).not.toContain('unknown'); expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
});

it.each(['startup', 'old turn', 'different input', 'unrelated error', 'quoted text'])('does not fail the active turn from %s evidence', async kind => {
  const error = { type: 'assistant', uuid: 'unrelated-error', parentUuid: 'other-input', isApiErrorMessage: true, error: 'authentication_failed',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } };
  if (kind === 'old turn') { appendFileSync(transcript, line(error)); await vi.advanceTimersByTimeAsync(350); }
  output(screen('Claude Code v2.1.287\n❯\nNot logged in · Run /login'));
  await vi.advanceTimersByTimeAsync(250);
  const { pending } = await arm(); let done = false; void pending.then(() => { done = true; }, () => {});
  if (kind === 'different input') appendFileSync(transcript, line({ type: 'user', uuid: 'other-input', timestamp: new Date().toISOString(), message: { role: 'user', content: 'another input' } }) + line(error));
  if (kind === 'unrelated error') appendFileSync(transcript, line({ type: 'user', uuid: 'current-input', timestamp: new Date().toISOString(), message: { role: 'user', content: prompts[0] } }) + line(error));
  if (kind === 'quoted text') output(screen('❯ quote: ⎿ Not logged in · Please run /login\n✻ Cooked for 1s\n❯'));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(done).toBe(false); expect(events.filter(event => ['error', 'completed'].includes(event.type))).toHaveLength(0);
  if (kind !== 'unrelated error') {
    await vi.advanceTimersByTimeAsync(90_000); await expect(pending).rejects.toBeInstanceOf(DriverRecoveryError);
    expect(phases()).toEqual(['pending', 'unknown']);
  } else { await driver.stop(); await expect(pending).rejects.toThrow('Driver stopped'); }
});

it('keeps the native input ancestry after an empty final-screen check, then fails without another redraw', async () => {
  const { pending } = await arm(); let done = false; void pending.then(() => { done = true; }, () => {});
  appendFileSync(transcript, line({ type: 'user', uuid: 'native-input', timestamp: new Date().toISOString(), message: { role: 'user', content: prompts[0] } }));
  await vi.advanceTimersByTimeAsync(350);
  output(screen(finalScreen)); await vi.advanceTimersByTimeAsync(1_000);
  expect(done).toBe(false);
  output(screen('❯')); await vi.advanceTimersByTimeAsync(250);
  appendFileSync(transcript, line({ type: 'assistant', uuid: 'native-error', parentUuid: 'native-input', isApiErrorMessage: true, error: 'rate_limit',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] } }));
  await vi.advanceTimersByTimeAsync(500);
  expect(done).toBe(true); await pending;
  expect(events.filter(event => ['error', 'completed'].includes(event.type)).map(event => event.type)).toEqual(['error', 'completed']);
});

it('does not let delayed persistent metadata postpone a proven native failure', async () => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const persistent = { setDutydeckMetadata() { return delayed; } };
  const access = driver as unknown as { persistentBackend(): unknown; firstPromptSent: boolean };
  vi.spyOn(access, 'persistentBackend').mockReturnValue(persistent);
  const { pending } = await arm(); let done = false; void pending.then(() => { done = true; }, () => {});
  appendFileSync(transcript, line({ type: 'user', uuid: 'native-input', timestamp: new Date().toISOString(), message: { role: 'user', content: prompts[0] } }));
  await vi.advanceTimersByTimeAsync(350);
  appendFileSync(transcript, line({ type: 'assistant', uuid: 'native-error', parentUuid: 'native-input', isApiErrorMessage: true, error: 'authentication_failed',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }));
  await vi.advanceTimersByTimeAsync(500);
  try {
    expect(done).toBe(true); await pending;
    expect(phases()).toEqual(['pending', 'confirmed']); expect(access.firstPromptSent).toBe(true);
    expect(events.filter(event => ['error', 'completed'].includes(event.type)).map(event => event.type)).toEqual(['error', 'completed']);
  } finally { release(); }
});

it('keeps an unrelated error outside the input ancestry after an empty final-screen check', async () => {
  const { pending } = await arm(); let done = false; void pending.then(() => { done = true; }, () => {});
  appendFileSync(transcript, line({ type: 'user', uuid: 'native-input', timestamp: new Date().toISOString(), message: { role: 'user', content: prompts[0] } }));
  await vi.advanceTimersByTimeAsync(350);
  output(screen(finalScreen)); await vi.advanceTimersByTimeAsync(1_000);
  appendFileSync(transcript, line({ type: 'assistant', uuid: 'unrelated-error', parentUuid: 'other-input', isApiErrorMessage: true, error: 'authentication_failed',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }));
  await vi.advanceTimersByTimeAsync(4_000);
  expect(done).toBe(false); expect(events.filter(event => ['error', 'completed'].includes(event.type))).toHaveLength(0);
  await driver.stop(); await expect(pending).rejects.toThrow('Driver stopped');
});

it('does not let late old-turn text suppress the current receipt-bound API failure in the same drain', async () => {
  const { pending } = await arm(); let done = false; void pending.then(() => { done = true; }, () => {});
  appendFileSync(transcript, [
    { type: 'assistant', uuid: 'old-answer', parentUuid: 'old-input', message: { role: 'assistant', content: [{ type: 'text', text: 'old turn answer' }] } },
    { type: 'user', uuid: 'native-input', timestamp: new Date().toISOString(), message: { role: 'user', content: prompts[0] } },
    { type: 'assistant', uuid: 'native-error', parentUuid: 'native-input', isApiErrorMessage: true, error: 'authentication_failed',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } },
  ].map(line).join(''));
  await vi.advanceTimersByTimeAsync(500);
  expect(done).toBe(true); await pending;
  expect(events.filter(event => ['error', 'completed'].includes(event.type)).map(event => event.type)).toEqual(['error', 'completed']);
});

it('serializes a late old metadata stamp before the next turn stamp after native failure', async () => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const writes: string[] = [];
  const persistent = { setDutydeckMetadata(_key: string, value: string) { writes.push(value); return value === 'old-stamp' ? delayed : Promise.resolve(); } };
  const access = driver as unknown as { persistentBackend(): unknown; firstPromptSent: boolean; preparedTurnId: string };
  vi.spyOn(access, 'persistentBackend').mockReturnValue(persistent);
  access.firstPromptSent = true; access.preparedTurnId = 'old-stamp';
  const first = await arm('old'); let done = false; void first.pending.then(() => { done = true; }, () => {});
  appendFileSync(transcript, line({ type: 'user', uuid: 'old-input', timestamp: new Date().toISOString(), message: { role: 'user', content: prompts[0] } }));
  await vi.advanceTimersByTimeAsync(350); expect(writes).toEqual(['old-stamp']);
  appendFileSync(transcript, line({ type: 'assistant', uuid: 'old-error', parentUuid: 'old-input', isApiErrorMessage: true, error: 'authentication_failed',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } }));
  await vi.advanceTimersByTimeAsync(500); expect(done).toBe(true); await first.pending;
  prompts = []; events = []; access.preparedTurnId = 'new-stamp';
  const next = await arm('next'); receipt(prompts[0]!); answer(); output(screen(finalScreen));
  await vi.advanceTimersByTimeAsync(1_000);
  try { expect(writes).toEqual(['old-stamp']); } finally { release(); }
  await vi.advanceTimersByTimeAsync(1_000); await next.pending;
  expect(writes).toEqual(['old-stamp', 'new-stamp']); expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
});
