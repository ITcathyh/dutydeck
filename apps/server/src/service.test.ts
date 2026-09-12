import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { getAuthToken } from './auth/auth.js';
import { accessMode, createProductionPtyBackend, listenOptions, startLocalServer } from './service.js';

const temporaryDirectories: string[] = [];
const tmuxSessions: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const session of tmuxSessions.splice(0)) {
    spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('expected TCP address'));
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

describe('server listen options', () => {
  it('turns the default IPv4 wildcard into a dual-stack socket', () => {
    expect(listenOptions({ host: '0.0.0.0', port: 4310 })).toEqual({
      host: '::',
      port: 4310,
      ipv6Only: false
    });
  });

  it('keeps an explicitly selected host unchanged', () => {
    expect(listenOptions({ host: '127.0.0.1', port: 4310 })).toEqual({
      host: '127.0.0.1',
      port: 4310
    });
  });
});

describe('server access mode', () => {
  it('keeps local access frictionless and remote access authenticated by default', () => {
    expect(accessMode({ host: '127.0.0.1', authEnabled: true })).toBe('local');
    expect(accessMode({ host: '0.0.0.0', authEnabled: true })).toBe('token');
  });

  it('opens a remote listener only after authentication is explicitly disabled', () => {
    expect(accessMode({ host: '0.0.0.0', authEnabled: false })).toBe('open');
    expect(accessMode({ host: '127.0.0.1', authEnabled: false })).toBe('local');
  });

  it('does not create or refresh an access token when auth is explicitly disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-open-'));
    temporaryDirectories.push(root);
    const database = join(root, 'dutydeck.db');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const service = await startLocalServer({
      webRoot: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DUTYDECK_HOST: '127.0.0.1',
        DUTYDECK_PORT: String(await freePort()),
        DUTYDECK_DEFAULT_CWD: root,
        DUTYDECK_DATABASE_URL: database,
        DUTYDECK_AUTH: 'false',
        DUTYDECK_AGENTS_JSON: '[]'
      }
    });
    await service.close();

    const repos = createRepositories(database);
    expect(await getAuthToken(repos.config)).toBeNull();
    repos.close();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('authentication is disabled'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('view tasks, control Agents, and access terminals'));
  });

  it('wires no-auth trusted-devhost management while all foundation execution stays staged and blocked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-foundation-service-'));
    temporaryDirectories.push(root);
    const port = await freePort();
    const service = await startLocalServer({
      webRoot: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DUTYDECK_HOST: '0.0.0.0',
        DUTYDECK_PORT: String(port),
        DUTYDECK_DEFAULT_CWD: root,
        DUTYDECK_DATABASE_URL: join(root, 'dutydeck.db'),
        DUTYDECK_AUTH: 'false',
        DUTYDECK_DISABLE_LARK_LISTENER: 'true',
        DUTYDECK_AGENTS_JSON: '[]'
      }
    });
    const base = `http://127.0.0.1:${port}`;
    const json = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) }
      });
      return { response, body: await response.json() as any };
    };
    try {
      const capabilities = await json('/api/foundation/capabilities');
      expect(capabilities.response.status).toBe(200);
      expect(capabilities.body).toMatchObject({
        repositoriesWired: true,
        permissionEvaluatorWired: true,
        runtimeWired: false,
        writesEnabled: true,
        readiness: 'offline_management_ready'
      });

      const bot = await json('/api/foundation/channel-bots', {
        method: 'POST',
        body: JSON.stringify({ id: 'bot-service', externalAppId: 'cli_service', displayName: 'Service Bot', brand: 'feishu' })
      });
      expect(bot.response.status).toBe(201);
      expect(bot.body).toMatchObject({
        id: 'bot-service', state: 'staged', desiredListenerState: 'disabled', fullTrustConfirmed: false,
        credentialStatus: 'missing', blockerCodes: expect.arrayContaining(['channel_bot_credential_required', 'channel_bot_activation_unavailable'])
      });

      expect((await json('/api/foundation/channel-bot-policies', {
        method: 'POST',
        body: JSON.stringify({
          id: 'policy-service', channelBotId: 'bot-service', defaults: { agentDefinitionId: 'codex' },
          routingDefaults: { groupReplyMode: 'chat-topic', mentionPolicy: 'topic' },
          accessPolicy: { mode: 'owner_only', principalIds: [] },
          groupToolsPolicy: { readCeiling: true, discoverCeiling: true, sendCeiling: false, readDefault: true, discoverDefault: true, sendDefault: false }
        })
      })).response.status).toBe(201);
      expect((await json('/api/foundation/group-bindings', {
        method: 'POST',
        body: JSON.stringify({
          id: 'binding-service', channelBotId: 'bot-service', externalChatId: 'oc_service', oncall: true,
          routingOverride: { groupReplyMode: { mode: 'set', value: 'chat-topic' }, mentionPolicy: { mode: 'set', value: 'topic' } }
        })
      })).response.status).toBe(201);

      const matrix = await json('/api/foundation/group-matrix');
      expect(matrix.body).toMatchObject({
        capabilities: { readiness: 'offline_management_ready', runtimeWired: false },
        bots: [{
          bot: { id: 'bot-service', state: 'staged' },
          cells: [{
            externalChatId: 'oc_service', desiredPolicy: { id: 'binding-service', revision: 1, oncall: true },
            effectiveSummary: { routing: { groupReplyMode: { value: 'chat-topic' }, mentionPolicy: { value: 'topic' } }, talkGrant: 'oncall_chat_members' }
          }]
        }]
      });

      const updated = await json('/api/foundation/group-bindings/binding-service', {
        method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, state: 'disabled' })
      });
      expect(updated.body).toMatchObject({ revision: 2, state: 'disabled' });
      const stale = await json('/api/foundation/group-bindings/binding-service', {
        method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, oncall: false })
      });
      expect(stale.response.status).toBe(409);
      expect(stale.body).toMatchObject({ error: { code: 'FOUNDATION_REVISION_CONFLICT' }, current: { revision: 2, oncall: true, state: 'disabled' } });

      const larkStatus = await json('/api/lark/status');
      expect(larkStatus.body).toMatchObject({
        listening: false, activeAppIds: [], listeningDisabled: true, policyIntegration: 'legacy_unmanaged'
      });
    } finally {
      await service.close();
    }
  });

  it('requires the verified installation token for remote foundation writes with no anonymous principal fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-foundation-token-'));
    temporaryDirectories.push(root);
    const database = join(root, 'dutydeck.db');
    const port = await freePort();
    const service = await startLocalServer({
      webRoot: root,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DUTYDECK_HOST: '0.0.0.0',
        DUTYDECK_PORT: String(port),
        DUTYDECK_DEFAULT_CWD: root,
        DUTYDECK_DATABASE_URL: database,
        DUTYDECK_AUTH: 'true',
        DUTYDECK_DISABLE_LARK_LISTENER: 'true',
        DUTYDECK_AGENTS_JSON: '[]'
      }
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/api/foundation/capabilities`)).status).toBe(401);
      const tokenRepository = createRepositories(database);
      const token = await getAuthToken(tokenRepository.config);
      tokenRepository.close();
      expect(token).toBeTruthy();
      const created = await fetch(`${base}/api/foundation/channel-bots`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'bot-token', externalAppId: 'cli_token', displayName: 'Token Bot', brand: 'lark' })
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ id: 'bot-token', state: 'staged', desiredListenerState: 'disabled' });
    } finally {
      await service.close();
    }
  });
});

describe('production PTY backend injection', () => {
  it('always selects a namespaced, owned tmux backend for Dutydeck sessions', () => {
    const backend = createProductionPtyBackend('ses/test:one', {
      isAvailable: kind => kind === 'tmux',
      probeSession: () => 'missing',
    });

    expect(backend.kind).toBe('tmux');
    expect(backend.sessionName).toMatch(/^dutydeck-ses-test-one-[a-f0-9]{16}$/);
    expect(backend.ownerId).toBe('dutydeck:ses/test:one');
    expect(createProductionPtyBackend('ses/test:one', {
      isAvailable: kind => kind === 'tmux',
      probeSession: () => 'missing',
    }).sessionName).toBe(backend.sessionName);
  });

  it('fails loudly instead of downgrading production sessions to PtyBackend', () => {
    expect(() => createProductionPtyBackend('ses-no-tmux', {
      isAvailable: () => false,
      probeSession: () => 'missing',
    })).toThrow(/tmux backend is unavailable/i);
  });

  const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
  const tmuxIt = tmuxAvailable ? it : it.skip;

  tmuxIt.each([false, true])('recovers an in-flight task through a full service restart (completed offline: %s)', async offline => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-service-turn-recovery-'));
    temporaryDirectories.push(root);
    const database = join(root, 'dutydeck.db');
    const runner = join(root, 'runner.mjs');
    writeFileSync(runner, [
      `#!${process.execPath}`,
      "import { appendFileSync, existsSync } from 'node:fs';",
      "process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');",
      "process.stdout.write('Claude Code v2.1.267 (mock)\\r\\n❯ \\r\\n'); let input = '';",
      // The real adapter pastes a multiline routing block, then Enter commits it.
      "process.stdin.on('data', data => {",
      "  input += data; const end = input.indexOf('\\x1b[201~');",
      "  if (end < 0 || !input.slice(end + 6).includes('\\r')) return;",
      "  input = ''; appendFileSync('submissions', 'submitted\\n');",
      "  process.stdout.write('\\x1b[2J\\x1b[HWorking (esc to interrupt)\\r\\n');",
      "  const timer = setInterval(() => {",
      "    if (!existsSync('finish')) return; clearInterval(timer);",
      "    process.stdout.write('\\x1b[2J\\x1b[HClaude Code v2.1.267 (mock)\\r\\n✳ Worked for 1s\\r\\n❯ \\r\\n');",
      '  }, 50);',
      '});', ''
    ].join('\n'));
    chmodSync(runner, 0o700);
    const serverEnv = async (): Promise<NodeJS.ProcessEnv> => ({
      ...process.env, NODE_ENV: 'test', DUTYDECK_HOST: '127.0.0.1', DUTYDECK_PORT: String(await freePort()),
      DUTYDECK_DEFAULT_CWD: root, DUTYDECK_DATABASE_URL: database, DUTYDECK_AUTH: 'false', DUTYDECK_DISABLE_LARK_LISTENER: 'true',
      DUTYDECK_AGENTS_JSON: JSON.stringify([{
        id: 'claude-code', name: 'Recovery test runner', command: runner, protocol: 'pty-cli',
        permissionMode: 'ask', env: { CLAUDE_CONFIG_DIR: root }, capabilities: { pause: false, resume: true }
      }])
    });
    const first = await startLocalServer({ webRoot: root, env: await serverEnv() });
    let restored: Awaited<ReturnType<typeof startLocalServer>> | undefined;
    try {
      const session = await first.runtime.start({ agentId: 'claude-code' });
      const backend = createProductionPtyBackend(session.id);
      tmuxSessions.push(backend.sessionName);
      const originalPid = backend.getPid();
      const project = join(root, 'projects', realpathSync(root).replace(/[^A-Za-z0-9-]/g, '-'));
      mkdirSync(project, { recursive: true });
      const transcript = join(project, session.id.replace(/^ses_/, '') + '.jsonl');
      writeFileSync(transcript, '');
      const record = (text: string) => appendFileSync(transcript, JSON.stringify({
        type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }
      }) + '\n');
      const task = await first.runtime.dispatch(session.id, 'recover this exact task');
      await vi.waitFor(() => expect(existsSync(join(root, 'submissions'))).toBe(true), { timeout: 25_000 });
      record('before restart');
      await vi.waitFor(async () => expect((await first.runtime.getEvents(session.id)).some(event => (event.data as any)?.text === 'before restart')).toBe(true));
      await first.close();
      const persisted = createRepositories(database);
      try {
        expect((await persisted.tasks.listBySession(session.id))[0]?.status).toBe('running');
        expect((await persisted.tasks.listBySession(session.id))[0]?.executionContext?.recovery?.turnId)
          .toBe(backend.getDutydeckMetadata('turn_id'));
      } finally { persisted.close(); }
      const complete = () => { record('final answer'); writeFileSync(join(root, 'finish'), ''); };
      if (offline) {
        complete();
        await vi.waitFor(() => expect(backend.captureCurrentScreen()).toContain('Worked for 1s'));
      }
      restored = await startLocalServer({ webRoot: root, env: await serverEnv() });
      if (!offline) {
        await vi.waitFor(() => expect(restored!.runtime.getDriver(session.id)).toBeDefined());
        expect((await restored.runtime.getTasks(session.id))[0]?.status).toBe('running');
        complete();
      }
      await vi.waitFor(async () => expect((await restored!.runtime.getTasks(session.id))[0]?.status, (await restored!.runtime.getSession(session.id))?.error).toBe('completed'), { timeout: 10_000 });
      expect(backend.getPid()).toBe(originalPid);
      expect(readFileSync(join(root, 'submissions'), 'utf8')).toBe('submitted\n');
      expect((await restored.runtime.getTasks(session.id)).map(item => item.id)).toEqual([task.id]);
      const events = await restored.runtime.getEvents(session.id);
      expect(events.filter(event => event.type === 'text').map(event => (event.data as any).text))
        .toEqual(['recover this exact task', 'before restart', 'final answer']);
      expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
      expect(events.filter(event => event.type === 'error')).toEqual([]);
      await restored.runtime.stop(session.id);
    } finally {
      await first.close();
      await restored?.close();
    }
  }, 60_000);

  tmuxIt('keeps a completed Dutydeck Run on the same pane across a service restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-persistent-pty-'));
    temporaryDirectories.push(root);
    const database = join(root, 'dutydeck.db');
    const fakeRunner = join(root, 'fake-claude-runner.sh');
    writeFileSync(fakeRunner, [
      '#!/bin/sh',
      "printf 'Claude Code v2.1.267 (mock)\\n❯ \\n'",
      'while IFS= read -r line; do',
      "  printf '\\033[2J\\033[HClaude Code v2.1.267 (mock)\\nhandled:%s\\n✳ Worked for 1s\\n❯ \\n' \"$line\"",
      'done',
      '',
    ].join('\n'));
    chmodSync(fakeRunner, 0o700);

    const serverEnv = async (): Promise<NodeJS.ProcessEnv> => ({
      ...process.env,
      NODE_ENV: 'test',
      DUTYDECK_HOST: '127.0.0.1',
      DUTYDECK_PORT: String(await freePort()),
      DUTYDECK_DEFAULT_CWD: root,
      DUTYDECK_DATABASE_URL: database,
      DUTYDECK_AUTH: 'false',
      DUTYDECK_DISABLE_LARK_LISTENER: 'true',
      DUTYDECK_AGENTS_JSON: JSON.stringify([{
        id: 'claude-code',
        name: 'Persistent test runner',
        command: fakeRunner,
        protocol: 'pty-cli',
        permissionMode: 'ask',
        capabilities: { pause: false, resume: false },
      }]),
    });

    const first = await startLocalServer({ webRoot: root, env: await serverEnv() });
    const session = await first.runtime.start({ agentId: 'claude-code' });
    const backend = createProductionPtyBackend(session.id);
    tmuxSessions.push(backend.sessionName);
    await first.runtime.send(session.id, 'before daemon restart');
    const originalPid = Number(spawnSync(
      'tmux',
      ['display-message', '-p', '-t', backend.sessionName, '#{pane_pid}'],
      { encoding: 'utf8' },
    ).stdout.trim());
    expect(originalPid).toBeGreaterThan(0);

    await first.close();
    expect(spawnSync('tmux', ['has-session', '-t', backend.sessionName]).status).toBe(0);

    const restored = await startLocalServer({ webRoot: root, env: await serverEnv() });
    expect(restored.runtime.getDriver(session.id)).toBeUndefined();
    await restored.runtime.send(session.id, 'after daemon restart');
    const restoredPid = Number(spawnSync(
      'tmux',
      ['display-message', '-p', '-t', backend.sessionName, '#{pane_pid}'],
      { encoding: 'utf8' },
    ).stdout.trim());
    expect(restoredPid).toBe(originalPid);
    expect((await restored.runtime.getTasks(session.id)).map(task => task.prompt)).toEqual([
      'before daemon restart',
      'after daemon restart',
    ]);

    await restored.runtime.stop(session.id);
    expect(spawnSync('tmux', ['has-session', '-t', backend.sessionName]).status).not.toBe(0);
    await restored.close();
  }, 30_000);
});

