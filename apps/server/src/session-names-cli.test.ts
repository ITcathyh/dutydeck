import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  runSessionNamesCli,
  SessionNamesCliError
} from './session-names-cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

const mockSession = {
  id: 'ses_1',
  agentId: 'mock-agent',
  state: 'idle',
  cwd: '/tmp/repo',
  runId: 'run_1',
  createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T00:00:00.000Z',
  name: 'Feature A'
};

describe('session-names CLI', () => {
  describe('validation before readState/readToken/fetch', () => {
    const fetcher = vi.fn();
    const readToken = vi.fn();
    const deps = { fetcher, readToken };

    it('rejects rename without sessionId or name', async () => {
      await expect(
        runSessionNamesCli({ action: 'rename', name: 'Valid Name', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_ID_REQUIRED' });

      await expect(
        runSessionNamesCli({ action: 'rename', sessionId: '   ', name: 'Valid Name', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_ID_REQUIRED' });

      await expect(
        runSessionNamesCli({ action: 'rename', sessionId: 'ses_1', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_NAME_REQUIRED' });

      await expect(
        runSessionNamesCli({ action: 'rename', sessionId: 'ses_1', name: '   ', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'INVALID_SESSION_NAME' });

      await expect(
        runSessionNamesCli({ action: 'rename', sessionId: 'ses_1', name: 'a'.repeat(81), url: 'http://127.0.0.1:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'INVALID_SESSION_NAME' });

      await expect(
        runSessionNamesCli({ action: 'rename', sessionId: 'ses_1', name: 'Name\nWithNewline', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'INVALID_SESSION_NAME' });

      expect(readToken).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects reset-name without sessionId', async () => {
      await expect(
        runSessionNamesCli({ action: 'reset-name', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_ID_REQUIRED' });

      await expect(
        runSessionNamesCli({ action: 'reset-name', sessionId: '   ', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_ID_REQUIRED' });

      expect(readToken).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects unknown action', async () => {
      await expect(
        runSessionNamesCli({ action: 'unknown' as any, url: 'http://127.0.0.1:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_UNKNOWN_ACTION' });

      expect(readToken).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe('security and token parsing', () => {
    it('reads auth.accessToken with readonly semantics', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'session-names-db-'));
      dirs.push(dir);
      const database = join(dir, 'runtime.sqlite');
      const db = new Database(database);
      db.exec('CREATE TABLE configs(key TEXT PRIMARY KEY, value TEXT)');
      db.prepare('INSERT INTO configs VALUES(?,?)').run('auth.accessToken', 'secret-session-token');
      db.close();

      const fetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockSession), { status: 200, headers: { 'content-type': 'application/json' } })
      );

      const result = await runSessionNamesCli(
        { action: 'rename', sessionId: 'ses_1', name: 'Feature A', url: 'http://127.0.0.1:4310', database },
        { fetcher }
      );

      expect(result).toEqual(mockSession);
      expect(fetcher).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:4310/api/sessions/ses_1/name'),
        expect.objectContaining({
          method: 'PATCH',
          redirect: 'error',
          headers: expect.objectContaining({
            authorization: 'Bearer secret-session-token',
            'content-type': 'application/json'
          }),
          body: JSON.stringify({ name: 'Feature A' })
        })
      );
    });

    it('rejects remote, non-http, credential, and missing database options', async () => {
      const deps = { fetcher: vi.fn(), readToken: vi.fn(), localAddresses: () => ['10.37.33.49'] };

      await expect(
        runSessionNamesCli({ action: 'list', url: 'http://example.com:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_LOCAL_RUNTIME_REQUIRED' });

      await expect(
        runSessionNamesCli({ action: 'list', url: 'https://127.0.0.1:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_LOCAL_RUNTIME_REQUIRED' });

      await expect(
        runSessionNamesCli({ action: 'list', url: 'http://user:pass@127.0.0.1:4310', database: '/dummy.db' }, deps)
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_LOCAL_RUNTIME_REQUIRED' });

      await expect(
        runSessionNamesCli({ action: 'list', url: 'http://127.0.0.1:4310' }, deps)
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_DATABASE_REQUIRED' });
    });
  });

  describe('request execution and response validation', () => {
    it('executes list with GET /api/sessions and validates session list shape', async () => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify([mockSession]), { status: 200, headers: { 'content-type': 'application/json' } })
      );
      const deps = { fetcher, readToken: () => 'token' };

      const result = await runSessionNamesCli({ action: 'list', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, deps);
      expect(result).toEqual([mockSession]);
      expect(fetcher).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:4310/api/sessions'),
        expect.objectContaining({ method: 'GET' })
      );
      // GET should not send content-type
      const headers = fetcher.mock.calls[0]![1].headers as Record<string, string>;
      expect(headers['content-type']).toBeUndefined();
    });

    it('executes reset-name with PATCH and { name: null }', async () => {
      const clearedSession = { ...mockSession, name: undefined };
      const fetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(clearedSession), { status: 200, headers: { 'content-type': 'application/json' } })
      );
      const deps = { fetcher, readToken: () => 'token' };

      const result = await runSessionNamesCli({ action: 'reset-name', sessionId: 'ses_1', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, deps);
      expect(result).toEqual(clearedSession);
      expect(fetcher).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:4310/api/sessions/ses_1/name'),
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ name: null })
        })
      );
    });

    it('rejects invalid response shapes (200 HTML or malformed JSON)', async () => {
      // HTML response (e.g. 200 OK from SPA fallback)
      const htmlFetcher = vi.fn().mockResolvedValue(
        new Response('<!DOCTYPE html><html><body>Error</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      );
      await expect(
        runSessionNamesCli({ action: 'rename', sessionId: 'ses_1', name: 'Name', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, { fetcher: htmlFetcher, readToken: () => 'token' })
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_INVALID_RESPONSE' });

      // Malformed list response
      const badListFetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ invalid: 'shape' }]), { status: 200, headers: { 'content-type': 'application/json' } })
      );
      await expect(
        runSessionNamesCli({ action: 'list', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, { fetcher: badListFetcher, readToken: () => 'token' })
      ).rejects.toMatchObject({ code: 'SESSION_NAMES_INVALID_RESPONSE' });
    });

    it('surfaces backend error codes upon non-200 responses', async () => {
      const errorFetcher = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'SESSION_NAME_OWNER_REQUIRED', message: 'Forbidden' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' }
        })
      );
      await expect(
        runSessionNamesCli({ action: 'rename', sessionId: 'ses_1', name: 'Name', url: 'http://127.0.0.1:4310', database: '/dummy.db' }, { fetcher: errorFetcher, readToken: () => 'token' })
      ).rejects.toMatchObject({ code: 'SESSION_NAME_OWNER_REQUIRED' });
    });
  });
});
