import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError } from '@dutydeck/shared';
import { larkMemoryScope, LarkMemoryStore } from './memory.js';
import { registerLarkMemoryTurnRoutes } from './memory-turn-routes.js';

const groups = larkMemoryScope('cli_bot', 'oc_group', 'group');
const apps: ReturnType<typeof Fastify>[] = [];
const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const repository of repositories.splice(0)) repository.close();
});

async function setup(options: { deny?: boolean } = {}) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); repositories.push(repos);
  const store = new LarkMemoryStore(repos.config);
  const app = Fastify(); apps.push(app);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RuntimeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  });
  const authorize = vi.fn(async (_request: unknown, sessionId: string) => {
    if (options.deny) throw new RuntimeError('POLICY_DENIED', '没有查看该任务结果的权限', 403);
    return sessionId;
  });
  await registerLarkMemoryTurnRoutes(app, { store, authorize });

  const used = await store.add(groups, { content: '回复统一用中文', source: 'user', chatId: 'oc_group' });
  await store.recordTurn(groups, { taskId: 'task_old', sessionId: 'ses_1', injected: [used.id] });
  await store.recordTurn(groups, { taskId: 'task_new', sessionId: 'ses_1', injected: [used.id] });
  const written = await store.add(groups, { content: '部署脚本在 scripts/deploy.sh', source: 'extraction', taskId: 'task_new', chatId: 'oc_group' });
  // 另一会话的记录不能从这个会话的详情里看到或删掉。
  await store.recordTurn(groups, { taskId: 'task_none', sessionId: 'ses_other', injected: [used.id] });
  return { app, store, authorize, used, written };
}

describe('Web task detail memory routes', () => {
  it('lists the memories each turn used and wrote, newest first, skipping turns of other sessions', async () => {
    const { app, authorize, used, written } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/sessions/ses_1/memory' });
    expect(response.statusCode).toBe(200);
    const { turns } = response.json();
    expect(turns.map((turn: { taskId: string }) => turn.taskId)).toEqual(['task_new', 'task_old']);
    expect(turns[0]).toMatchObject({ shared: true, injected: [{ id: used.id, content: '回复统一用中文', source: 'user' }], written: [{ id: written.id, source: 'extraction' }] });
    expect(turns[1].written).toEqual([]);
    expect(authorize).toHaveBeenCalledWith(expect.anything(), 'ses_1');
  });

  it('deletes only an entry the turn listed, and reports the deletion on the next read', async () => {
    const { app, store, written } = await setup();
    const other = await store.add(groups, { content: '与本轮无关的记忆', source: 'user', chatId: 'oc_group' });
    const unlisted = await app.inject({ method: 'DELETE', url: `/api/sessions/ses_1/memory/task_new/entries/${other.id}` });
    expect(unlisted.statusCode).toBe(404);
    expect(unlisted.json().error.code).toBe('MEMORY_NOT_FOUND');
    const foreign = await app.inject({ method: 'DELETE', url: `/api/sessions/ses_1/memory/task_none/entries/${other.id}` });
    expect(foreign.json().error.code).toBe('MEMORY_TURN_NOT_FOUND');

    const removed = await app.inject({ method: 'DELETE', url: `/api/sessions/ses_1/memory/task_new/entries/${written.id}` });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: { id: written.id } });
    expect((await store.list(groups)).map(entry => entry.id)).not.toContain(written.id);
    const again = await app.inject({ method: 'DELETE', url: `/api/sessions/ses_1/memory/task_new/entries/${written.id}` });
    expect(again.statusCode).toBe(404);
    const [latest] = (await app.inject({ method: 'GET', url: '/api/sessions/ses_1/memory' })).json().turns;
    expect(latest.written[0]).toMatchObject({ id: written.id, deletedAt: expect.any(String) });
  });

  it('applies the session policy before reading or deleting', async () => {
    const { app, store, written } = await setup({ deny: true });
    expect((await app.inject({ method: 'GET', url: '/api/sessions/ses_1/memory' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/sessions/ses_1/memory/task_new/entries/${written.id}` })).statusCode).toBe(403);
    expect((await store.list(groups)).map(entry => entry.id)).toContain(written.id);
  });
});
