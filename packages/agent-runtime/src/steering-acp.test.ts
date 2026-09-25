import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

// 插话请求挂着不回时，会话不能被它卡住：真实 AcpxAdapter + Mock ACP 子进程，
// 只 mock driver 证明不了 ACP 连接上挂着的请求何时结束。
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(env: Record<string, string> = { mock_acp_steering: '1', mock_acp_agent_name: '@agentclientprotocol/claude-agent-acp' }) {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-steering-acp-'));
  const repos = createRepositories(join(directory, 'state.sqlite'), { newDatabaseAuthority: 'ledger_v1' });
  const agent = agentConfigSchema.parse({ id: 'mock', name: 'Mock', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp', cwd: directory, env, permissionMode: 'ask', timeout: 10 });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe: (() => ({ available: true, protocol: 'acp', acp: true })) as any });
  cleanup.push(async () => { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id, cwd: directory });
  const texts = async () => (await runtime.getEvents(session.id)).filter(event => event.type === 'text').map(event => String((event.data as { text?: unknown }).text));
  const status = async (taskId: string) => (await runtime.getTasks(session.id)).find(task => task.id === taskId)?.status;
  const running = async () => {
    const first = await runtime.dispatch(session.id, 'wait for steering');
    await expect.poll(texts, { timeout: 10_000 }).toContain('waiting for steering');
    return first;
  };
  return { repos, runtime, session, texts, status, running };
}

describe('unanswered ACP steering request', () => {
  it('leaves cancel, interrupt and stop usable, and ends only when the connection closes', async () => {
    const h = await fixture();
    const first = await h.running();
    const second = await h.runtime.dispatch(h.session.id, 'never answer this');
    const third = await h.runtime.dispatch(h.session.id, 'third');
    const steering = h.runtime.injectQueued(h.session.id, second.id, 'installation_owner');
    await expect.poll(h.texts, { timeout: 10_000 }).toContain('steering unanswered');
    // The agent may already hold the steered content, so that one Task cannot be cancelled mid-request; others can.
    await expect(h.runtime.cancelQueued(h.session.id, second.id, 'installation_owner')).rejects.toMatchObject({ code: 'STEERING_IN_PROGRESS' });
    await h.runtime.cancelQueued(h.session.id, third.id, 'installation_owner');
    expect(await h.status(third.id)).toBe('cancelled');
    await h.runtime.interrupt(h.session.id, first.id, 'installation_owner');
    await expect.poll(() => h.status(first.id), { timeout: 10_000 }).toBe('interrupted');
    // The turn ending does not end the request: without the runtime timeout the queue would wait on it.
    expect(await Promise.race([steering.then(() => 'settled'), new Promise(done => setTimeout(done, 500, 'pending'))])).toBe('pending');
    expect(await h.status(second.id)).toBe('queued');
    await h.runtime.stop(h.session.id, { kind: 'installation_owner', id: 'installation_owner' });
    await expect(steering).resolves.toMatchObject({ outcome: 'failed' });
  });

  it('keeps the Task queued for its own turn when the agent advertises steering but does not honour promptRequired', async () => {
    const h = await fixture({ mock_acp_steering: '1', mock_acp_agent_name: '@agentclientprotocol/codex-acp' });
    const first = await h.running();
    const second = await h.runtime.dispatch(h.session.id, 'second');
    await expect(h.runtime.injectQueued(h.session.id, second.id, 'installation_owner')).resolves.toMatchObject({ outcome: 'unsupported', task: { status: 'queued' } });
    expect((await h.texts()).some(text => text.startsWith('Steered:'))).toBe(false);
    await h.runtime.interrupt(h.session.id, first.id, 'installation_owner');
    await expect.poll(() => h.status(second.id), { timeout: 10_000 }).toBe('completed');
    expect(await h.texts()).toContain('Mock reply: second');
  });

  it('ends a pending steering request when the agent connection drops, leaving the Task queued', async () => {
    const h = await fixture();
    const first = await h.running();
    const second = await h.runtime.dispatch(h.session.id, 'drop connection');
    await expect(h.runtime.injectQueued(h.session.id, second.id, 'installation_owner')).resolves.toMatchObject({ outcome: 'failed', task: { status: 'queued' } });
    // The dropped turn follows crash recovery (reconcile_required pauses the queue by design); steering no longer holds the Task.
    await expect.poll(() => h.status(first.id), { timeout: 10_000 }).toBe('reconcile_required');
    await h.runtime.cancelQueued(h.session.id, second.id, 'installation_owner');
    expect(await h.status(second.id)).toBe('cancelled');
  });
});
