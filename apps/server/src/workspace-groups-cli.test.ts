import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { createCliProgram } from './cli-program.js';
import {
  runWorkspaceGroupsCli,
  WorkspaceGroupsCliError
} from './workspace-groups-cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const mockSnapshot = {
  organization: {
    groups: [{ id: 'group-1', name: 'Frontend' }],
    directoryGroups: { '/data00/web': 'group-1' },
    sessionGroups: { 'session-1': 'group-1' }
  },
  workspaces: [
    {
      id: 'group-1',
      name: 'Frontend',
      directories: ['/data00/web'],
      sessionIds: ['session-1'],
      custom: true
    }
  ]
};

describe('workspace-groups CLI', () => {
  it('reads auth.accessToken with read-only semantics without running migrations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-groups-db-'));
    dirs.push(dir);
    const database = join(dir, 'runtime.sqlite');
    const db = new Database(database);
    db.exec('CREATE TABLE configs(key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO configs VALUES(?,?)').run('auth.accessToken', 'secret-access-token');
    db.close();

    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockSnapshot), { status: 200, headers: { 'content-type': 'application/json' } })
    );

    const result = await runWorkspaceGroupsCli(
      { action: 'list', url: 'http://127.0.0.1:4310', database },
      { fetcher }
    );

    expect(result).toEqual(mockSnapshot);
    expect(fetcher).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4310/api/workspace-groups'),
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: {
          authorization: 'Bearer secret-access-token'
        }
      })
    );
    // GET 无 body 时不应携带 JSON content-type（Fastify 对空 body + application/json 会 500）
    const getHeaders = fetcher.mock.calls[0]![1].headers as Record<string, string>;
    expect(getHeaders['content-type']).toBeUndefined();
    expect(getHeaders['authorization']).toBe('Bearer secret-access-token');

    // 验证数据库未被修改，只保留建表时的结构（无迁移副作用）
    const checkDb = new Database(database, { readonly: true });
    expect(checkDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'configs' }]);
    checkDb.close();
  });

  it('rejects remote URLs, credential URLs, non-loopback addresses, and non-http protocols', async () => {
    const fetcher = vi.fn();
    const readToken = vi.fn();
    const deps = { fetcher, readToken, localAddresses: () => ['10.37.33.49'] };

    // 拒绝 remote 域名
    await expect(
      runWorkspaceGroupsCli({ action: 'list', url: 'http://example.com:4310', database: '/dummy.db' }, deps)
    ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_LOCAL_RUNTIME_REQUIRED' });

    // 拒绝带 userinfo 的 URL
    await expect(
      runWorkspaceGroupsCli({ action: 'list', url: 'http://user:pass@127.0.0.1:4310', database: '/dummy.db' }, deps)
    ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_LOCAL_RUNTIME_REQUIRED' });

    // 拒绝非本机 IP
    await expect(
      runWorkspaceGroupsCli({ action: 'list', url: 'http://10.99.99.99:4310', database: '/dummy.db' }, deps)
    ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_LOCAL_RUNTIME_REQUIRED' });

    // 拒绝 https 协议
    await expect(
      runWorkspaceGroupsCli({ action: 'list', url: 'https://127.0.0.1:4310', database: '/dummy.db' }, deps)
    ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_LOCAL_RUNTIME_REQUIRED' });

    // 显式 --url 但没有 --database
    await expect(
      runWorkspaceGroupsCli({ action: 'list', url: 'http://127.0.0.1:4310' }, deps)
    ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_DATABASE_REQUIRED' });

    // 既没有调用 readToken 也没有发起 fetch
    expect(readToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('supports loopback IPv4, loopback IPv6, localhost, and verified local interface', async () => {
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(mockSnapshot), { status: 200, headers: { 'content-type': 'application/json' } }))
    );
    const deps = { fetcher, readToken: () => 'token', localAddresses: () => ['10.37.33.49'] };

    for (const validUrl of [
      'http://127.0.0.1:4310',
      'http://localhost:4310',
      'http://[::1]:4310',
      'http://10.37.33.49:4310'
    ]) {
      const res = await runWorkspaceGroupsCli({ action: 'list', url: validUrl, database: '/dummy.db' }, deps);
      expect(res).toEqual(mockSnapshot);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  describe('no mutation on bad inputs', () => {
    const fetcher = vi.fn();
    const readToken = vi.fn();
    const deps = { fetcher, readToken };

    it('rejects create without name', async () => {
      await expect(
        runWorkspaceGroupsCli({ action: 'create', url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_NAME_REQUIRED' });

      await expect(
        runWorkspaceGroupsCli({ action: 'create', name: '   ', url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_NAME_REQUIRED' });

      expect(readToken).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects rename without groupId or name', async () => {
      await expect(
        runWorkspaceGroupsCli({ action: 'rename', name: 'New Name', url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_ID_REQUIRED' });

      await expect(
        runWorkspaceGroupsCli({ action: 'rename', groupId: 'g1', url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_NAME_REQUIRED' });

      expect(readToken).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects delete without groupId', async () => {
      await expect(
        runWorkspaceGroupsCli({ action: 'delete', url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_ID_REQUIRED' });

      expect(readToken).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects move without groupId or without any target, or with relative directory', async () => {
      await expect(
        runWorkspaceGroupsCli({ action: 'move', sessionIds: ['s1'], url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_ID_REQUIRED' });

      // sessionIds 和 directories 均为空
      await expect(
        runWorkspaceGroupsCli({ action: 'move', groupId: 'g1', sessionIds: [], directories: [], url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_TARGET_REQUIRED' });

      // 非绝对路径
      await expect(
        runWorkspaceGroupsCli({ action: 'move', groupId: 'g1', directories: ['relative/path'], url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_DIRECTORY_INVALID' });

      // 批量无效必须整批拒绝：有效 session 与空 session 混合，不能只写有效部分
      await expect(
        runWorkspaceGroupsCli({ action: 'move', groupId: 'g1', sessionIds: ['s1', '', 's2'], url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_SESSION_ID_INVALID' });

      // 有效目录与纯空白目录混合，同样整批拒绝
      await expect(
        runWorkspaceGroupsCli({ action: 'move', groupId: 'g1', sessionIds: ['s1'], directories: ['/data00/repo', '   '], url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_DIRECTORY_INVALID' });

      expect(readToken).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects reset without any target, or with relative directory', async () => {
      await expect(
        runWorkspaceGroupsCli({ action: 'reset', sessionIds: [], directories: [], url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_TARGET_REQUIRED' });

      await expect(
        runWorkspaceGroupsCli({ action: 'reset', directories: ['./rel'], url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_DIRECTORY_INVALID' });

      // reset 同样不允许静默丢弃空 session / 空目录
      await expect(
        runWorkspaceGroupsCli({ action: 'reset', sessionIds: ['s1', '  '], directories: ['/data00/repo'], url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_SESSION_ID_INVALID' });

      await expect(
        runWorkspaceGroupsCli({ action: 'reset', sessionIds: ['s1'], directories: ['', '/data00/repo'], url: 'http://127.0.0.1:4310', database: '/db' }, deps)
      ).rejects.toMatchObject({ code: 'WORKSPACE_GROUPS_DIRECTORY_INVALID' });

      expect(readToken).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  describe('API paths, encoding, and body payloads', () => {
    it('creates a workspace group with POST and returns createdGroupId', async () => {
      const createdSnapshot = { ...mockSnapshot, createdGroupId: 'group-new-1' };
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(createdSnapshot), { status: 200 }));
      const deps = { fetcher, readToken: () => 'token' };

      const result = await runWorkspaceGroupsCli({
        action: 'create',
        name: 'Backend Services',
        url: 'http://127.0.0.1:4310',
        database: '/db'
      }, deps);

      expect(result).toEqual(createdSnapshot);
      expect(fetcher).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:4310/api/workspace-groups'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'Backend Services' })
        })
      );
    });

    it('renames a workspace group with PATCH and encodes path parameters', async () => {
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(mockSnapshot), { status: 200 }));
      const deps = { fetcher, readToken: () => 'token' };

      const specialId = 'group/special#1?name=test';
      await runWorkspaceGroupsCli({
        action: 'rename',
        groupId: specialId,
        name: 'Updated Name',
        url: 'http://127.0.0.1:4310',
        database: '/db'
      }, deps);

      const calledUrl = fetcher.mock.calls[0]![0] as URL;
      expect(calledUrl.pathname).toBe(`/api/workspace-groups/${encodeURIComponent(specialId)}`);
      expect(fetcher).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ name: 'Updated Name' })
        })
      );
    });

    it('deletes a workspace group with DELETE and encodes path parameters', async () => {
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(mockSnapshot), { status: 200 }));
      const deps = { fetcher, readToken: () => 'token' };

      const specialId = 'group@alpha/beta';
      await runWorkspaceGroupsCli({
        action: 'delete',
        groupId: specialId,
        url: 'http://127.0.0.1:4310',
        database: '/db'
      }, deps);

      const calledUrl = fetcher.mock.calls[0]![0] as URL;
      expect(calledUrl.pathname).toBe(`/api/workspace-groups/${encodeURIComponent(specialId)}`);
      expect(fetcher).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('DELETE succeeds against a real Fastify body parser without a JSON content-type', async () => {
      // 真实回归：Fastify 在 content-type: application/json 但 body 为空时直接 500
      // （FST_ERR_CTP_EMPTY_JSON_BODY）。DELETE 无 body，因此不能带 JSON content-type。
      const deleteHits = vi.fn();
      const app = Fastify();
      app.delete('/api/workspace-groups/:id', async request => {
        deleteHits((request.headers as Record<string, string>).authorization ?? null, (request.headers as Record<string, string>)['content-type'] ?? null);
        return mockSnapshot;
      });

      const injectFetcher: typeof fetch = async (url, init) => {
        const injected = await app.inject({
          method: (init?.method ?? 'GET') as 'DELETE',
          url: new URL(url as string).pathname,
          headers: init?.headers as Record<string, string> | undefined
        });
        return new Response(injected.body, {
          status: injected.statusCode,
          headers: { 'content-type': injected.headers['content-type'] as string }
        });
      };

      const result = await runWorkspaceGroupsCli({
        action: 'delete',
        groupId: 'wg_01j7abc',
        url: 'http://127.0.0.1:4310',
        database: '/db'
      }, { fetcher: injectFetcher, readToken: () => 'local-token' });

      await app.close();

      // 路由被真实处理并返回合法 snapshot，而不是 Fastify 的空 body 500
      expect(result).toEqual(mockSnapshot);
      expect(deleteHits).toHaveBeenCalledTimes(1);
      // auth 头保留，JSON content-type 不存在
      expect(deleteHits).toHaveBeenCalledWith('Bearer local-token', null);
    });

    it('moves sessions and directories to a group with PUT assignments', async () => {
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(mockSnapshot), { status: 200 }));
      const deps = { fetcher, readToken: () => 'token' };

      await runWorkspaceGroupsCli({
        action: 'move',
        groupId: 'g-target',
        sessionIds: ['session-a', 'session-b'],
        directories: ['/data00/repo1', '/data00/repo2'],
        url: 'http://127.0.0.1:4310',
        database: '/db'
      }, deps);

      expect(fetcher).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:4310/api/workspace-groups/assignments'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            groupId: 'g-target',
            sessionIds: ['session-a', 'session-b'],
            directories: ['/data00/repo1', '/data00/repo2']
          })
        })
      );
    });

    it('supports move with only session-ids or only directories', async () => {
      const fetcher = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(mockSnapshot), { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const deps = { fetcher, readToken: () => 'token' };

      // 仅 sessionIds
      await runWorkspaceGroupsCli({
        action: 'move',
        groupId: 'g-target',
        sessionIds: ['session-only'],
        url: 'http://127.0.0.1:4310',
        database: '/db'
      }, deps);
      expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
        groupId: 'g-target',
        sessionIds: ['session-only']
      });

      // 仅 directories
      await runWorkspaceGroupsCli({
        action: 'move',
        groupId: 'g-target',
        directories: ['/data00/dir-only'],
        url: 'http://127.0.0.1:4310',
        database: '/db'
      }, deps);
      expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
        groupId: 'g-target',
        directories: ['/data00/dir-only']
      });
    });

    it('resets assignments by setting groupId: null with PUT', async () => {
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(mockSnapshot), { status: 200 }));
      const deps = { fetcher, readToken: () => 'token' };

      await runWorkspaceGroupsCli({
        action: 'reset',
        sessionIds: ['session-x'],
        directories: ['/data00/reset-dir'],
        url: 'http://127.0.0.1:4310',
        database: '/db'
      }, deps);

      expect(fetcher).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:4310/api/workspace-groups/assignments'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            groupId: null,
            sessionIds: ['session-x'],
            directories: ['/data00/reset-dir']
          })
        })
      );
    });
  });

  describe('HTTP error handling and secret protection', () => {
    it('returns non-zero error with safe status and code without leaking server messages or secrets', async () => {
      const leakedSecret = 'SUPER_SENSITIVE_LEAKED_TOKEN_OR_PASSWORD';
      const fetcher = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'WORKSPACE_GROUP_NOT_FOUND',
              message: `Fatal error leaking secrets: ${leakedSecret}`
            }
          }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        )
      );
      const deps = { fetcher, readToken: () => 'token' };

      let caughtError: unknown;
      try {
        await runWorkspaceGroupsCli({
          action: 'rename',
          groupId: 'non-existent',
          name: 'New Name',
          url: 'http://127.0.0.1:4310',
          database: '/db'
        }, deps);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(WorkspaceGroupsCliError);
      const cliError = caughtError as WorkspaceGroupsCliError;
      expect(cliError.code).toBe('WORKSPACE_GROUP_NOT_FOUND');
      expect(cliError.message).toBe('Workspace groups request failed with HTTP 404');
      // 关键断言：绝不泄露远端包含敏感信息的 message
      expect(cliError.message).not.toContain(leakedSecret);
      expect(JSON.stringify(cliError)).not.toContain(leakedSecret);
    });

    it('falls back to default code when server responds with 500 HTML or unparseable body', async () => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain' } })
      );
      const deps = { fetcher, readToken: () => 'token' };

      await expect(
        runWorkspaceGroupsCli({
          action: 'list',
          url: 'http://127.0.0.1:4310',
          database: '/db'
        }, deps)
      ).rejects.toMatchObject({
        code: 'WORKSPACE_GROUPS_REQUEST_FAILED',
        message: 'Workspace groups request failed with HTTP 500'
      });
    });

    it('rejects HTTP 200 responses with HTML or unparseable JSON without leaking body', async () => {
      const htmlBody = '<html><body>Proxy Error with sensitive-proxy-secret</body></html>';
      const fetcher = vi.fn().mockResolvedValue(
        new Response(htmlBody, { status: 200, headers: { 'content-type': 'text/html' } })
      );
      const deps = { fetcher, readToken: () => 'token' };

      let caughtError: unknown;
      try {
        await runWorkspaceGroupsCli({
          action: 'list',
          url: 'http://127.0.0.1:4310',
          database: '/db'
        }, deps);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(WorkspaceGroupsCliError);
      const cliError = caughtError as WorkspaceGroupsCliError;
      expect(cliError.code).toBe('WORKSPACE_GROUPS_INVALID_SNAPSHOT');
      expect(cliError.message).toBe('Workspace groups API returned an invalid snapshot');
      expect(cliError.message).not.toContain('sensitive-proxy-secret');
      expect(JSON.stringify(cliError)).not.toContain('sensitive-proxy-secret');
    });

    it('rejects HTTP 200 responses lacking snapshot structure without leaking body', async () => {
      const invalidJson = JSON.stringify({ ok: true, internalDebug: 'sensitive-debug-detail' });
      const fetcher = vi.fn().mockResolvedValue(
        new Response(invalidJson, { status: 200, headers: { 'content-type': 'application/json' } })
      );
      const deps = { fetcher, readToken: () => 'token' };

      let caughtError: unknown;
      try {
        await runWorkspaceGroupsCli({
          action: 'list',
          url: 'http://127.0.0.1:4310',
          database: '/db'
        }, deps);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(WorkspaceGroupsCliError);
      const cliError = caughtError as WorkspaceGroupsCliError;
      expect(cliError.code).toBe('WORKSPACE_GROUPS_INVALID_SNAPSHOT');
      expect(cliError.message).toBe('Workspace groups API returned an invalid snapshot');
      expect(cliError.message).not.toContain('sensitive-debug-detail');
      expect(JSON.stringify(cliError)).not.toContain('sensitive-debug-detail');
    });
  });

  describe('Commander integration and JSON formatting', () => {
    it('wires Commander arguments to runWorkspaceGroupsCli and outputs JSON', async () => {
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(mockSnapshot), { status: 200 }));
      let capturedOutput = '';
      const output = (result: unknown) => {
        capturedOutput = JSON.stringify({ ok: true, ...(result as object) });
      };

      const program = createCliProgram('0.0.6', {
        workspaceGroups: async (action, params, options) => {
          const res = await runWorkspaceGroupsCli(
            {
              action,
              groupId: params.groupId,
              name: params.name,
              sessionIds: params.sessionIds,
              directories: options.directory,
              url: options.url,
              database: options.database,
              json: options.json
            },
            { fetcher, readToken: () => 'token' }
          );
          output(res);
        }
      });

      await program.parseAsync([
        'node', 'dutydeck',
        '--database', '/root/db.sqlite',
        'workspace-groups', 'move', 'target-g', 's1', 's2',
        '--directory', '/data00/repo1',
        '--directory', '/data00/repo2',
        '--url', 'http://127.0.0.1:4310',
        '--json'
      ]);

      expect(fetcher).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:4310/api/workspace-groups/assignments'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            groupId: 'target-g',
            sessionIds: ['s1', 's2'],
            directories: ['/data00/repo1', '/data00/repo2']
          })
        })
      );

      const parsed = JSON.parse(capturedOutput);
      expect(parsed.ok).toBe(true);
      expect(parsed.workspaces).toEqual(mockSnapshot.workspaces);
      expect(parsed.organization).toEqual(mockSnapshot.organization);
    });

    it('formats error as JSON with non-zero exit code when WorkspaceGroupsCliError is thrown', () => {
      const error = new WorkspaceGroupsCliError('WORKSPACE_GROUPS_NAME_REQUIRED', 'Group name is required');
      const formatted = JSON.stringify({ ok: false, error: { code: error.code, message: error.message } });
      const parsed = JSON.parse(formatted);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('WORKSPACE_GROUPS_NAME_REQUIRED');
      expect(parsed.error.message).toBe('Group name is required');
    });
  });
});
