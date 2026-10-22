import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, DriverTranscriptSourceObservation, InsightClient } from '@dutydeck/shared';
import { pinnedSessionUuid, type CliAdapter } from '@dutydeck/cli-adapters';
import { PtyBackend, TmuxBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from './driver.js';
import { claudeProjectDir, codexHome, traeHome } from './cli-paths.js';
import { buildSessionMarker } from './session-id/index.js';
import * as transcriptSource from './transcript-source.js';
import {
  TranscriptSourceTracker,
  freezeTranscriptSource,
  transcriptClientForAdapter,
  verifyLaunchedTranscript,
  verifyLaunchedTranscriptAsync,
} from './transcript-source.js';

const repaint = (text: string) => `\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`;
const idleFooter = '⏵⏵ bypass permissions on (shift to cycle) · ↓ for agents';

function readJsonLines<T>(path: string): T[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

interface SpawnedEnv { HOME?: string; CODEX_HOME?: string; TRAE_HOME?: string }

/** A real node CLI that records the env it was spawned with, then idles. */
function writeIdleScript(cwd: string): { script: string; envLog: string } {
  const envLog = join(cwd, 'spawned-env.jsonl');
  const script = join(cwd, 'cli.mjs');
  writeFileSync(script, `import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(envLog)}, JSON.stringify({HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, TRAE_HOME: process.env.TRAE_HOME}) + '\\n');
setInterval(() => {}, 1000);`);
  return { script, envLog };
}

function makeAdapter(id: string, script: string): CliAdapter {
  return {
    id: id as CliAdapter['id'],
    capabilities: { resume: true },
    buildArgs: () => [script],
    buildResumeCommand: () => ['--resume', 'x'],
    writeInput() {},
  } as unknown as CliAdapter;
}

function makeAgent(cwd: string, command: string, env: Record<string, string>): AgentConfig {
  return {
    id: 'fixture', name: 'Fixture', command, args: [], protocol: 'pty-cli', cwd, env,
    permissionMode: 'ask', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false,
  };
}

describe('freezeTranscriptSource / client identification', () => {
  it.each([
    ['codex', 'codex'], ['claude-code', 'claude'], ['seed', 'claude'], ['relay', 'claude'],
    ['traex', 'traex'], ['grok', undefined], ['gemini', undefined], ['opencode', undefined],
  ] as Array<[string, InsightClient | undefined]>)('maps adapter %s to client %j', (adapterId, client) => {
    expect(transcriptClientForAdapter(adapterId)).toBe(client);
  });

  it('freezes only env-derived non-secret path roots, per client', () => {
    const env = { HOME: '/home/daemon', CODEX_HOME: '/isolated/codex', TRAE_HOME: '/isolated/trae', CLAUDE_CONFIG_DIR: '/isolated/claude' };
    expect(freezeTranscriptSource('codex', env)).toEqual({ client: 'codex', dataRoot: '/isolated/codex' });
    expect(freezeTranscriptSource('traex', env)).toEqual({ client: 'traex', dataRoot: '/isolated/trae' });
    expect(freezeTranscriptSource('claude-code', env)).toEqual({ client: 'claude', dataRoot: '/isolated/claude' });
    // HOME-relative fallback, no override: the child HOME, not the resolver's.
    const homeOnly = { HOME: '/home/child' };
    expect(freezeTranscriptSource('codex', homeOnly)?.dataRoot).toBe(codexHome(homeOnly));
    expect(freezeTranscriptSource('traex', homeOnly)?.dataRoot).toBe(traeHome(homeOnly));
    expect(freezeTranscriptSource('claude-code', homeOnly)?.dataRoot).toBe('/home/child/.claude');
    expect(freezeTranscriptSource('gemini', env)).toBeUndefined();
  });
});

describe('PTY launch observations at the real spawn boundary', () => {
  let cwd: string;

  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'dd-insight-pty-')); });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('publishes launch_observed/created at start with the exact final HOME/override the child received', async () => {
    const { script, envLog } = writeIdleScript(cwd);
    const codexRoot = join(cwd, 'codex-root');
    const childHome = join(cwd, 'home-a');
    const env = { CODEX_HOME: codexRoot, HOME: childHome };
    const observations: DriverTranscriptSourceObservation[] = [];
    const driver = new PtyCliDriver({
      agent: makeAgent(cwd, process.execPath, env),
      adapter: makeAdapter('codex', script),
      backend: new PtyBackend(),
      onEvent() {}, onExit() {},
      sessionId: 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    driver.subscribeTranscriptSource(o => observations.push(o));
    await driver.start();
    await expect.poll(() => readJsonLines<SpawnedEnv>(envLog)).toHaveLength(1);
    const spawned = readJsonLines<SpawnedEnv>(envLog)[0]!;
    // The real child received exactly what the observation froze.
    expect(spawned.HOME).toBe(childHome);
    expect(spawned.CODEX_HOME).toBe(codexRoot);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      client: 'codex', launchKind: 'created', proofKind: 'launch_observed',
      dataRoot: codexRoot, cwd, nativeSessionId: null, verifiedPath: null, identityProof: null,
    });
    expect(Object.isFrozen(observations[0])).toBe(true);
    await driver.stop();
  });

  it('appends a new launch observation on every real respawn, frozen at each spawn env', async () => {
    const { script, envLog } = writeIdleScript(cwd);
    const env = { CODEX_HOME: join(cwd, 'codex-root'), HOME: join(cwd, 'home-a') };
    const observations: DriverTranscriptSourceObservation[] = [];
    const driver = new PtyCliDriver({
      agent: makeAgent(cwd, process.execPath, env),
      adapter: makeAdapter('codex', script),
      backend: new PtyBackend(),
      onEvent() {}, onExit() {},
      sessionId: 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    driver.subscribeTranscriptSource(o => observations.push(o));
    await driver.start();
    await expect.poll(() => readJsonLines<SpawnedEnv>(envLog)).toHaveLength(1);
    // A CLI-level resume kills and re-spawns the process through respawn().
    await driver.resume();
    await expect.poll(() => readJsonLines<SpawnedEnv>(envLog)).toHaveLength(2);
    expect(readJsonLines<SpawnedEnv>(envLog).map(e => e.CODEX_HOME)).toEqual([env.CODEX_HOME, env.CODEX_HOME]);
    expect(observations).toHaveLength(2);
    for (const o of observations) {
      expect(o).toMatchObject({ launchKind: 'created', proofKind: 'launch_observed', dataRoot: env.CODEX_HOME });
    }
    expect(observations[0]!.observationId).not.toBe(observations[1]!.observationId);
    await driver.stop();
  });

  it('does not change the frozen old root when the daemon HOME moves after start', async () => {
    const { script } = writeIdleScript(cwd);
    const homeA = join(cwd, 'home-a');
    vi.stubEnv('HOME', homeA);
    const observations: DriverTranscriptSourceObservation[] = [];
    const driver = new PtyCliDriver({
      agent: makeAgent(cwd, process.execPath, { HOME: homeA }),
      adapter: makeAdapter('claude-code', script),
      backend: new PtyBackend(),
      onEvent() {}, onExit() {},
      sessionId: 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    driver.subscribeTranscriptSource(o => observations.push(o));
    await driver.start();
    expect(observations[0]!.dataRoot).toBe(join(homeA, '.claude'));
    // Daemon HOME relocates after the child was born.
    vi.stubEnv('HOME', join(cwd, 'home-b'));
    expect(freezeTranscriptSource('claude-code', process.env)?.dataRoot).toBe(join(cwd, 'home-b', '.claude'));
    // The recorded launch is immutable and still pinned to the spawn-time root.
    expect(observations[0]!.dataRoot).toBe(join(homeA, '.claude'));
    expect(Object.isFrozen(observations[0])).toBe(true);
    vi.unstubAllEnvs();
    await driver.stop();
  });

  it('aborts the previous launch scan on respawn and never publishes its late identity', async () => {
    const { script } = writeIdleScript(cwd);
    const dataRoot = join(cwd, 'codex-root');
    const root = join(dataRoot, 'sessions'); mkdirSync(root, { recursive: true });
    const sessionId = 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const nativeSessionId = '11111111-1111-4111-8111-111111111111';
    const path = join(root, `rollout-now-${nativeSessionId}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: nativeSessionId, cwd } }) + '\n'
      + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: buildSessionMarker(sessionId) } }) + '\n');
    const verified = verifyLaunchedTranscript('codex', dataRoot, { sessionId, cwd });
    expect(verified?.nativeSessionId).toBe(nativeSessionId);
    let finishScan!: (value: transcriptSource.VerifiedTranscriptIdentity | undefined) => void;
    const scan = new Promise<transcriptSource.VerifiedTranscriptIdentity | undefined>(resolve => { finishScan = resolve; });
    const verify = vi.spyOn(transcriptSource, 'verifyLaunchedTranscriptAsync').mockReturnValueOnce(scan);
    const observations: DriverTranscriptSourceObservation[] = [];
    const backend = new PtyBackend();
    const kill = backend.kill.bind(backend);
    let finishKill!: () => void, killing!: () => void;
    const killGate = new Promise<void>(resolve => { finishKill = resolve; });
    const killStarted = new Promise<void>(resolve => { killing = resolve; });
    vi.spyOn(backend, 'kill').mockImplementationOnce(async () => { killing(); await killGate; await kill(); });
    const driver = new PtyCliDriver({ agent: makeAgent(cwd, process.execPath, { CODEX_HOME: dataRoot }),
      adapter: makeAdapter('codex', script), backend, sessionId, onEvent() {}, onExit() {} });
    driver.subscribeTranscriptSource(o => observations.push(o));
    let resume: Promise<void> | undefined;
    try {
      await driver.start();
      resume = driver.resume();
      await killStarted;
      expect(verify.mock.calls[0]?.[3]?.aborted).toBe(true);
      finishScan(verified);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(observations).toHaveLength(1);
      finishKill(); await resume;
      await expect.poll(() => observations.length).toBe(3);
      expect(observations.map(o => o.nativeSessionId)).toEqual([null, null, nativeSessionId]);
      expect(observations[0]?.observationId).not.toBe(observations[1]?.observationId);
    } finally { finishScan(verified); finishKill(); await resume?.catch(() => {}); await driver.stop(); verify.mockRestore(); }
  });

  it('emits no launch when attaching to an existing tmux session (old process env unknowable)', async () => {
    const tmuxName = `dd-insight-attach-${process.pid}`;
    // Simulate a daemon restart: the pane survives from a previous driver,
    // created through the owned backend (so the ownership marker exists).
    const original = new TmuxBackend(tmuxName, { ownerId: 'insight-test' });
    await original.spawn('sleep', ['60'], { cwd, cols: 120, rows: 30, env: process.env });
    const observations: DriverTranscriptSourceObservation[] = [];
    const driver = new PtyCliDriver({
      agent: makeAgent(cwd, 'sleep', {}),
      adapter: makeAdapter('codex', '/unused'),
      backend: new TmuxBackend(tmuxName, { ownerId: 'insight-test' }),
      onEvent() {}, onExit() {},
      sessionId: 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    driver.subscribeTranscriptSource(o => observations.push(o));
    try {
      await driver.start(); // takes the reattach branch, no spawn
      expect(observations).toHaveLength(0);
    } finally {
      await driver.stop({ discardSession: true }).catch(() => {});
      try { execFileSync('tmux', ['kill-session', '-t', tmuxName]); } catch { /* already gone */ }
    }
  });

  it('emits no pseudo source for an unsupported adapter', async () => {
    const { script } = writeIdleScript(cwd);
    const observations: DriverTranscriptSourceObservation[] = [];
    const driver = new PtyCliDriver({
      agent: makeAgent(cwd, process.execPath, {}),
      adapter: makeAdapter('gemini', script),
      backend: new PtyBackend(),
      onEvent() {}, onExit() {},
      sessionId: 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    driver.subscribeTranscriptSource(o => observations.push(o));
    await driver.start();
    expect(observations).toHaveLength(0);
    await driver.stop();
  });
});

describe.each([['sync', verifyLaunchedTranscript], ['async', verifyLaunchedTranscriptAsync]] as const)('native identity is content-verified, never filename/mtime based (%s)', (_name, verifyLaunchedTranscript) => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'dd-insight-id-')); });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const sessionA = 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const sessionB = 'ses_bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('two same-cwd sessions never cross native ids, and a bare pinned file stays unverified', async () => {
    const configDir = join(cwd, 'config');
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const project = claudeProjectDir(cwd, env);
    mkdirSync(project, { recursive: true });
    const fileA = join(project, `${pinnedSessionUuid(sessionA)}.jsonl`);
    const fileB = join(project, `${pinnedSessionUuid(sessionB)}.jsonl`);
    // B is newer: a newest-mtime resolver would pick it for A.
    writeFileSync(fileA, JSON.stringify({
      type: 'user', sessionId: pinnedSessionUuid(sessionA),
      message: { role: 'user', content: buildSessionMarker(sessionA) },
    }) + '\n');
    writeFileSync(fileB, JSON.stringify({
      type: 'user', sessionId: pinnedSessionUuid(sessionB),
      message: { role: 'user', content: buildSessionMarker(sessionB) },
    }) + '\n');
    const root = freezeTranscriptSource('claude-code', env)!.dataRoot;
    const verifiedA = (await verifyLaunchedTranscript('claude', root, { sessionId: sessionA, cwd }));
    const verifiedB = (await verifyLaunchedTranscript('claude', root, { sessionId: sessionB, cwd }));
    expect(verifiedA?.nativeSessionId).toBe(pinnedSessionUuid(sessionA));
    expect(verifiedA?.verifiedPath).toBe(fileA);
    expect(verifiedB?.nativeSessionId).toBe(pinnedSessionUuid(sessionB));
    expect(verifiedB?.verifiedPath).toBe(fileB);
    expect(verifiedA?.identityProof).toMatch(/^pty-marker-v1:[0-9a-f]{64}$/);
    // A pinned file whose content lacks the marker is not identity.
    rmSync(fileA);
    writeFileSync(fileA, JSON.stringify({ type: 'user', message: { role: 'user', content: 'unrelated' } }) + '\n');
    expect((await verifyLaunchedTranscript('claude', root, { sessionId: sessionA, cwd }))).toBeUndefined();
  });

  it('stays ambiguous when two distinct Claude native ids carry the same marker', async () => {
    const configDir = join(cwd, 'config-amb');
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const project = claudeProjectDir(cwd, env);
    mkdirSync(project, { recursive: true });
    const idA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const idB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    // Both files carry the SAME dutydeck marker under DIFFERENT native ids;
    // B is newer so an mtime/first-hit strategy would wrongly confirm it.
    writeFileSync(join(project, `${idA}.jsonl`), JSON.stringify({
      type: 'user', sessionId: idA, message: { role: 'user', content: buildSessionMarker(sessionA) },
    }) + '\n');
    writeFileSync(join(project, `${idB}.jsonl`), JSON.stringify({
      type: 'user', sessionId: idB, message: { role: 'user', content: buildSessionMarker(sessionA) },
    }) + '\n');
    const root = freezeTranscriptSource('claude-code', env)!.dataRoot;
    expect((await verifyLaunchedTranscript('claude', root, { sessionId: sessionA, cwd }))).toBeUndefined();
  });

  it('verifies a codex launch via history.jsonl marker, ignoring filename-only candidates', async () => {
    const root = join(cwd, 'codex-root');
    const env = { CODEX_HOME: root };
    mkdirSync(join(root, 'sessions', '2026', '10', '03'), { recursive: true });
    const nativeId = '11111111-2222-3333-4444-555555555555';
    const rollout = join(root, 'sessions/2026/10/03', `rollout-2026-10-03T00-00-00-${nativeId}.jsonl`);
    writeFileSync(rollout, JSON.stringify({
      type: 'session_meta', payload: { id: nativeId, cwd: realpathSync(cwd) },
    }) + '\n');
    // No marker anywhere yet: launch stays unverified despite the UUID filename.
    expect((await verifyLaunchedTranscript('codex', root, { sessionId: sessionA, cwd }))).toBeUndefined();
    // Marker lands in history.jsonl → content identity confirmed.
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, 'history.jsonl'), JSON.stringify({
      session_id: nativeId, ts: '2026-10-03T00:00:00Z', text: `do work ${buildSessionMarker(sessionA)}`,
    }) + '\n');
    const verified = (await verifyLaunchedTranscript('codex', root, { sessionId: sessionA, cwd }));
    expect(verified?.nativeSessionId).toBe(nativeId);
    expect(verified?.verifiedPath).toBe(rollout);
  });

  it.each([
    ['no session_meta (events only)', JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'x' } }) + '\n'],
    ['empty file', ''],
    ['session_meta naming a different id', JSON.stringify({ type: 'session_meta', payload: { id: '99999999-9999-9999-9999-999999999999', cwd: '/fixture' } }) + '\n'],
  ])('rejects codex history marker when the rollout is %s', async (_label, rolloutBody) => {
    const root = join(cwd, `codex-root-${_label.replace(/\W/g, '-')}`);
    mkdirSync(join(root, 'sessions'), { recursive: true });
    const nativeId = '11111111-2222-3333-4444-555555555555';
    writeFileSync(join(root, 'sessions', `rollout-2026-10-03T00-00-00-${nativeId}.jsonl`), rolloutBody);
    appendFileSync(join(root, 'history.jsonl'), JSON.stringify({
      session_id: nativeId, ts: '2026-10-03T00:00:00Z', text: buildSessionMarker(sessionA),
    }) + '\n');
    // Filename + history marker must NOT verify without a self-consistent content meta.
    expect((await verifyLaunchedTranscript('codex', root, { sessionId: sessionA, cwd: '/fixture' }))).toBeUndefined();
  });

  it('stays ambiguous when two distinct codex native ids carry the same marker', async () => {
    const root = join(cwd, 'codex-ambiguous');
    const sessions = join(root, 'sessions', '2026', '10', '03');
    mkdirSync(sessions, { recursive: true });
    const id1 = '11111111-2222-3333-4444-555555555555';
    const id2 = '22222222-3333-4444-5555-666666666666';
    // Two history lines, DIFFERENT native ids, same marker (last/mtime must not win).
    appendFileSync(join(root, 'history.jsonl'),
      JSON.stringify({ session_id: id1, text: `work ${buildSessionMarker(sessionA)}` }) + '\n'
      + JSON.stringify({ session_id: id2, text: `work ${buildSessionMarker(sessionA)}` }) + '\n');
    for (const id of [id1, id2]) {
      writeFileSync(join(sessions, `rollout-2026-10-03T00-00-0${id === id1 ? 1 : 2}-${id}.jsonl`), JSON.stringify({
        type: 'session_meta', payload: { id, cwd: realpathSync(cwd) },
      }) + '\n');
    }
    expect((await verifyLaunchedTranscript('codex', root, { sessionId: sessionA, cwd }))).toBeUndefined();
  });

  it('accepts repeated marker lines naming the SAME codex id (legit resume, not ambiguous)', async () => {
    const root = join(cwd, 'codex-resume');
    mkdirSync(join(root, 'sessions'), { recursive: true });
    const nativeId = '11111111-2222-3333-4444-555555555555';
    writeFileSync(join(root, 'sessions', `rollout-x-${nativeId}.jsonl`), JSON.stringify({
      type: 'session_meta', payload: { id: nativeId, cwd: realpathSync(cwd) },
    }) + '\n');
    appendFileSync(join(root, 'history.jsonl'),
      JSON.stringify({ session_id: nativeId, text: `first ${buildSessionMarker(sessionA)}` }) + '\n'
      + JSON.stringify({ session_id: nativeId, text: `again ${buildSessionMarker(sessionA)}` }) + '\n');
    expect((await verifyLaunchedTranscript('codex', root, { sessionId: sessionA, cwd }))?.nativeSessionId).toBe(nativeId);
  });

  it('does not verify when candidates exceed budget and an older file holds a conflicting id (41-file case)', async () => {
    // Exact shape of t3a-limit-ambiguity-probe: 41 files; OLDEST (index 0)
    // and NEWEST (index 40) carry the SAME marker under DIFFERENT ids, 39 in
    // between are unrelated. A newest-40 slice drops the oldest conflict and
    // would falsely verify "native-new".
    const configDir = join(cwd, 'config-over-budget');
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const project = claudeProjectDir('/fixture', env);
    mkdirSync(project, { recursive: true });
    const marker = buildSessionMarker(sessionA);
    for (let i = 0; i < 41; i++) {
      const f = join(project, `${i}.jsonl`);
      writeFileSync(f, JSON.stringify({
        type: 'user', sessionId: i === 0 ? 'native-old' : 'native-new',
        message: { role: 'user', content: i === 0 || i === 40 ? marker : 'unrelated' },
      }) + '\n');
      const t = new Date(1_000_000 + i * 1000);
      utimesSync(f, t, t);
    }
    const root = freezeTranscriptSource('claude-code', env)!.dataRoot;
    expect((await verifyLaunchedTranscript('claude', root, { sessionId: sessionA, cwd: '/fixture' }))).toBeUndefined();
  });

  it('does not verify a normal small directory as over-budget (budget boundary is exact)', async () => {
    const configDir = join(cwd, 'config-at-budget');
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const project = claudeProjectDir('/fixture', env);
    mkdirSync(project, { recursive: true });
    // Exactly the budget (40) files, all same id + marker → still verifiable.
    for (let i = 0; i < 40; i++) {
      writeFileSync(join(project, `f${i}.jsonl`), JSON.stringify({
        type: 'user', sessionId: 'the-one-id',
        message: { role: 'user', content: i === 0 ? buildSessionMarker(sessionA) : 'x' },
      }) + '\n');
    }
    const root = freezeTranscriptSource('claude-code', env)!.dataRoot;
    expect((await verifyLaunchedTranscript('claude', root, { sessionId: sessionA, cwd: '/fixture' }))?.nativeSessionId)
      .toBe('the-one-id');
  });

  it('rejects two physical codex rollouts whose session_meta names the SAME native id', async () => {
    const root = join(cwd, 'codex-dup-file');
    const sessions = join(root, 'sessions', '2026', '10', '03');
    mkdirSync(sessions, { recursive: true });
    const nativeId = '11111111-2222-3333-4444-555555555555';
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: realpathSync(cwd) } }) + '\n';
    writeFileSync(join(sessions, `rollout-a-${nativeId}.jsonl`), meta);
    writeFileSync(join(sessions, `rollout-b-${nativeId}.jsonl`), meta);
    appendFileSync(join(root, 'history.jsonl'), JSON.stringify({
      session_id: nativeId, text: buildSessionMarker(sessionA),
    }) + '\n');
    // Unique native id, but the physical FILE is ambiguous → no verifiedPath.
    expect((await verifyLaunchedTranscript('codex', root, { sessionId: sessionA, cwd }))).toBeUndefined();
  });

  it('rejects a pinned Claude path that symlinks outside the approved root', async () => {
    const configDir = join(cwd, 'config-symlink');
    const outsideDir = join(cwd, 'outside-root');
    const env = { CLAUDE_CONFIG_DIR: configDir };
    const project = claudeProjectDir(cwd, env);
    mkdirSync(project, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    // A real file OUTSIDE the root carrying a convincing marker+id.
    const escaped = join(outsideDir, 'escaped.jsonl');
    writeFileSync(escaped, JSON.stringify({
      type: 'user', sessionId: pinnedSessionUuid(sessionA),
      message: { role: 'user', content: buildSessionMarker(sessionA) },
    }) + '\n');
    // The pinned path existsSync() (follows links) but resolves out of root.
    symlinkSync(escaped, join(project, `${pinnedSessionUuid(sessionA)}.jsonl`));
    const root = freezeTranscriptSource('claude-code', env)!.dataRoot;
    expect((await verifyLaunchedTranscript('claude', root, { sessionId: sessionA, cwd }))).toBeUndefined();
  });

  it('still verifies a self-attributing codex rollout when history.jsonl exceeds the tail window', async () => {
    // Truncated history-only evidence is not enough, but a rollout whose OWN
    // head carries marker + session_meta(id,cwd) is independent strong evidence.
    const root = join(cwd, 'codex-huge-history');
    const sessions = join(root, 'sessions', '2026', '10', '03');
    mkdirSync(sessions, { recursive: true });
    const nativeId = '11111111-2222-3333-4444-555555555555';
    const rollout = join(sessions, `rollout-x-${nativeId}.jsonl`);
    writeFileSync(rollout,
      JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: realpathSync(cwd) } }) + '\n'
      + JSON.stringify({ type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: buildSessionMarker(sessionA) }],
      } }) + '\n');
    // history.jsonl > 4 MiB; the visible tail does NOT name our id at all.
    writeFileSync(join(root, 'history.jsonl'), 'x'.repeat(4 * 1024 * 1024 + 10));
    expect((await verifyLaunchedTranscript('codex', root, { sessionId: sessionA, cwd }))?.verifiedPath)
      .toBe(realpathSync(rollout));
  });

  it('refuses truncated history-only evidence with no self-attributing rollout', async () => {
    const root = join(cwd, 'codex-huge-history-only');
    mkdirSync(join(root, 'sessions', '2026', '10', '03'), { recursive: true });
    const nativeId = '11111111-2222-3333-4444-555555555555';
    writeFileSync(join(root, 'sessions', '2026', '10', '03', `rollout-x-${nativeId}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: realpathSync(cwd) } }) + '\n');
    // > 4 MiB history whose tail happens to carry our marker: still incomplete,
    // an older conflicting marker above the window cannot be ruled out.
    writeFileSync(join(root, 'history.jsonl'),
      'y'.repeat(4 * 1024 * 1024 + 10) + '\n'
      + JSON.stringify({ session_id: nativeId, text: buildSessionMarker(sessionA) }) + '\n');
    expect((await verifyLaunchedTranscript('codex', root, { sessionId: sessionA, cwd }))).toBeUndefined();
  });
});

