import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runRecoveryCli } from './recovery-cli.js';
import { createCliProgram } from './cli-program.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('owner recovery CLI', () => {
  it('reads the exact runtime token without migrations and submits a validated decision through HTTP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-cli-')); dirs.push(dir);
    const database = join(dir, 'runtime.sqlite'), file = join(dir, 'decision.json');
    const db = new Database(database); db.exec('CREATE TABLE configs(key TEXT PRIMARY KEY,value TEXT)'); db.prepare('INSERT INTO configs VALUES(?,?)').run('auth.accessToken', 'local-secret'); db.close();
    const decision = { action: 'confirm_result', outcome: 'unknown', runId: 'run', taskId: 'task', attemptId: 'attempt', expectedRevision: 3, decisionId: 'decision', evidenceRefs: ['reviewed'], resourceChecks: [] };
    writeFileSync(file, JSON.stringify(decision));
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ replayed: false }), { status: 200 }));
    expect(await runRecoveryCli('confirm', 'session', { url: 'http://127.0.0.1:4311', database, file }, { fetcher })).toEqual({ replayed: false });
    expect(fetcher).toHaveBeenCalledWith(new URL('http://127.0.0.1:4311/api/sessions/session/recovery/confirm'), expect.objectContaining({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' } }));
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(decision);
    const check = new Database(database, { readonly: true });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'configs' }]); check.close();
  });
  it('does not expose the local token to external or database-unspecified runtimes', async () => {
    const readToken = vi.fn(), fetcher = vi.fn();
    await expect(runRecoveryCli('inspect', 'session', { url: 'http://example.com', database: '/db' }, { readToken, fetcher })).rejects.toMatchObject({ code: 'RECOVERY_LOCAL_RUNTIME_REQUIRED' });
    await expect(runRecoveryCli('inspect', 'session', { url: 'http://127.0.0.1:4311' }, { readToken, fetcher })).rejects.toMatchObject({ code: 'RECOVERY_DATABASE_REQUIRED' });
    expect(readToken).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('supports an exact local-interface listener while rejecting foreign IPs and credential URLs', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const deps = { fetcher, readToken: vi.fn().mockReturnValue('owner'), localAddresses: () => ['10.37.33.49'] };
    await runRecoveryCli('inspect', 'session', { url: 'http://10.37.33.49:4310', database: '/db' }, deps);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const url of ['http://10.37.33.50:4310', 'http://owner@10.37.33.49:4310', 'http://main.local:4310']) {
      await expect(runRecoveryCli('inspect', 'session', { url, database: '/db' }, deps)).rejects.toMatchObject({ code: 'RECOVERY_LOCAL_RUNTIME_REQUIRED' });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['retire-pty', 'replace-native'] as const)('submits explicit %s scope without accepting a client exit proof', async operation => {
    const dir = mkdtempSync(join(tmpdir(), 'recovery-action-')); dirs.push(dir);
    const file = join(dir, 'decision.json');
    const decision = { runId: 'run', resourceId: 'resource', expectedRevision: 3, decisionId: 'decision', ...(operation === 'retire-pty' ? { evidenceRefs: ['reviewed'] } : {}) };
    writeFileSync(file, JSON.stringify(decision));
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const options = { url: 'http://127.0.0.1:4311', database: '/db', file }, deps = { fetcher, readToken: () => 'owner' };
    await runRecoveryCli(operation, 'session', options, deps);
    expect(fetcher.mock.calls[0]![0].pathname).toBe(`/api/sessions/session/recovery/${operation}`);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual(decision);
    writeFileSync(file, JSON.stringify({ ...decision, gone: true }));
    await expect(runRecoveryCli(operation, 'session', options, deps)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('wires explicit probe scope and global database through Commander', async () => {
    const recovery = vi.fn();
    await createCliProgram('test', { recovery }).parseAsync(['node', 'dutydeck', '--database', '/child/db', 'recovery', 'probe', 'session', '--url', 'http://127.0.0.1:4311', '--run-id', 'run']);
    expect(recovery).toHaveBeenCalledWith('probe', 'session', expect.objectContaining({ database: '/child/db', url: 'http://127.0.0.1:4311', runId: 'run' }));
  });
});
