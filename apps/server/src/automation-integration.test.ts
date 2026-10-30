import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalExecutionJson, installationOwnerTaskActor, type AttemptResultV1, type RepositoryBundle, type TaskRequestV1 } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { createAutomationIntegration } from './automation-integration.js';
import { createLarkCardService, type LarkCardService } from './lark/service.js';
import { runAgentScheduleRequest } from './agent-schedule-request.js';
import { SessionAutomationService } from './session-automation.js';

const opened: RepositoryBundle[] = [];
const claims: Array<ReturnType<RepositoryBundle['control']['attachRuntime']>> = [];
afterEach(() => { for (const claim of claims.splice(0)) claim.release(); for (const repo of opened.splice(0)) repo.close(); });

async function fixture() {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); opened.push(repos);
  const claim = repos.control.attachRuntime('automation-integration-test'); claims.push(claim);
  const at = new Date().toISOString();
  const session = { id: 's1', agentId: 'a', source: 'lark', sourceId: 'cli_a:oc_chat:group:thread:om_root', cwd: process.cwd(), state: 'completed', runId: 'r', createdAt: at, updatedAt: at };
  repos.execution.bind(claim).createSession({ id: 's1', runId: 'r', agentId: 'a', cwd: process.cwd(), state: 'idle', source: 'lark', sourceId: 'cli_a:oc_chat:group:thread:om_root', permissionMode: 'ask', createdAt: at, updatedAt: at });
  let bot = { appId: 'cli_a', appSecret: 'secret-canary', listening: true, fullTrustConfirmed: true, allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], allowedEmails: [] };
  const setBot = async (patch: object) => { bot = { ...bot, ...patch }; await repos.config.set('lark.bots', JSON.stringify([bot])); };
  await setBot({});
  const groups = { authorize: vi.fn(async () => undefined), beginTurn: vi.fn() };
  const client = {
    getUserEmails: vi.fn(async () => []),
    reply: vi.fn<(...args: Parameters<LarkCardService['reply']>) => ReturnType<LarkCardService['reply']>>(async () => ({ messageId: 'om_result' })),
    send: vi.fn<(...args: Parameters<LarkCardService['send']>) => ReturnType<LarkCardService['send']>>(async () => ({ messageId: 'om_result' }))
  };
  const runtime = { getSession: vi.fn(async () => session), getEvents: vi.fn(async () => []) };
  const integration = createAutomationIntegration(repos, runtime as any, groups as any, { client: () => client as any, log: { warn: vi.fn() } });
  /** 经真实账本接受并结算 number=1 Attempt，冻结 AttemptResultV1；不依赖 getEvents 切片。 */
  const settleTask = (status: 'completed' | 'failed' | 'interrupted', text = 'target result', occurrenceId = 'occ1', sourceId = 'automation1', retry?: 'capacity' | 'manual'): AttemptResultV1 => {
    const x = repos.execution.bind(claim);
    const requestKey = `session-automation:schedule:${occurrenceId}`;
    const request: TaskRequestV1 = { version: 1, namespace: 'schedule', key: requestKey, sessionId: 's1', actor: { kind: 'channel', id: 'ou_alice', appId: 'cli_a' }, prompt: 'target', mode: 'queue', skills: [], options: { permissionMode: 'ask' }, sources: [], sourcePayload: { agentPrompt: 'target', skills: [] } };
    const input: any = { version: 2, prompt: 'target', executionContext: { agentPrompt: 'target', actorId: 'ou_alice' }, contentSources: [], executionOptions: { permissionMode: 'ask' } };
    const { digest: _digest, ...unsigned } = input;
    input.digest = createHash('sha256').update(canonicalExecutionJson(unsigned)).digest('hex');
    const accepted = x.acceptTask({ sessionId: 's1', runId: 'r' }, request, input, 'back');
    const taskId = accepted.task!.id;
    const claimed = x.claimNext({ sessionId: 's1', runId: 'r' })!;
    const first = claimed.attempt!;
    let attempt = first;
    if (retry) {
      let priorFence = { sessionId: 's1', runId: 'r', taskId, attemptId: first.attemptId, expectedRevision: first.revision };
      x.markSubmissionPending(priorFence, { submissionId: 'prior-submission', inputDigest: input.digest, resourceRefs: [], authorizationRefs: [] });
      priorFence = { ...priorFence, expectedRevision: repos.execution.getTaskExecution(taskId)!.currentAttempt!.revision };
      const failed = { kind: 'driver_result' as const, submissionId: 'prior-submission', outcome: 'failed' as const, outputDigest: createHash('sha256').update('').digest('hex'), stopReason: 'end_turn', complete: true };
      if (retry === 'capacity') {
        x.appendEvent(priorFence, { id: 'capacity-error', type: 'error', data: { code: 'codex_capacity', nativeSource: 'codex', nativeTerminal: true, capacityReason: 'selected_model_capacity', nativeTurnId: 'turn' } });
        x.settleCapacityRetry(priorFence, 'prior-settlement', failed);
        vi.useFakeTimers({ toFake: ['Date'] });
        try { vi.setSystemTime(Date.now() + 31_000); attempt = x.claimNext({ sessionId: 's1', runId: 'r' })!.attempt!; }
        finally { vi.useRealTimers(); }
      } else {
        x.settleAttempt(priorFence, 'prior-settlement', failed);
        const settled = repos.execution.getTaskExecution(taskId)!.currentAttempt!;
        x.retryAttempt({ ...priorFence, expectedRevision: settled.revision }, { decisionId: 'manual-retry', actor: request.actor, action: 'retry', allowDuplicateEffects: true, evidenceRefs: ['operator'], resourceChecks: [] }, []);
        attempt = x.claimNext({ sessionId: 's1', runId: 'r' })!.attempt!;
      }
    }
    let fence: any = { sessionId: 's1', runId: 'r', taskId, attemptId: attempt.attemptId, expectedRevision: attempt.revision };
    x.appendEvent(fence, { id: 'out', type: 'text', data: { role: 'assistant', text } });
    x.markSubmissionPending(fence, { submissionId: 'sub1', inputDigest: input.digest, resourceRefs: [], authorizationRefs: [] });
    const current = repos.execution.getTaskExecution(taskId)!.attempts.find(item => item.attemptId === attempt.attemptId)!;
    fence = { ...fence, expectedRevision: current.revision };
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    const settled = x.settleAttempt(fence, 'set1', { kind: 'driver_result', submissionId: 'sub1', outcome: status, outputDigest: digest, stopReason: 'end_turn', complete: true });
    const events = repos.execution.getAttemptEvents(attempt.attemptId);
    const throughSequence = events.filter(event => event.type === 'completed' && event.settlementId === 'set1').at(-1)!.sequence;
    const result: AttemptResultV1 = { version: 1, taskId, attemptId: attempt.attemptId, settlementId: 'set1', throughSequence, outcome: status, output: { text, digest } };
    repos.config.set(`session_automation/occurrence/${occurrenceId}`, JSON.stringify({
      schemaVersion: 2,
      id: occurrenceId,
      revision: 1,
      scheduleId: sourceId,
      sessionId: 's1',
      generation: 1,
      scheduledForUtc: new Date().toISOString(),
      conditionStatus: 'passed',
      runStatus: 'completed',
      taskId,
      runtimeAttemptId: first.attemptId,
      result,
      admission: {
        version: 1,
        kind: 'canonical',
        taskIdVersion: 'v1',
        taskId,
        request
      },
      actor: { kind: 'channel', id: 'ou_alice', appId: 'cli_a' },
      delivery: { status: 'pending', attempts: 0, updatedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
    return result;
  };
  return { repos, session, setBot, groups, client, runtime, settleTask, ...integration };
}

describe('automation service integration', () => {
  it('accepts only a verified automatic successor while keeping the source pinned to its first admission', async () => {
    const f = await fixture();
    const result = f.settleTask('completed', 'safe capacity result', 'occ1', 'automation1', 'capacity');
    const source = JSON.parse((await f.repos.config.get('session_automation/occurrence/occ1'))!);
    expect(source.runtimeAttemptId).not.toBe(result.attemptId);
    await f.repos.config.set('automation.delivery-target.automation1', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_original', replyInThread: true }));
    await f.deliver('s1', result, 'occ1', 'automation1');
    await f.deliver('s1', result, 'occ1', 'automation1');
    expect(f.client.reply).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.client.reply.mock.calls)).toContain('safe capacity result');
    expect(JSON.parse((await f.repos.config.get('session_automation/occurrence/occ1'))!).runtimeAttemptId).toBe(source.runtimeAttemptId);
  });

  it('delivers an audited manual successor while preserving the first admission', async () => {
    const f = await fixture();
    const result = f.settleTask('completed', 'manual retry output', 'occ1', 'automation1', 'manual');
    await f.repos.config.set('automation.delivery-target.automation1', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_original', replyInThread: true }));
    await f.deliver('s1', result, 'occ1', 'automation1');
    expect(f.client.reply).toHaveBeenCalledOnce();
    expect(f.client.send).not.toHaveBeenCalled();
  });

  it('checks the lease again after a slow authorization before any provider send or fallback', async () => {
    const f = await fixture(); const result = f.settleTask('completed');
    await f.repos.config.set('automation.delivery-target.automation1', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_original', replyInThread: true }));
    let expired = false, authorizations = 0;
    f.groups.authorize.mockImplementation(async () => { if (++authorizations === 2) expired = true; return undefined; });
    const controller = new AbortController();
    const assertCurrent = vi.fn(async () => { if (expired) throw new Error('lease expired during authorization'); });
    await expect(f.deliver('s1', result, 'occ1', 'automation1', { signal: controller.signal, assertCurrent })).rejects.toThrow('lease expired during authorization');
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(f.client.reply).not.toHaveBeenCalled(); expect(f.client.send).not.toHaveBeenCalled();
  });

  it('reuses the persisted provider receipt before the source delivered flag is saved', async () => {
    const f = await fixture();
    const result = f.settleTask('completed');
    await f.repos.config.set('automation.delivery-target.automation1', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_original', replyInThread: true }));
    await f.deliver('s1', result, 'occ1', 'automation1');
    await f.deliver('s1', result, 'occ1', 'automation1');
    expect(f.client.reply).toHaveBeenCalledOnce();
    expect(await f.repos.config.list!('lark.delivery.')).toHaveLength(1);
  });

  it('checks the captured actor without changing a running turn identity, and rechecks revocation', async () => {
    const f = await fixture();
    expect(await f.previewAuthorize('s1', 'ou_alice')).toBe(true);
    expect(await f.previewAuthorize('s1', 'ou_bob')).toBe(false);
    expect(f.client.getUserEmails).not.toHaveBeenCalled();
    expect(await f.authorize('s1', 'ou_alice')).toBe(true);
    expect(await f.authorize('s1', 'ou_bob')).toBe(false);
    expect(f.groups.beginTurn).not.toHaveBeenCalled();
    await f.setBot({ allowedUsers: [{ openId: 'ou_bob', name: 'Bob' }] });
    expect(await f.authorize('s1', 'ou_alice')).toBe(false);
    await f.setBot({ listening: false });
    expect(await f.authorize('s1', installationOwnerTaskActor)).toBe(false);
  });

  it('requires a known actor for local sessions and keeps foundation bindings disabled', async () => {
    const f = await fixture();
    f.session.source = 'web';
    expect(await f.authorize('s1')).toBe(false);
    expect(await f.authorize('s1', 'ou_alice')).toBe(false);
    expect(await f.authorize('s1', installationOwnerTaskActor)).toBe(true);
    f.session.source = 'foundation_group_binding';
    expect(await f.authorize('s1', installationOwnerTaskActor)).toBe(false);
  });

  it.each(['completed', 'failed', 'interrupted'] as const)('delivers %s from the frozen attempt result and pins the recipient across retries', async status => {
    const f = await fixture();
    const result = f.settleTask(status, 'target result');
    const timestamp = new Date().toISOString();
    const mapping = (id: string, reply: string) => ({ id, channel: 'lark-card:cli_a', externalId: id, sessionId: 's1', createdAt: timestamp, extra: JSON.stringify({ app_id: 'cli_a', chat_id: 'oc_chat', reply_message_id: reply, reply_in_thread: true }) });
    await f.repos.channelMappings.save(mapping('original', 'om_original'));
    await f.repos.channelMappings.save({ ...mapping('old_inserted_last', 'om_old'), createdAt: '2000-01-01T00:00:00.000Z' });
    await f.prepareDelivery('s1', 'automation1');
    await f.repos.channelMappings.save(mapping('later', 'om_later'));
    await f.deliver('s1', result, 'occ1', 'automation1');
    await f.deliver('s1', result, 'occ1', 'automation1');
    const first = f.client.reply.mock.calls[0]![0] as any;
    expect(first.messageId).toBe('om_original');
    expect(f.client.reply).toHaveBeenCalledOnce();
    const receipt = await f.repos.config.get(`lark.delivery.${first.idempotencyKey}.summary`);
    expect(JSON.parse(receipt!)).toMatchObject({ messageId: 'om_result' });
    expect(first.state).toBe(status);
    expect(JSON.stringify(first)).toContain('target result');
    expect(JSON.stringify(first)).not.toContain('secret-canary');
    await f.setBot({ listening: false });
    await expect(f.deliver('s1', result, 'occ1', 'automation1')).rejects.toThrow('权限');
    expect(f.client.reply).toHaveBeenCalledOnce();
  });

  it('rejects a forged body/throughSequence even with a real task, attempt and settlement; nothing is sent', async () => {
    const f = await fixture();
    const result = f.settleTask('completed', 'real output');
    await f.repos.config.set('automation.delivery-target.automation1', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_original', replyInThread: true }));
    const forgedText = 'FORGED-BODY-CANARY';
    const forged: AttemptResultV1 = {
      ...result,
      throughSequence: result.throughSequence + 100,
      output: { text: forgedText, digest: createHash('sha256').update(forgedText).digest('hex') }
    };
    await expect(f.deliver('s1', forged, 'occ1', 'automation1')).rejects.toMatchObject({ code: 'AUTOMATION_RESULT_NOT_READY' });
    expect(f.client.reply).not.toHaveBeenCalled();
  });

  it('rejects a real task result presented for an unrelated source/occurrence; nothing is sent to its thread', async () => {
    const f = await fixture();
    const result = f.settleTask('completed', 'source-one result');
    // 即使无关来源已冻结自己的回报话题，也不能借同 Session 的真实结果投递过去。
    await f.repos.config.set('automation.delivery-target.unrelated-automation', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_other_thread', replyInThread: true }));
    await expect(f.deliver('s1', result, 'unrelated-occ', 'unrelated-automation')).rejects.toMatchObject({ code: 'AUTOMATION_RESULT_NOT_READY' });
    expect(f.client.reply).not.toHaveBeenCalled();
  });

  it('rejects delivery when source actor is modified to an authorized actor but actual accepted actor was revoked', async () => {
    const f = await fixture();
    const result = f.settleTask('completed', 'valid result');
    const key = 'session_automation/occurrence/occ1';
    const record = JSON.parse((await f.repos.config.get(key))!);
    record.actor = { kind: 'channel', id: 'ou_bob', appId: 'cli_a' };
    await f.repos.config.set(key, JSON.stringify(record));
    await f.setBot({ allowedUsers: [{ openId: 'ou_bob', name: 'Bob' }] });
    expect(await f.authorize('s1', 'ou_alice')).toBe(false);
    await f.repos.config.set('automation.delivery-target.automation1', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_original', replyInThread: true }));
    await expect(f.deliver('s1', result, 'occ1', 'automation1')).rejects.toMatchObject({ code: 'AUTOMATION_RESULT_NOT_READY' });
    expect(f.client.reply).not.toHaveBeenCalled();
  });

  it('rejects delivery when a real second source carries a matching admission key but points to a task accepted under another key', async () => {
    const f = await fixture();
    const result = f.settleTask('completed', 'valid result');
    const key = 'session_automation/occurrence/other-occ';
    const record = JSON.parse((await f.repos.config.get('session_automation/occurrence/occ1'))!);
    record.id = 'other-occ';
    record.scheduleId = 'other-source';
    record.admission.request.key = 'session-automation:schedule:other-occ';
    await f.repos.config.set(key, JSON.stringify(record));
    await f.repos.config.set('automation.delivery-target.other-source', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_other_thread', replyInThread: true }));
    await expect(f.deliver('s1', result, 'other-occ', 'other-source')).rejects.toMatchObject({ code: 'AUTOMATION_RESULT_NOT_READY' });
    expect(f.client.reply).not.toHaveBeenCalled();
  });

  it('fails before send when a notice target is missing and reports to the frozen target after recovery', async () => {
    const f = await fixture();
    const schedule: any = { id: 'sch_1', sessionId: 's1', name: '每日数据巡检', generation: 2, actorId: 'ou_alice', disabledReason: 'Session is no longer active' };
    // 1. 无 delivery-target 时静默跳过
    await expect(f.onScheduleDisabled!(schedule, 'Session is no longer active')).rejects.toMatchObject({ code: 'AUTOMATION_DESTINATION_MISSING' });
    expect(f.client.reply).not.toHaveBeenCalled();

    // 2. 有 delivery-target 时向原位置发送通知卡片
    await f.repos.config.set('automation.delivery-target.sch_1', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_target_thread', replyInThread: true }));
    await f.onScheduleDisabled!(schedule, 'Session is no longer active');
    expect(f.client.reply).toHaveBeenCalledTimes(1);
    const sent = f.client.reply.mock.calls[0]![0] as any;
    expect(sent.messageId).toBe('om_target_thread');
    expect(sent.taskName).toBe('每日数据巡检');
    expect(JSON.stringify(sent.elements)).toContain('定时计划『每日数据巡检』已停用：Session is no longer active');
  });

  it('sets result card taskName to schedule name and adds disable button for schedule deliveries', async () => {
    const f = await fixture();
    const result = f.settleTask('completed', '巡检通过');
    await f.repos.config.set('session_automation/schedule/automation1', JSON.stringify({
      id: 'automation1',
      sessionId: 's1',
      name: '自动化日常巡检',
      prompt: 'run check'
    }));
    await f.repos.config.set('automation.delivery-target.automation1', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_sched_thread', replyInThread: true }));
    await f.deliver('s1', result, 'occ1', 'automation1');
    expect(f.client.reply).toHaveBeenCalledTimes(1);
    const sent = f.client.reply.mock.calls[0]![0] as any;
    expect(sent.taskName).toBe('自动化日常巡检');
    const button = sent.elements.find((el: any) => el.element_id === 'disable_schedule');
    expect(button).toBeDefined();
    expect(button.text?.content).toBe('停用此计划');
    expect(button.behaviors?.[0]?.value).toEqual({ dutydeck_schedule_disable: 'automation1' });
  });
});

describe('Agent schedule request delivery', () => {
  const mapping = (externalId: string, taskId: string, createdAt: string, sessionId = 's1') => ({
    id: `lark-card:cli_a:${externalId}`, channel: 'lark-card:cli_a', externalId, sessionId, createdAt,
    extra: JSON.stringify({ app_id: 'cli_a', chat_id: 'oc_chat', reply_message_id: externalId, reply_in_thread: true, runtime_task_id: taskId })
  });
  const schedule = { schemaVersion: 1 as const, id: 'schedule_req', revision: 1, generation: 1, sessionId: 's1', name: '盯结论', prompt: '看看这个话题有没有排查结论',
    trigger: { kind: 'interval' as const, everySeconds: 900, anchorAt: '2026-10-16T00:00:00.000Z' }, timezone: 'Asia/Shanghai',
    dstPolicy: { gap: 'skip' as const, overlap: 'first' as const }, condition: { kind: 'always' as const }, enabled: false, createdAt: '', updatedAt: '' };

  it('persists once and recovers confirmation delivery through the real Lark service with bounded UUIDs', async () => {
    const f = await fixture();
    const prompt = ['检查最近七天的运行记录。'.repeat(50), '', '只提方案，不修改代码。', '每条建议列出问题、方案、预期收益和 P0–P3 优先级。'].join('\n');
    const bodies: any[] = [];
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'token', expire: 7200 });
      if (String(url).endsWith('/images')) return response({ code: 0, data: { image_key: 'img_test' } });
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (body.uuid.length > 50) return response({ code: 99992402, msg: 'uuid exceeds 50 characters' }, 400);
      if (bodies.length === 1) return response({ code: 230001, msg: 'temporary card delivery failure' }, 400);
      return response({ code: 0, data: { message_id: 'om_confirmation' } });
    });
    const service = createLarkCardService({ LARK_APP_ID: 'cli_a', LARK_APP_SECRET: 'test-secret' }, fetcher as typeof fetch);
    try {
      const integration = createAutomationIntegration(f.repos, f.runtime as any, f.groups as any, { client: () => service, log: { warn: vi.fn() } });
      const automation = new SessionAutomationService({ repositories: f.repos, runtime: f.runtime as any, authorize: integration.authorize, prepareDelivery: integration.prepareDelivery });
      const request = () => runAgentScheduleRequest({ automation,
        prepareDelivery: id => integration.prepareMessageDelivery('s1', { appId: 'cli_a', chatId: 'oc_chat', messageId: 'om_request', replyInThread: true }, id),
        sendConfirmation: integration.sendScheduleRequest
      }, { sessionId: 's1', requestId: 'task_1', actorId: 'ou_alice' }, { every: 15, prompt });
      const failed = await request();
      expect(failed).toMatchObject({ saved: true, pendingConfirmation: true, confirmationDelivery: 'failed' });
      expect(JSON.parse((await f.repos.config.get(`session_automation/schedule/${failed.scheduleId}`))!).enabled).toBe(false);
      expect(await request()).toMatchObject({ scheduleId: failed.scheduleId, message: expect.stringContaining('已发确认卡') });
      await request();
      expect(bodies).toHaveLength(2);
      expect(bodies[0].uuid).toBe(bodies[1].uuid);
      expect(bodies[0].uuid.length).toBeLessThanOrEqual(50);
      expect((await f.repos.config.list('session_automation/schedule/'))).toHaveLength(1);
      expect(JSON.stringify(JSON.parse(bodies[1].content))).toContain('dutydeck_schedule_enable');
      const card = JSON.parse(bodies[1].content);
      const summary = card.body.elements.find((element: any) => element.element_id === 'schedule_request');
      expect(summary.content).toContain('**时区**：Asia/Shanghai');
      expect(summary.content).toContain('**发到哪**：本话题');
      expect(summary.content).toContain('当前未启用');
      expect(summary.content).not.toContain(prompt);
      const fullPrompt = card.body.elements.find((element: any) => element.element_id === 'schedule_request_prompt');
      expect(fullPrompt).toMatchObject({ expanded: false, elements: [{ tag: 'div', text: { tag: 'plain_text', content: prompt } }] });
      expect(fullPrompt.elements[0].text.content).toContain('只提方案，不修改代码');
      expect(fullPrompt.elements[0].text.content).toContain('P0–P3');
    } finally { service.close(); }
  });

  it('updates a same-name schedule from a later chat request and says so on a new confirmation card', async () => {
    const f = await fixture();
    const bodies: any[] = [];
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'token', expire: 7200 });
      if (String(url).endsWith('/images')) return response({ code: 0, data: { image_key: 'img_test' } });
      bodies.push(JSON.parse(String(init?.body)));
      return response({ code: 0, data: { message_id: `om_confirmation_${bodies.length}` } });
    });
    const service = createLarkCardService({ LARK_APP_ID: 'cli_a', LARK_APP_SECRET: 'test-secret' }, fetcher as typeof fetch);
    try {
      const integration = createAutomationIntegration(f.repos, f.runtime as any, f.groups as any, { client: () => service, log: { warn: vi.fn() } });
      const automation = new SessionAutomationService({ repositories: f.repos, runtime: f.runtime as any, authorize: integration.authorize, prepareDelivery: integration.prepareDelivery });
      const request = (requestId: string, prompt: string) => runAgentScheduleRequest({ automation,
        prepareDelivery: id => integration.prepareMessageDelivery('s1', { appId: 'cli_a', chatId: 'oc_chat', messageId: `om_${requestId}`, replyInThread: true }, id),
        sendConfirmation: integration.sendScheduleRequest
      }, { sessionId: 's1', requestId, actorId: 'ou_alice' }, { cron: '0 2 * * *', name: '更新并部署 Open Lark', prompt });
      const created = await request('task_1', '拉取最新代码并部署');
      expect(created).toMatchObject({ pendingConfirmation: true, message: expect.stringContaining('已发确认卡') });
      expect(created).not.toHaveProperty('updated');
      const updated = await request('task_2', '拉取最新代码、跑测试后部署');
      expect(updated).toMatchObject({ pendingConfirmation: true, updated: true, scheduleId: created.scheduleId, message: expect.stringContaining('已更新同名的现有任务') });
      expect(await f.repos.config.list('session_automation/schedule/')).toHaveLength(1);
      expect(JSON.parse((await f.repos.config.get(`session_automation/schedule/${created.scheduleId}`))!)).toMatchObject({ prompt: '拉取最新代码、跑测试后部署', enabled: false });
      expect(bodies).toHaveLength(2);
      expect(bodies[1].uuid).not.toBe(bodies[0].uuid);
      const notice = JSON.stringify(JSON.parse(bodies[1].content));
      expect(notice).toContain('已更新本对话里同名的现有任务「更新并部署 Open Lark」，没有新建');
      expect(notice).toContain('dutydeck_schedule_enable');
      expect(JSON.stringify(JSON.parse(bodies[0].content))).not.toContain('已更新');
      // 同一条更新请求重试：没有新改动，不再发卡。
      await request('task_2', '拉取最新代码、跑测试后部署');
      expect(bodies).toHaveLength(2);
    } finally { service.close(); }
  });

  it('reports to the message of the requesting turn, even when a later message in the session is newer', async () => {
    const f = await fixture();
    await f.repos.channelMappings.save(mapping('om_request', 'task_now', '2026-10-16T09:00:00.000Z'));
    await f.repos.channelMappings.save(mapping('om_queued', 'task_later', '2026-10-16T09:05:00.000Z'));
    await f.prepareTaskDelivery('s1', 'task_now', 'schedule_req');
    expect(JSON.parse((await f.repos.config.get('automation.delivery-target.schedule_req'))!)).toEqual({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_request', replyInThread: true });
    // 已有回报位置不覆盖；找不到这一轮的卡片时不写，交给 prepareDelivery 推断。
    await f.prepareTaskDelivery('s1', 'task_later', 'schedule_req');
    expect(JSON.parse((await f.repos.config.get('automation.delivery-target.schedule_req'))!).replyMessageId).toBe('om_request');
    await f.prepareTaskDelivery('s1', 'task_unknown', 'schedule_other');
    expect(await f.repos.config.get('automation.delivery-target.schedule_other')).toBeUndefined();
  });

  it('reports to the requesting message in private chats, whose card records carry no reply_message_id', async () => {
    const f = await fixture();
    f.runtime.getSession.mockResolvedValue({ ...f.session, sourceId: 'cli_a:oc_p2p:p2p' });
    await f.repos.channelMappings.save({ id: 'lark-card:cli_a:om_p2p_request', channel: 'lark-card:cli_a', externalId: 'om_p2p_request', sessionId: 's1', createdAt: '2026-10-16T09:00:00.000Z',
      extra: JSON.stringify({ app_id: 'cli_a', chat_id: 'oc_p2p', chat_type: 'p2p', runtime_task_id: 'task_now' }) });
    await f.prepareTaskDelivery('s1', 'task_now', 'schedule_req');
    expect(JSON.parse((await f.repos.config.get('automation.delivery-target.schedule_req'))!)).toEqual({ appId: 'cli_a', chatId: 'oc_p2p', replyMessageId: 'om_p2p_request', replyInThread: false });
    // createSchedule 接着调的通用 prepareDelivery 认这个位置，不再报找不到回报位置。
    await expect(f.prepareDelivery('s1', 'schedule_req')).resolves.toBeUndefined();
    await f.sendScheduleRequest({ ...schedule, sessionId: 's1' });
    expect(f.client.reply.mock.calls[0]![0]).toMatchObject({ messageId: 'om_p2p_request' });
    expect(JSON.stringify((f.client.reply.mock.calls[0]![0] as any).elements)).toContain('**发到哪**：本会话');
  });

  it('posts a confirmation card with an enable button to the frozen target', async () => {
    const f = await fixture();
    await expect(f.sendScheduleRequest(schedule)).rejects.toMatchObject({ code: 'AUTOMATION_DESTINATION_MISSING' });
    await f.repos.config.set('automation.delivery-target.schedule_req', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_request', replyInThread: true }));
    await f.sendScheduleRequest(schedule);
    expect(f.client.reply).toHaveBeenCalledTimes(1);
    const sent = f.client.reply.mock.calls[0]![0] as any;
    expect(sent).toMatchObject({ messageId: 'om_request', replyInThread: true, statusLabel: '未启用' });
    expect(JSON.stringify(sent.elements)).toContain('**做什么**：看看这个话题有没有排查结论');
    expect(JSON.stringify(sent.elements)).toContain('**什么时候**：每 15 分钟');
    expect(JSON.stringify(sent.elements)).toContain('**发到哪**：本话题');
    const button = sent.elements.find((element: any) => element.element_id === 'schedule_request_toggle');
    expect(button.text.content).toBe('确认启用');
    expect(button.behaviors[0].value).toEqual({ dutydeck_schedule_enable: 'schedule_req', card: 'request' });
  });
});


it('freezes an explicit busy message origin and rejects cross-chat or conflicting targets', async () => {
  const f = await fixture();
  const origin = { appId: 'cli_a', chatId: 'oc_chat', messageId: 'om_busy_now', replyInThread: false };
  await f.prepareMessageDelivery('s1', origin, 'busy_schedule');
  expect(JSON.parse((await f.repos.config.get('automation.delivery-target.busy_schedule'))!)).toEqual({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_busy_now', replyInThread: false });
  await expect(f.prepareMessageDelivery('s1', { ...origin, chatId: 'oc_other' }, 'wrong_chat')).rejects.toMatchObject({ code: 'AUTOMATION_DESTINATION_MISSING' });
  await expect(f.prepareMessageDelivery('s1', { ...origin, messageId: 'om_changed' }, 'busy_schedule')).rejects.toMatchObject({ code: 'AUTOMATION_DESTINATION_CHANGED' });
});

it('delivers an independent execution to its frozen origin and rejects revoked origin authority', async () => {
  const f = await fixture();
  const result = f.settleTask('completed', 'independent result');
  const raw = JSON.parse((await f.repos.config.get('session_automation/occurrence/occ1'))!);
  await f.repos.config.set('session_automation/occurrence/occ1', JSON.stringify({ ...raw, sessionId: 'origin', executionSessionId: 's1' }));
  f.session.id = 'origin';
  await f.repos.config.set('automation.delivery-target.automation1', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_original', replyInThread: true }));
  await f.deliver('origin', result, 'occ1', 'automation1');
  expect(f.client.reply).toHaveBeenCalledOnce();
  await f.setBot({ allowedUsers: [{ openId: 'ou_other', name: 'Other' }] });
  await expect(f.deliver('origin', result, 'occ1', 'automation1')).rejects.toMatchObject({ code: 'AUTOMATION_DELIVERY_REVOKED' });
  expect(f.client.reply).toHaveBeenCalledOnce();
});

it('reconciles a persisted disabled notice receipt without another send and refuses missing evidence', async () => {
  const f = await fixture();
  const schedule: any = { id: 'notice', sessionId: 's1', name: 'Frozen name', actorId: 'ou_alice', disabledAt: '2026-10-26T00:00:00.000Z', disabledReason: 'Session is no longer active' };
  await f.repos.config.set('automation.delivery-target.notice', JSON.stringify({ appId: 'cli_a', chatId: 'oc_chat', replyMessageId: 'om_original', replyInThread: true }));
  expect(await f.reconcileDisabledNotification(schedule)).toBe(false);
  expect(f.client.reply).not.toHaveBeenCalled();
  const guard = vi.fn(async () => {});
  await f.onScheduleDisabled(schedule, schedule.disabledReason, guard);
  expect(guard).toHaveBeenCalled();
  expect(await f.reconcileDisabledNotification(schedule)).toBe(true);
  expect(f.client.reply).toHaveBeenCalledOnce();
  f.session.source = 'schedule';
  expect(await f.authorize('s1', installationOwnerTaskActor)).toBe(false);
  f.session.source = 'web';
  expect(await f.onScheduleDisabled(schedule, schedule.disabledReason)).toBe('not_requested');
});
