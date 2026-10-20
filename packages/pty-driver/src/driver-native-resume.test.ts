import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAdapter } from '@dutydeck/cli-adapters';
import { PtyBackend, TmuxBackend } from '@dutydeck/session-backends';
import type { AgentConfig, NormalizedDriverEvent } from '@dutydeck/shared';
import { PtyCliDriver } from './driver.js';
import { buildSessionMarker } from './session-id/marker.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const parent = '33333333-3333-4333-8333-333333333333';
const child = '44444444-4444-4444-8444-444444444444';
const parentSession = 'ses_11111111-1111-4111-8111-111111111111';
const childSession = 'ses_22222222-2222-4222-8222-222222222222';
const jsonl = (entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
const user = (session: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: buildSessionMarker(session) } });

it.each([
  { requested: parentSession, parentPresent: true, ownHistory: false, ownPrompt: false, expected: parent },
  { requested: parentSession, parentPresent: false, ownHistory: false, ownPrompt: false, expected: undefined },
  { requested: childSession, parentPresent: true, ownHistory: true, ownPrompt: false, expected: child },
  { requested: childSession, parentPresent: false, ownHistory: false, ownPrompt: true, expected: undefined },
])('public resume uses only an attributable native session: %j', async ({ requested, parentPresent, ownHistory, ownPrompt, expected }) => {
  const home = mkdtempSync(join(tmpdir(), 'driver-native-resume-')); roots.push(home);
  const sessions = join(home, 'sessions'); mkdirSync(sessions);
  const meta = (id: string) => ({ type: 'session_meta', payload: { id, cwd: home, source: 'cli' } });
  if (parentPresent) {
    const path = join(sessions, `rollout-parent-${parent}.jsonl`);
    writeFileSync(path, jsonl([meta(parent), user(parentSession)])); utimesSync(path, 1, 1);
  }
  const childPath = join(sessions, `rollout-child-${child}.jsonl`);
  writeFileSync(childPath, jsonl([meta(child), meta(parent), user(parentSession), ...(ownPrompt ? [user(childSession)] : [])])); utimesSync(childPath, 2, 2);
  if (ownHistory) writeFileSync(join(home, 'history.jsonl'), jsonl([{ session_id: child, text: buildSessionMarker(childSession) }]));
  const agent: AgentConfig = { id: 'fixture', name: 'Fixture', command: 'codex', args: [], protocol: 'pty-cli', cwd: home,
    env: { CODEX_HOME: home }, permissionMode: 'full-trust', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false };
  const events: NormalizedDriverEvent[] = [];
  const driver = new PtyCliDriver({ agent, adapter: createCodexAdapter(), backend: new PtyBackend(), sessionId: requested, onEvent: event => events.push(event), onExit() {} });
  // Exercise real public resume/adapter/cache behavior, stopping only at the process boundary.
  const respawn = vi.spyOn(driver as unknown as { respawn(args: string[]): Promise<void> }, 'respawn').mockResolvedValue();
  await driver.resume();
  expect(respawn).toHaveBeenCalledTimes(1);
  const argv = respawn.mock.calls[0]![0];
  expect(driver.getCliSessionId()).toBe(expected);
  if (expected) {
    expect(argv).toContain('resume'); expect(argv.at(-1)).toBe(expected);
  } else {
    expect(argv).not.toContain('resume'); expect(argv).not.toContain(child);
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', data: expect.objectContaining({ state: 'resume_degraded' }) }));
  }
});

it.each(['matching', 'foreign', 'filename-only', 'inherited-only'] as const)('automatic persistent startup uses marker evidence rather than %s rollout recency or filenames', async kind => {
  const home = mkdtempSync(join(tmpdir(), 'driver-native-start-')); roots.push(home);
  const sessions = join(home, 'sessions'); mkdirSync(sessions);
  const meta = (id: string) => ({ type: 'session_meta', payload: { id, cwd: home, source: 'cli' } });
  writeFileSync(join(sessions, `rollout-newest-${child}.jsonl`), jsonl([meta(child),
    ...(kind === 'inherited-only' ? [meta(parent)] : []),
    ...(kind === 'filename-only' ? [] : [user(kind === 'matching' || kind === 'inherited-only' ? childSession : parentSession)]),
  ]));
  const backend = new TmuxBackend('native-start', { ownerId: `dutydeck:${childSession}` });
  vi.spyOn(TmuxBackend, 'probeSession').mockResolvedValue('missing');
  const spawn = vi.spyOn(backend, 'spawn').mockResolvedValue();
  vi.spyOn(backend, 'getPid').mockResolvedValue(undefined);
  vi.spyOn(backend, 'onData').mockImplementation(() => {});
  vi.spyOn(backend, 'onExit').mockImplementation(() => {});
  vi.spyOn(backend, 'setDutydeckMetadata').mockResolvedValue();
  vi.spyOn(backend, 'kill').mockResolvedValue();
  const agent: AgentConfig = { id: 'fixture', name: 'Fixture', command: 'unused-fixture', args: [], protocol: 'pty-cli', cwd: home,
    env: { CODEX_HOME: home }, permissionMode: 'full-trust', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false };
  const driver = new PtyCliDriver({ agent, adapter: createCodexAdapter(), backend, sessionId: childSession, onEvent() {}, onExit() {} });
  vi.spyOn(driver, 'isStopped').mockResolvedValue(true);
  try {
    await driver.start();
    const argv = spawn.mock.calls[0]![1];
    expect(argv.includes('resume')).toBe(kind === 'matching');
    expect(driver.getCliSessionId()).toBe(kind === 'matching' ? child : undefined);
    if (kind === 'matching') expect(argv.at(-1)).toBe(child);
    else { expect(argv).not.toContain(child); expect(argv).not.toContain(parent); }
  } finally { await driver.stop(); }
});
