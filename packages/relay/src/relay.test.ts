import { describe, expect, it, vi } from 'vitest';
import {
  RelayAskBroker,
  RelayCapabilityRegistry,
  RelayError,
  RelayService,
  loadOrCreateRelaySigningSecret,
  relayCommandEnvKey,
  relaySigningSecretConfigKey,
  relayTokenEnvKey,
  relayUrlEnvKey,
  type RelayEventPublisher,
  type RelaySessionSnapshot
} from './index.js';

const liveSession = (id: string): RelaySessionSnapshot => ({ id, state: 'idle' });

function sessionLookup(sessions: Record<string, RelaySessionSnapshot | undefined>) {
  return { async get(id: string) { return sessions[id]; } };
}

function recordingPublisher() {
  const published: Array<{ sessionId: string; kind: string; text: string; askId?: string }> = [];
  const publisher: RelayEventPublisher = {
    async publish(sessionId, input) { published.push({ sessionId, ...input }); }
  };
  return { published, publisher };
}

const bearer = (token: string) => `Bearer ${token}`;

describe('relay capability', () => {
  it('mints a token that decodes back to its own session and rejects other sessions', async () => {
    const sessions = sessionLookup({ ses_a: liveSession('ses_a'), ses_b: liveSession('ses_b') });
    const registry = new RelayCapabilityRegistry(sessions, 'http://127.0.0.1:4310', 'secret');

    const tokenA = registry.tokenFor('ses_a');
    expect((await registry.resolve(tokenA)).sessionId).toBe('ses_a');

    // 关键回归：拿 A 的 token 去操作 B 必须被拒，否则一个会话能冒充另一个
    await expect(registry.resolve(tokenA, 'ses_b')).rejects.toMatchObject({ code: 'RELAY_UNAUTHORIZED', statusCode: 401 });
    // 反过来 B 的 token 解出的也只能是 B，绝不能是调用方自报的 A
    expect((await registry.resolve(registry.tokenFor('ses_b'), 'ses_b')).sessionId).toBe('ses_b');
  });

  it('rejects a missing token, a forged signature, and a tampered session id', async () => {
    const sessions = sessionLookup({ ses_a: liveSession('ses_a'), ses_evil: liveSession('ses_evil') });
    const registry = new RelayCapabilityRegistry(sessions, 'http://127.0.0.1:4310', 'secret');

    await expect(registry.resolve(undefined)).rejects.toMatchObject({ code: 'RELAY_CONTEXT_REQUIRED', statusCode: 401 });
    await expect(registry.resolve('   ')).rejects.toMatchObject({ code: 'RELAY_CONTEXT_REQUIRED' });
    await expect(registry.resolve('garbage')).rejects.toMatchObject({ code: 'RELAY_UNAUTHORIZED' });

    // 换掉 payload 段但保留别人的签名段：签名必须重算失败
    const [, , digest] = registry.tokenFor('ses_a').split('.');
    const forged = `v1.${Buffer.from('ses_evil', 'utf8').toString('base64url')}.${digest}`;
    await expect(registry.resolve(forged)).rejects.toMatchObject({ code: 'RELAY_UNAUTHORIZED' });

    // 另一个 secret 签出来的 token 不能在本实例通过
    const other = new RelayCapabilityRegistry(sessions, 'http://127.0.0.1:4310', 'other-secret');
    await expect(registry.resolve(other.tokenFor('ses_a'))).rejects.toMatchObject({ code: 'RELAY_UNAUTHORIZED' });
  });

  it('rejects tokens for sessions that ended, were archived, or never existed', async () => {
    const sessions = sessionLookup({
      ses_stopped: { id: 'ses_stopped', state: 'stopped' },
      ses_failed: { id: 'ses_failed', state: 'failed' },
      ses_archived: { id: 'ses_archived', state: 'idle', archivedAt: new Date().toISOString() }
    });
    const registry = new RelayCapabilityRegistry(sessions, 'http://127.0.0.1:4310', 'secret');
    for (const id of ['ses_stopped', 'ses_failed', 'ses_archived', 'ses_missing']) {
      await expect(registry.resolve(registry.tokenFor(id))).rejects.toMatchObject({ code: 'RELAY_SESSION_ENDED', statusCode: 401 });
    }
  });

  it('injects relay env for ANY session — the M3 gap versus lark group tools', () => {
    const registry = new RelayCapabilityRegistry(sessionLookup({}), 'http://127.0.0.1:4310/', 'secret', "'node' '/abs/cli.js'");
    const env = registry.environmentFor('ses_web');
    // 该会话没有任何飞书绑定，仍然拿到完整回传凭证
    expect(env[relayUrlEnvKey]).toBe('http://127.0.0.1:4310/api/relay');
    expect(env[relayTokenEnvKey]).toBe(registry.tokenFor('ses_web'));
    expect(env[relayCommandEnvKey]).toBe("'node' '/abs/cli.js'");
    // 键名必须是小写 snake_case（ACPX 持久化键名约束）
    for (const key of Object.keys(env)) expect(key).toBe(key.toLowerCase());
  });

  it('is deterministic across restarts so a long-lived child keeps working', async () => {
    const store = new Map<string, string>();
    const fakeStore = {
      async get(key: string) { return store.get(key); },
      async set(key: string, value: string) { store.set(key, value); }
    };
    const first = await loadOrCreateRelaySigningSecret(fakeStore);
    const second = await loadOrCreateRelaySigningSecret(fakeStore);
    expect(second).toBe(first);
    expect(store.get(relaySigningSecretConfigKey)).toBe(first);

    // 同一 secret 重建 registry（模拟 daemon 重启）后，旧 token 仍然有效
    const sessions = sessionLookup({ ses_a: liveSession('ses_a') });
    const before = new RelayCapabilityRegistry(sessions, 'http://x', first).tokenFor('ses_a');
    const after = new RelayCapabilityRegistry(sessions, 'http://x', second);
    expect((await after.resolve(before)).sessionId).toBe('ses_a');
  });
});

