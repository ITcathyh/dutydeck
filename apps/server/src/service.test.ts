import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    const seed = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    seed.close();
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
    const database = join(root, 'dutydeck.db');
    const seed = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    seed.close();
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
    const seed = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    seed.close();
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
      isAvailable: (kind: string) => kind === 'tmux',
      probeSession: () => 'missing',
    });

    expect(backend.kind).toBe('tmux');
    expect(backend.sessionName).toMatch(/^dutydeck-ses-test-one-[a-f0-9]{16}$/);
    expect(backend.ownerId).toBe('dutydeck:ses/test:one');
    expect(createProductionPtyBackend('ses/test:one', {
      isAvailable: (kind: string) => kind === 'tmux',
      probeSession: () => 'missing',
    }).sessionName).toBe(backend.sessionName);
  });

  it('fails loudly instead of downgrading production sessions to PtyBackend', () => {
    expect(() => createProductionPtyBackend('ses-no-tmux', {
      isAvailable: (kind: string) => false,
      probeSession: () => 'missing',
    })).toThrow(/tmux backend is unavailable/i);
  });

  const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
  const tmuxIt = tmuxAvailable ? it : it.skip;

  tmuxIt('runs a custom command with the Claude adapter alongside the original agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-custom-claude-'));
    temporaryDirectories.push(root);
    const database = join(root, 'dutydeck.db');
    const seed = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    seed.close();
    const runner = join(root, 'runner.mjs');
    writeFileSync(runner, [
      `#!${process.execPath}`,
      "import { writeFileSync } from 'node:fs';",
      "if (process.argv.includes('--version')) { console.log('fixture 1.0'); process.exit(0); }",
      "writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));",
      "process.stdout.write('Claude Code v2.1.267 (mock)\\n❯ \\n');",
      'setInterval(() => {}, 1000);', '',
    ].join('\n'));
    chmodSync(runner, 0o700);
    const service = await startLocalServer({
      webRoot: root,
      env: {
        ...process.env, NODE_ENV: 'test', DUTYDECK_HOST: '127.0.0.1', DUTYDECK_PORT: String(await freePort()),
        DUTYDECK_DEFAULT_CWD: root, DUTYDECK_DATABASE_URL: database,
        DUTYDECK_AUTH: 'false', DUTYDECK_DISABLE_LARK_LISTENER: 'true',
        DUTYDECK_AGENTS_JSON: JSON.stringify(['claude-code', 'ccflash'].map(id => ({
          id, name: id, command: runner, args: [join(root, `${id}.json`), '--wrapper-profile', id],
          ...(id === 'ccflash' ? { adapterId: 'claude-code' } : {}), protocol: 'pty-cli',
          permissionMode: 'ask',
          env: {
            CLAUDE_CONFIG_DIR: root,
            dutydeck_relay_url: 'http://127.0.0.1:9/fixture-relay',
            dutydeck_relay_token: 'fixture-relay-token',
            dutydeck_relay_command: 'dutydeck-fixture',
          },
        }))),
      },
    });
    const sessions: string[] = [];
    try {
      for (const agentId of ['claude-code', 'ccflash']) {
        const session = await service.runtime.start({ agentId, model: 'gateway/custom[1m]' });
        sessions.push(session.id);
        tmuxSessions.push(createProductionPtyBackend(session.id).sessionName);
        expect(session.agentId).toBe(agentId);
        const dump = join(root, `${agentId}.json`);
        await vi.waitFor(() => expect(existsSync(dump)).toBe(true));
        const rawArgv: string[] = JSON.parse(readFileSync(dump, 'utf8'));
        const settingsCount = rawArgv.filter(arg => arg === '--settings').length;
        expect(settingsCount).toBe(1);
        const settingsIndex = rawArgv.indexOf('--settings');
        const settingsPath = rawArgv[settingsIndex + 1]!;
        expect(existsSync(settingsPath)).toBe(true);
        expect(statSync(dirname(settingsPath)).mode & 0o777).toBe(0o700);
        expect(statSync(settingsPath).mode & 0o777).toBe(0o600);

        const argvWithoutSettings = [...rawArgv.slice(0, settingsIndex), ...rawArgv.slice(settingsIndex + 2)];
        expect(argvWithoutSettings).toEqual([
          '--wrapper-profile', agentId, '--session-id', session.id.replace(/^ses_/, ''),
          '--model', 'gateway/custom[1m]', '--disallowed-tools', 'EnterPlanMode,ExitPlanMode',
        ]);
        expect(rawArgv.join(' ')).not.toContain('fixture-relay-token');

        const settingsJson = JSON.parse(readFileSync(settingsPath, 'utf8'));
        expect(settingsJson.env?.CLAUDE_CONFIG_DIR).toBe(root);
        expect(settingsJson.env?.dutydeck_relay_token).toMatch(/^(?:fixture-relay-token|v1\.)/);
        expect(rawArgv.join(' ')).not.toContain(settingsJson.env?.dutydeck_relay_token);
        expect(settingsJson.hooks.PreToolUse).toEqual([
          {
            matcher: '^AskUserQuestion$',
            hooks: [{ type: 'command', command: 'dutydeck-fixture session native-ask', timeout: 1230 }],
          },
        ]);
      }
    } finally {
      for (const id of sessions) await service.runtime.stop(id);
      await service.close();
    }
  }, 30_000);

  tmuxIt.each([false, true])('recovers the original task and drains its queue across service restarts without duplicate submission (completed offline: %s)', async offline => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-service-turn-recovery-'));
    temporaryDirectories.push(root);
    const database = join(root, 'dutydeck.db');
    const seed = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    seed.close();
    const runner = join(root, 'runner.mjs');
    writeFileSync(runner, [
      `#!${process.execPath}`,
      "import { appendFileSync, existsSync } from 'node:fs';",
      "process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');",
      "process.stdout.write('Claude Code v2.1.267 (mock)\\r\\n❯ \\r\\n'); let input = ''; let count = 0;",
      // The real adapter pastes a multiline routing block, then Enter commits it.
      "process.stdin.on('data', data => {",
      "  input += data; const end = input.indexOf('\\x1b[201~');",
      "  if (end < 0 || !input.slice(end + 6).includes('\\r')) return;",
      "  input = ''; count++; const turn = count; appendFileSync('submissions', 'submitted\\n');",
      "  process.stdout.write('\\x1b[2J\\x1b[HWorking (esc to interrupt)\\r\\n');",
      "  const timer = setInterval(() => {",
      "    if (!existsSync('finish-' + turn)) return; clearInterval(timer);",
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
      const queued = await first.runtime.dispatch(session.id, 'continue after recovery');
      const before = createRepositories(database);
      let originalAttemptId: string;
      let originalSubmissionId: string;
      try {
        const attempt = before.execution.getTaskExecution(task.id)!.currentAttempt!;
        originalAttemptId = attempt.attemptId;
        originalSubmissionId = attempt.submission!.submissionId;
      } finally { before.close(); }
      await first.close();
      const persisted = createRepositories(database);
      try {
        const persistedTasks = await persisted.tasks.listBySession(session.id);
        expect(persistedTasks[0]?.status).toBe('reconcile_required');
        const taskExec = persisted.execution.getTaskExecution(task.id)!;
        expect(taskExec.attempts).toHaveLength(1);
        expect(taskExec.attempts[0]?.state).toBe('reconcile_required');
        expect(taskExec.attempts[0]?.submission?.recovery?.turnId)
          .toBe(backend.getDutydeckMetadata('turn_id'));
      } finally { persisted.close(); }
      const complete = () => { record('final answer'); writeFileSync(join(root, 'finish-1'), ''); };
      if (offline) {
        complete();
        await vi.waitFor(() => expect(backend.captureCurrentScreen()).toContain('Worked for 1s'));
      }
      restored = await startLocalServer({ webRoot: root, env: await serverEnv() });
      expect(backend.getPid()).toBe(originalPid);
      if (!offline) {
        await vi.waitFor(async () => expect((await restored!.runtime.getTasks(session.id))[0]?.status).toBe('running'));
        expect((await restored.runtime.getTasks(session.id))[1]?.status).toBe('queued');
        expect(readFileSync(join(root, 'submissions'), 'utf8')).toBe('submitted\n');
        // Repeating a restart while the same turn is busy must retain its identity.
        await restored.close();
        restored = await startLocalServer({ webRoot: root, env: await serverEnv() });
        expect(backend.getPid()).toBe(originalPid);
        complete();
      }
      await vi.waitFor(async () => expect((await restored!.runtime.getTasks(session.id))[0]?.status).toBe('completed'), { timeout: 25_000 });
      await vi.waitFor(() => expect(readFileSync(join(root, 'submissions'), 'utf8')).toBe('submitted\nsubmitted\n'), { timeout: 25_000 });
      expect((await restored.runtime.getTasks(session.id))[1]?.id).toBe(queued.id);
      record('queued answer'); writeFileSync(join(root, 'finish-2'), '');
      await vi.waitFor(async () => expect((await restored!.runtime.getTasks(session.id))[1]?.status).toBe('completed'), { timeout: 25_000 });
      const persistedAfter = createRepositories(database);
      try {
        const original = persistedAfter.execution.getTaskExecution(task.id)!;
        expect(original.attempts).toHaveLength(1);
        expect(original.currentAttempt?.attemptId).toBe(originalAttemptId!);
        expect(original.currentAttempt?.submission?.submissionId).toBe(originalSubmissionId!);
      } finally { persistedAfter.close(); }
      expect((await restored.runtime.getTasks(session.id)).map(item => ({ id: item.id, status: item.status })))
        .toEqual([{ id: task.id, status: 'completed' }, { id: queued.id, status: 'completed' }]);
      const events = await restored.runtime.getEvents(session.id);
      for (const text of ['before restart', 'final answer', 'queued answer']) {
        expect(events.filter(event => event.type === 'text' && (event.data as any).text === text)).toHaveLength(1);
      }
      expect(events.filter(event => event.type === 'completed')).toHaveLength(2);
      expect(readFileSync(join(root, 'submissions'), 'utf8')).toBe('submitted\nsubmitted\n');
      await restored.runtime.stop(session.id, { kind: 'installation_owner', id: 'installation_owner' });
      expect(spawnSync('tmux', ['has-session', '-t', backend.sessionName]).status).not.toBe(0);
    } finally {
      await first.close();
      await restored?.close();
    }
  }, 90_000);

  tmuxIt('preserves pane across service restart with durable queued task blocked from unverified execution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-persistent-pty-'));
    temporaryDirectories.push(root);
    const database = join(root, 'dutydeck.db');
    const seed = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    seed.close();
    const fakeRunner = join(root, 'fake-claude-runner.sh');
    writeFileSync(fakeRunner, [
      '#!/bin/sh',
      "printf 'Claude Code v2.1.267 (mock)\\n❯ \\n'",
      'while IFS= read -r line; do',
      "  printf '\\033[2J\\033[HClaude Code v2.1.267 (mock)\\nhandled:%s\\n✳ Worked for 1s\\n❯ \\n' \"$line\"",
      '  for f in "$CLAUDE_CONFIG_DIR"/projects/*/*.jsonl; do',
      '    if [ -f "$f" ]; then',
      '      printf \'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"handled:%s"}],"stop_reason":"end_turn"}}\\n\' "$line" >> "$f"',
      '    fi',
      '  done',
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
        env: { CLAUDE_CONFIG_DIR: root },
        capabilities: { pause: false, resume: false },
      }]),
    });

    const first = await startLocalServer({ webRoot: root, env: await serverEnv() });
    let restored: Awaited<ReturnType<typeof startLocalServer>> | undefined;
    let sessionName: string | undefined;
    try {
      const session = await first.runtime.start({ agentId: 'claude-code' });
      const backend = createProductionPtyBackend(session.id);
      sessionName = backend.sessionName;
      tmuxSessions.push(backend.sessionName);

      // 先构造真实 assistant transcript 并断言首轮 completed
      const project = join(root, 'projects', realpathSync(root).replace(/[^A-Za-z0-9-]/g, '-'));
      mkdirSync(project, { recursive: true });
      const transcript = join(project, session.id.replace(/^ses_/, '') + '.jsonl');
      writeFileSync(transcript, '');

      const firstTask = await first.runtime.send(session.id, 'before daemon restart');
      expect(firstTask.status).toBe('completed');
      expect((await first.runtime.getTasks(session.id))[0]?.status).toBe('completed');

      const originalPid = Number(spawnSync(
        'tmux',
        ['display-message', '-p', '-t', backend.sessionName, '#{pane_pid}'],
        { encoding: 'utf8' },
      ).stdout.trim());
      expect(originalPid).toBeGreaterThan(0);

      await first.close();
      expect(spawnSync('tmux', ['has-session', '-t', backend.sessionName]).status).toBe(0);

      // 重开后同原 pane 仍在，新任务可 durable queued 但资源未证不继续发送
      restored = await startLocalServer({ webRoot: root, env: await serverEnv() });
      expect(restored.runtime.getDriver(session.id)).toBeUndefined();

      const restoredPid = Number(spawnSync(
        'tmux',
        ['display-message', '-p', '-t', backend.sessionName, '#{pane_pid}'],
        { encoding: 'utf8' },
      ).stdout.trim());
      expect(restoredPid).toBe(originalPid);

      const nextTask = await restored.runtime.dispatch(session.id, 'after daemon restart');
      expect(nextTask.status).toBe('queued');
      expect((await restored.runtime.getTasks(session.id)).map(task => task.prompt)).toEqual([
        'before daemon restart',
        'after daemon restart',
      ]);
      expect((await restored.runtime.getTasks(session.id))[1]?.status).toBe('queued');

      // 资源未被安全认领时，stop 不得静默回收该 pane：必须保留 stop blocker 并拒绝，
      // 而不是假装已干净停止。service 关闭时 pane 保持存活，由本测试的 afterEach 清理。
      await expect(restored.runtime.stop(session.id)).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
      expect((await restored.runtime.getTasks(session.id))[1]?.status).toBe('queued');
      expect(backend.getPid()).toBe(originalPid);
      await expect(restored.runtime.stop(session.id, { kind: 'installation_owner', id: 'installation_owner' }))
        .rejects.toMatchObject({ code: 'SESSION_RESOURCE_BLOCKED' });
      expect((await restored.runtime.getTasks(session.id))[1]?.status).toBe('cancelled');
      expect(backend.getPid()).toBe(originalPid);
    } finally {
      await first.close();
      await restored?.close();
    }
    // 资源未经安全认领时，service 关闭不得自动 kill 这个原 pane（保守保留待人工核对）；
    // tmux 会话由 afterEach 的 kill-session 兜底清理。
    expect(spawnSync('tmux', ['has-session', '-t', sessionName]).status).toBe(0);
  }, 60_000);
});

describe('production schedule foundation wiring', () => {
  it('keeps legacy schedules blocked across restarts while wiring only the collaboration executor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-schedule-service-'));
    temporaryDirectories.push(root);
    const database = join(root, 'dutydeck.db');
    const bootstrap = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
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
        executorWired: true, executableNamespace: 'collaboration', uiEntryReady: true, readiness: 'offline_management_ready'
      });
      expect(capabilities.body.blockers).toEqual([]);

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
      const enableLegacy = await call(firstBase, '/api/foundation/schedules/schedule-service', {
        method: 'PATCH', body: JSON.stringify({ expectedRevision: 1, state: 'enabled' })
      });
      expect(enableLegacy.response.status).toBe(409);
      expect(enableLegacy.body.error.code).toBe('SCHEDULE_ENABLE_FORBIDDEN');
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
