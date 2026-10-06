import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, DriverFactory, NormalizedDriverEvent } from '@dutydeck/shared';
import { DutydeckRuntime, type RuntimeOptions } from './index.js';
import { agentAuthFailure, agentLoginProblem } from './agent-availability.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

/** 真实运行时 + 内存 SQLite；驱动按 script 逐轮发事件，idle 决定 isIdle 的回答。 */
async function fixture(script: Array<NormalizedDriverEvent[] | Error>, options: RuntimeOptions = {}, binary = 'claude', name = 'Claude') {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-availability-'));
  // 原因与修法按命令名区分（claude / codex-acp）；运行时启动会话前核对命令存在，放一个不会被执行的同名文件。
  await mkdir(join(cwd, 'bin')); await writeFile(join(cwd, 'bin', binary), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const driver = { idle: true };
  const factory: DriverFactory = (_agent, _protocol, emit) => ({ start: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => true,
    interrupt: async () => {}, isIdle: () => driver.idle, send: async () => {
      const turn = script.shift() ?? [{ type: 'text', data: { text: 'ok' } }, { type: 'completed', data: { stopReason: 'end_turn' } }];
      if (turn instanceof Error) throw turn;
      for (const event of turn) emit(event);
    } });
  const agent: AgentConfig = { id: 'claude-code', name, command: join(cwd, 'bin', binary), args: [], cwd, env: {}, protocol: 'acp', permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const runtime = new DutydeckRuntime(repos, { ...options, driverFactory: factory, cleanupIntervalMs: 0 });
  cleanups.push(async () => { await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });
  return { runtime, session, agent, driver };
}
const authFailure: NormalizedDriverEvent[] = [
  { type: 'error', data: { message: 'Claude 登录或凭据已失效', code: 'claude_api_authentication_failed', retryable: false } },
  { type: 'completed', data: { stopReason: 'end_turn' } }
];

describe('Agent 可用性标记', () => {
  it('登录失败的一轮标记 Agent 不可用，带原因、修法和时间；之后正常完成的一轮清掉标记', async () => {
    const h = await fixture([authFailure]);
    expect((await h.runtime.send(h.session.id, 'first')).status).toBe('failed');
    expect(h.runtime.getAgentAvailability('claude-code')).toEqual({ reason: 'Claude Code 登录或凭据失效',
      remedy: '在开发机执行 `claude /login`，或检查 ~/.claude/settings.json 里的凭据', at: expect.any(String) });
    expect((await h.runtime.send(h.session.id, 'second')).status).toBe('completed');
    expect(h.runtime.getAgentAvailability('claude-code')).toBeUndefined();
  });

  it('建会话时 Codex 的 Authentication required 也算未登录', async () => {
    const h = await fixture([new Error('Authentication required')], {}, 'codex-acp', 'Codex');
    await h.runtime.send(h.session.id, 'first');
    expect(h.runtime.getAgentAvailability('claude-code')).toMatchObject({ reason: 'Codex 未登录', remedy: '在开发机执行 `codex login`' });
  });

  it('复查：状态命令确认已登录清掉标记，确认未登录保留并刷新时间，说不准保持原样', async () => {
    const states: Array<'logged_in' | 'logged_out' | 'unknown'> = ['logged_out', 'unknown', 'logged_in'];
    const agentStatusCheck = vi.fn(async () => states.shift()!);
    const h = await fixture([authFailure], { agentStatusCheck });
    // 没有标记、也不是启动检查时不跑状态命令。
    expect(await h.runtime.checkAgentAvailability('claude-code')).toBeUndefined();
    expect(agentStatusCheck).not.toHaveBeenCalled();
    await h.runtime.send(h.session.id, 'first');
    const marked = h.runtime.getAgentAvailability('claude-code')!;
    expect(await h.runtime.checkAgentAvailability('claude-code')).toMatchObject({ reason: 'Claude Code 未登录' });
    expect(await h.runtime.checkAgentAvailability('claude-code')).toMatchObject({ reason: 'Claude Code 未登录' });
    expect(await h.runtime.checkAgentAvailability('claude-code')).toBeUndefined();
    expect(agentStatusCheck).toHaveBeenCalledTimes(3);
    expect(marked.reason).toBe('Claude Code 登录或凭据失效');
  });

  it('服务启动时 force 检查：状态命令说未登录就直接记上标记', async () => {
    const h = await fixture([], { agentStatusCheck: async () => 'logged_out' });
    expect(await h.runtime.checkAgentAvailability('claude-code', { force: true })).toMatchObject({ reason: 'Claude Code 未登录' });
  });

  it('没有状态命令的 Agent：复查清掉标记，让下一次真实请求当检查', async () => {
    const h = await fixture([authFailure], { agentStatusCheck: () => undefined });
    await h.runtime.send(h.session.id, 'first');
    expect(h.runtime.getAgentAvailability('claude-code')).toBeDefined();
    expect(await h.runtime.checkAgentAvailability('claude-code')).toBeUndefined();
    expect(h.runtime.getAgentAvailability('claude-code')).toBeUndefined();
  });

  it('认出的失败种类与修法', () => {
    expect(agentAuthFailure({ code: 'AGENT_LOGIN_REQUIRED' })).toBe('login');
    expect(agentAuthFailure({ code: 'ACP_PROVIDER_TERMINAL_ERROR', detailCode: 'access' })).toBe('credential');
    expect(agentAuthFailure({ code: 'ACP_PROVIDER_TERMINAL_ERROR', detailCode: 'provider_error' })).toBeUndefined();
    expect(agentAuthFailure({ code: 'provider_no_model_reply', message: 'Claude 未产生模型回复' })).toBeUndefined();
    const ccflash = { id: 'ccflash', name: 'ccflash', command: '/home/u/.local/bin/claude', args: ['--settings', '/home/u/.dutydeck/agent-profiles/ccflash.settings.json'], env: {} } as unknown as AgentConfig;
    expect(agentLoginProblem(ccflash, 'credential').remedy).toBe('在开发机执行 `claude /login`，或检查 /home/u/.dutydeck/agent-profiles/ccflash.settings.json 里的凭据');
  });
});

describe('Agent 是否停下', () => {
  it('有轮次在跑为 busy，驱动确认空闲为 idle，驱动说不准为 unknown', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await fixture([]);
    // 没有驱动、也没有执行进程：没有东西在跑。
    expect(h.runtime.inspectAgentQuiescence('ses_without_driver')).toBe('idle');
    await h.runtime.send(h.session.id, 'warm up');
    expect(h.runtime.inspectAgentQuiescence(h.session.id)).toBe('idle');
    h.driver.idle = false;
    expect(h.runtime.inspectAgentQuiescence(h.session.id)).toBe('unknown');
    h.driver.idle = true;
    // 驱动不在了、执行进程还没确认退出（可能是还没接回的持久终端）：说不准。
    const drivers = (h.runtime as any).drivers as Map<string, unknown>;
    const attached = drivers.get(h.session.id);
    drivers.delete(h.session.id);
    expect(h.runtime.inspectAgentQuiescence(h.session.id)).toBe('unknown');
    drivers.set(h.session.id, attached);
    const driver = (h.runtime as any).drivers.get(h.session.id);
    const send = driver.send;
    driver.send = async (input: unknown) => { await gate; return send(input); };
    const task = await h.runtime.dispatch(h.session.id, 'slow');
    await vi.waitFor(() => expect(h.runtime.inspectAgentQuiescence(h.session.id)).toBe('busy'));
    release();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id)).find(item => item.id === task.id)?.status).toBe('completed'));
    expect(h.runtime.inspectAgentQuiescence(h.session.id)).toBe('idle');
  });
});
