// history list/show 的端到端回归：真实 DutydeckRuntime + SQLite + HTTP 路由。
// mock driver 按 prompt 回答，任务结果经执行账本结算，与线上读取最终回答的路径一致。
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig, Session } from '@dutydeck/shared';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import { registerLarkAgentToolRoutes } from './agent-tools-routes.js';
import { larkBotsConfigKey } from './config.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const longAnswer = `开头的中间过程${'过程'.repeat(5_000)}最终结论：采用蓝绿部署`;

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-agent-history-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      send: async prompt => {
        emit({ type: 'text', data: { text: prompt.includes('长回答') ? longAnswer : `回答：${prompt.split('\n').at(-1)}` } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }
    } satisfies AgentDriver)
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_hist', appSecret: 'fake', defaultAgentId: 'mock', groupToolsEnabled: true, groupToolsAllowSend: false }]));
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1');
  const tools = new LarkAgentToolsService(capabilities, repos.config, { history: repos, workbenchTask: id => runtime.getActiveTaskContext(id) });
  const app = Fastify();
  await registerLarkAgentToolRoutes(app, tools);
  cleanups.push(async () => { await app.close(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });

  const run = async (sourceId: string, prompt: string) => {
    const session = await runtime.start({ agentId: 'mock', cwd, source: 'lark', sourceId });
    const { id } = await runtime.dispatch(session.id, prompt, 'queue', `[Dutydeck 群上下文 INJECTED_CONTEXT]\n${prompt}`, undefined, 'ou_alice');
    await vi.waitFor(async () => expect((await runtime.getTasks(session.id)).find(task => task.id === id)?.status).toBe('completed'));
    return { session, taskId: id };
  };
  const get = (session: Session, url: string) => app.inject({ method: 'GET', url: `/api/lark/agent-tools${url}`,
    headers: { authorization: `Bearer ${capabilities.environmentFor(session).dutydeck_group_tools_token}` } });
  return { run, get };
}

describe('history tools over runtime + SQLite', () => {
  it('reads visible requests and settled answers of this chat and rejects other chats with 404', async () => {
    const { run, get } = await harness();
    const deploy = await run('cli_hist:oc_group:group:user:ou_alice', '部署方案讨论');
    const long = await run('cli_hist:oc_group:group:thread:om_root', '请给长回答');
    const other = await run('cli_hist:oc_other:group:user:ou_alice', '其他群的部署方案');
    const background = await run('cli_hist:oc_group:group:collaboration:man_1', '后台委托的部署方案');
    const p2p = await run('cli_hist:oc_p2p:p2p', '私聊的部署方案');

    const listed = await get(deploy.session, '/history');
    expect(listed.statusCode).toBe(200);
    expect(listed.json().tasks.map((item: { taskId: string }) => item.taskId)).toEqual([long.taskId, deploy.taskId]);
    expect(listed.json().tasks[1]).toMatchObject({ status: 'completed', actorId: 'ou_alice', request: '部署方案讨论', answer: '回答：部署方案讨论' });
    expect(listed.body).not.toContain('INJECTED_CONTEXT');

    // 关键词可以只出现在回答里。
    const byAnswer = await get(deploy.session, `/history?query=${encodeURIComponent('蓝绿部署')}`);
    expect(byAnswer.json().tasks.map((item: { taskId: string }) => item.taskId)).toEqual([long.taskId]);

    const shown = await get(deploy.session, `/history/${long.taskId}`);
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toMatchObject({ taskId: long.taskId, request: '请给长回答', answerClipped: true });
    expect(shown.json().answer.length).toBeLessThanOrEqual(8_000);
    expect(shown.json().answer.endsWith('最终结论：采用蓝绿部署')).toBe(true);

    for (const { taskId } of [other, background, p2p]) {
      const denied = await get(deploy.session, `/history/${taskId}`);
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toMatchObject({ error: { code: 'HISTORY_TASK_NOT_FOUND' } });
      expect(denied.body).not.toContain('部署方案');
    }
    const fromP2p = await get(p2p.session, `/history/${deploy.taskId}`);
    expect(fromP2p.statusCode).toBe(404);
    expect((await get(p2p.session, '/history')).json().tasks.map((item: { taskId: string }) => item.taskId)).toEqual([p2p.taskId]);
  });
});