describe('relay send', () => {
  it('publishes into the session event stream under the token-derived session', async () => {
    const { published, publisher } = recordingPublisher();
    const sessions = sessionLookup({ ses_a: liveSession('ses_a') });
    const registry = new RelayCapabilityRegistry(sessions, 'http://x', 'secret');
    const service = new RelayService(registry, publisher, new RelayAskBroker(publisher));

    const result = await service.send(bearer(registry.tokenFor('ses_a')), 'ses_a', { text: '  进度过半  ' });
    expect(result).toMatchObject({ ok: true, sessionId: 'ses_a', delivered: true });
    expect(published).toEqual([{ sessionId: 'ses_a', kind: 'send', text: '进度过半' }]);
  });

  it('refuses empty text and text past the length cap, and never publishes them', async () => {
    const { published, publisher } = recordingPublisher();
    const registry = new RelayCapabilityRegistry(sessionLookup({ ses_a: liveSession('ses_a') }), 'http://x', 'secret');
    const service = new RelayService(registry, publisher, new RelayAskBroker(publisher));
    const auth = bearer(registry.tokenFor('ses_a'));

    await expect(service.send(auth, 'ses_a', { text: '   ' })).rejects.toMatchObject({ code: 'RELAY_MESSAGE_REQUIRED', statusCode: 400 });
    await expect(service.send(auth, 'ses_a', { text: 'x'.repeat(32_001) })).rejects.toMatchObject({ statusCode: 413 });
    expect(published).toEqual([]);
  });

  it('does not publish when the caller is unauthorized', async () => {
    const { published, publisher } = recordingPublisher();
    const registry = new RelayCapabilityRegistry(sessionLookup({ ses_a: liveSession('ses_a'), ses_b: liveSession('ses_b') }), 'http://x', 'secret');
    const service = new RelayService(registry, publisher, new RelayAskBroker(publisher));

    await expect(service.send(undefined, 'ses_a', { text: 'hi' })).rejects.toBeInstanceOf(RelayError);
    await expect(service.send(bearer(registry.tokenFor('ses_b')), 'ses_a', { text: 'hi' })).rejects.toMatchObject({ code: 'RELAY_UNAUTHORIZED' });
    expect(published).toEqual([]);
  });
});

