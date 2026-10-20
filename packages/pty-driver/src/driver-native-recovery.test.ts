import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import { TmuxBackend } from '@dutydeck/session-backends';
import { DriverDetachedError, type AgentConfig, type NormalizedDriverEvent } from '@dutydeck/shared';
import { PtyCliDriver } from './driver.js';
import { buildSessionMarker } from './session-id/index.js';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); vi.restoreAllMocks(); });
const line = (record: unknown) => JSON.stringify(record) + '\n';
const event = (type: string, turn: string, extra = {}) => ({ type: 'event_msg', payload: { type, turn_id: turn, ...extra } });
const user = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

it.each(['cancel', 'error', 'thinking-cancel', 'text-error', 'text-success', 'foreign', 'old'] as const)(
  'recovers Codex %s only from input and terminal after the real submission cursor', async kind => {
    const cwd = mkdtempSync(join(tmpdir(), 'dd-native-recovery-'));
    releases.push(async () => rmSync(cwd, { recursive: true, force: true }));
    const sessionId = 'ses_native-recovery-fixture', ownerId = `dutydeck:${sessionId}`;
    const nativeId = randomUUID(), nativeTurn = randomUUID();
    const day = join(cwd, 'sessions', '2026', '10', '20'); mkdirSync(day, { recursive: true });
    const path = join(day, `rollout-2026-10-20-${nativeId}.jsonl`);
    const marker = buildSessionMarker(sessionId);
    writeFileSync(path, line({ type: 'session_meta', payload: { id: nativeId, cwd, source: 'cli' } })
      + line(event('task_started', 'old-turn')) + line(user(marker + '\nold input'))
      + line(event('task_complete', 'old-turn', { last_agent_message: 'old answer', error: { message: 'old failure' } })));
    writeFileSync(join(cwd, 'history.jsonl'), line({ session_id: nativeId, text: marker + '\nold input' }));
    const metadata = new Map([['first_prompt_sent', 'true']]);
    vi.spyOn(TmuxBackend, 'probeSession').mockResolvedValue('exists');
    vi.spyOn(TmuxBackend, 'sessionOwner').mockResolvedValue(ownerId);
    vi.spyOn(TmuxBackend.prototype, 'attach').mockImplementation(async function () { this.initialScreen = { data: '›\r\n100% left', cols: 120, rows: 30 }; });
    vi.spyOn(TmuxBackend.prototype, 'getDutydeckMetadata').mockImplementation(async key => metadata.get(key));
    vi.spyOn(TmuxBackend.prototype, 'setDutydeckMetadata').mockImplementation(async (key, value) => { metadata.set(key, value); });
    vi.spyOn(TmuxBackend.prototype, 'getPid').mockResolvedValue(undefined);
    vi.spyOn(TmuxBackend.prototype, 'onData').mockImplementation(() => {});
    vi.spyOn(TmuxBackend.prototype, 'onExit').mockImplementation(() => {});
    vi.spyOn(TmuxBackend.prototype, 'detach').mockResolvedValue();
    vi.spyOn(TmuxBackend.prototype, 'kill').mockImplementation(async () => { throw new Error('must preserve original pane'); });
    const agent = { id: 'codex', name: 'fixture', command: 'unused-fixture', args: [], cwd, env: { CODEX_HOME: cwd },
      permissionMode: 'full-trust', protocol: 'pty-cli', timeout: 6, capabilities: { resume: true }, builtin: false } as AgentConfig;
    const make = (events: NormalizedDriverEvent[], submitting = false) => {
      const adapter = createCliAdapter('codex');
      if (submitting) {
        adapter.prepareInput = undefined;
        adapter.writeInput = (_backend, prompt) => {
          appendFileSync(join(cwd, 'history.jsonl'), line({ session_id: nativeId, text: prompt, ts: Date.now() / 1000 }));
          appendFileSync(path, line(event('task_started', nativeTurn)) + line(user('# AGENTS.md instructions'))
            + line(user('<environment_context>fixture</environment_context>')) + line(user(prompt))
            + line(event('item_completed', nativeTurn, { thread_id: nativeId, item: { type: 'UserMessage', content: [{ type: 'text', text: prompt }] } })));
        };
      }
      const driver = new PtyCliDriver({ agent, adapter, sessionId, backend: new TmuxBackend('native-recovery', { ownerId }),
        onEvent: e => events.push(e), onExit() {} });
      releases.push(async () => { driver.prepareForDaemonShutdown(); await driver.stop(); });
      return driver;
    };
    const original = make([], true);
    await original.start();
    const checkpoint = (await original.checkpoint())!;
    expect(checkpoint.transcript.offset).toBeGreaterThan(0); expect(checkpoint.transcript.path).toBe(path);
    const sending = original.send('new task').catch(error => error);
    await vi.waitFor(() => expect(metadata.get('turn_id')).toBe(checkpoint.turnId));
    original.prepareForDaemonShutdown(); await original.stop();
    expect(await sending).toBeInstanceOf(DriverDetachedError);
    if (kind === 'thinking-cancel') appendFileSync(path, line({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] } }));
    if (kind !== 'old') appendFileSync(path, line(event(kind.includes('cancel') ? 'turn_aborted' : 'task_complete', kind === 'foreign' ? 'foreign-turn' : nativeTurn,
      { last_agent_message: kind.startsWith('text-') ? 'visible answer' : null,
        ...(['error', 'text-error', 'foreign'].includes(kind) ? { error: { codex_error_info: 'usage_limit_exceeded', message: 'Usage exhausted' } } : {}) })));
    const events: NormalizedDriverEvent[] = [], attached = vi.fn(async () => {});
    const restored = make(events);
    let settled = false;
    const recovery = restored.recover(checkpoint, attached).then(() => { settled = true; }, error => error);
    await vi.waitFor(() => expect(attached).toHaveBeenCalledOnce());
    if (kind === 'foreign' || kind === 'old') {
      await new Promise(resolve => setTimeout(resolve, 700));
      expect(settled).toBe(false);
      expect(events.filter(e => e.type === 'error' || e.type === 'completed' || e.type === 'text')).toEqual([]);
      restored.prepareForDaemonShutdown(); await restored.stop(); await recovery;
    } else {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 4_500 });
      expect(events.filter(e => e.type === 'completed').map(e => e.data.stopReason)).toEqual([kind.includes('cancel') ? 'cancelled' : 'end_turn']);
      expect(events.filter(e => e.type === 'error').map(e => e.data.code)).toEqual(kind.includes('error') ? ['usage_limit_exceeded'] : []);
      expect(events.filter(e => e.type === 'text').map(e => e.data.text)).toEqual(kind.startsWith('text-') ? ['visible answer'] : []);
    }
  }, 12_000);
