import Database from 'better-sqlite3';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { dutydeckPtySessionName } from '@dutydeck/pty-driver';
import {
  DatabaseCliError,
  runDatabaseExecutionStatus,
  runDatabaseRetireLegacy,
  runDatabaseUpgradeExecution
} from './database-cli.js';

describe('database-cli', () => {
  const directories: string[] = [];
  const children: Array<{ child: ChildProcess; exit: Promise<number | null> }> = [];

  afterEach(async () => {
    for (const { child, exit } of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        // Give it a short moment before SIGKILL
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 200).unref();
      }
      await exit;
    }
    for (const dir of directories.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dutydeck-db-cli-test-'));
    directories.push(dir);
    return dir;
  }

  function tempFile(name = 'test.db'): string {
    return join(tempDir(), name);
  }

  function spawnCli(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const cliEntry = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--conditions=development', '--import', 'tsx', cliEntry, ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          pnpm_config_verify_deps_before_run: 'false',
          DUTYDECK_DISABLE_LARK_LISTENER: 'true'
        }
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    const exit = new Promise<number | null>(resolve => {
      child.once('exit', code => resolve(code));
    });
    children.push({ child, exit });

    return exit.then(exitCode => ({ exitCode, stdout, stderr }));
  }

  describe('runDatabaseExecutionStatus', () => {
    it('requires --database option', async () => {
      await expect(runDatabaseExecutionStatus({ database: '' })).rejects.toThrow(DatabaseCliError);
    });

    it('returns missing when file does not exist without creating files', async () => {
      const nonExistent = join(tempDir(), 'sub', 'non-existent.db');
      const result = await runDatabaseExecutionStatus({ database: nonExistent });
      expect(result.status).toBe('missing');
      expect(existsSync(nonExistent)).toBe(false);
    });

    it('inspects uninitialized database accurately', async () => {
      const dbPath = tempFile();
      const db = new Database(dbPath);
      db.close();

      const result = await runDatabaseExecutionStatus({ database: dbPath });
      expect(result.status).toBe('uninitialized');
      expect(result.counts?.tasks).toBe(0);
    });

    it('inspects legacy database and reads schema version and task counts', async () => {
      const dbPath = tempFile();
      const repos = createRepositories(dbPath, { newDatabaseAuthority: 'legacy' });
      try {
        await repos.sessions.save({
          id: 'session-1',
          agentId: 'agent-1',
          state: 'idle',
          cwd: '/tmp',
          runId: 'run-1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        expect(repos.tasks.create).toBeDefined();
        await repos.tasks.create!({
          id: 'task-1',
          sessionId: 'session-1',
          prompt: 'legacy task',
          status: 'queued',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      } finally {
        repos.close();
      }

      const db = new Database(dbPath, { readonly: true });
      let schemaVersion: number;
      try {
        schemaVersion = (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version;
      } finally {
        db.close();
      }

      const result = await runDatabaseExecutionStatus({ database: dbPath });
      expect(result.status).toBe('legacy');
      expect(result.authority).toBe('legacy');
      expect(result.schemaVersion).toBe(schemaVersion);
      expect(result.counts?.tasks).toBe(1);
    });
  });

  describe('runDatabaseUpgradeExecution', () => {
    it('refuses non-existent database paths and does not create files', async () => {
      const nonExistent = join(tempDir(), 'non-existent.db');
      await expect(runDatabaseUpgradeExecution({ database: nonExistent })).rejects.toThrow(
        expect.objectContaining({ code: 'DATABASE_NOT_FOUND' })
      );
      expect(existsSync(nonExistent)).toBe(false);
    });

    it('refuses directory paths', async () => {
      const dir = tempDir();
      await expect(runDatabaseUpgradeExecution({ database: dir })).rejects.toThrow(
        expect.objectContaining({ code: 'DATABASE_UNSAFE_FILE' })
      );
    });

    it('refuses unsupported schema databases', async () => {
      const dbPath = tempFile();
      const db = new Database(dbPath);
      db.exec('CREATE TABLE custom_data (id INT);');
      db.close();

      await expect(runDatabaseUpgradeExecution({ database: dbPath })).rejects.toThrow(
        expect.objectContaining({ code: 'DATABASE_UNSUPPORTED' })
      );
    });

    it('upgrades real non-empty legacy database to ledger_v1, preserves queue order, input and unknown resources', async () => {
      const dbPath = tempFile();
      const repos = createRepositories(dbPath, { newDatabaseAuthority: 'legacy' });
      try {
        await repos.sessions.save({
          id: 'session-order',
          agentId: 'agent-1',
          state: 'idle',
          cwd: '/tmp',
          runId: 'run-order',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        });
        // Task 1: queued first
        expect(repos.tasks.create).toBeDefined();
        await repos.tasks.create!({
          id: 'task-q1',
          sessionId: 'session-order',
          prompt: 'first task',
          status: 'queued',
          createdAt: '2026-01-01T00:01:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z'
        });
        // Task 2: queued second
        await repos.tasks.create!({
          id: 'task-q2',
          sessionId: 'session-order',
          prompt: 'second task',
          status: 'queued',
          createdAt: '2026-01-01T00:02:00.000Z',
          updatedAt: '2026-01-01T00:02:00.000Z'
        });
        // Task 3: completed
        await repos.tasks.create!({
          id: 'task-done',
          sessionId: 'session-order',
          prompt: 'done task',
          status: 'completed',
          createdAt: '2026-01-01T00:00:30.000Z',
          updatedAt: '2026-01-01T00:00:30.000Z'
        });
      } finally {
        repos.close();
      }

      const result = await runDatabaseUpgradeExecution({ database: dbPath });
      expect(result.authority).toBe('ledger_v1');
      expect(result.before.authority).toBe('legacy');
      expect(result.before.counts.tasks).toBe(3);
      expect(result.before.counts.attempts).toBe(0);
      expect(result.before.counts.registeredAccess).toBe(1);
      expect(result.after.authority).toBe('ledger_v1');
      expect(result.after.counts.tasks).toBe(3);
      expect(result.after.counts.attempts).toBe(1); // the completed task has 1 attempt
      expect(result.after.counts.resources).toBe(1); // legacy unknown resource created
      expect(result.after.counts.registeredAccess).toBe(1);

      // Verify queue order preserved
      const verifyDb = new Database(dbPath, { readonly: true });
      try {
        const q1 = verifyDb.prepare('SELECT queue_position FROM tasks WHERE id = ?').get('task-q1') as { queue_position: number };
        const q2 = verifyDb.prepare('SELECT queue_position FROM tasks WHERE id = ?').get('task-q2') as { queue_position: number };
        expect(q1.queue_position).toBe(1);
        expect(q2.queue_position).toBe(2);

        // Verify legacy resource has stage='unknown' and kind='legacy'
        const resource = verifyDb.prepare('SELECT json FROM driver_resources WHERE session_id = ?').get('session-order') as { json: string };
        const parsedResource = JSON.parse(resource.json);
        expect(parsedResource.kind).toBe('legacy');
        expect(parsedResource.stage).toBe('unknown');

        // Verify task requests recorded
        const request = verifyDb.prepare('SELECT * FROM task_requests WHERE task_id = ?').get('task-q1') as { namespace: string; request_digest: string };
        expect(request.namespace).toBe('legacy');
        expect(request.request_digest).toBe('legacy_unverifiable');
      } finally {
        verifyDb.close();
      }

      // Idempotence check: repeating upgrade on an already upgraded database succeeds idempotently
      const repeatResult = await runDatabaseUpgradeExecution({ database: dbPath });
      expect(repeatResult.authority).toBe('ledger_v1');
      expect(repeatResult.after.authority).toBe('ledger_v1');
      expect(repeatResult.after.counts.tasks).toBe(3);

      // Verify connection was released and can be opened in write mode cleanly
      const reopened = createRepositories(dbPath);
      reopened.close();
    });

    // Note: this test verifies isolation using another in-process RepositoryBundle + claim writer; independent Node process isolation is verified by dedicated probe.
    it('isolates upgrade snapshot from subsequent writer after control release (F1 regression)', async () => {
      const dbPath = tempFile('isolated-snapshot.db');
      const repos = createRepositories(dbPath, { newDatabaseAuthority: 'legacy' });
      repos.close();

      let injected = false;
      let postCloseWriterBlockers: any = null;
      const originalClose = Database.prototype.close;
      Database.prototype.close = function (...args: any[]) {
        let isFinalManagementClose = false;
        if (!injected && this.name === dbPath && !this.readonly && this.open) {
          try {
            isFinalManagementClose = (this.prepare('SELECT COUNT(*) AS n FROM dutydeck_access').get() as { n: number }).n === 0;
          } catch {}
        }
        const out = Reflect.apply(originalClose, this, args);
        if (isFinalManagementClose) {
          injected = true;
          // Independent compliant writer acquires runtime and creates new resource AFTER management close
          const runtimeRepos = createRepositories(dbPath, { mode: 'runtime' });
          const claim = runtimeRepos.control.attachRuntime('post-close-writer');
          try {
            const bound = runtimeRepos.execution.bind(claim);
            bound.createSession({
              id: 'raced',
              runId: 'run-raced',
              agentId: 'a',
              cwd: '/tmp',
              state: 'idle',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z'
            });
            bound.beforeCreate(
              { sessionId: 'raced', runId: 'run-raced' },
              { resourceId: 'raced-resource', kind: 'operation' }
            );
            postCloseWriterBlockers = runtimeRepos.execution.getSessionResourceBlockers('raced');
          } finally {
            claim.release();
            runtimeRepos.close();
          }
        }
        return out;
      };

      let report: any;
      try {
        report = await runDatabaseUpgradeExecution({ database: dbPath });
      } finally {
        Database.prototype.close = originalClose;
      }

      expect(injected).toBe(true);
      expect(postCloseWriterBlockers).toEqual([
        expect.objectContaining({ sessionId: 'raced', resourceId: 'raced-resource' })
      ]);
      // The upgrade report must NOT be contaminated by the post-close writer!
      // Its after counts and blockers must reflect the snapshot inside the maintenance window.
      expect(report.after.counts.resources).toBe(0);
      expect(report.blockers.length).toBe(0);
    });

    it('captures before counts after preflight inspect close and before exclusive maintenance acquisition (Window 1)', async () => {
      const dbPath = tempFile('window1-preflight-race.db');
      createRepositories(dbPath).close();
      const originalClose = Database.prototype.close;
      let injected = false;
      Database.prototype.close = function (...args: any[]) {
        const target = !injected && this.name === dbPath && this.readonly;
        const result = Reflect.apply(originalClose, this, args);
        if (target) {
          injected = true;
          const writerScript = `
            import assert from "node:assert/strict";
            import { createRepositories } from "@dutydeck/storage";
            const path = process.argv[1];
            const p = createRepositories(path);
            try {
              await p.sessions.save({ id: "s", runId: "r", agentId: "a", state: "idle", cwd: "/tmp", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
              assert.ok(p.tasks.create);
              await p.tasks.create({ id: "t", sessionId: "s", prompt: "one", status: "completed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
            } finally {
              p.close();
            }
          `;
          const writerRes = spawnSync(
            process.execPath,
            ['--conditions=development', '--import', 'tsx', '--input-type=module', '-e', writerScript, dbPath],
            {
              cwd: process.cwd(),
              encoding: 'utf8',
              timeout: 30000,
              env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', DUTYDECK_DISABLE_LARK_LISTENER: 'true' }
            }
          );
          expect(writerRes.status).toBe(0);
          expect(writerRes.stderr).toBe('');
        }
        return result;
      };

      let report: any;
      try {
        report = await runDatabaseUpgradeExecution({ database: dbPath });
      } finally {
        Database.prototype.close = originalClose;
      }

      expect(injected).toBe(true);
      expect(report.before.counts.tasks).toBe(1);
      expect(report.before.counts.attempts).toBe(0);
      expect(report.before.counts.registeredAccess).toBe(1);
      expect(report.after.counts.tasks).toBe(1);
      expect(report.after.counts.attempts).toBe(1);
      expect(report.after.counts.resources).toBe(1);
      expect(report.blockers.length).toBe(1);
      expect(report.after.counts.registeredAccess).toBe(1);
    });

    it.each(['legacy', 'ledger_v1'] as const)(
      'denies competing runtime claim during snapshot capture and ensures atomic maintenance isolation (%s, Window 2)',
      async authority => {
        const dbPath = tempFile(`window2-capture-${authority}.db`);
        const init = createRepositories(dbPath);
        await init.sessions.save({
          id: 's',
          runId: 'r',
          agentId: 'a',
          state: 'idle',
          cwd: '/tmp',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        });
        expect(init.tasks.create).toBeDefined();
        await init.tasks.create!({
          id: 't',
          sessionId: 's',
          prompt: 'one',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        });
        if (authority === 'ledger_v1') {
          init.execution.upgradeLegacy();
        }
        init.close();

        const temporary = new Database(dbPath);
        const proto = Object.getPrototypeOf(temporary.prepare('SELECT 1'));
        temporary.close();

        const originalGet = proto.get;
        const originalAll = proto.all;
        let resourceCountReads = 0;
        let attempted = false;
        const captures: Array<{ sql: string; inTransaction: boolean; phase: string }> = [];
        let competingResult: { acquired: boolean; code?: string } | undefined;

        const claimScript = `
          import { createRepositories } from "@dutydeck/storage";
          const path = process.argv[1];
          let p, c;
          try {
            p = createRepositories(path, { mode: "runtime" });
            c = p.control.attachRuntime("during-capture");
            console.log(JSON.stringify({ acquired: true }));
          } catch (e) {
            console.log(JSON.stringify({ acquired: false, code: e.code }));
          } finally {
            if (c) c.release();
            if (p) p.close();
          }
        `;

        const observe = (stmt: any) => {
          if (stmt.database.name !== dbPath) return;
          const sql = stmt.source as string;
          if (!sql.includes('COUNT(*) AS c FROM') && !sql.startsWith('SELECT json FROM driver_resources WHERE session_id=')) return;

          const inTransaction = stmt.database.inTransaction as boolean;
          const phaseRow = stmt.database.prepare('SELECT phase FROM dutydeck_control WHERE id=1').get() as { phase: string };
          captures.push({ sql, inTransaction, phase: phaseRow.phase });

          expect(inTransaction).toBe(true);
          expect(phaseRow.phase).toBe('maintenance');

          if (sql === 'SELECT COUNT(*) AS c FROM driver_resources' && ++resourceCountReads === 2) {
            attempted = true;
            const res = spawnSync(
              process.execPath,
              ['--conditions=development', '--import', 'tsx', '--input-type=module', '-e', claimScript, dbPath],
              {
                cwd: process.cwd(),
                encoding: 'utf8',
                timeout: 30000,
                env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', DUTYDECK_DISABLE_LARK_LISTENER: 'true' }
              }
            );
            expect(res.status).toBe(0);
            competingResult = JSON.parse(res.stdout.trim());
            expect(competingResult?.acquired).toBe(false);
            expect(['SQLITE_BUSY', 'DATABASE_MAINTENANCE']).toContain(competingResult?.code);
          }
        };

        proto.get = function (...args: any[]) {
          const result = Reflect.apply(originalGet, this, args);
          observe(this);
          return result;
        };
        proto.all = function (...args: any[]) {
          const result = Reflect.apply(originalAll, this, args);
          observe(this);
          return result;
        };

        let captured: any;
        try {
          captured = await runDatabaseUpgradeExecution({ database: dbPath });
        } finally {
          proto.get = originalGet;
          proto.all = originalAll;
        }

        expect(attempted).toBe(true);
        expect(captured.before.authority).toBe(authority);
        expect(captured.after.authority).toBe('ledger_v1');
        expect(captured.after.counts.resources).toBe(1);
        expect(captured.blockers.length).toBe(1);
        expect(captures.some(c => c.sql.startsWith('SELECT json FROM driver_resources'))).toBe(true);
        if (authority === 'ledger_v1') {
          expect(captured.before).toEqual(captured.after);
        }

        // After upgrade and close finish, a new runtime can successfully attach
        const afterRepos = createRepositories(dbPath, { mode: 'runtime' });
        const claim = afterRepos.control.attachRuntime('after-capture');
        expect(() => claim.assertCurrent()).not.toThrow();
        claim.release();
        afterRepos.close();
      }
    );

    it('rejects upgrade when active runtime is running, without stopping runtime', async () => {
      const dbPath = tempFile('active-runtime.db');
      const runtimeRepos = createRepositories(dbPath, { mode: 'runtime' });
      const claim = runtimeRepos.control.attachRuntime('runtime-worker-1');

      try {
        // Status should be readable during active runtime
        const status = await runDatabaseExecutionStatus({ database: dbPath });
        expect(status.status).toBe('legacy');
        expect(status.control?.hasRuntime).toBe(true);

        // Upgrade must be rejected because runtime is actively attached
        await expect(runDatabaseUpgradeExecution({ database: dbPath })).rejects.toThrow(
          expect.objectContaining({ code: expect.stringMatching(/DATABASE_(?:UPGRADE_BUSY|RUNTIME_STILL_ATTACHED)/) })
        );

        // Runtime must NOT be stopped! Claim remains valid
        expect(() => claim.assertCurrent()).not.toThrow();
      } finally {
        claim.release();
        runtimeRepos.close();
      }
    });
  });

  describe('ChildProcess CLI blackbox execution', () => {
    it('executes database execution-status via real subprocess and outputs single JSON line', async () => {
      const dbPath = tempFile('cli-sub-status.db');
      const repos = createRepositories(dbPath, { newDatabaseAuthority: 'legacy' });
      repos.close();

      const { exitCode, stdout, stderr } = await spawnCli([
        'database',
        'execution-status',
        '--database',
        dbPath
      ]);

      expect(exitCode).toBe(0);
      expect(stderr.trim()).toBe('');

      // Must be a single line of valid JSON
      const lines = stdout.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]!);
      expect(parsed).toMatchObject({
        ok: true,
        database: dbPath,
        status: 'legacy',
        authority: 'legacy'
      });

      // Ensure no environment variables or credentials leaked into output
      expect(stdout).not.toMatch(/(?:DUTYDECK_AUTH|TOKEN|SECRET|PASSWORD)/i);
    });

    it('executes database upgrade-execution via real subprocess and handles errors with exit code 1', async () => {
      const nonExistent = join(tempDir(), 'does-not-exist.db');

      const { exitCode, stdout, stderr } = await spawnCli([
        'database',
        'upgrade-execution',
        '--database',
        nonExistent
      ]);

      expect(exitCode).toBe(1);
      const lines = stderr.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);

      const errorJson = JSON.parse(lines[0]!);
      expect(errorJson).toMatchObject({
        ok: false,
        error: {
          code: 'DATABASE_NOT_FOUND'
        }
      });
    });

    it('executes real upgrade-execution lifecycle via subprocess end-to-end', async () => {
      const dbPath = tempFile('cli-sub-upgrade.db');
      const repos = createRepositories(dbPath, { newDatabaseAuthority: 'legacy' });
      await repos.sessions.save({
        id: 's-cli',
        agentId: 'a-1',
        state: 'idle',
        cwd: '/tmp',
        runId: 'r-cli',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      expect(repos.tasks.create).toBeDefined();
      await repos.tasks.create!({
        id: 't-cli',
        sessionId: 's-cli',
        prompt: 'cli task',
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      repos.close();

      const { exitCode, stdout } = await spawnCli([
        'database',
        'upgrade-execution',
        '--database',
        dbPath
      ]);

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed).toMatchObject({
        ok: true,
        database: dbPath,
        authority: 'ledger_v1',
        before: {
          authority: 'legacy',
          counts: { tasks: 1, attempts: 0, registeredAccess: 1 }
        },
        after: {
          authority: 'ledger_v1',
          counts: { tasks: 1, attempts: 1, registeredAccess: 1 }
        }
      });

      // Follow up with execution-status subprocess to verify persistence
      const statusRes = await spawnCli([
        'database',
        'execution-status',
        '--database',
        dbPath
      ]);
      expect(statusRes.exitCode).toBe(0);
      const statusJson = JSON.parse(statusRes.stdout.trim());
      expect(statusJson).toMatchObject({
        ok: true,
        status: 'ledger_v1',
        authority: 'ledger_v1'
      });
    });

    it('executes database execution-status without database and outputs single JSON line to stderr with exit code 1', async () => {
      const { exitCode, stdout, stderr } = await spawnCli([
        'database',
        'execution-status'
      ]);

      expect(exitCode).toBe(1);
      expect(stdout.trim()).toBe('');
      const lines = stderr.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      const err = JSON.parse(lines[0]!);
      expect(err).toMatchObject({
        ok: false,
        error: {
          code: 'DATABASE_OPTION_REQUIRED'
        }
      });
    });

    it('executes database upgrade-execution without database and outputs single JSON line to stderr with exit code 1', async () => {
      const { exitCode, stdout, stderr } = await spawnCli([
        'database',
        'upgrade-execution'
      ]);

      expect(exitCode).toBe(1);
      expect(stdout.trim()).toBe('');
      const lines = stderr.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      const err = JSON.parse(lines[0]!);
      expect(err).toMatchObject({
        ok: false,
        error: {
          code: 'DATABASE_OPTION_REQUIRED'
        }
      });
    });
  });
});

describe('database retire-legacy command', () => {
  const directories: string[] = [];
  const sockets: string[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) { try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch {} }
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const directory = (prefix: string) => { const value = mkdtempSync(join(tmpdir(), prefix)); directories.push(value); return value; };
  const scope = (database: string, tmuxSocket: string) => ({ database, hostname: hostname(), uid: process.getuid!(), tmuxSocket });
  const legacyDatabase = async () => {
    const file = join(directory('dutydeck-db-retire-'), 'test.db');
    const repositories = createRepositories(file);
    const time = '2026-09-15T00:00:00.000Z';
    await repositories.sessions.save({ id: 'ses_cli', agentId: 'ccflash', state: 'completed', cwd: '/workspace', protocol: 'pty-cli', runId: 'run_cli', createdAt: time, updatedAt: time });
    await repositories.tasks.save({ id: 'task_cli', sessionId: 'ses_cli', prompt: 'done', status: 'completed', createdAt: time, updatedAt: time });
    repositories.execution.upgradeLegacy(); repositories.close();
    return file;
  };

  it('retires a migrated session in an explicit private tmux scope and replays idempotently', async () => {
    const file = await legacyDatabase();
    const tmuxDirectory = directory('dutydeck-retire-scope-'); chmodSync(tmuxDirectory, 0o700);
    const tmuxSocket = join(tmuxDirectory, 'socket'); sockets.push(tmuxSocket);
    execFileSync('tmux', ['-S', tmuxSocket, 'new-session', '-d', '-s', 'unrelated', 'sleep', '60']);
    const first = await runDatabaseRetireLegacy(scope(file, tmuxSocket));
    expect(first.sessions).toEqual([{ sessionId: 'ses_cli', status: 'retired' }]);
    expect(first).toMatchObject({ retired: 1, replayed: 0, blocked: 0 });
    await expect(runDatabaseRetireLegacy(scope(file, tmuxSocket))).resolves.toMatchObject({ retired: 0, replayed: 1, blocked: 0 });
    const check = createRepositories(file);
    expect(await check.sessions.get('ses_cli')).toMatchObject({ state: 'stopped', archivedAt: expect.any(String), error: expect.stringContaining('原上下文未自动恢复') });
    check.close();
  });

  it('checks maintenance isolation before stopping an owned tmux target', async () => {
    const file = await legacyDatabase();
    const live = createRepositories(file, { mode: 'runtime', upgrade: 'never' });
    const claim = live.control.attachRuntime('runtime-test');
    const tmuxDirectory = directory('dutydeck-live-scope-'); chmodSync(tmuxDirectory, 0o700);
    const tmuxSocket = join(tmuxDirectory, 'socket'); sockets.push(tmuxSocket);
    const target = dutydeckPtySessionName('ses_cli');
    execFileSync('tmux', ['-S', tmuxSocket, 'new-session', '-d', '-s', target, 'sleep', '60']);
    execFileSync('tmux', ['-S', tmuxSocket, 'set-option', '-t', target, '@dutydeck_owner_id', 'dutydeck:ses_cli']);
    await expect(runDatabaseRetireLegacy(scope(file, tmuxSocket))).rejects.toMatchObject({ code: 'DATABASE_RUNTIME_STILL_ATTACHED' });
    expect(() => execFileSync('tmux', ['-S', tmuxSocket, 'has-session', '-t', `=${target}`])).not.toThrow();
    claim.release(); live.close();
  });

  it('reports one unsupported session as blocked while retiring another verified session', async () => {
    const file = join(directory('dutydeck-db-mixed-retire-'), 'test.db');
    const repositories = createRepositories(file);
    const time = '2026-09-15T00:00:00.000Z';
    for (const [id, protocol] of [['ses_bad', 'jsonl'], ['ses_corrupt', 'pty-cli'], ['ses_good', 'pty-cli']] as const) {
      await repositories.sessions.save({ id, agentId: 'ccflash', state: 'completed', cwd: '/workspace', protocol, runId: `run_${id}`, createdAt: time, updatedAt: time });
      await repositories.tasks.save({ id: `task_${id}`, sessionId: id, prompt: 'done', status: 'completed', createdAt: time, updatedAt: time });
    }
    repositories.execution.upgradeLegacy(); repositories.close();
    const corrupt = new Database(file);
    corrupt.prepare("INSERT INTO configs VALUES ('legacy_retirement:ses_corrupt','{invalid')").run(); corrupt.close();
    const tmuxDirectory = directory('dutydeck-mixed-scope-'); chmodSync(tmuxDirectory, 0o700);
    const tmuxSocket = join(tmuxDirectory, 'socket'); sockets.push(tmuxSocket);
    execFileSync('tmux', ['-S', tmuxSocket, 'new-session', '-d', '-s', 'unrelated', 'sleep', '60']);
    const result = await runDatabaseRetireLegacy(scope(file, tmuxSocket));
    expect(result).toMatchObject({ retired: 1, blocked: 2, replayed: 0 });
    expect(result.sessions).toEqual([
      { sessionId: 'ses_bad', status: 'blocked', code: 'LEGACY_RETIREMENT_PROTOCOL_UNSUPPORTED', detail: 'jsonl' },
      { sessionId: 'ses_corrupt', status: 'blocked', code: 'LEGACY_RETIREMENT_DATABASE_BLOCKED', detail: 'LEGACY_RETIREMENT_RECEIPT_INVALID' },
      { sessionId: 'ses_good', status: 'retired' }
    ]);
  });
});