describe('production schedule foundation wiring', () => {
  it('persists offline schedule management across restarts without exposing an executor or dispatch route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-schedule-service-'));
    temporaryDirectories.push(root);
    const database = join(root, 'dutydeck.db');
    const bootstrap = createRepositories(database);
    await bootstrap.secretRefs.create({
      id: 'secret-schedule-service', kind: 'generic', provider: 'local-file-v1', referenceKey: 'schedule.service.ref', status: 'configured'
    });
    await bootstrap.channelBots.create({
      id: 'bot-schedule-service', channel: 'lark', externalAppId: 'cli_schedule_service', displayName: 'Schedule Service Bot', brand: 'feishu',
      credentialRef: 'secret-schedule-service', state: 'staged'
    });
    bootstrap.close();

    const envFor = async (): Promise<NodeJS.ProcessEnv> => ({
      ...process.env,
      NODE_ENV: 'test',
      DUTYDECK_HOST: '127.0.0.1',
      DUTYDECK_PORT: String(await freePort()),
      DUTYDECK_DEFAULT_CWD: root,
      DUTYDECK_DATABASE_URL: database,
      DUTYDECK_AUTH: 'false',
      DUTYDECK_DISABLE_LARK_LISTENER: 'true',
      DUTYDECK_AGENTS_JSON: '[]'
    });
    const scheduleBody = {
      id: 'schedule-service', channelBotId: 'bot-schedule-service', name: 'Service restart review',
      trigger: { kind: 'cron', expression: '0 9 * * 1-5' }, timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' },
      delivery: { mode: 'chat', chatRef: 'private_schedule_chat_ref', continuation: 'chat_root' },
      cwdRef: 'private_schedule_cwd_ref', payloadRef: 'private_schedule_payload_ref', identityRef: 'identity_schedule_service', secretRef: 'secret-schedule-service'
    };

    const first = await startLocalServer({ webRoot: root, env: await envFor() });
    const firstBase = `http://127.0.0.1:${first.config.port}`;
    const call = async (base: string, path: string, init?: RequestInit) => {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) }
      });
      return { response, body: await response.json() as any };
    };
    try {
      const capabilities = await call(firstBase, '/api/foundation/schedules/capabilities');
      expect(capabilities.body).toMatchObject({
        repositoriesWired: true, permissionEvaluatorWired: true, writesEnabled: true,
        executorWired: false, uiEntryReady: false, readiness: 'offline_management_ready'
      });
      expect(capabilities.body.blockers.map((item: { code: string }) => item.code)).toEqual(expect.arrayContaining([
        'schedule_executor_unavailable', 'schedule_ui_entry_unwired'
      ]));

      const created = await call(firstBase, '/api/foundation/schedules', { method: 'POST', body: JSON.stringify(scheduleBody) });
      expect(created.response.status).toBe(201);
      expect(created.body).toMatchObject({
        definition: {
          id: 'schedule-service', revision: 1, state: 'staged', desiredExecutorState: 'disabled',
          sourceOwnership: 'dutydeck', sourceEnabled: false, currentGeneration: 1
        },
        readiness: { executionEligible: false }
      });
      expect(created.body.readiness.blockers.map((item: { code: string }) => item.code)).toEqual(expect.arrayContaining([
        'schedule_staged_disabled', 'schedule_lease_required', 'schedule_executor_unavailable'
      ]));
      for (const privateValue of ['private_schedule_chat_ref', 'private_schedule_cwd_ref', 'private_schedule_payload_ref']) {
        expect(JSON.stringify(created.body)).not.toContain(privateValue);
      }

      const preview = await call(firstBase, '/api/foundation/schedules/schedule-service/preview?after=2026-08-28T02%3A00%3A00.000Z');
      expect(preview.body).toMatchObject({
        scheduleId: 'schedule-service', executionEligible: false,
        preview: { scheduledForUtc: '2026-08-31T01:00:00.000Z' }
      });

      const edited = await call(firstBase, '/api/foundation/schedules/schedule-service', {
        method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, name: 'Edited after preview', state: 'disabled' })
      });
      expect(edited.body).toMatchObject({
        definition: { id: 'schedule-service', revision: 2, name: 'Edited after preview', state: 'disabled', desiredExecutorState: 'disabled', currentGeneration: 2 },
        readiness: { executionEligible: false }
      });
      expect((await call(firstBase, '/api/foundation/schedules/schedule-service/enable', { method: 'POST' })).response.status).toBe(404);
      expect((await call(firstBase, '/api/foundation/schedules/schedule-service/run-now', { method: 'POST' })).response.status).toBe(404);
      expect(await first.runtime.listSessions()).toEqual([]);
    } finally {
      await first.close();
    }

    const second = await startLocalServer({ webRoot: root, env: await envFor() });
    const secondBase = `http://127.0.0.1:${second.config.port}`;
    try {
      const persisted = await call(secondBase, '/api/foundation/schedules/schedule-service');
      expect(persisted.response.status).toBe(200);
      expect(persisted.body).toMatchObject({
        definition: { revision: 2, name: 'Edited after preview', state: 'disabled', desiredExecutorState: 'disabled', currentGeneration: 2 },
        readiness: { executionEligible: false }, currentGeneration: { generation: 2, definitionRevision: 2, state: 'staged_disabled' }
      });
      expect((await call(secondBase, '/api/foundation/schedules/schedule-service/run-now', { method: 'POST' })).response.status).toBe(404);
      expect(await second.runtime.listSessions()).toEqual([]);
    } finally {
      await second.close();
    }

    const inspection = createRepositories(database);
    expect(await inspection.scheduleOccurrences.listByDefinition('schedule-service', 20)).toEqual([]);
    expect(await inspection.scheduleWatermarks.get('schedule-service')).toMatchObject({
      scheduleDefinitionId: 'schedule-service', lastPlannedOccurrenceKey: undefined, lastClaimedOccurrenceKey: undefined,
      lastStartedOccurrenceKey: undefined, lastSettledOccurrenceKey: undefined, nextDueAt: undefined
    });
    expect(await inspection.scheduleLeases.getByKey('schedule_writer:bot-schedule-service')).toBeUndefined();
    inspection.close();
  });
});
