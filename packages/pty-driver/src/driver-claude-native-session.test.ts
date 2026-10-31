import { describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createCliAdapter, pinnedSessionUuid } from '@dutydeck/cli-adapters';
import { PtyBackend, TmuxBackend } from '@dutydeck/session-backends';
import { agentConfigSchema, type DriverTranscriptSourceObservation, type NormalizedDriverEvent } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { childProcessIdentity, observeProcess } from '../../storage/src/process-identity.js';
import { DutydeckRuntime } from '../../agent-runtime/src/index.js';
import { PtyCliDriver } from './driver.js';
const script = fileURLToPath(new URL('./fixtures/claude-native-session.mjs', import.meta.url));
const probe = { identify: childProcessIdentity, observe: observeProcess };
const adapter = () => ({ ...createCliAdapter('claude-code'), prepareInput: undefined,
  buildArgs: (ctx: any) => [script, ctx.resume ? '--resume' : '--session-id', ctx.resumeSessionId ?? pinnedSessionUuid(ctx.sessionId)],
  writeInput: async (backend: any, prompt: string) => { await backend.write(JSON.stringify({ prompt }) + '\r'); },
});
const agent = (cwd: string) => agentConfigSchema.parse({ id: 'claude-code', name: 'fixture', command: process.execPath, args: [], cwd,
  env: { HOME: cwd, CLAUDE_CONFIG_DIR: cwd }, permissionMode: 'full-trust', timeout: 30, protocol: 'pty-cli', capabilities: { resume: true } });
