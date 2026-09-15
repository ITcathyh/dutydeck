import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalExecutionJson, installationOwnerTaskActor, type AttemptResultV1, type RepositoryBundle, type TaskRequestV1 } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { createAutomationIntegration } from './automation-integration.js';
import type { LarkCardService } from './lark/service.js';

const opened: RepositoryBundle[] = [];
const claims: Array<ReturnType<RepositoryBundle['control']['attachRuntime']>> = [];
afterEach(() => { for (const claim of claims.splice(0)) claim.release(); for (const repo of opened.splice(0)) repo.close(); });

async function fixture() {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); opened.push(repos);
  const claim = repos.control.attachRuntime('automation-integration-test'); claims.push(claim);
  const at = new Date().toISOString();
  const session = { id: 's1', agentId: 'a', source: 'lark', sourceId: 'cli_a:oc_chat:group:thread:om_root', cwd: '/project', state: 'completed', runId: 'r', createdAt: at, updatedAt: at };
  repos.execution.bind(claim).createSession({ id: 's1', runId: 'r', agentId: 'a', cwd: '/project', state: 'idle', source: 'lark', sourceId: 'cli_a:oc_chat:group:thread:om_root', permissionMode: 'ask', createdAt: at, updatedAt: at });
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
  const settleTask = (status: 'completed' | 'failed' | 'interrupted', text = 'target result', occurrenceId = 'occ1', sourceId = 'automation1'): AttemptResultV1 => {
    const x = repos.execution.bind(claim);
    const requestKey = `session-automation:schedule:${occurrenceId}`;
    const request: TaskRequestV1 = { version: 1, namespace: 'schedule', key: requestKey, sessionId: 's1', actor: { kind: 'channel', id: 'ou_alice', appId: 'cli_a' }, prompt: 'target', mode: 'queue', skills: [], options: { permissionMode: 'ask' }, sources: [], sourcePayload: { agentPrompt: 'target', skills: [] } };
    const input: any = { version: 2, prompt: 'target', executionContext: { agentPrompt: 'target', actorId: 'ou_alice' }, contentSources: [], executionOptions: { permissionMode: 'ask' } };
    const { digest: _digest, ...unsigned } = input;
    input.digest = createHash('sha256').update(canonicalExecutionJson(unsigned)).digest('hex');
    const accepted = x.acceptTask({ sessionId: 's1', runId: 'r' }, request, input, 'back');
    const taskId = accepted.task!.id;
    const claimed = x.claimNext({ sessionId: 's1', runId: 'r' })!;
    const attempt = claimed.attempt!;
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
      runtimeAttemptId: attempt.attemptId,
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
  it('checks the captured actor without changing a running turn identity, and rechecks revocation', async () => {
    const f = await fixture();
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
    const second = f.client.reply.mock.calls[1]![0] as any;
    expect(first.messageId).toBe('om_original'); expect(second.messageId).toBe('om_original');
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.state).toBe(status);
    expect(JSON.stringify(first)).toContain('target result');
    expect(JSON.stringify(first)).not.toContain('secret-canary');
    await f.setBot({ listening: false });
    await expect(f.deliver('s1', result, 'occ1', 'automation1')).rejects.toThrow('权限');
    expect(f.client.reply).toHaveBeenCalledTimes(2);
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
});
