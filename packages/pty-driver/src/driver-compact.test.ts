import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { PromptNotWrittenError, type NormalizedDriverEvent } from '@dutydeck/shared';
import type { SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const promptId = '22222222-2222-4222-8222-222222222222';
const successFixture = readFileSync(new URL('./transcript/fixtures/claude-compact-2.1.220.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const emptyFixture = readFileSync(new URL('./transcript/fixtures/claude-compact-empty-2.1.220.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const screen = (text: string) => `\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`;
const idleScreen = '──────────\n❯\n──────────\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const busyScreen = '❯ /compact\n✻ Compacting conversation…\nesc to interrupt';
const permissionScreen = 'Permission required\nDo you want to proceed?\n❯';
const compactDraftScreen = '──────────\n❯ /compact  <optional custom summarization instructions>\n──────────\n⏵⏵ bypass permissions on (shift+tab to cycle)';
const compactDraftWithStatusScreen = '──────────\n❯ /compact  <optional custom summarization instructions>\n──────────\nContext status one\nContext status two\n⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleWithStatusScreen = (status: string) => idleScreen.replace('⏵⏵ bypass', `${status}\nContext status two\n⏵⏵ bypass`);
const maintenanceNotWrittenMessage = '上下文压缩还没结束，或无法确认终端已恢复，本条消息没有写入。请稍后重发；一直这样请发 /new 开新会话。';
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function sequence(fixture: any[], suffix = 'current') {
  const [, input, second, third] = structuredClone(fixture);
  input.parentUuid = 'leaf';
  input.uuid = `input-${suffix}`;
  input.promptId = promptId;
  input.sessionId = sessionId;
  input.timestamp = new Date().toISOString();
  if (fixture === successFixture) {
    second.logicalParentUuid = input.parentUuid;
    second.uuid = `boundary-${suffix}`;
    second.sessionId = sessionId;
    third.parentUuid = second.uuid;
    third.uuid = `summary-${suffix}`;
    third.promptId = promptId;
    third.sessionId = third.session_id = sessionId;
  } else {
    second.parentUuid = input.uuid;
    second.uuid = `command-${suffix}`;
    second.promptId = promptId;
    second.sessionId = second.session_id = sessionId;
    third.parentUuid = second.uuid;
    third.uuid = `failure-${suffix}`;
    third.sessionId = third.session_id = sessionId;
  }
  return [input, second, third];
}

describe('PTY Claude maintenance compaction', () => {
  let directory: string, transcript: string, driver: PtyCliDriver;
  let output: (data: string) => void;
  let exit: (code: number | null) => void;
  let events: NormalizedDriverEvent[], prompts: string[];
  let interrupts: number;
  let awaitingAnswer: boolean;

  beforeEach(async () => {
    vi.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), 'dd-driver-compact-'));
    const project = join(directory, 'projects', realpathSync(directory).replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(project, { recursive: true });
    transcript = join(project, `${pinnedSessionUuid('ses_compact')}.jsonl`);
    writeFileSync(transcript, line({ type: 'mode', mode: 'normal', sessionId, uuid: 'leaf', timestamp: new Date().toISOString() }));
    events = []; prompts = []; interrupts = 0; awaitingAnswer = false;
    const backend: SessionBackend = {
      kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {},
      interrupt() { interrupts++; },
      onData(callback) { output = callback; }, onExit(callback) { exit = callback; },
    };
    const adapter = createCliAdapter('claude-code');
    driver = new PtyCliDriver({
      agent: { id: 'claude-code', name: 'fixture', command: 'unused', args: [], protocol: 'pty-cli', cwd: directory,
        env: { CLAUDE_CONFIG_DIR: directory }, permissionMode: 'full-trust', timeout: 0, capabilities: { pause: false, resume: true }, builtin: false },
      adapter: { ...adapter, prepareInput: undefined, writeInput(backend, prompt) { prompts.push(prompt); return backend.write(prompt); } },
      backend, sessionId: 'ses_compact', awaitingAnswer: () => awaitingAnswer,
      timings: { maintenanceTimeoutMs: 1_000, maintenanceIdleGraceMs: 500 },
      onEvent(event) { events.push(event); }, onExit() {},
    });
    await driver.start();
    output(screen(idleScreen));
    await vi.advanceTimersByTimeAsync(250);
  });

  afterEach(async () => {
    await driver.stop();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  async function armCompact() {
    const pending = driver.compact!();
    void pending.catch(() => {});
    for (let index = 0; index < 100 && prompts.length === 0; index++) await vi.advanceTimersByTimeAsync(1);
    expect(prompts).toEqual(['/compact']);
    return { pending };
  }

  function useRealWriter(onWrite: (data: string) => void | boolean | Promise<void | boolean>) {
    const real = createCliAdapter('claude-code');
    const writes: string[] = [];
    (driver as any).adapter = { ...(driver as any).adapter,
      writeInput(backend: any, prompt: string) { prompts.push(prompt); return real.writeInput(backend, prompt); } };
    (driver as any).backend.write = (data: string) => { writes.push(data); return onWrite(data); };
    return writes;
  }

  async function advanceUntil(accept: () => boolean, limit = 5_000) {
    for (let elapsed = 0; elapsed < limit && !accept(); elapsed += 10) await vi.advanceTimersByTimeAsync(10);
    expect(accept()).toBe(true);
  }

  async function append(...entries: unknown[]) {
    appendFileSync(transcript, entries.map(line).join(''));
    await vi.advanceTimersByTimeAsync(350);
  }

  async function succeedCompact(suffix = 'current') {
    await append(...sequence(successFixture, suffix));
  }

  async function completeBusiness(text: string) {
    const count = prompts.length;
    const pending = driver.send(text);
    void pending.catch(() => {});
    for (let index = 0; index < 100 && prompts.length === count; index++) await vi.advanceTimersByTimeAsync(1);
    expect(prompts.length).toBe(count + 1);
    const prompt = prompts.at(-1)!;
    await append(
      { type: 'user', uuid: `business-${count}`, parentUuid: 'leaf', promptId: `business-prompt-${count}`, sessionId, timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } },
      { type: 'assistant', uuid: `answer-${count}`, parentUuid: `business-${count}`, sessionId, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `answer to ${text}` }] } },
    );
    output(screen(`answer to ${text}\n✻ Cooked for 1s\n${idleScreen}`));
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
  }

  async function expectMaintenanceRejected(pending: Promise<unknown>) {
    void pending.catch(() => {});
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled, 2_000);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    await expect(pending).rejects.toThrow(maintenanceNotWrittenMessage);
  }

  async function makeUnknown() {
    const { pending } = await armCompact();
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(1_601);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect((driver as any).maintenanceUnknown).toBe(true);
    expect(prompts).toEqual(['/compact']);
  }

  it('completes from generation-bound evidence without creating a business turn, then sends normally', async () => {
    const { pending } = await armCompact();
    await succeedCompact();
    await expect(pending).resolves.toBe('completed');
    expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
    expect(prompts).toEqual(['/compact']);
    await completeBusiness('after compact');
    expect(prompts).toHaveLength(2);
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
  });

  it('emits proactive completion only at finish and preserves external boundary events', async () => {
    const { pending } = await armCompact();
    await succeedCompact('unique-finish');
    await expect(pending).resolves.toBe('completed');
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction').map(event => event.data)).toEqual([
      { state: 'compaction', phase: 'start', proactive: true, maintenanceGeneration: 1 },
      { state: 'compaction', phase: 'completed', proactive: true, maintenanceGeneration: 1 },
    ]);
    events.length = 0;
    await append(...sequence(successFixture, 'external-after-finish'));
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction').map(event => event.data)).toEqual([
      { state: 'compaction', phase: 'completed' },
    ]);
  });

  it('continues the business prompt after explicit empty-context failure', async () => {
    const { pending } = await armCompact();
    await append(...sequence(emptyFixture, 'empty'));
    await expect(pending).resolves.toBe('failed');
    expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
    await completeBusiness('after failed compact');
    expect(prompts).toHaveLength(2);
  });

  it('keeps business send and a second compact from taking ownership', async () => {
    const { pending: first } = await armCompact();
    await expect(driver.send('must wait')).rejects.toBeInstanceOf(PromptNotWrittenError);
    await expect(driver.compact!()).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(prompts).toEqual(['/compact']);
    await succeedCompact();
    await expect(first).resolves.toBe('completed');
    await completeBusiness('after ownership');
    expect(prompts).toHaveLength(2);
  });

  it('rejects raw terminal business and control writes during active maintenance', async () => {
    const { pending } = await armCompact();
    const raw: string[] = [];
    const backend = (driver as any).backend;
    const originalWrite = backend.write.bind(backend);
    backend.write = (data: string) => { raw.push(data); return originalWrite(data); };
    const terminal = driver.createTerminalStream();
    await expectMaintenanceRejected(terminal.write('manual business prompt\r'));
    await expectMaintenanceRejected(terminal.write('\x03'));
    expect(raw).toEqual([]);
    expect(interrupts).toBe(0);
    await succeedCompact('raw-input-active');
    await expect(pending).resolves.toBe('completed');
    await terminal.write('after compact\r');
    expect(raw).toEqual(['after compact\r']);
    terminal.dispose();
  });

  it('rejects raw terminal writes until unknown maintenance has recovered', async () => {
    await makeUnknown();
    const raw: string[] = [];
    const backend = (driver as any).backend;
    const originalWrite = backend.write.bind(backend);
    backend.write = (data: string) => { raw.push(data); return originalWrite(data); };
    const terminal = driver.createTerminalStream();
    const interruptCount = interrupts;
    await expectMaintenanceRejected(terminal.write('manual business prompt\r'));
    expect(raw).toEqual([]);
    expect(interrupts).toBe(interruptCount);
    output(screen(idleScreen));
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.isIdle()).toBe(true);
    await terminal.write('after recovery\r');
    expect(raw).toEqual(['after recovery\r']);
    terminal.dispose();
  });

  it('rejects resume during active and unknown maintenance before respawn', async () => {
    const { pending } = await armCompact();
    const respawn = vi.fn();
    (driver as any).respawn = respawn;
    await expect(driver.resume()).rejects.toMatchObject({ code: 'TURN_IN_PROGRESS' });
    expect(respawn).not.toHaveBeenCalled();
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(1_601);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect((driver as any).maintenanceUnknown).toBe(true);
    await expect(driver.resume()).rejects.toMatchObject({ code: 'TURN_IN_PROGRESS' });
    expect(respawn).not.toHaveBeenCalled();
    expect(prompts).toEqual(['/compact']);
  });

  it('cancels before the command is written without interrupting the terminal', async () => {
    const source = (driver as any).transcript;
    const flush = source.flush.bind(source);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(source, 'flush').mockImplementationOnce(() => gate);
    const pending = driver.compact!();
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await driver.interrupt();
    release();
    vi.spyOn(source, 'flush').mockImplementation(flush);
    await expect(pending).resolves.toBe('cancelled');
    expect(prompts).toEqual([]);
    expect(interrupts).toBe(0);
  });

  it('cancels only the maintenance wait and permits the next business submission', async () => {
    const { pending } = await armCompact();
    output(screen(busyScreen));
    await driver.interrupt();
    expect(interrupts).toBe(1);
    output(screen(idleScreen));
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe('cancelled');
    expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction' && event.data.phase === 'cancelled')).toHaveLength(1);
    await completeBusiness('after interrupt');
    expect(prompts).toHaveLength(2);
  });

  it('waits for compaction activity to clear before releasing an interrupted empty composer', async () => {
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(0);
    await driver.interrupt();
    expect(settled).toBe(false);
    output(screen(`✶ Compacting conversation…\n▱▱▱▱▱▱▱▱ 0%\n${idleScreen}`));
    await vi.advanceTimersByTimeAsync(200);
    expect((driver as any).snapshot.viewportText({ preserveStructure: true })).toContain('Compacting conversation');
    expect(settled).toBe(false);
    output(screen(idleScreen));
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toBe('cancelled');
    await completeBusiness('after compaction status cleared');
  });

  it('clears the owned compact draft only after compaction activity disappears', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    (driver as any).timings.maintenanceIdleGraceMs = 700;
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    let clears = 0;
    (driver as any).backend.write = (data: string) => {
      if (data === '\x15') { clears++; output(screen(idleScreen)); }
    };
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(0);
    await driver.interrupt();
    output(screen('✶ Compacting conversation…\n▱▱▱▱▱▱▱▱ 0%\n──────────\n❯ /compact  <optional custom summarization instructions>\n──────────\n⏵⏵ bypass permissions on (shift+tab to cycle)\n\n\n'));
    await vi.advanceTimersByTimeAsync(600);
    expect((driver as any).snapshot.viewportText({ preserveStructure: true })).toContain('❯ /compact');
    expect(clears).toBe(0);
    expect(settled).toBe(false);
    output(screen(compactDraftScreen));
    await advanceUntil(() => settled, 3_000);
    await expect(pending).resolves.toBe('cancelled');
    expect(clears).toBe(1);
    expect(interrupts).toBe(1);
    await completeBusiness('after draft cleanup');
    expect(prompts).toHaveLength(2);
  });

  it('does not clear a different composer draft during maintenance recovery', async () => {
    const { pending } = await armCompact();
    let clears = 0;
    (driver as any).backend.write = (data: string) => { if (data === '\x15') clears++; };
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(0);
    await driver.interrupt();
    output(screen('❯ /compact  <optional custom summarization instructions>\nCompacted old history\n──────────\n❯ /clear\n──────────\n⏵⏵ bypass permissions on (shift+tab to cycle)'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_600);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(clears).toBe(0);
  });

  it('uses only composer recovery after cancellation, not pre-write background or approval gates', async () => {
    const { pending } = await armCompact();
    output(screen(busyScreen));
    const source = (driver as any).transcript;
    source.pendingBackgroundWork = () => 1;
    (driver as any).hookPermissions.set('late-hook', () => {});
    awaitingAnswer = true;
    (driver as any).humanWaits.add('late-human');
    await driver.interrupt();
    output(screen(`✻ Waiting for 1 background agent to finish\n${idleScreen}`));
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe('cancelled');
    expect(prompts).toEqual(['/compact']);
  });

  it('times out by interrupting compaction and returns failed only after the composer is ready', async () => {
    const { pending } = await armCompact();
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(interrupts).toBe(1);
    output(screen(idleScreen));
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe('failed');
    await completeBusiness('after timeout');
    expect(prompts).toHaveLength(2);
  });

  it('revokes the real writer final Enter when timeout happens during paste settling', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 1_000;
    (driver as any).timings.maintenanceIdleGraceMs = 5_000;
    const paste = deferred();
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) {
        output(screen(compactDraftScreen));
        return paste.promise;
      }
      if (data === '\x15') output(screen(idleScreen));
    });
    const { pending } = await armCompact();
    await advanceUntil(() => writes.some(data => data.includes('/compact')));
    await advanceUntil(() => interrupts === 1, 2_000);
    paste.resolve();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled || writes.includes('\r'), 7_000);
    expect(writes).not.toContain('\r');
    await expect(pending).resolves.toBe('failed');
  });

  it('keeps the business prompt unsubmitted and maintenance owned when recovery is unknown', async () => {
    const { pending } = await armCompact();
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(1_601);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    await expectMaintenanceRejected(driver.send('not submitted'));
    await expectMaintenanceRejected(driver.compact!());
    expect(prompts).toEqual(['/compact']);
    expect(events.filter(event => event.type === 'completed')).toHaveLength(0);
  });

  it.each(['background', 'hook', 'answer', 'human'] as const)('rechecks %s after flushing before any command write', async kind => {
    const source = (driver as any).transcript;
    const flush = source.flush.bind(source);
    vi.spyOn(source, 'flush').mockImplementationOnce(async () => {
      await flush();
      if (kind === 'background') source.pendingBackgroundWork = () => 1;
      if (kind === 'hook') (driver as any).hookPermissions.set('hook', () => {});
      if (kind === 'answer') awaitingAnswer = true;
      if (kind === 'human') (driver as any).humanWaits.add('human');
    });
    await expect(driver.compact!()).resolves.toBe('failed');
    expect(prompts).toEqual([]);
  });

  it('rechecks manual waiting after arming and immediately before the final write', async () => {
    const source = (driver as any).transcript;
    const wait = source.waitForCompaction?.bind(source);
    expect(wait).toBeTypeOf('function');
    vi.spyOn(source, 'waitForCompaction').mockImplementationOnce((request: unknown) => {
      (driver as any).humanWaits.add('human');
      return wait(request);
    });
    await expect(driver.compact!()).resolves.toBe('failed');
    expect(prompts).toEqual([]);
  });

  it('does not Ctrl-C when the first guarded key fails before any backend write', async () => {
    const real = createCliAdapter('claude-code');
    const writes: string[] = [];
    (driver as any).backend.write = (data: string) => { writes.push(data); };
    (driver as any).adapter = { ...(driver as any).adapter,
      writeInput(backend: any, prompt: string) {
        prompts.push(prompt);
        (driver as any).humanWaits.add('late-human');
        output(screen(permissionScreen));
        return real.writeInput(backend, prompt);
      } };
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(writes).toEqual([]);
    expect(interrupts).toBe(0);
  });

  it.each(['background', 'hook', 'answer', 'human'] as const)('rechecks %s with the real writer between paste and final Enter', async kind => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    const source = (driver as any).transcript;
    let clears = 0;
    const write = (data: string) => {
      if (data.includes('/compact')) {
        output(screen(compactDraftScreen));
        if (kind === 'background') source.pendingBackgroundWork = () => 1;
        if (kind === 'hook') (driver as any).hookPermissions.set('late-hook', () => {});
        if (kind === 'answer') awaitingAnswer = true;
        if (kind === 'human') (driver as any).humanWaits.add('late-human');
      }
      if (data === '\x15') { clears++; output(screen(idleScreen)); }
    };
    const writes = useRealWriter(write);
    if (kind === 'human') {
      (driver as any).backend.sendText = (data: string) => { writes.push(data); write(data); };
      (driver as any).backend.sendSpecialKeys = (...keys: string[]) => { writes.push(...keys); };
    }
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled || writes.includes('\r') || writes.includes('Enter'));
    expect(writes).not.toContain('\r');
    expect(writes).not.toContain('Enter');
    await expect(pending).resolves.toBe('failed');
    expect(clears).toBe(1);
  });

  it('requires the current complete owned composer before the real final Enter', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    let clears = 0;
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) output(screen('──────────\n❯ /clear\n──────────\n⏵⏵ bypass permissions on (shift+tab to cycle)'));
      if (data === '\x15') clears++;
    });
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled || writes.includes('\r'));
    expect(writes).not.toContain('\r');
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(clears).toBe(0);
  });

  it('blocks the real final Enter while compaction activity is above the owned composer', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    let clears = 0;
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) output(screen(`✻ Compacting conversation…\n${compactDraftScreen}`));
      if (data === '\x15') { clears++; output(screen(idleScreen)); }
    });
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled || writes.includes('\r'));
    expect(writes).not.toContain('\r');
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(clears).toBe(0);
  });

  it('blocks final Enter and cleanup when activity and esc precede a two-status composer', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    let clears = 0;
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) output(screen(`✻ Compacting conversation…\nesc to interrupt\n${compactDraftWithStatusScreen}`));
      if (data === '\x15') { clears++; output(screen(idleScreen)); }
    });
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled || writes.includes('\r'));
    expect(writes).not.toContain('\r');
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(clears).toBe(0);
  });

  it('allows the owned composer after an earlier compaction reached completion', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) output(screen(`✻ Compacting conversation…\nesc to interrupt\n✻ Cooked for 1s\n${compactDraftWithStatusScreen}`));
      if (data === '\r') output(screen(idleScreen));
    });
    const { pending } = await armCompact();
    await advanceUntil(() => writes.includes('\r'));
    await succeedCompact('completed-history');
    await expect(pending).resolves.toBe('completed');
  });

  it('blocks final Enter and cleanup when only the composer status displays completion', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    let clears = 0;
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) output(screen(`✻ Compacting conversation…\nesc to interrupt\n${compactDraftWithStatusScreen.replace('Context status one', '✻ Cooked for 1s')}`));
      if (data === '\x15') { clears++; output(screen(idleScreen)); }
    });
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled || writes.includes('\r'));
    expect(writes).not.toContain('\r');
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(clears).toBe(0);
    expect(writes).not.toContain('\x15');
  });

  it('allows final Enter without cleanup when only the composer status displays busy', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    let clears = 0;
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) output(screen(`✻ Compacting conversation…\nesc to interrupt\n✻ Cooked for 1s\n${compactDraftWithStatusScreen.replace('Context status one', 'esc to interrupt')}`));
      if (data === '\r') output(screen(idleScreen));
      if (data === '\x15') clears++;
    });
    const { pending } = await armCompact();
    await advanceUntil(() => writes.includes('\r'));
    expect(writes).not.toContain('\x15');
    expect(clears).toBe(0);
    await succeedCompact('display-only-busy');
    await expect(pending).resolves.toBe('completed');
    expect(writes).not.toContain('\x15');
  });

  it('does not let display-only completion release an interrupted empty composer during activity', async () => {
    const writes: string[] = [];
    (driver as any).backend.write = (data: string) => { writes.push(data); };
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(0);
    await driver.interrupt();
    output(screen(`✶ Compacting conversation…\n▱▱▱▱▱▱▱▱ 0%\n${idleWithStatusScreen('✻ Cooked for 1s')}`));
    await vi.advanceTimersByTimeAsync(200);
    expect((driver as any).snapshot.viewportText({ preserveStructure: true })).toContain('Compacting conversation');
    expect(settled).toBe(false);
    expect(writes).not.toContain('\r');
    expect(writes).not.toContain('\x15');
    output(screen(idleWithStatusScreen('✻ Cooked for 1s')));
    await advanceUntil(() => settled);
    await expect(pending).resolves.toBe('cancelled');
    expect(writes).not.toContain('\r');
    expect(writes).not.toContain('\x15');
  });

  it('releases an interrupted empty composer after real completion despite display-only busy', async () => {
    const writes: string[] = [];
    (driver as any).backend.write = (data: string) => { writes.push(data); };
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(0);
    await driver.interrupt();
    output(screen(`✻ Compacting conversation…\nesc to interrupt\n✻ Cooked for 1s\n${idleWithStatusScreen('esc to interrupt')}`));
    await advanceUntil(() => settled);
    await expect(pending).resolves.toBe('cancelled');
    expect(writes).not.toContain('\r');
    expect(writes).not.toContain('\x15');
  });

  it('accepts the real compact command palette below the current owned composer', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    const paste = deferred();
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) {
        output(screen('──────────\n❯ /compact\n──────────\n/compact  Free up context by summarizing the conversation so far\n/other-command  Placeholder command description'));
        return paste.promise;
      }
      if (data === '\r') output(screen(idleScreen));
    });
    const { pending } = await armCompact();
    await advanceUntil(() => writes.some(data => data.includes('/compact')));
    await vi.advanceTimersByTimeAsync(0);
    expect((driver as any).maintenanceComposerIsOwned((driver as any).maintenanceActive)).toBe(true);
    paste.resolve();
    await advanceUntil(() => writes.includes('\r'));
    await succeedCompact('command-palette');
    await expect(pending).resolves.toBe('completed');
  });

  it('does not turn an unwritable pre-write terminal into continuation-enabling failure', async () => {
    const source = (driver as any).transcript;
    const flush = source.flush.bind(source);
    vi.spyOn(source, 'flush').mockImplementationOnce(async () => {
      await flush();
      output(screen(busyScreen));
      await vi.advanceTimersByTimeAsync(0);
    });
    const pending = driver.compact!();
    void pending.catch(() => {});
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled, 2_000);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect((driver as any).maintenanceUnknown).toBe(true);
    expect(prompts).toEqual([]);
    await expectMaintenanceRejected(driver.send('must not be written'));
    let clears = 0;
    (driver as any).backend.write = (data: string) => { if (data === '\x15') clears++; };
    output(screen(compactDraftScreen));
    await expectMaintenanceRejected(driver.send('an unowned compact draft is not cleanup authority'));
    expect(clears).toBe(0);
    expect(prompts).toEqual([]);
  });

  it('shares and awaits the in-flight backend interrupt before releasing maintenance', async () => {
    const { pending } = await armCompact();
    const interrupted = deferred();
    (driver as any).backend.interrupt = () => { interrupts++; return interrupted.promise; };
    output(screen(busyScreen));
    const interrupting = driver.interrupt();
    await vi.advanceTimersByTimeAsync(0);
    output(screen(idleScreen));
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(600);
    expect(settled).toBe(false);
    interrupted.resolve();
    await interrupting;
    await expect(pending).resolves.toBe('cancelled');
  });

  it('settles compact and interrupt without timers when the process exits with a backend interrupt pending', async () => {
    const { pending } = await armCompact();
    expect((driver as any).maintenanceActive.terminalWriteAttempted).toBe(true);
    (driver as any).backend.interrupt = () => { interrupts++; return new Promise<void>(() => {}); };
    output(screen(busyScreen));
    const interrupting = driver.interrupt();
    let interruptSettled = false, compactSettled = false;
    void interrupting.then(() => { interruptSettled = true; });
    void pending.then(() => { compactSettled = true; }, () => { compactSettled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(interrupts).toBe(1);
    expect(interruptSettled).toBe(false);
    expect(compactSettled).toBe(false);
    exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(interruptSettled).toBe(true);
    expect(compactSettled).toBe(true);
    await expect(interrupting).resolves.toBeUndefined();
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
  });

  it('does not call a queued maintenance interrupt after the process exits', async () => {
    const { pending } = await armCompact();
    const maintenance = (driver as any).maintenanceActive;
    expect(maintenance.terminalWriteAttempted).toBe(true);
    const stoppedAtCall: boolean[] = [];
    (driver as any).backend.interrupt = () => { stoppedAtCall.push((driver as any).stopped); };
    const recovering = (driver as any).recoverInterruptedMaintenance(maintenance) as Promise<boolean>;
    exit(0);
    await vi.advanceTimersByTimeAsync(0);
    await expect(recovering).resolves.toBe(false);
    expect(stoppedAtCall).toEqual([]);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
  });

  it('honors cancellation during post-outcome recovery and awaits the shared interrupt', async () => {
    const { pending } = await armCompact();
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(0);
    await succeedCompact('cancel-during-recovery');
    const interrupted = deferred();
    (driver as any).backend.interrupt = () => { interrupts++; return interrupted.promise; };
    const interrupting = driver.interrupt();
    await vi.advanceTimersByTimeAsync(0);
    output(screen(idleScreen));
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(600);
    expect(settled).toBe(false);
    interrupted.resolve();
    await interrupting;
    await expect(pending).resolves.toBe('cancelled');
  });

  it('runs owned cleanup after a cancelled paste rejects the previous pending write', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    const paste = deferred();
    let clears = 0;
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) {
        output(screen(busyScreen));
        return paste.promise.then(() => { output(screen(compactDraftScreen)); });
      }
      if (data === '\x15') { clears++; output(screen(idleScreen)); }
    });
    const { pending } = await armCompact();
    await advanceUntil(() => writes.some(data => data.includes('/compact')));
    await driver.interrupt();
    paste.resolve();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled);
    await expect(pending).resolves.toBe('cancelled');
    expect(clears).toBe(1);
    expect(writes).not.toContain('\r');
  });

  it('waits for an interrupted paste to settle before accepting an empty composer', async () => {
    const paste = deferred();
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) return paste.promise;
    });
    const { pending } = await armCompact();
    await advanceUntil(() => writes.some(data => data.includes('/compact')));
    await driver.interrupt();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);
    paste.resolve();
    await advanceUntil(() => settled);
    await expect(pending).resolves.toBe('cancelled');
  });

  it('settles unsubmitted when an interrupted paste never settles within the recovery bound', async () => {
    const paste = deferred();
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) return paste.promise;
    });
    const { pending } = await armCompact();
    await advanceUntil(() => writes.some(data => data.includes('/compact')));
    await driver.interrupt();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled, 1_000);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    await expectMaintenanceRejected(driver.send('must wait for the old paste'));
    output(screen(idleScreen));
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.isIdle()).toBe(false);
    expect((driver as any).maintenanceUnknown).toBe(true);
    paste.resolve();
    await advanceUntil(() => (driver as any).maintenanceUnknownRecovery?.writesSettled === true);
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.isIdle()).toBe(true);
    expect((driver as any).maintenanceUnknown).toBe(false);
    (driver as any).adapter = { ...(driver as any).adapter, writeInput(_backend: any, prompt: string) { prompts.push(prompt); } };
    await completeBusiness('after the old paste settled');
  });

  it('revalidates the owned composer when queued cleanup reaches the backend', async () => {
    const { pending } = await armCompact();
    const maintenance = (driver as any).maintenanceActive;
    const predecessor = deferred();
    maintenance.pending = predecessor.promise;
    maintenance.cancelError = new Error('maintenance cancelled');
    let clears = 0;
    (driver as any).backend.write = (data: string) => { if (data === '\x15') clears++; };
    output(screen(compactDraftScreen));
    await vi.advanceTimersByTimeAsync(0);
    const cleanup = (driver as any).submissionBackend(maintenance, 'maintenance-cleanup').write('\x15');
    void cleanup.catch(() => {});
    output(screen('──────────\n❯ /clear\n──────────\n⏵⏵ bypass permissions on (shift+tab to cycle)'));
    await vi.advanceTimersByTimeAsync(0);
    predecessor.resolve();
    await expect(cleanup).rejects.toThrow('composer');
    expect(clears).toBe(0);
    await driver.interrupt();
    void pending.catch(() => {});
  });

  it('keeps the unknown fence when a late recovery attempt would otherwise return failed', async () => {
    const { pending } = await armCompact();
    vi.spyOn((driver as any), 'waitForMaintenanceRecovery').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const interruptedRecovery = vi.spyOn((driver as any), 'recoverInterruptedMaintenance').mockResolvedValueOnce(false);
    await succeedCompact('late-recovery');
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    interruptedRecovery.mockRestore();
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(0);
    await expectMaintenanceRejected(driver.send('still fenced'));
  });

  it('keeps maintenance unknown when observation fails after the real final Enter on an idle screen', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    const observation = deferred();
    const source = (driver as any).transcript;
    vi.spyOn(source, 'waitForCompaction').mockImplementationOnce(() => observation.promise);
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) output(screen(compactDraftScreen));
      if (data === '\r') {
        output(screen(idleScreen));
        queueMicrotask(() => observation.reject(new Error('transcript observation stopped')));
      }
    });
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled);
    expect(writes).toContain('\r');
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(0);
    await expectMaintenanceRejected(driver.send('must remain unsubmitted'));
    expect(prompts).toEqual(['/compact']);
    output(screen(idleScreen));
    (driver as any).adapter = { ...(driver as any).adapter, writeInput(_backend: any, prompt: string) { prompts.push(prompt); } };
    await completeBusiness('after observation failure and terminal recovery');
  });

  it('can return explicit failure when writing fails before the final Enter and the owned draft is cleared', async () => {
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    const paste = deferred();
    let clears = 0;
    const writes = useRealWriter(data => {
      if (data.includes('/compact')) {
        output(screen(compactDraftScreen));
        return paste.promise;
      }
      if (data === '\x15') { clears++; output(screen(idleScreen)); }
    });
    const { pending } = await armCompact();
    await advanceUntil(() => writes.some(data => data.includes('/compact')));
    await vi.advanceTimersByTimeAsync(0);
    paste.reject(new Error('paste failed before Enter'));
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => settled);
    await expect(pending).resolves.toBe('failed');
    expect(writes).not.toContain('\r');
    expect(clears).toBe(1);
  });

  it('fences a business send already starting and refreshes maintenance ownership after start', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (driver as any).started = false;
    vi.spyOn(driver, 'start').mockImplementation(async () => {
      await gate;
      (driver as any).started = true;
      (driver as any).wiringGeneration++;
    });
    const sending = driver.send('racing business prompt');
    void sending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const compacting = driver.compact!();
    void compacting.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    release();
    for (let index = 0; index < 100 && prompts.length === 0; index++) await vi.advanceTimersByTimeAsync(1);
    await expect(sending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(prompts).toEqual(['/compact']);
    await succeedCompact('after-start');
    await expect(compacting).resolves.toBe('completed');
  });

  it('settles an armed observer as unknown when the process exits before the command write', async () => {
    const source = (driver as any).transcript;
    const wait = source.waitForCompaction?.bind(source);
    expect(wait).toBeTypeOf('function');
    vi.spyOn(source, 'waitForCompaction').mockImplementationOnce((request: unknown) => {
      const observation = wait(request);
      exit(0);
      return observation;
    });
    const pending = driver.compact!();
    void pending.catch(() => {});
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect((driver as any).maintenanceUnknown).toBe(true);
    expect(prompts).toEqual([]);
    expect(interrupts).toBe(0);
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction' && event.data?.proactive === true && event.data.phase === 'completed')).toEqual([]);
  });

  it('settles post-observation recovery as unknown when the process exits', async () => {
    const recovering = vi.spyOn(driver as any, 'recoverCompletedMaintenance');
    const { pending } = await armCompact();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    output(screen(busyScreen));
    await succeedCompact('exit-during-recovery');
    expect(recovering).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect((driver as any).maintenanceUnknown).toBe(true);
    expect(prompts).toEqual(['/compact']);
    expect(interrupts).toBe(0);
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction' && event.data?.proactive === true && event.data.phase === 'completed')).toEqual([]);
  });

  it.each(['unsettled', 'settled'] as const)('preserves unknown without a recovery grace after stop (%s writes)', async writes => {
    const { pending } = await armCompact();
    output(screen(busyScreen));
    const maintenance = (driver as any).maintenanceActive;
    maintenance.pending = writes === 'unsettled' ? new Promise(() => {}) : Promise.resolve();
    maintenance.writesSettled = false;
    const stopping = driver.stop();
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect((driver as any).maintenanceUnknown).toBe(true);
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction' && event.data.phase === 'cancelled')).toEqual([]);
    await stopping;
  });

  it('refreshes this maintenance when a cancelled first start later succeeds', async () => {
    const gate = deferred();
    (driver as any).started = false;
    vi.spyOn(driver, 'start').mockImplementation(async () => {
      await gate.promise;
      output(screen(idleScreen));
      await (driver as any).snapshot.writeAndFlush('');
      (driver as any).wiringGeneration++;
      (driver as any).started = true;
    });
    const pending = driver.compact!();
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(0);
    await driver.interrupt();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe('cancelled');
    expect(prompts).toEqual([]);
    expect(interrupts).toBe(0);
    await completeBusiness('after reattach start cancellation');
    expect(prompts).toHaveLength(1);
  });

  it('refreshes unknown recovery when a cancelled first start later succeeds', async () => {
    const gate = deferred();
    (driver as any).started = false;
    vi.spyOn(driver, 'start').mockImplementation(async () => {
      await gate.promise;
      output(screen(idleScreen));
      await (driver as any).snapshot.writeAndFlush('');
      (driver as any).wiringGeneration++;
      (driver as any).started = true;
    });
    const pending = driver.compact!();
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    output(screen(busyScreen));
    await vi.advanceTimersByTimeAsync(0);
    await driver.interrupt();
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect((driver as any).maintenanceUnknown).toBe(true);
    expect((driver as any).maintenanceActive).toBeUndefined();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect((driver as any).maintenanceUnknownRecovery.wiringGeneration).toBe(1);
    await completeBusiness('after late start unknown recovery');
    expect((driver as any).maintenanceUnknown).toBe(false);
    expect(driver.isIdle()).toBe(true);
    const compacting = driver.compact!();
    void compacting.catch(() => {});
    await advanceUntil(() => prompts.length === 2);
    await succeedCompact('after-late-start-unknown');
    await expect(compacting).resolves.toBe('completed');
  });

  it('rechecks an unknown terminal and completes the next business prompt after recovery', async () => {
    await makeUnknown();
    output(screen(idleScreen));
    await completeBusiness('after unknown terminal recovery');
    expect((driver as any).maintenanceUnknown).toBe(false);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe('/compact');
    expect(prompts[1]).toContain('after unknown terminal recovery');
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
  });

  it('rejects in Chinese while real activity remains, then recovers without another interrupt', async () => {
    await makeUnknown();
    const interruptCount = interrupts;
    output(screen(`✶ Compacting conversation…\n▱▱▱▱▱▱▱▱ 0%\n${idleWithStatusScreen('✻ Cooked for 1s')}`));
    await expectMaintenanceRejected(driver.send('still compacting'));
    expect((driver as any).maintenanceUnknown).toBe(true);
    expect(prompts).toEqual(['/compact']);
    expect(interrupts).toBe(interruptCount);
    output(screen(`✻ Compacting conversation…\nesc to interrupt\n✻ Cooked for 1s\n${idleWithStatusScreen('esc to interrupt')}`));
    await completeBusiness('after real completion despite display-only busy');
    expect(interrupts).toBe(interruptCount);
  });

  it('resets unknown from synchronous isIdle only for an actually empty composer', async () => {
    await makeUnknown();
    const writes: string[] = [];
    (driver as any).backend.write = (data: string) => { writes.push(data); };
    output(screen(compactDraftScreen));
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.isIdle()).toBe(false);
    expect((driver as any).maintenanceUnknown).toBe(true);
    expect(prompts).toEqual(['/compact']);
    output(screen(idleScreen));
    await vi.advanceTimersByTimeAsync(0);
    expect(driver.isIdle()).toBe(true);
    expect((driver as any).maintenanceUnknown).toBe(false);
    expect(prompts).toEqual(['/compact']);
    expect(writes).toEqual([]);
  });

  it('cleans only the current owned compact draft before recovering a business send', async () => {
    await makeUnknown();
    const interruptCount = interrupts;
    let clears = 0;
    (driver as any).backend.write = (data: string) => {
      if (data === '\x15') { clears++; output(screen(idleScreen)); }
    };
    output(screen(compactDraftScreen));
    await completeBusiness('after owned unknown draft cleanup');
    expect(clears).toBe(1);
    expect(interrupts).toBe(interruptCount);
    expect((driver as any).maintenanceUnknown).toBe(false);
  });

  it.each([
    ['current clear', '──────────\n❯ /clear\n──────────\n⏵⏵ bypass permissions on (shift+tab to cycle)'],
    ['unrelated draft', '──────────\n❯ do not erase this\n──────────\n⏵⏵ bypass permissions on (shift+tab to cycle)'],
    ['historical compact above clear', '❯ /compact  <optional custom summarization instructions>\nCompacted old history\n──────────\n❯ /clear\n──────────\n⏵⏵ bypass permissions on (shift+tab to cycle)'],
  ])('does not erase or release a %s composer after unknown', async (_kind, currentScreen) => {
    await makeUnknown();
    let clears = 0;
    (driver as any).backend.write = (data: string) => { if (data === '\x15') clears++; };
    output(screen(currentScreen));
    await expectMaintenanceRejected(driver.send('must not replace a foreign draft'));
    expect(clears).toBe(0);
    expect((driver as any).maintenanceUnknown).toBe(true);
    expect(prompts).toEqual(['/compact']);
  });

  it('does not adopt a previous generation input first observed after rearming', async () => {
    await makeUnknown();
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    output(screen(idleScreen));
    const second = driver.compact!();
    void second.catch(() => {});
    let settled = false;
    void second.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => prompts.length === 2);
    const late = sequence(successFixture, 'unobserved-old-input');
    late[0].promptId = late[2].promptId = 'unobserved-old-prompt';
    await append(...late);
    expect(settled).toBe(false);
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction'
      && event.data.maintenanceGeneration === 2 && event.data.phase === 'completed')).toEqual([]);
    await append(...sequence(successFixture, 'actual-new-input'));
    await advanceUntil(() => settled);
    await expect(second).resolves.toBe('completed');
  });

  it('starts a new compact generation after recovery without adopting late old evidence', async () => {
    await makeUnknown();
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    output(screen(idleScreen));
    const second = driver.compact!();
    void second.catch(() => {});
    let settled = false;
    void second.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => prompts.length === 2);
    const late = sequence(successFixture, 'late-old');
    const current = sequence(successFixture, 'independent-new-generation');
    current[0].promptId = 'new-generation-prompt-id';
    current[2].promptId = 'new-generation-prompt-id';
    await append(current[0]);
    await append(late[1], late[2]);
    expect(settled).toBe(false);
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction'
      && event.data.maintenanceGeneration === 1 && ['completed', 'failed', 'cancelled'].includes(String(event.data.phase)))).toEqual([]);
    await append(current[1], current[2]);
    await advanceUntil(() => settled);
    await expect(second).resolves.toBe('completed');
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction'
      && event.data.maintenanceGeneration === 2 && event.data.phase === 'completed')).toHaveLength(1);
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction'
      && event.data.maintenanceGeneration === 1 && ['completed', 'failed', 'cancelled'].includes(String(event.data.phase)))).toEqual([]);
  });

  it('keeps the new boundary valid when old boundary and summary arrive after it', async () => {
    await makeUnknown();
    (driver as any).timings.maintenanceTimeoutMs = 10_000;
    output(screen(idleScreen));
    const second = driver.compact!();
    void second.catch(() => {});
    let settled = false;
    void second.then(() => { settled = true; }, () => { settled = true; });
    await advanceUntil(() => prompts.length === 2);
    const late = sequence(successFixture, 'late-old-after-new-boundary');
    const current = sequence(successFixture, 'new-boundary-before-old-boundary');
    current[0].promptId = 'new-boundary-prompt-id';
    current[2].promptId = 'new-boundary-prompt-id';
    await append(current[0], current[1]);
    await append(late[1], late[2]);
    expect(settled).toBe(false);
    await append(current[2]);
    expect(settled).toBe(true);
    await expect(second).resolves.toBe('completed');
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction'
      && event.data.maintenanceGeneration === 2 && event.data.phase === 'completed')).toHaveLength(1);
    expect(events.filter(event => event.type === 'status' && event.data?.state === 'compaction'
      && event.data.maintenanceGeneration === 1 && ['completed', 'failed', 'cancelled'].includes(String(event.data.phase)))).toEqual([]);
  });

  it('does not release unknown after backend wiring ownership changes', async () => {
    await makeUnknown();
    output(screen(idleScreen));
    (driver as any).wiringGeneration++;
    await expectMaintenanceRejected(driver.send('must not cross wiring ownership'));
    expect((driver as any).maintenanceUnknown).toBe(true);
    expect(prompts).toEqual(['/compact']);
  });

  it('leaves other CLI families unsupported without writing a slash command', async () => {
    (driver as any).adapter = { ...(driver as any).adapter, id: 'untested-cli' };
    await expect(driver.compact!()).resolves.toBe('unsupported');
    expect(prompts).toEqual([]);
  });
});
