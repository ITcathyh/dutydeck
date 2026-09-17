import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type Session } from '@dutydeck/shared';
import { AgentGroupToolError, LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import { larkBotsConfigKey } from './config.js';
import { LarkMemoryStore, larkMemoryKey } from './memory.js';
import { larkMemoryToolsPath, registerLarkMemoryTools } from './memory-tools.js';

const apps: ReturnType<typeof Fastify>[] = [];
const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const repository of repositories.splice(0)) repository.close();
});

const session = (id: string, sourceId: string): Session => ({
  id, agentId: 'codex', state: 'idle', cwd: '/tmp', source: 'lark', sourceId, runId: 'run_1', createdAt: '', updatedAt: ''
});

async function setup(options: { actorId?: string } = {}) {
  const repos = createRepositories(':memory:'); repositories.push(repos);
  const groupSession = session('ses_group', 'cli_bot:oc_group:group');
  const p2pSession = session('ses_p2p', 'cli_bot:oc_p2p:p2p');
  await repos.sessions.save(groupSession);
  await repos.sessions.save(p2pSession);
  // 群协作关闭的机器人：记忆工具仍必须可用。
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_bot', appSecret: 'secret', name: 'Bot', defaultAgentId: 'codex', groupToolsEnabled: false }]));
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:4310');
  const tools = new LarkAgentToolsService(capabilities, repos.config, {});
  const store = new LarkMemoryStore(repos.config);
  const app = Fastify(); apps.push(app);
  // 与 app.ts 相同的错误映射：capability 错误与领域错误都以 { error: { code } } 返回。
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AgentGroupToolError) return reply.code(error.statusCode).send(error.response());
    if (error instanceof RuntimeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } });
  });
  const getActiveTaskContext = vi.fn((sessionId: string) => sessionId === 'ses_group' && options.actorId ? { taskId: 'task_1', actorId: options.actorId } : undefined);
  await registerLarkMemoryTools(app, { tools, store, runtime: { getActiveTaskContext } });
  const headers = (target: Session) => ({ authorization: `Bearer ${capabilities.environmentFor(target).dutydeck_group_tools_token}` });
  return { repos, app, store, groupSession, p2pSession, headers };
}

describe('Lark memory agent tools', () => {
  it('lets the bound session read, add and remove memories of its own chat only', async () => {
    const { app, store, groupSession, p2pSession, headers } = await setup({ actorId: 'ou_alice' });
    const empty = await app.inject({ method: 'GET', url: larkMemoryToolsPath, headers: headers(groupSession) });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ chatId: 'oc_group', entries: [] });

    const added = await app.inject({ method: 'POST', url: larkMemoryToolsPath, headers: headers(groupSession), payload: { content: '项目用 pnpm，测试命令 pnpm test' } });
    expect(added.statusCode).toBe(200);
    const entry = added.json().entry;
    expect(entry).toMatchObject({ content: '项目用 pnpm，测试命令 pnpm test', source: 'agent', sessionId: 'ses_group', createdBy: 'ou_alice' });
    expect(entry.id).toMatch(/^mem_[0-9a-f]{8}$/);

    // 同一机器人的私聊会话看不到群里的记忆：作用域来自 token 绑定，不来自请求体。
    const other = await app.inject({ method: 'GET', url: larkMemoryToolsPath, headers: headers(p2pSession) });
    expect(other.json()).toEqual({ chatId: 'oc_p2p', entries: [] });
    const foreignDelete = await app.inject({ method: 'DELETE', url: `${larkMemoryToolsPath}/${entry.id}`, headers: headers(p2pSession) });
    expect(foreignDelete.statusCode).toBe(404);
    expect(await store.list({ appId: 'cli_bot', chatId: 'oc_group' })).toHaveLength(1);

    const listed = await app.inject({ method: 'GET', url: larkMemoryToolsPath, headers: headers(groupSession) });
    expect(listed.json().entries).toEqual([entry]);

    const removed = await app.inject({ method: 'DELETE', url: `${larkMemoryToolsPath}/${entry.id}`, headers: headers(groupSession) });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().removed).toMatchObject({ id: entry.id, deletedBy: 'ou_alice', deletedAt: expect.any(String) });
    const again = await app.inject({ method: 'DELETE', url: `${larkMemoryToolsPath}/${entry.id}`, headers: headers(groupSession) });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('MEMORY_NOT_FOUND');
  });

  it('rejects malformed content and invalid or expired capabilities', async () => {
    const { app, repos, groupSession, headers } = await setup();
    const missing = await app.inject({ method: 'POST', url: larkMemoryToolsPath, headers: headers(groupSession), payload: { content: 42 } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('MEMORY_CONTENT_REQUIRED');
    const blank = await app.inject({ method: 'POST', url: larkMemoryToolsPath, headers: headers(groupSession), payload: { content: '   ' } });
    expect(blank.statusCode).toBe(400);

    const forged = await app.inject({ method: 'GET', url: larkMemoryToolsPath, headers: { authorization: 'Bearer v1.forged' } });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe('GROUP_TOOL_UNAUTHORIZED');

    // 机器人被删除后 capability 仍解析得到会话，但工具必须拒绝。
    await repos.config.set(larkBotsConfigKey, JSON.stringify([]));
    const orphan = await app.inject({ method: 'GET', url: larkMemoryToolsPath, headers: headers(groupSession) });
    expect(orphan.statusCode).toBe(404);
    expect(orphan.json().error.code).toBe('GROUP_TOOL_BOT_NOT_FOUND');
    expect(await repos.config.get(larkMemoryKey({ appId: 'cli_bot', chatId: 'oc_group' }))).toBeUndefined();
  });
});
