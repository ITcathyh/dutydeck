import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

describe('server directory browser', () => {
  let temp: string;
  let root: string;
  let app: FastifyInstance;
  const token = 'directory-browser-test-token';
  const headers = { authorization: `Bearer ${token}` };
  const url = (path: string) => `/api/system/directories?path=${encodeURIComponent(path)}`;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'dockmux-directories-'));
    root = join(temp, 'workspace');
    await mkdir(join(root, 'project'), { recursive: true });
    await mkdir(join(temp, 'outside'));
    await writeFile(join(root, 'file.txt'), 'not a directory');
    app = await buildApp({} as any, {
      system: { platform: 'linux', directoryRoots: async () => [root] },
      auth: { mode: 'token', getToken: async () => token }
    });
  });

  afterEach(async () => {
    await app?.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('lists real directories on Linux and returns navigation within the configured root', async () => {
    const response = await app.inject({ method: 'GET', url: url(root), headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ path: root, roots: expect.arrayContaining([root]), host: expect.any(String), entries: [{ name: 'project', path: join(root, 'project') }] });
    expect(response.json().parent).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: url(join(root, 'project')), headers })).json().parent).toBe(root);
  });

  it('requires the existing management authentication', async () => {
    const response = await app.inject({ method: 'GET', url: url(root) });
    expect(response.statusCode).toBe(401);
    expect(response.json()).not.toHaveProperty('entries');
  });

  it('rejects sibling paths and dot-dot traversal beyond permitted roots', async () => {
    for (const path of [join(temp, 'outside'), `${root}/../outside`]) {
      const response = await app.inject({ method: 'GET', url: url(path), headers });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('DIRECTORY_OUTSIDE_ROOTS');
    }
  });

  it('hides escaping symlinks and rejects explicitly opening them', async () => {
    await symlink(join(temp, 'outside'), join(root, 'escape'));
    await symlink(join(root, 'project'), join(root, 'inside'));
    const response = await app.inject({ method: 'GET', url: url(root), headers });
    expect(response.json().entries.map((entry: { name: string }) => entry.name)).toEqual(['inside', 'project']);
    const rejected = await app.inject({ method: 'GET', url: url(join(root, 'escape')), headers });
    expect(rejected.statusCode).toBe(403);
  });

  it('distinguishes missing paths, files, and malformed input', async () => {
    const cases = [
      [join(root, 'missing'), 404, 'DIRECTORY_NOT_FOUND'],
      [join(root, 'file.txt'), 400, 'NOT_A_DIRECTORY'],
      ['relative/path', 400, 'INVALID_DIRECTORY'],
      [`${root}\0`, 400, 'INVALID_DIRECTORY']
    ] as const;
    for (const [path, status, code] of cases) {
      const response = await app.inject({ method: 'GET', url: url(path), headers });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.code).toBe(code);
    }
  });

  it('refreshes permitted roots when configuration changes', async () => {
    await app.close();
    let roots = [root];
    app = await buildApp({} as any, { system: { directoryRoots: async () => roots } });
    expect((await app.inject({ method: 'GET', url: url(root) })).statusCode).toBe(200);
    roots = [];
    expect((await app.inject({ method: 'GET', url: url(root) })).statusCode).toBe(403);
  });
});
