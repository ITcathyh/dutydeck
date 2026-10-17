import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { TmuxBackend, type SessionBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';

const frame = (state: string) => `\x1b]7501;state=${state}:app=claude-code\x07`;
const repaint = (text: string) => `\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`;
const idleScreen = 'Answer\n✻ Cooked for 3s\n❯\n⏵⏵ bypass permissions on';
const busyScreen = 'Thinking\n❯\n⏵⏵ bypass permissions on · esc to interrupt';
const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

describe('OSC lost-edge recovery with real Claude transcript and approval hooks', () => {
  let cwd: string, path: string, driver: PtyCliDriver, output: (data: string) => void;
  let events: NormalizedDriverEvent[], input: number;
  const completed = () => events.filter(e => e.type === 'completed');
  const append = (entry: unknown) => appendFileSync(path, JSON.stringify(entry) + '\n');
  const final = () => append({ type: 'assistant', uuid: `final-${input}`, parentUuid: `input-${input}`, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'final' }] } });
  beforeEach(async () => {
    vi.useFakeTimers(); events = []; input = 0;
    cwd = mkdtempSync(join(tmpdir(), 'dutydeck-osc-recovery-'));
    const project = join(cwd, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(project, { recursive: true });
    path = join(project, `${pinnedSessionUuid('ses_osc-recovery')}.jsonl`); writeFileSync(path, '');
    const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, onExit() {}, interrupt() {}, onData(cb) { output = cb; } };
    driver = new PtyCliDriver({
      agent: { id: 'claude-code', name: 'Claude', command: 'unused', args: [], protocol: 'pty-cli', cwd, env: { CLAUDE_CONFIG_DIR: cwd }, permissionMode: 'ask', timeout: 3600, capabilities: { pause: false, resume: false }, builtin: false },
      adapter: { ...createCliAdapter('claude-code'), prepareInput: undefined, writeInput(_backend, prompt) {
        input++;
        append({ type: 'user', uuid: `input-${input}`, timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
      } }, backend, sessionId: 'ses_osc-recovery', onEvent: e => events.push(e), onExit() {},
    });
    await driver.start(); output(frame('idle'));
  });
  afterEach(async () => { await driver?.stop(); vi.restoreAllMocks(); vi.useRealTimers(); rmSync(cwd, { recursive: true, force: true }); });
  async function send() {
    const pending = driver.send('Simple task');
    void pending.catch(() => {});
    await tick(); await vi.advanceTimersByTimeAsync(350); await tick();
    expect(events.some(e => e.type === 'status' && e.data.state === 'input_receipt' && e.data.phase === 'confirmed')).toBe(true);
    output(frame('working')); return { pending };
  }
  it('recovers a lost done after the exact current native transcript terminal arrives', async () => {
    const { pending } = await send(); output(repaint(idleScreen));
    await vi.advanceTimersByTimeAsync(60_000); expect(completed()).toHaveLength(0);
    final(); await vi.advanceTimersByTimeAsync(2_000); await tick();
    expect(completed()).toHaveLength(1); await pending;
    expect(events.some(e => e.type === 'status' && e.data.state === 'program_status_fallback')).toBe(true);
  });
  it('does not cancel native-terminal recovery when the human-wait deadline is rescheduled', async () => {
    (driver as any).agent.timeout = 1;
    const { pending } = await send();
    output(frame('blocked:kind=permission')); output(repaint(idleScreen));
    final(); await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect(completed()).toHaveLength(1); await pending;
    expect((driver as any).humanWaits.has('osc7501')).toBe(false);
  });
  it('keeps normal OSC authority when a native terminal arrives shortly before done', async () => {
    const { pending } = await send(); output(repaint(idleScreen));
    final(); await vi.advanceTimersByTimeAsync(350); await tick();
    expect(completed()).toHaveLength(0);
    expect((driver as any).idleDetector.programStatusActive()).toBe(true);
    output(frame('done')); await tick(); await pending;
    expect(completed()).toHaveLength(1);
    expect(events.some(e => e.type === 'status' && e.data.state === 'program_status_fallback')).toBe(false);
  });
  it('releases a stale permission block only after the real pending hook is adjudicated', async () => {
    const { pending } = await send();
    const request = driver.requestPermission!({ title: 'Bash' })!;
    output(frame('blocked:kind=permission')); output(repaint(busyScreen));
    await vi.advanceTimersByTimeAsync(60_000); expect(completed()).toHaveLength(0);
    await driver.resolvePermission!(request.id, true); await request.decision;
    expect((driver as any).idleDetector.programStatusActive()).toBe(false);
    expect((driver as any).humanWaits.has('osc7501')).toBe(false);
    expect(completed()).toHaveLength(0);
    final(); output(repaint(idleScreen)); await vi.advanceTimersByTimeAsync(1_000); await tick();
    expect(completed()).toHaveLength(1); await pending;
  });
  it.each(['hook', 'background'] as const)('retains authority while real %s work is pending despite a native terminal', async hold => {
    await send(); output(repaint(idleScreen));
    if (hold === 'hook') driver.requestPermission!({ title: 'Bash' });
    else vi.spyOn((driver as any).transcript, 'pendingBackgroundWork').mockReturnValue(1);
    final(); await vi.advanceTimersByTimeAsync(3_000);
    expect((driver as any).idleDetector.programStatusActive()).toBe(true);
    expect(completed()).toHaveLength(0);
  });
  it('does not use the previous receipt terminal to release a fresh working turn', async () => {
    const first = await send(); final(); output(frame('done')); await vi.advanceTimersByTimeAsync(1_000); await first.pending;
    expect(completed()).toHaveLength(1);
    await send(); output(repaint(idleScreen));
    append({ type: 'assistant', uuid: 'late-old-final', parentUuid: 'input-1', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'old answer' }] } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect((driver as any).idleDetector.programStatusActive()).toBe(true);
    expect(completed()).toHaveLength(1);
  });
  it('recognizes a new native terminal when a whole empty continuation is read in one poll', async () => {
    const { pending } = await send(); output(repaint(idleScreen));
    final(); await vi.advanceTimersByTimeAsync(350);
    expect((driver as any).transcript.hasTurnTerminal()).toBe(true);
    output(frame('working'));
    append({ type: 'assistant', uuid: 'empty-continuation', parentUuid: `final-${input}`, message: { role: 'assistant', stop_reason: null, content: [] } });
    append({ type: 'assistant', uuid: 'continuation-final', parentUuid: 'empty-continuation', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'continued final' }] } });
    await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect(completed()).toHaveLength(1); await pending;
  });
  it.each([false, true])('distinguishes a new terminal identity from an old terminal replay (replay=%s)', async replay => {
    const { pending } = await send(); output(repaint(idleScreen));
    final(); await vi.advanceTimersByTimeAsync(350); output(frame('working'));
    if (replay) final();
    else append({ type: 'assistant', uuid: 'another-final', parentUuid: `final-${input}`, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'new final' }] } });
    await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect(completed()).toHaveLength(replay ? 0 : 1);
    if (replay) expect((driver as any).idleDetector.programStatusActive()).toBe(true);
    else await pending;
  });
  it('does not recover from a final written before working but read by a later poll', async () => {
    const { pending } = await send(); output(repaint(idleScreen));
    final();
    // No timer or flush between this disk append and the newer busy frame.
    output(frame('working'));
    await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect(completed()).toHaveLength(0);
    expect((driver as any).idleDetector.programStatusActive()).toBe(true);
    append({ type: 'assistant', uuid: 'actual-new-final', parentUuid: `final-${input}`, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'new final' }] } });
    await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect(completed()).toHaveLength(1); await pending;
  });
  async function recoverWithBacklog(busy: string, history: unknown[]) {
    await driver.stop(); events = []; input = 1;
    for (const entry of history) append(entry);
    vi.spyOn(TmuxBackend, 'probeSession').mockResolvedValue('exists');
    vi.spyOn(TmuxBackend, 'sessionOwner').mockResolvedValue('dutydeck:ses_osc-recovery');
    vi.spyOn(TmuxBackend.prototype, 'getDutydeckMetadata').mockImplementation(async key => key === 'turn_id' ? 'recovered-turn' : 'true');
    vi.spyOn(TmuxBackend.prototype, 'attach').mockResolvedValue(undefined);
    vi.spyOn(TmuxBackend.prototype, 'getPid').mockResolvedValue(undefined);
    vi.spyOn(TmuxBackend.prototype, 'onData').mockImplementation(cb => { output = cb; cb(frame(busy)); });
    vi.spyOn(TmuxBackend.prototype, 'onExit').mockImplementation(() => {});
    vi.spyOn(TmuxBackend.prototype, 'kill').mockResolvedValue(undefined);
    driver = new PtyCliDriver({
      agent: (driver as any).agent, adapter: createCliAdapter('claude-code'),
      backend: new TmuxBackend('fixture-recover-osc', { ownerId: 'dutydeck:ses_osc-recovery' }),
      sessionId: 'ses_osc-recovery', onEvent: e => events.push(e), onExit() {},
    });
    const attached = vi.fn(async () => {});
    const pending = driver.recover({ kind: 'pty-jsonl-v1', turnId: 'recovered-turn', transcript: { path, offset: 0 } }, attached);
    void pending.catch(() => {});
    await tick(); await vi.advanceTimersByTimeAsync(350); await tick();
    expect(attached).toHaveBeenCalledOnce();
    expect((driver as any).idleDetector.programStatusActive()).toBe(true);
    return { pending };
  }
  it.each(['working', 'blocked:kind=permission'])('recovers a restored cursor-bound input after attach-backlog %s loses its terminal OSC', async busy => {
    const { pending } = await recoverWithBacklog(busy, [{ type: 'user', uuid: 'input-1', message: { role: 'user', content: 'Recovered task' } }]);
    output(repaint(idleScreen)); final();
    await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect(completed()).toHaveLength(1); await pending;
    expect(events.some(e => e.type === 'status' && e.data.state === 'program_status_fallback')).toBe(true);
  });
  it.each(['no-input', 'sidechain', 'foreign'] as const)('does not restore input proof from %s transcript records', async kind => {
    const history: unknown[] = kind === 'no-input' ? [] : [{ type: 'user', uuid: 'input-1', isSidechain: kind === 'sidechain', message: { role: 'user', content: 'Recovered task' } }];
    await recoverWithBacklog('working', history); output(repaint(idleScreen));
    if (kind === 'foreign') append({ type: 'user', uuid: 'foreign-input', message: { role: 'user', content: 'Another input' } });
    final(); await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect((driver as any).idleDetector.programStatusActive()).toBe(true);
    expect(completed()).toHaveLength(0);
  });
  it('does not accept a final whose partial record started before the busy disk watermark', async () => {
    const { pending } = await send(); output(repaint(idleScreen));
    const entry = JSON.stringify({ type: 'assistant', uuid: 'partial-final', parentUuid: `input-${input}`, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'partial final' }] } });
    appendFileSync(path, entry.slice(0, 40)); output(frame('working'));
    appendFileSync(path, entry.slice(40) + '\n');
    await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect(completed()).toHaveLength(0);
    append({ type: 'assistant', uuid: 'post-partial-final', parentUuid: 'partial-final', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'new final' }] } });
    await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect(completed()).toHaveLength(1); await pending;
  });
  it('does not treat an unavailable disk watermark as the beginning of the transcript', async () => {
    await send(); output(repaint(idleScreen));
    const history = readFileSync(path, 'utf8'); rmSync(path);
    output(frame('working')); writeFileSync(path, history); final();
    await vi.advanceTimersByTimeAsync(3_000); await tick();
    expect(completed()).toHaveLength(0);
    expect((driver as any).idleDetector.programStatusActive()).toBe(true);
  });
  it('a new working signal during recovery flush still vetoes completion', async () => {
    await send(); output(repaint(idleScreen)); await vi.advanceTimersByTimeAsync(100);
    let release!: () => void;
    vi.spyOn((driver as any).transcript, 'flush').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    final(); await vi.advanceTimersByTimeAsync(1_350); await tick();
    expect(release).toBeTypeOf('function');
    output(frame('working')); release(); await tick();
    expect((driver as any).idleDetector.programStatusActive()).toBe(true);
    expect(completed()).toHaveLength(0);
    append({ type: 'system', subtype: 'metadata', uuid: 'late-metadata', parentUuid: `final-${input}` });
    await vi.advanceTimersByTimeAsync(3_000);
    expect((driver as any).idleDetector.programStatusActive()).toBe(true);
    expect(completed()).toHaveLength(0);
  });
  it('keeps real long working with a busy screen open even after 24 hours', async () => {
    const { pending } = await send(); void pending.catch(() => {});
    output(repaint(busyScreen));
    for (let hour = 0; hour < 24; hour++) {
      append({ type: 'assistant', uuid: `thinking-${hour}`, parentUuid: `input-${input}`, message: { role: 'assistant', stop_reason: null, content: [{ type: 'thinking', thinking: 'still thinking' }] } });
      await vi.advanceTimersByTimeAsync(3_600_000);
    }
    expect((driver as any).idleDetector.programStatusActive()).toBe(true);
    expect(completed()).toHaveLength(0);
  });
});
