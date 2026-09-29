import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { createAutomationIntegration } from './automation-integration.js';
import { SessionAutomationService } from './session-automation.js';
import { __testOnly_resetLarkGate } from './lark/api-gate.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); __testOnly_resetLarkGate(); });
const json = (response: ServerResponse, body: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-auto-http-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const provider = { uploads: 0, files: [] as string[], summaries: [] as string[], mode: 'ok' as 'ok' | 'fail_summary' | 'hold_summary', held: [] as ServerResponse[], disconnected: 0,
    afterFile: undefined as (() => Promise<void>) | undefined };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const path = request.url!;
    if (path.includes('/auth/')) { json(response, { code: 0, tenant_access_token: 'synthetic', expire: 3600 }); return; }
    if (path === '/open-apis/im/v1/files') { provider.uploads++; json(response, { code: 0, data: { file_key: `file_${provider.uploads}` } }); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.msg_type === 'file') {
      provider.files.push(body.uuid);
      await provider.afterFile?.();
      json(response, { code: 0, data: { message_id: `om_file_${provider.files.length}` } }); return;
    }
    provider.summaries.push(body.uuid);
    if (provider.mode === 'hold_summary') {
      provider.held.push(response);
      response.on('close', () => { if (!response.writableEnded) provider.disconnected++; });
      return;
    }
    if (provider.mode === 'fail_summary') { json(response, { code: 123456, msg: 'synthetic summary failure' }); return; }
    json(response, { code: 0, data: { message_id: `om_summary_${provider.summaries.length}` } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const env = { LARK_OPEN_API_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, LARK_API_QPS: '1000', LARK_API_BURST: '1000',
    LARK_API_RETRY_MAX_ATTEMPTS: '0', LARK_API_REQUEST_TIMEOUT_MS: '10000' };
  const bot = { appId: 'cli_http', appSecret: 'synthetic', listening: true, fullTrustConfirmed: true, allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], allowedEmails: [] };
  const now = { value: new Date('2026-09-12T00:00:00.000Z') };
  const state = { output: 'answer', sends: 0 };
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: directory, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  let active: Awaited<ReturnType<typeof open>>;
  async function open() {
    const repos = createRepositories(join(directory, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
    let automation!: SessionAutomationService;
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0,
      authorizeTask: (session, task, phase) => automation.authorizeTask(task, phase),
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (_agent, _protocol, emit) => ({ start: async () => {}, send: async () => {
        state.sends++; emit({ type: 'text', data: { text: state.output } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      }, stop: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true }) });
    await runtime.initialize([agent]);
    await repos.config.set('lark.bots', JSON.stringify([bot]));
    const integration = createAutomationIntegration(repos, runtime, { authorize: async () => undefined } as any, { env, log: { warn: () => {} } });
    automation = new SessionAutomationService({ repositories: repos, runtime, ...integration, clock: () => new Date(now.value) });
    return { repos, runtime, automation, integration, close: async () => { await automation.close(); await runtime.shutdown(); repos.close(); } };
  }
  active = await open();
  cleanups.push(() => active.close());
  const session = await active.runtime.start({ agentId: 'mock', source: 'lark', sourceId: 'cli_http:oc_http:group' });
  await active.repos.channelMappings.save({ id: 'original', channel: 'lark-card:cli_http', externalId: 'original', sessionId: session.id, createdAt: now.value.toISOString(),
    extra: JSON.stringify({ app_id: 'cli_http', chat_id: 'oc_http', reply_message_id: 'om_original', reply_in_thread: true }) });
  const schedule = async (output: string) => {
    state.output = output;
    const at = new Date(now.value.getTime() + 1000);
    const created = await active.automation.createSchedule(session.id, { name: 'HTTP result', prompt: 'run', trigger: { kind: 'at', localDateTime: at.toISOString().slice(0, 19) },
      timezone: 'UTC', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' } }, 'ou_alice');
    await active.automation.updateSchedule(session.id, created.id, { expectedRevision: 1, enabled: true }, 'ou_alice');
    now.value = new Date(at.getTime() + 1);
    await active.automation.tick();
    const occurrence = (await active.automation.listBySession(session.id, 'ou_alice')).occurrences.find(item => item.scheduleId === created.id)!;
    await vi.waitFor(async () => expect((await active.runtime.getTasks(session.id)).find(task => task.id === occurrence.taskId)?.status).toBe('completed'));
    await active.automation.tick();
    return occurrence.id;
  };
  const delivery = async (id: string) => JSON.parse((await active.repos.config.get(`session_automation/occurrence/${id}`))!).delivery;
  return { provider, now, state, session, bot, schedule, delivery, get current() { return active; }, restart: async () => { await active.close(); active = await open(); } };
}

it('uses real HTTP and reopened SQLite to resume only missing result segments with separate occurrence receipts', async () => {
  const h = await fixture();
  h.provider.mode = 'fail_summary';
  const first = await h.schedule('完整结果🙂'.repeat(5000));
  await vi.waitFor(async () => expect(await h.delivery(first)).toMatchObject({ status: 'error', attempts: 1 }));
  expect(h.provider.uploads).toBe(1); expect(h.provider.files).toHaveLength(1);
  const summaryAttempts = h.provider.summaries.length;
  await h.restart(); h.provider.mode = 'ok';
  await h.current.automation.tick();
  await vi.waitFor(async () => expect(await h.delivery(first)).toMatchObject({ status: 'delivered', attempts: 2 }));
  expect(h.provider.uploads).toBe(1); expect(h.provider.files).toHaveLength(1);
  expect(h.provider.summaries).toHaveLength(summaryAttempts + 1); expect(new Set(h.provider.summaries).size).toBe(1);
  expect(h.state.sends).toBe(1);
  // Simulate a crash after the provider receipt commit but before the source acknowledgement.
  const key = `session_automation/occurrence/${first}`;
  const raw = (await h.current.repos.config.get(key))!; const value = JSON.parse(raw);
  await h.current.repos.config.compareAndSet!(key, raw, JSON.stringify({ ...value, revision: value.revision + 1, delivery: { ...value.delivery, status: 'pending' } }));
  await h.restart(); await h.current.automation.tick();
  await vi.waitFor(async () => expect(await h.delivery(first)).toMatchObject({ status: 'delivered', attempts: 3 }));
  expect(h.provider.summaries).toHaveLength(summaryAttempts + 1);
  const second = await h.schedule('另一份完整结果🙂'.repeat(5000));
  await vi.waitFor(async () => expect(await h.delivery(second)).toMatchObject({ status: 'delivered' }));
  expect(h.provider.uploads).toBe(2); expect(h.provider.files).toHaveLength(2); expect(new Set(h.provider.files).size).toBe(2);
  expect(new Set(h.provider.summaries).size).toBe(2); expect(h.state.sends).toBe(2);
});

it('cancels pending HTTP on concurrent close, persists retryable delivery, and resumes after reopening', async () => {
  const h = await fixture(); h.provider.mode = 'hold_summary';
  const first = await h.schedule('answer');
  await vi.waitFor(() => expect(h.provider.held).toHaveLength(1));
  await Promise.all([h.current.automation.close(), h.current.automation.close()]);
  await vi.waitFor(() => expect(h.provider.disconnected).toBe(1));
  expect(await h.delivery(first)).toMatchObject({ status: 'error', attempts: 1 });
  const raw = JSON.parse((await h.current.repos.config.get(`session_automation/occurrence/${first}`))!);
  expect(raw.leaseOwner).toBeUndefined();
  h.provider.mode = 'ok'; await h.restart(); await h.current.automation.tick();
  await vi.waitFor(async () => expect(await h.delivery(first)).toMatchObject({ status: 'delivered', attempts: 2 }));
  expect(h.state.sends).toBe(1);
});

it('rechecks revoked authorization after a successful file send before summary or fallback HTTP', async () => {
  const h = await fixture();
  h.provider.afterFile = async () => { await h.current.repos.config.set('lark.bots', JSON.stringify([{ ...h.bot, listening: false }])); };
  const first = await h.schedule('完整结果🙂'.repeat(5000));
  await vi.waitFor(async () => expect(await h.delivery(first)).toMatchObject({ status: 'error', attempts: 1 }));
  expect(h.provider.uploads).toBe(1); expect(h.provider.files).toHaveLength(1); expect(h.provider.summaries).toHaveLength(0);
  expect((await h.current.repos.config.list!('lark.delivery.')).length).toBe(2);
});

it('aborts only the sender whose source lost its lease while a second HTTP delivery completes', async () => {
  const h = await fixture(); h.provider.mode = 'hold_summary';
  const heartbeats: Array<() => void> = [];
  const original = globalThis.setInterval;
  const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, ms: number) => {
    if (ms === 10_000) heartbeats.push(handler);
    return original(handler, ms);
  }) as typeof setInterval);
  try {
    const first = await h.schedule('one');
    await vi.waitFor(() => expect(h.provider.held).toHaveLength(1));
    const second = await h.schedule('two');
    await vi.waitFor(() => expect(h.provider.held).toHaveLength(2));
    const key = `session_automation/occurrence/${first}`;
    const raw = (await h.current.repos.config.get(key))!; const value = JSON.parse(raw);
    await h.current.repos.config.compareAndSet!(key, raw, JSON.stringify({ ...value, revision: value.revision + 1, delivery: { ...value.delivery, status: 'not_requested' } }));
    heartbeats[0]!();
    await vi.waitFor(() => expect(h.provider.disconnected).toBe(1));
    expect(h.provider.held[1]!.destroyed).toBe(false);
    json(h.provider.held[1]!, { code: 0, data: { message_id: 'om_second' } });
    await vi.waitFor(async () => expect(await h.delivery(second)).toMatchObject({ status: 'delivered', attempts: 1 }));
    expect(await h.delivery(first)).toMatchObject({ status: 'not_requested', attempts: 0 });
    expect(h.provider.summaries).toHaveLength(2);
  } finally { timer.mockRestore(); }
});
