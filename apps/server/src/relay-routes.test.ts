import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { createRepositories } from '@dockmux/storage';
import { RelayAskBroker, RelayCapabilityRegistry } from '@dockmux/relay';
import type { AgentEvent, EventType, Session } from '@dockmux/shared';

const apps: any[] = [];
const repositories: Array<ReturnType<typeof createRepositories>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const repository of repositories.splice(0)) repository.close();
});

/**
 * 最小 runtime 替身：只实现 relay 真正用到的三个方法
 * （publishSessionEvent / subscribe / getEvents），并保留真实的
 * 序号推进与 fan-out 语义，用来验证「消息确实进了事件流」。
 */
function fakeRuntime(sessions: Record<string, Session | undefined>) {
  const events: AgentEvent[] = [];
  const listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  let sequence = 0;
  return {
    events,
    listeners,
    async getSession(id: string) { return sessions[id]; },
    async publishSessionEvent(sessionId: string, type: EventType, data: unknown) {
      const session = sessions[sessionId];
      if (!session) throw Object.assign(new Error('missing'), { statusCode: 404 });
      const event: AgentEvent = { id: `evt_${++sequence}`, sessionId, sequence, type, timestamp: new Date().toISOString(), data };
      events.push(event);
      for (const listener of listeners.get(sessionId) ?? []) listener(event);
      return event;
    },
    subscribe(sessionId: string, listener: (event: AgentEvent) => void) {
      const set = listeners.get(sessionId) ?? new Set();
      set.add(listener);
      listeners.set(sessionId, set);
      return () => set.delete(listener);
    },
    async getEvents(sessionId: string, after = 0) { return events.filter(e => e.sessionId === sessionId && e.sequence > after); }
  };
}

const session = (id: string, state = 'idle'): Session => ({
  id, agentId: 'claude-code', state: state as Session['state'], cwd: '/tmp',
  runId: 'run_1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
});

