import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema, type AgentConfig } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver } from './index.js';

// 先出计划的计划轮是一条以 deny-all 运行的任务；下一轮回到会话本身的权限。
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe('task-level deny-all for the plan phase', () => {
  it('rejects ACP permission requests in the plan task and asks again in the next task', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-plan-acp-'));
    const repos = createRepositories(join(directory, 'state.sqlite'), { newDatabaseAuthority: 'ledger_v1' });
    const agent = agentConfigSchema.parse({ id: 'mock', name: 'Mock', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp', cwd: directory, env: {}, permissionMode: 'ask', timeout: 10 });
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe: (() => ({ available: true, protocol: 'acp', acp: true })) as any });
    cleanup.push(async () => { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id, cwd: directory });
    const texts = async () => (await runtime.getEvents(session.id)).filter(event => event.type === 'text').map(event => String((event.data as { text?: unknown }).text));
    const status = async (taskId: string) => (await runtime.getTasks(session.id)).find(task => task.id === taskId)?.status;

    const plan = await runtime.dispatch(session.id, '/plan permission edit', 'queue', 'permission edit', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'deny-all');
    await expect.poll(() => status(plan.id), { timeout: 15_000 }).toBe('completed');
    expect((await texts()).find(text => text.startsWith('Permission:'))).toContain('"optionId":"deny"');
    expect(runtime.getPendingPermissions(session.id)).toEqual([]);

    const execute = await runtime.dispatch(session.id, '计划已批准', 'queue', 'permission edit again');
    await expect.poll(() => runtime.getPendingPermissions(session.id).length, { timeout: 15_000 }).toBe(1);
    await runtime.resolvePermission(session.id, runtime.getPendingPermissions(session.id)[0]!.id, true);
    await expect.poll(() => status(execute.id), { timeout: 15_000 }).toBe('completed');
    expect((await texts()).filter(text => text.startsWith('Permission:')).at(-1)).toContain('"optionId":"allow"');
    expect((await runtime.getSession(session.id))?.permissionMode).toBe('ask');
  }, 40_000);

  function ptyHarness(agentId: string) {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    let emit!: (event: any) => void;
    const configured: AgentConfig[] = [];
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => { emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }),
      interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {}), setPermissionMode: vi.fn() };
    const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'pty-cli' as const, available: true, pause: false, resume: true }),
      ptyDriverFactory: (config, _protocol, onEvent) => { configured.push(config); emit = onEvent; return driver; } });
    const agent: AgentConfig = { id: agentId, name: agentId, command: process.execPath, args: [], protocol: 'pty-cli', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
    cleanup.push(async () => { await runtime.shutdown(); repos.close(); });
    return { repos, runtime, driver, configured, agent };
  }

  it('switches a Claude terminal driver to deny-all for the plan task without restarting it', async () => {
    const h = ptyHarness('claude-code');
    await h.repos.agents.save(h.agent);
    await h.runtime.initialize([h.agent]);
    const session = await h.runtime.start({ agentId: 'claude-code' });
    // 终端按会话本身的模式启动；驱动据此在 deny-all 任务里仍用它启动 CLI。
    expect(h.configured[0]?.env.dutydeck_session_permission_mode).toBe('ask');
    const plan = await h.runtime.dispatch(session.id, '/plan work', 'queue', 'work', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'deny-all');
    await expect.poll(async () => (await h.runtime.getTasks(session.id)).find(task => task.id === plan.id)?.status).toBe('completed');
    expect(h.driver.setPermissionMode).toHaveBeenLastCalledWith('deny-all');
    await h.runtime.send(session.id, 'execute');
    expect(h.driver.setPermissionMode).toHaveBeenLastCalledWith('ask');
    expect(h.configured).toHaveLength(1);
    // 会话级切换仍不支持：已启动的终端不能换掉启动参数里的姿态。
    await expect(h.runtime.setPermissionMode(session.id, 'full-trust')).rejects.toMatchObject({ code: 'PERMISSION_MODE_SWITCH_UNSUPPORTED' });
  });

  it('fails a plan task on a terminal CLI that cannot enforce deny-all without sending the prompt', async () => {
    const h = ptyHarness('codex');
    await h.repos.agents.save(h.agent);
    await h.runtime.initialize([h.agent]);
    const session = await h.runtime.start({ agentId: 'codex' });
    const plan = await h.runtime.dispatch(session.id, '/plan work', 'queue', 'work', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'deny-all');
    await expect.poll(async () => (await h.runtime.getTasks(session.id)).find(task => task.id === plan.id)?.status).toBe('failed');
    expect(h.driver.send).not.toHaveBeenCalled();
    expect(h.driver.setPermissionMode).not.toHaveBeenCalled();
  });
});
