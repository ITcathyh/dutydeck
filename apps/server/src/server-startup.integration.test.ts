import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type AgentConfig } from '@dutydeck/shared';
import { startLocalServer, type LocalServer } from './service.js';

const directories: string[] = [];
const servers: LocalServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {
      // Best-effort teardown between test cases.
    }
  }
  for (const dir of directories.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function allocatePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Failed to allocate port'));
        return;
      }
      const port = address.port;
      probe.close(error => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function fakeAgentConfig(cwd: string): AgentConfig {
  const fixturePath = resolve(process.cwd(), 'tests/fixtures/process-driver-turn-agent.mjs');
  return {
    id: 'fake-agent',
    name: 'Fake Turn Agent',
    command: process.execPath,
    args: [fixturePath],
    protocol: 'pipe',
    cwd,
    env: {},
    permissionMode: 'full-trust',
    timeout: 30,
    capabilities: { pause: false, resume: true },
    builtin: false,
  };
}

describe('Server startup integration with real SQLite file', () => {
  it('initializes fresh database directly with ledger_v1 authority and executes tasks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-startup-fresh-'));
    directories.push(dir);
    const database = join(dir, 'fresh.sqlite');
    const port = await allocatePort();
    const agent = fakeAgentConfig(dir);

    const server = await startLocalServer({
      webRoot: dir,
      env: {
        ...process.env,
        HOME: dir,
        NODE_ENV: 'test',
        DUTYDECK_DATABASE_URL: database,
        DUTYDECK_DEFAULT_CWD: dir,
        DUTYDECK_PORT: String(port),
        DUTYDECK_HOST: '127.0.0.1',
        DUTYDECK_AUTH: 'false',
        DUTYDECK_AGENTS_JSON: JSON.stringify([agent]),
        DUTYDECK_DISABLE_LARK_LISTENER: 'true',
      },
    });
    servers.push(server);

    // Verify authority directly in SQLite file
    const sqlite = new Database(database, { readonly: true });
    try {
      const row = sqlite.prepare('SELECT authority FROM execution_authority WHERE id = 1').get() as
        | { authority?: string }
        | undefined;
      expect(row?.authority).toBe('ledger_v1');
    } finally {
      sqlite.close();
    }

    // Start a session and execute a task to verify ledger task execution
    const session = await server.runtime.start({ agentId: agent.id });
    expect(session.state).toBe('idle');

    const dispatched = await server.runtime.dispatch(session.id, 'hello startup integration');
    expect(dispatched.id).toMatch(/^task_/);

    // Poll until task reaches a terminal state
    let completed = false;
    for (let i = 0; i < 100; i++) {
      const currentTasks = await server.runtime.getTasks(session.id);
      const found = currentTasks.find(t => t.id === dispatched.id);
      if (found && (found.status === 'completed' || found.status === 'failed')) {
        expect(found.status).toBe('completed');
        completed = true;
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(completed).toBe(true);

    // Session remains persistent and idle after task completion
    const currentSession = await server.runtime.getSession(session.id);
    expect(currentSession?.state).toBe('idle');

    // Clean shutdown releases database claim
    await server.close();
    const serverIndex = servers.indexOf(server);
    if (serverIndex >= 0) servers.splice(serverIndex, 1);

    // Can reopen for management without busy errors
    const maintenanceRepos = createRepositories(database, { mode: 'management' });
    try {
      expect(maintenanceRepos.execution.authority()).toBe('ledger_v1');
    } finally {
      maintenanceRepos.close();
    }
  });

  it('rejects startup on legacy database, releases resources, and preserves legacy data for offline upgrade', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-startup-legacy-'));
    directories.push(dir);
    const database = join(dir, 'legacy.sqlite');
    const port = await allocatePort();
    const agent = fakeAgentConfig(dir);

    // Seed an existing legacy database with historical session and task data
    const seedRepos = createRepositories(database, { newDatabaseAuthority: 'legacy' });
    const historicalTime = '2026-01-01T00:00:00.000Z';
    await seedRepos.sessions.save({
      id: 'ses_legacy_historical',
      agentId: agent.id,
      state: 'completed',
      cwd: dir,
      permissionMode: 'full-trust',
      protocol: 'pipe',
      runId: 'run_legacy_seed',
      createdAt: historicalTime,
      updatedAt: historicalTime,
    });
    await seedRepos.tasks.save({
      id: 'task_legacy_historical',
      sessionId: 'ses_legacy_historical',
      prompt: 'historical prompt before ledger',
      status: 'completed',
      createdAt: historicalTime,
      updatedAt: historicalTime,
    });
    expect(seedRepos.execution.authority()).toBe('legacy');
    seedRepos.close();

    // Attempting to start the service must reject with EXECUTION_UPGRADE_REQUIRED
    let startupError: unknown;
    try {
      const server = await startLocalServer({
        webRoot: dir,
        env: {
          ...process.env,
          HOME: dir,
          NODE_ENV: 'test',
          DUTYDECK_DATABASE_URL: database,
          DUTYDECK_DEFAULT_CWD: dir,
          DUTYDECK_PORT: String(port),
          DUTYDECK_HOST: '127.0.0.1',
          DUTYDECK_AUTH: 'false',
          DUTYDECK_AGENTS_JSON: JSON.stringify([agent]),
          DUTYDECK_DISABLE_LARK_LISTENER: 'true',
        },
      });
      servers.push(server);
    } catch (error) {
      startupError = error;
    }

    expect(startupError).toBeInstanceOf(RuntimeError);
    expect((startupError as RuntimeError).code).toBe('EXECUTION_UPGRADE_REQUIRED');

    // Verify resources were released: database is not locked by runtime claim
    // and historical data / legacy authority remain intact
    const maintenanceRepos = createRepositories(database, { mode: 'management' });
    try {
      expect(maintenanceRepos.execution.authority()).toBe('legacy');
      const preservedSession = await maintenanceRepos.sessions.get('ses_legacy_historical');
      expect(preservedSession).toBeDefined();
      expect(preservedSession?.state).toBe('completed');
      const preservedTasks = await maintenanceRepos.tasks.listBySession('ses_legacy_historical');
      expect(preservedTasks).toHaveLength(1);
      const preservedTask = preservedTasks[0];
      expect(preservedTask).toBeDefined();
      expect(preservedTask?.prompt).toBe('historical prompt before ledger');

      // Now perform offline database upgrade to verify it can be cleanly upgraded
      const upgradeSnapshot = maintenanceRepos.execution.upgradeLegacy();
      expect(upgradeSnapshot.after.authority).toBe('ledger_v1');
      expect(maintenanceRepos.execution.authority()).toBe('ledger_v1');
    } finally {
      maintenanceRepos.close();
    }
  });
});