async function harness(sessions: Record<string, Session | undefined> = { ses_a: session('ses_a') }) {
  const runtime = fakeRuntime(sessions);
  const capabilities = new RelayCapabilityRegistry(
    { async get(id) { const found = sessions[id]; return found && { id: found.id, state: found.state, archivedAt: found.archivedAt }; } },
    'http://127.0.0.1:4310',
    'test-secret'
  );
  const broker = new RelayAskBroker({
    async publish(sessionId, input) {
      await runtime.publishSessionEvent(sessionId, 'text', { text: input.text, relay: input.kind, ...(input.askId ? { askId: input.askId } : {}) });
    }
  });
  const app = await buildApp(runtime as any, { relay: { runtime: runtime as any, capabilities, broker } });
  apps.push(app);
  return { app, runtime, capabilities, broker };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('relay routes — authentication', () => {
  it('rejects a request with no token, a garbage token, and another session\'s token', async () => {
    const { app, capabilities, runtime } = await harness({ ses_a: session('ses_a'), ses_b: session('ses_b') });

    const missing = await app.inject({ method: 'POST', url: '/api/relay/sessions/ses_a/send', payload: { text: 'hi' } });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('RELAY_CONTEXT_REQUIRED');

    const garbage = await app.inject({ method: 'POST', url: '/api/relay/sessions/ses_a/send', headers: auth('nope'), payload: { text: 'hi' } });
    expect(garbage.statusCode).toBe(401);

    // 拿 B 的 token 打 A 的路径：必须 401
    const crossed = await app.inject({ method: 'POST', url: '/api/relay/sessions/ses_a/send', headers: auth(capabilities.tokenFor('ses_b')), payload: { text: 'hi' } });
    expect(crossed.statusCode).toBe(401);
    expect(crossed.json().error.code).toBe('RELAY_UNAUTHORIZED');

    // 三次被拒都不能有任何事件落进流里
    expect(runtime.events).toHaveLength(0);
  });

  it('binds the message to the token\'s session even if the path claims another one', async () => {
    const { app, capabilities, runtime } = await harness({ ses_a: session('ses_a'), ses_b: session('ses_b') });
    // 用 self 占位（CLI 的实际形态）：会话完全由 token 决定
    const response = await app.inject({ method: 'POST', url: '/api/relay/sessions/self/send', headers: auth(capabilities.tokenFor('ses_b')), payload: { text: 'from b' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ sessionId: 'ses_b' });
    expect(runtime.events.map(e => e.sessionId)).toEqual(['ses_b']);
  });
});

describe('relay send — reaches the event stream', () => {
  it('appends a text event carrying the relay marker', async () => {
    const { app, capabilities, runtime } = await harness();
    const response = await app.inject({ method: 'POST', url: '/api/relay/sessions/self/send', headers: auth(capabilities.tokenFor('ses_a')), payload: { text: '中途进度' } });

    expect(response.statusCode).toBe(200);
    expect(runtime.events).toHaveLength(1);
    expect(runtime.events[0]).toMatchObject({ sessionId: 'ses_a', type: 'text', sequence: 1, data: { text: '中途进度', relay: 'send' } });
    // 不能标成 user，否则 Web 时间线会把它当成新一轮的起点而切碎轮次
    expect((runtime.events[0]!.data as any).role).toBeUndefined();
  });

  it('is visible to a live subscriber (the SSE fan-out path)', async () => {
    const { app, capabilities, runtime } = await harness();
    const seen: AgentEvent[] = [];
    runtime.subscribe('ses_a', event => seen.push(event));

    await app.inject({ method: 'POST', url: '/api/relay/sessions/self/send', headers: auth(capabilities.tokenFor('ses_a')), payload: { text: 'live' } });

    expect(seen.map(e => (e.data as any).text)).toEqual(['live']);
  });

  it('rejects an empty message with 400 and writes nothing', async () => {
    const { app, capabilities, runtime } = await harness();
    const response = await app.inject({ method: 'POST', url: '/api/relay/sessions/self/send', headers: auth(capabilities.tokenFor('ses_a')), payload: { text: '  ' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('RELAY_MESSAGE_REQUIRED');
    expect(runtime.events).toHaveLength(0);
  });
});

describe('relay ask — blocking round trip over HTTP', () => {
  it('holds the response open until the user answers, then returns the answer', async () => {
    const { app, capabilities, broker, runtime } = await harness();

    const inFlight = app.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers: auth(capabilities.tokenFor('ses_a')), payload: { question: '继续吗？', timeoutMs: 30_000 } });
    let done = false;
    void inFlight.then(() => { done = true; });

    // 问题先落进事件流
    await vi.waitFor(() => expect(broker.listPending('ses_a')).toHaveLength(1));
    expect(runtime.events[0]).toMatchObject({ type: 'text', data: { relay: 'ask', text: '继续吗？' } });
    // 响应此刻仍被扣住
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(done).toBe(false);

    const askId = broker.listPending('ses_a')[0]!.id;
    const answered = await app.inject({ method: 'POST', url: `/api/relay/sessions/ses_a/asks/${askId}/answer`, payload: { answer: '继续' } });
    expect(answered.statusCode).toBe(200);

    const response = await inFlight;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'answered', answer: '继续' });
    expect(runtime.events.map(e => (e.data as any).relay)).toEqual(['ask', 'answer']);
  });

  it('returns expired (not an error) when nobody answers in time', async () => {
    const { app, capabilities } = await harness();
    const response = await app.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers: auth(capabilities.tokenFor('ses_a')), payload: { question: '在吗', timeoutMs: 1_000 } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'expired' });
  });

  it('wakes a blocked ask when the session reaches a terminal state', async () => {
    const { app, capabilities, broker, runtime } = await harness();
    const inFlight = app.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers: auth(capabilities.tokenFor('ses_a')), payload: { question: 'q', timeoutMs: 60_000 } });
    await vi.waitFor(() => expect(broker.listPending('ses_a')).toHaveLength(1));

    // 会话被 stop：status 事件经 runtime.subscribe 抵达 relay，必须唤醒等待者
    await runtime.publishSessionEvent('ses_a', 'status', { state: 'stopped' });

    const response = await inFlight;
    expect(response.json()).toMatchObject({ status: 'cancelled' });
  });

  it('rejects answering an unknown ask and a cross-session answer', async () => {
    const { app, capabilities, broker } = await harness({ ses_a: session('ses_a'), ses_b: session('ses_b') });
    const inFlight = app.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers: auth(capabilities.tokenFor('ses_a')), payload: { question: 'q', timeoutMs: 30_000 } });
    await vi.waitFor(() => expect(broker.listPending('ses_a')).toHaveLength(1));
    const askId = broker.listPending('ses_a')[0]!.id;

    expect((await app.inject({ method: 'POST', url: '/api/relay/sessions/ses_a/asks/ask_missing/answer', payload: { answer: 'x' } })).statusCode).toBe(404);
    // ses_b 想替 ses_a 的提问作答
    expect((await app.inject({ method: 'POST', url: `/api/relay/sessions/ses_b/asks/${askId}/answer`, payload: { answer: 'x' } })).statusCode).toBe(404);

    await app.inject({ method: 'POST', url: `/api/relay/sessions/ses_a/asks/${askId}/answer`, payload: { answer: 'ok' } });
    await inFlight;
    // 已结束的提问再答一次 → 409
    expect((await app.inject({ method: 'POST', url: `/api/relay/sessions/ses_a/asks/${askId}/answer`, payload: { answer: 'again' } })).statusCode).toBe(409);
  });

  it('lists pending asks for the session so the UI can render them', async () => {
    const { app, capabilities, broker } = await harness();
    void app.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers: auth(capabilities.tokenFor('ses_a')), payload: { question: '待答', timeoutMs: 30_000 } });
    await vi.waitFor(() => expect(broker.listPending('ses_a')).toHaveLength(1));

    const listed = await app.inject({ method: 'GET', url: '/api/relay/sessions/ses_a/asks' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().asks).toMatchObject([{ sessionId: 'ses_a', question: '待答', status: 'pending' }]);
    broker.close();
  });
});