describe('driver appends content-verified identity through the real transcript path', () => {
  let directory: string;
  let output: (data: string) => void;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const sessionId = 'ses_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const nativeId = pinnedSessionUuid(sessionId);

  async function startDriver(adapterOverrides: Partial<CliAdapter> = {}) {
    directory = mkdtempSync(join(tmpdir(), 'dutydeck-insight-turn-'));
    const project = join(directory, 'projects', realpathSync(directory).replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${nativeId}.jsonl`);
    writeFileSync(transcript, '');
    const observations: DriverTranscriptSourceObservation[] = [];
    const sequence: string[] = [];
    const driver = new PtyCliDriver({
      agent: { id: 'claude-code', name: 'Claude', command: 'unused', args: [], protocol: 'pty-cli', cwd: directory,
        env: { CLAUDE_CONFIG_DIR: directory }, permissionMode: 'full-trust', timeout: 60,
        capabilities: { pause: false, resume: true }, builtin: false },
      adapter: {
        id: 'claude-code', capabilities: { resume: true }, buildArgs: () => [],
        completionPattern: /done/, writeInput(_backend: unknown, prompt: string) {
          appendFileSync(transcript, JSON.stringify({
            type: 'user', timestamp: new Date().toISOString(), sessionId: nativeId,
            message: { role: 'user', content: prompt },
          }) + '\n');
        },
        ...adapterOverrides,
      } as unknown as CliAdapter,
      backend: {
        kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, onExit() {},
        onData(callback: (data: string) => void) { output = callback; }, interrupt() {},
      },
      sessionId, onEvent(event) { if (event.type === 'completed') sequence.push('completed'); }, onExit() {},
    });
    driver.subscribeTranscriptSource(o => { observations.push(o); if (o.nativeSessionId) sequence.push('identity'); });
    await driver.start();
    output(repaint(`Claude Code\n${directory}\n❯\n${idleFooter}`));
    await vi.advanceTimersByTimeAsync(250);
    return { driver, transcript, observations, sequence, answer: () => appendFileSync(transcript,
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done result' }] } }) + '\n') };
  }

  afterEach(async () => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('emits root observation at launch then the verified identity once prompt #1 is persisted', async () => {
    const { driver, transcript, observations, sequence, answer } = await startDriver({
      // A throwing listener on the launch observation must not break the turn
      // or suppress the later identity observation.
    });
    let threwOnce = false;
    driver.subscribeTranscriptSource(o => {
      if (!threwOnce && o.nativeSessionId === null) { threwOnce = true; throw new Error('boom'); }
    });
    const pending = driver.send('do the work');
    answer();
    output(repaint(`done result\n✻ done 12:00 PM\n❯\n${idleFooter}`));
    await vi.advanceTimersByTimeAsync(700);
    await pending; // turn completes despite the throwing listener
    expect(threwOnce).toBe(true);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      client: 'claude', proofKind: 'launch_observed', dataRoot: directory,
      nativeSessionId: null, verifiedPath: null,
    });
    expect(observations[1]).toMatchObject({
      client: 'claude', proofKind: 'launch_observed',
      nativeSessionId: nativeId, verifiedPath: transcript,
      streamIdentity: { kind: 'main', nativeAgentId: null },
    });
    expect(observations[1]!.identityProof).toMatch(/^pty-marker-v1:[0-9a-f]{64}$/);
    expect(sequence).toEqual(['identity', 'completed']);
    await driver.stop();
  });

  it('rechecks a launch when prompt #1 lands during the initial scan and emits identity before completed', async () => {
    let finishScan!: (value: undefined) => void;
    const firstScan = new Promise<undefined>(resolve => { finishScan = resolve; });
    const verify = vi.spyOn(transcriptSource, 'verifyLaunchedTranscriptAsync').mockReturnValueOnce(firstScan);
    const { driver, observations, sequence, answer } = await startDriver();
    try {
      const pending = driver.send('do the work');
      answer();
      output(repaint(`done result\n✻ done 12:00 PM\n❯\n${idleFooter}`));
      await vi.advanceTimersByTimeAsync(700);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(observations).toHaveLength(1);
      expect(sequence).toEqual([]);
      finishScan(undefined);
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(verify).toHaveBeenCalledTimes(2);
      expect(observations[1]?.nativeSessionId).toBe(nativeId);
      expect(sequence).toEqual(['identity', 'completed']);
    } finally { finishScan(undefined); await driver.stop(); }
  });

  it('aborts an in-flight scan on stop and rejects even a late verified result', async () => {
    let finishScan!: (value: transcriptSource.VerifiedTranscriptIdentity | undefined) => void;
    const scan = new Promise<transcriptSource.VerifiedTranscriptIdentity | undefined>(resolve => { finishScan = resolve; });
    const verify = vi.spyOn(transcriptSource, 'verifyLaunchedTranscriptAsync').mockReturnValueOnce(scan);
    const { driver, transcript, observations } = await startDriver();
    appendFileSync(transcript, JSON.stringify({ type: 'user', sessionId: nativeId, message: { role: 'user', content: buildSessionMarker(sessionId) } }) + '\n');
    const verified = verifyLaunchedTranscript('claude', directory, { sessionId, cwd: directory });
    expect(verified?.nativeSessionId).toBe(nativeId);
    await driver.stop();
    expect(verify.mock.calls[0]?.[3]?.aborted).toBe(true);
    finishScan(verified);
    await vi.advanceTimersByTimeAsync(0);
    expect(observations).toHaveLength(1);
  });

  it('rechecks output after awaiting launch verification before completing the turn', async () => {
    let finishScan!: (value: undefined) => void;
    const firstScan = new Promise<undefined>(resolve => { finishScan = resolve; });
    vi.spyOn(transcriptSource, 'verifyLaunchedTranscriptAsync').mockReturnValueOnce(firstScan);
    const { driver, sequence, answer } = await startDriver();
    try {
      let complete = false;
      const pending = driver.send('do the work').then(() => { complete = true; });
      answer();
      output(repaint(`done result\n✻ done 12:00 PM\n❯\n${idleFooter}`));
      await vi.advanceTimersByTimeAsync(700);
      output(repaint('Still working\nEsc to interrupt'));
      finishScan(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(sequence).toEqual(['identity']);
      expect(complete).toBe(false);
      output(repaint(`done result\n✻ done 12:00 PM\n❯\n${idleFooter}`));
      await vi.advanceTimersByTimeAsync(700);
      await pending;
      expect(sequence).toEqual(['identity', 'completed']);
    } finally { finishScan(undefined); await driver.stop(); }
  });
});

it('yields during complete launch verification and closes a cancelled scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dd-source-cooperative-'));
  const sessions = join(root, 'sessions'); mkdirSync(sessions);
  const sessionId = 'ses_cooperative_scan';
  const nativeSessionId = '11111111-1111-4111-8111-111111111111';
  const path = join(sessions, `rollout-now-${nativeSessionId}.jsonl`);
  const padding = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(4000) } }) + '\n';
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: nativeSessionId, cwd: root } }) + '\n' + padding.repeat(512)
    + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: buildSessionMarker(sessionId) } }) + '\n');
  try {
    const ctx = { sessionId, cwd: root };
    let complete = false;
    const tick = new Promise<void>(resolve => setImmediate(resolve));
    const pending = verifyLaunchedTranscriptAsync('codex', root, ctx).then(result => { complete = true; return result; });
    await tick;
    expect(complete).toBe(false);
    const verified = await pending;
    expect(verified?.nativeSessionId).toBe(nativeSessionId);
    expect(verified).toEqual(verifyLaunchedTranscript('codex', root, ctx));
    const controller = new AbortController();
    const cancelled = verifyLaunchedTranscriptAsync('codex', root, ctx, controller.signal);
    controller.abort();
    expect(await cancelled).toBeUndefined();
    expect(await verifyLaunchedTranscriptAsync('codex', root, ctx)).toEqual(verified);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('TranscriptSourceTracker subscription semantics', () => {
  it('replays immutable history to late subscribers, stops after unsubscribe, isolates listener errors', () => {
    const tracker = new TranscriptSourceTracker();
    const binding = { client: 'claude' as const, dataRoot: '/r' };
    tracker.recordLaunch(binding, '/cwd');
    const boom = () => { throw new Error('listener failure must not break the driver'); };
    const unsubscribeBoom = tracker.subscribe(boom);
    const early: DriverTranscriptSourceObservation[] = [];
    tracker.subscribe(o => early.push(o));
    expect(early).toHaveLength(1); // late replay
    expect(() => tracker.recordLaunch({ client: 'codex', dataRoot: '/r2' }, '/cwd')).not.toThrow();
    expect(early).toHaveLength(2);
    unsubscribeBoom();
    const late: DriverTranscriptSourceObservation[] = [];
    tracker.subscribe(o => late.push(o));
    expect(late).toHaveLength(2); // full replay
    expect(Object.isFrozen(late[0])).toBe(true);
    const unsubLate = tracker.subscribe(() => { throw new Error('x'); });
    unsubLate();
    const after: number[] = [];
    const unsub = tracker.subscribe(() => after.push(1));
    after.length = 0; // drop the synchronous history replay
    unsub();
    tracker.recordLaunch({ client: 'traex', dataRoot: '/r3' }, '/cwd');
    expect(after).toHaveLength(0); // unsubscribed never fires
  });
});