describe('relay ask', () => {
  it('blocks until answered and returns the answer', async () => {
    const { published, publisher } = recordingPublisher();
    const broker = new RelayAskBroker(publisher);
    const registry = new RelayCapabilityRegistry(sessionLookup({ ses_a: liveSession('ses_a') }), 'http://x', 'secret');
    const service = new RelayService(registry, publisher, broker);

    const pending = service.ask(bearer(registry.tokenFor('ses_a')), 'ses_a', { question: '要发布吗？' });
    let settled = false;
    void pending.then(() => { settled = true; });

    // 问题必须先进事件流，用户才看得见
    await vi.waitFor(() => expect(broker.listPending('ses_a')).toHaveLength(1));
    expect(published[0]).toMatchObject({ sessionId: 'ses_a', kind: 'ask', text: '要发布吗？' });
    // 关键：此刻仍未 resolve —— 这就是「阻塞」
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    const askId = broker.listPending('ses_a')[0]!.id;
    await service.answer('ses_a', askId, { answer: '  发布  ' });
    await expect(pending).resolves.toMatchObject({ status: 'answered', answer: '发布', askId });
    // 回答也进事件流，用户在时间线里看得到自己答了什么
    expect(published[1]).toMatchObject({ sessionId: 'ses_a', kind: 'answer', text: '发布', askId });
    expect(broker.listPending('ses_a')).toHaveLength(0);
  });

  it('expires after the timeout instead of hanging forever', async () => {
    const { publisher } = recordingPublisher();
    const broker = new RelayAskBroker(publisher);
    const outcome = await broker.register({ sessionId: 'ses_a', question: '在吗？', timeoutMs: 1_000 });
    expect(outcome).toMatchObject({ status: 'expired' });
    expect(broker.listPending('ses_a')).toHaveLength(0);
    expect(broker.get(outcome.askId)).toMatchObject({ status: 'expired' });
  });

  it('wakes blocked asks when the session ends — never leaves the child hanging', async () => {
    const { publisher } = recordingPublisher();
    const broker = new RelayAskBroker(publisher);
    const first = broker.register({ sessionId: 'ses_a', question: 'q1', timeoutMs: 60_000 });
    const second = broker.register({ sessionId: 'ses_a', question: 'q2', timeoutMs: 60_000 });
    const other = broker.register({ sessionId: 'ses_b', question: 'q3', timeoutMs: 60_000 });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(3));

    broker.cancelSession('ses_a', '会话已停止');

    expect(await first).toMatchObject({ status: 'cancelled', reason: '会话已停止' });
    expect(await second).toMatchObject({ status: 'cancelled' });
    // 别的会话的提问不受影响
    expect(broker.listPending('ses_b')).toHaveLength(1);
    broker.close();
    expect(await other).toMatchObject({ status: 'cancelled' });
  });

  it('wakes blocked asks on shutdown', async () => {
    const { publisher } = recordingPublisher();
    const broker = new RelayAskBroker(publisher);
    const pending = broker.register({ sessionId: 'ses_a', question: 'q', timeoutMs: 60_000 });
    await vi.waitFor(() => expect(broker.listPending('ses_a')).toHaveLength(1));
    broker.close('Dutydeck 服务已关闭');
    expect(await pending).toMatchObject({ status: 'cancelled', reason: 'Dutydeck 服务已关闭' });
  });

  it('does not register the ask when publishing the question fails', async () => {
    const broker = new RelayAskBroker({
      async publish() { throw new Error('stream down'); }
    });
    await expect(broker.register({ sessionId: 'ses_a', question: 'q', timeoutMs: 60_000 })).rejects.toThrow('stream down');
    // 否则子进程会阻塞在一个用户根本看不见的问题上
    expect(broker.listPending('ses_a')).toHaveLength(0);
  });

  it('rejects answering an unknown, already-settled, or cross-session ask', async () => {
    const { publisher } = recordingPublisher();
    const broker = new RelayAskBroker(publisher);
    const pending = broker.register({ sessionId: 'ses_a', question: 'q', timeoutMs: 60_000 });
    await vi.waitFor(() => expect(broker.listPending('ses_a')).toHaveLength(1));
    const askId = broker.listPending('ses_a')[0]!.id;

    await expect(broker.answer('ask_missing', 'x')).rejects.toMatchObject({ code: 'RELAY_ASK_NOT_FOUND', statusCode: 404 });
    // 另一个会话不能替本会话回答
    await expect(broker.answer(askId, 'x', { sessionId: 'ses_b' })).rejects.toMatchObject({ code: 'RELAY_ASK_NOT_FOUND' });
    await expect(broker.answer(askId, '   ')).rejects.toMatchObject({ code: 'RELAY_ANSWER_REQUIRED', statusCode: 400 });

    await broker.answer(askId, '好');
    await pending;
    // 重复回答必须报 409，而不是静默成功
    await expect(broker.answer(askId, '再答一次')).rejects.toMatchObject({ code: 'RELAY_ASK_SETTLED', statusCode: 409 });
  });

  it('validates the timeout range and the question', async () => {
    const { publisher } = recordingPublisher();
    const broker = new RelayAskBroker(publisher);
    await expect(broker.register({ sessionId: 'ses_a', question: '  ' })).rejects.toMatchObject({ code: 'RELAY_QUESTION_REQUIRED' });
    for (const timeoutMs of [0, -1, 999, 3_600_001, 1.5]) {
      await expect(broker.register({ sessionId: 'ses_a', question: 'q', timeoutMs })).rejects.toMatchObject({ code: 'RELAY_INVALID_TIMEOUT' });
    }
  });
});