const latest = (repos: ReturnType<typeof createRepositories>, id: string) => repos.insight.listSources(id).filter(source => source.client === 'claude' && source.proofKind === 'launch_observed' && source.identityProof?.startsWith('pty-claude-process-v1:')).at(-1);
const launches = (cwd: string) => readFileSync(join(cwd, 'launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

describe.skipIf(process.platform !== 'linux')('Claude native process integration', () => {
  it('an active native rotation rejects the old attempt, never resends, and the next input belongs to the new session', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dd-claude-active-'))), backend = new PtyBackend(), events: NormalizedDriverEvent[] = [];
    const driver = new PtyCliDriver({ agent: agent(cwd), adapter: adapter(), backend, processProbe: probe, sessionId: 'ses_rotation_active', onEvent: event => events.push(event), onExit() {} });
    try {
      await driver.start();
      await vi.waitFor(() => expect(launches(cwd)).toHaveLength(1), { timeout: 6_000 });
      await driver.send('first');
      const pending = driver.send('HOLD'); void pending.catch(() => {});
      await vi.waitFor(() => expect(events.filter(event => event.data?.state === 'input_receipt' && event.data.phase === 'confirmed')).toHaveLength(2));
      const id = '22222222-2222-4222-8222-222222222222';
      await backend.write('/clear ' + id + '\r');
      await expect(pending).rejects.toThrow('outcome remains unknown');
      await driver.send('after');
      expect(driver.getCliSessionId()).toBe(id);
      expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['ANSWER:first', 'ANSWER:after']);
      expect(events.filter(event => event.type === 'completed')).toHaveLength(2);
      expect(launches(cwd)).toHaveLength(1);
    } finally { await driver.stop(); rmSync(cwd, { recursive: true, force: true }); }
  }, 20_000);

  it.each(['before-prepare', 'after-prepare', 'undiscovered'])('preserves a native switch %s without waiting for the tail tick', async phase => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dd-claude-stop-race-')));
    vi.stubEnv('HOME', cwd); vi.stubEnv('TMUX_TMPDIR', cwd);
    const name = 'native-stop-race', sources: DriverTranscriptSourceObservation[] = [];
    const configured = agent(cwd);
    if (phase === 'undiscovered') configured.env.FIXTURE_DEFER_NATIVE_STATE = '1';
    const driver = new PtyCliDriver({ agent: configured, adapter: adapter(), backend: new TmuxBackend(name, { ownerId: 'dutydeck:race' }),
      processProbe: probe, sessionId: 'ses_stop_race', onEvent() {}, onExit() {} });
    driver.subscribeTranscriptSource(source => sources.push(source));
    try {
      await driver.start(); await driver.send('first');
      if (phase !== 'undiscovered') await vi.waitFor(() => expect(sources.some(source => source.nativeSessionId && source.identityProof?.startsWith('pty-claude-process-v1:'))).toBe(true), { timeout: 7_000 });
      const source = sources.filter(source => source.identityProof?.startsWith('pty-claude-process-v1:')).at(-1)!;
      if (phase === 'undiscovered') expect(source).toBeUndefined();
      else driver.confirmTranscriptSource(source.observationId);
      const selected = driver.getCliSessionId();
      if (phase === 'after-prepare') await driver.prepareForDaemonShutdown(false);
      const id = '55555555-5555-4555-8555-555555555555', state = join(cwd, 'sessions', launches(cwd)[0].pid + '.json');
      // The subprocess waits while this JS event loop is blocked: no tail tick
      // can observe the actual fixture CLI's /clear before the assertion below.
      execFileSync(process.execPath, ['-e', `const {execFileSync}=require('node:child_process'),{readFileSync,existsSync}=require('node:fs');
        execFileSync('tmux',['send-keys','-t',process.argv[1],'/clear '+process.argv[3],'Enter']);
        const end=Date.now()+3000; while(!existsSync(process.argv[2]) || JSON.parse(readFileSync(process.argv[2],'utf8')).sessionId!==process.argv[3]) {
          if(Date.now()>end) throw Error('native command did not finish'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
        }`, name, state, id]);
      expect(driver.getCliSessionId()).toBe(selected);
      if (source) driver.confirmTranscriptSource(source.observationId); // late A ACK cannot authorize B retirement.
      if (phase !== 'after-prepare') await driver.prepareForDaemonShutdown(false);
      await driver.stop();
      expect(driver.isDetachedForShutdown()).toBe(true);
      expect(await TmuxBackend.probeSession(name)).toBe('exists');
    } finally {
      await driver.stop();
      try { execFileSync('tmux', ['-S', join(cwd, `tmux-${process.getuid!()}`, 'default'), 'kill-server'], { stdio: 'ignore' }); } catch { /* private server */ }
      vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  it.each([false, true])('persists rotation or preserves its private tmux pane when persistence fails=%s', async failPersistence => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dd-claude-cold-')));
    vi.stubEnv('HOME', cwd); vi.stubEnv('TMUX_TMPDIR', cwd);
    const database = join(cwd, 'state.sqlite');
    let repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    let failWrites = false, failedWrites = 0;
    const bind = repos.insight.bindSources.bind(repos.insight);
    vi.spyOn(repos.insight, 'bindSources').mockImplementation(claim => {
      const writer = bind(claim);
      return { appendObserved(observation) {
        if (failWrites && observation.identityProof?.startsWith('pty-claude-process-v1:')) { failedWrites++; throw new Error('fixture write failure'); }
        writer.appendObserved(observation);
      } };
    });
    let runtime: DutydeckRuntime | undefined;
    let backend: TmuxBackend | undefined;
    const makeRuntime = () => new DutydeckRuntime(repos, { cleanupIntervalMs: 0,
      probe: () => ({ available: true, protocol: 'pty-cli', resume: true }),
      ptyDriverFactory: (configured, _protocol, onEvent, onExit, sessionId) => {
        backend = new TmuxBackend(`native-${sessionId}`, { ownerId: `dutydeck:${sessionId}` });
        return new PtyCliDriver({ agent: configured, adapter: adapter(), backend, processProbe: probe, sessionId, onEvent, onExit,
          claudeResumeSource: latest(repos, sessionId) });
      },
    });
    try {
      runtime = makeRuntime(); await runtime.initialize([agent(cwd)]);
      const session = await runtime.start({ agentId: 'claude-code', cwd });
      expect((await runtime.send(session.id, 'first')).status).toBe('completed');
      await vi.waitFor(() => expect(latest(repos, session.id)?.nativeSessionId).toBe(launches(cwd)[0].sid), { timeout: 7_000 });
      const oldObservation = latest(repos, session.id)!;
      failWrites = failPersistence;
      const uncertain = runtime.send(session.id, 'HOLD');
      await vi.waitFor(async () => expect((await runtime!.getEvents(session.id)).filter(event => event.data?.state === 'input_receipt' && event.data.phase === 'confirmed')).toHaveLength(2));
      const id = '44444444-4444-4444-8444-444444444444';
      await backend!.write('/clear ' + id + '\r');
      const unknown = await uncertain;
      expect(unknown.status).toBe('reconcile_required');
      expect(repos.execution.getTaskExecution(unknown.id)?.attempts).toHaveLength(1);
      await vi.waitFor(() => expect(runtime!.getDriver(session.id)?.isIdle?.()).toBe(true));
      await runtime.settleIdleAttempt(session.id, { taskId: unknown.id, decisionId: 'rotation-reviewed', outcome: 'unknown', evidenceRefs: ['operator:native-clear'] }, { kind: 'installation_owner', id: 'installation_owner' });
      if (!failPersistence) await vi.waitFor(() => expect(latest(repos, session.id)?.nativeSessionId).toBeNull(), { timeout: 7_000 });
      expect((await runtime.send(session.id, 'after')).status).toBe('completed');
      const liveDriver = runtime.getDriver(session.id) as PtyCliDriver;
      await vi.waitFor(() => expect(liveDriver.getCliSessionId()).toBe(id));
      if (failPersistence) {
        liveDriver.confirmTranscriptSource(oldObservation.observationId); // late ACK for A must not confirm B.
        await vi.waitFor(() => expect(failedWrites).toBeGreaterThan(0));
        await new Promise(resolve => setTimeout(resolve, 4_200));
        const attempts = failedWrites;
        await new Promise(resolve => setTimeout(resolve, 1_100));
        expect(failedWrites).toBe(attempts); // bounded retries, not an infinite write/log loop.
        expect(latest(repos, session.id)?.nativeSessionId).toBe(oldObservation.nativeSessionId);
        await runtime.cleanupIdleDrivers(Date.now() + 7 * 60 * 60_000);
        expect(runtime.getDriver(session.id)).toBe(liveDriver);
        expect(await TmuxBackend.probeSession(`native-${session.id}`)).toBe('exists');
      } else await vi.waitFor(() => expect(latest(repos, session.id)?.nativeSessionId).toBe(id));
      await runtime.shutdown();
      if (failPersistence) expect(liveDriver.isDetachedForShutdown()).toBe(true);
      runtime = undefined;
      if (failPersistence) {
        const receipt = JSON.parse((await repos.config.get(`runtime_idle_terminal:${session.id}`))!);
        const name = `native-${session.id}`;
        const terminal = () => new PtyCliDriver({ agent: agent(cwd), adapter: adapter(), backend: new TmuxBackend(name, { ownerId: `dutydeck:${session.id}` }),
          processProbe: probe, sessionId: session.id, onEvent() {}, onExit() {}, claudeResumeSource: latest(repos, session.id) });
        const rejectReceipt = async (identity: unknown) => {
          const driver = terminal();
          try { await expect(driver.attachTerminal(identity)).rejects.toThrow(); }
          finally { await driver.prepareForDaemonShutdown(true); await driver.stop(); }
          expect(await TmuxBackend.probeSession(name)).toBe('exists');
        };
        await rejectReceipt({ ...receipt.identity, process: { ...receipt.identity.process, start: 'stale-birth' } });
        await rejectReceipt({ ...receipt.identity, tmux: { ...receipt.identity.tmux, targetId: '$99999' } });
        await rejectReceipt({ ...receipt.identity, tmux: { ...receipt.identity.tmux, scope: { ...receipt.identity.tmux.scope, sessionName: 'foreign-pane' } } });
        execFileSync('tmux', ['set-option', '-t', name, '@dutydeck_owner_id', 'external-owner']);
        await rejectReceipt(receipt.identity);
        execFileSync('tmux', ['set-option', '-t', name, '@dutydeck_owner_id', `dutydeck:${session.id}`]);
        const path = join(cwd, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'), id + '.jsonl');
        const background = (count: number) => appendFileSync(path, JSON.stringify({ sessionId: id, cwd, type: 'system', subtype: 'turn_duration', pendingBackgroundAgentCount: count }) + '\n');
        background(1); await rejectReceipt(receipt.identity); background(0);
      }
      repos.close();
      // A confirmed source retires the pane; an unconfirmed source retains the same process.
      expect(await TmuxBackend.probeSession(`native-${session.id}`)).toBe(failPersistence ? 'exists' : 'missing');
      repos = createRepositories(database); runtime = makeRuntime(); await runtime.initialize([agent(cwd)]);
      if (failPersistence) expect(await runtime.getTerminalDriver(session.id)).toBeDefined();
      expect((await runtime.send(session.id, 'cold')).status).toBe('completed');
      expect(launches(cwd)).toHaveLength(failPersistence ? 1 : 2);
      if (!failPersistence) expect(launches(cwd).at(-1)).toMatchObject({ sid: id, args: expect.arrayContaining(['--resume', id]) });
      await vi.waitFor(() => expect(latest(repos, session.id)?.nativeSessionId).toBe(id));
      expect((await runtime.getEvents(session.id)).filter(event => event.type === 'text' && event.data.role !== 'user').map(event => event.data.text)).toEqual(['ANSWER:first', 'ANSWER:after', 'ANSWER:cold']);
      await runtime.shutdown(); runtime = undefined; repos.close();
      repos = createRepositories(database); runtime = makeRuntime(); await runtime.initialize([agent(cwd)]);
      expect((await runtime.send(session.id, 'again')).status).toBe('completed');
      expect(launches(cwd).at(-1).sid).toBe(id);
    } finally {
      await runtime?.shutdown(); repos.close();
      try { execFileSync('tmux', ['-S', join(cwd, `tmux-${process.getuid!()}`, 'default'), 'kill-server'], { stdio: 'ignore' }); } catch { /* private server already stopped */ }
      vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true });
    }
  }, 40_000);
});
