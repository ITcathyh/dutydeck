import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { recordRiskDenial } from '@dutydeck/shared/secret-guard';
import { LarkRiskApprovals, readRiskApproval, riskApprovalKey, riskContinuationText } from './risk-approvals.js';
import { LarkGroupManager } from './group-management.js';
import { larkBotsConfigKey } from './config.js';
import type { StoredLarkConfig } from './config.js';
import type { CoordinatorState } from './coordinator-state.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'risk-approval-'));
  const db = join(cwd, 'tasks.db');
  let repos = createRepositories(db);
  const appId = 'cli_example';
  const sessionId = 'ses_example';
  const actorId = 'ou_requester';
  const scopeId = 'thread:om_example';
  const event = { messageId: 'om_request', senderOpenId: actorId, chatId: 'oc_example', chatType: 'group', threadId: 'omt_example',
    senderType: 'user', messageType: 'text', content: '{"text":"Publish the reviewed changes"}' } as const;
  const session = { id: sessionId, sourceId: appId + ':' + event.chatId + ':group:' + scopeId, source: 'lark', state: 'running', cwd, agentId: 'example' };
  const config = { appId, defaultAgentId: 'example', highRiskAllowedUsers: [{ openId: 'ou_first', name: 'First' }],
    highRiskAllowedEmails: ['second@example.com'], highRiskPattern: 'publish', riskControlMode: 'enforced', listening: true } as StoredLarkConfig;
  const request = { sessionId, taskId: 'task_example', turnToken: 'example-turn', actorId, summary: 'Publish the reviewed changes', command: 'publish ' + 'x'.repeat(700) };
  recordRiskDenial(cwd, sessionId, { requestPrefix: 'dutydeck agent --turn ' + request.turnToken }, { tool_name: 'Bash', tool_input: { command: request.command } });
  const runtime = { getSession: async () => session, listSessions: async () => [session], riskContinuationReady: vi.fn(() => false) };
  const service = {
    getUserEmails: async (id: string) => id === 'ou_second' ? ['second@example.com'] : [],
    batchGetIdByEmail: async () => 'ou_second', getContactUser: async (id: string) => ({ name: id === actorId ? 'Requester' : 'Second' }),
    getMessageLink: async () => 'https://example.com/message', getChatPreflightInfo: async () => ({ name: 'Example group' }), replyText: vi.fn(),
    callOpenApi: vi.fn(async (_path: string, init: { method: string; body: Record<string,string> }) =>
      ({ data: { message_id: init.method === 'POST' ? 'om_card_' + init.body.receive_id : undefined } }))
  };
  const gate = vi.fn(async (_app: string, _chat: string, _actor: string, _action: string, _session: string, _options: { taskRequesterOpenId?: string }) => ({ allowed: true }));
  const log = { info: vi.fn(), warn: vi.fn() };
  const resume = vi.fn(async () => {});
  const coordinator = () => new LarkRiskApprovals({ workflowOptions: { store: repos.config }, runtime, service, groupManager: { authorize: gate },
    cardMappings: repos.channelMappings, log } as unknown as CoordinatorState, resume);
  let approvals = coordinator();
  cleanup.push(async () => { repos.close(); await rm(cwd, { recursive: true, force: true }); });
  return { config, request, event, session, runtime, service, gate, log, resume, get repos() { return repos; },
    create: (changes = {}) => approvals.request({ ...request, ...changes }, config, event, scopeId),
    click: (id = 'ou_first', decision = 'approve', taskId = request.taskId) => approvals.decide(config, taskId, decision, id, { messageId: 'om_card_' + id }),
    record: () => readRiskApproval(repos.config, appId, request.taskId), reconcile: () => approvals.reconcile(config),
    restart() { repos.close(); repos = createRepositories(db); approvals = coordinator(); } };
}

it('requires an eligible Lark actor and the exact command denied in this attempt', async () => {
  const h = await fixture();
  h.session.source = 'web';
  await expect(h.create()).rejects.toMatchObject({ code: 'RISK_APPROVAL_UNAVAILABLE' });
  h.session.source = 'lark'; h.config.riskControlMode = 'guidance';
  await expect(h.create()).rejects.toMatchObject({ code: 'RISK_APPROVAL_UNAVAILABLE' });
  h.config.riskControlMode = 'enforced';
  h.config.highRiskAllowedUsers.push({ openId: h.request.actorId, name: 'Requester' });
  await expect(h.create()).rejects.toMatchObject({ code: 'RISK_ALREADY_ALLOWED' });
  h.config.highRiskAllowedUsers.pop();
  for (const changes of [{ turnToken: 'other-attempt' }, { command: 'publish other' }, { command: 'publish .env' }])
    await expect(h.create(changes)).rejects.toMatchObject({ code: 'RISK_REQUEST_INELIGIBLE' });
  expect(h.service.callOpenApi).not.toHaveBeenCalled();
  h.config.highRiskAllowedEmails = []; h.config.highRiskAllowedUsers = [];
  await expect(h.create()).rejects.toThrow('没有可送达的管理员');
  h.config.highRiskAllowedUsers = [{ openId: 'ou_first', name: 'First' }];
  h.service.callOpenApi.mockRejectedValue(new Error('unreachable'));
  await expect(h.create()).rejects.toThrow('没有可送达的管理员');
});

it('sends one private card per resolved recipient, persists approval before waiting, resumes once eligible', async () => {
  const h = await fixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 0, 15, 18, 7));
  for (const result of await Promise.all([h.create(), h.create()])) expect(result).toMatchObject({ pendingApproval: true, approvers: ['First', 'Second'] });
  expect(h.service.callOpenApi.mock.calls.map(([path, init]) => [path, init.body.receive_id])).toEqual(['ou_first','ou_second'].map(id => ['/open-apis/im/v1/messages?receive_id_type=open_id', id]));
  const card = JSON.parse(h.service.callOpenApi.mock.calls[0]![1].body.content);
  expect(card.header.title.content).toBe('高危操作待批准');
  const text = JSON.stringify(card.body);
  for (const part of ['Requester', 'Example group', 'https://example.com/message', h.request.summary, '…', '有效至']) expect(text).toContain(part);
  expect(text).toContain('有效至：01-16 18:07');
  expect(text).not.toContain(h.request.command);
  expect(card.body.elements.filter((e: any) => e.tag === 'button').map((e: any) => [e.text.content,e.type])).toEqual([['批准本次','primary'],['拒绝','default']]);
  h.restart();
  expect(await h.click('ou_other')).toMatchObject({ content: '你没有批准高危操作的权限' });
  h.gate.mockResolvedValueOnce({ allowed: false });
  expect(await h.click()).toMatchObject({ content: '你没有批准高危操作的权限' });
  expect((await h.record())?.status).toBe('pending');
  await Promise.all([h.click(), h.click('ou_second','reject')]);
  expect(await h.record()).toMatchObject({ status: 'approved', decision: { actor: 'ou_first', approved: true }, waiting: true });
  expect(h.service.callOpenApi.mock.calls.filter(([,init]) => init.method === 'PATCH' && init.body.content.includes('等会话里的后台任务结束后继续'))).toHaveLength(2);
  h.restart(); await h.reconcile();
  expect(h.resume).not.toHaveBeenCalled();
  h.runtime.riskContinuationReady.mockReturnValue(true);
  await h.reconcile();
  expect(h.resume).toHaveBeenCalledOnce();
  const approvedCard = JSON.parse(h.service.callOpenApi.mock.calls.at(-1)![1].body.content);
  expect(approvedCard.header.title.content).toBe('已批准 · First · 01-15 18:07');
  expect(approvedCard.body.elements).toEqual([]);
  const record = (await h.record())!;
  expect(record).toMatchObject({ event: h.event, actorId: h.request.actorId, sessionId: h.request.sessionId, taskId: h.request.taskId });
  expect(riskContinuationText(record)).toBe('管理员 First 已批准本次请求中的高危操作（Publish the reviewed changes）。继续完成原请求；本轮的高危命令已放行。');
});

it.each(['reject','expire-pending','expire-waiting','stopped','archived','replaced'])('closes %s in the original topic without submitting a turn', async kind => {
  const h = await fixture();
  await h.create();
  if (kind === 'reject') {
    await h.click('ou_second','reject'); await h.reconcile();
    expect(h.service.replyText).toHaveBeenCalledTimes(1);
    expect(h.service.replyText).toHaveBeenCalledWith(expect.objectContaining({ messageId: h.event.messageId, replyInThread: true,
      text: expect.stringContaining('管理员拒绝了本次高危操作：' + h.request.summary) }));
  } else {
    if (kind !== 'expire-pending') await h.click();
    if (kind.startsWith('expire')) vi.spyOn(Date, 'now').mockReturnValueOnce((await h.record())!.expiresAt + 1);
    else if (kind === 'stopped') h.session.state = 'stopped';
    else if (kind === 'archived') Object.assign(h.session, { archivedAt: new Date().toISOString() });
    else h.session.id = 'ses_replacement';
    if (kind === 'expire-pending') await h.click(); else await h.reconcile();
  }
  expect(h.service.callOpenApi.mock.calls.at(-1)![1].body.content).toContain(kind === 'reject' ? '已拒绝 · Second' : kind.startsWith('expire') ? '已过期，请重新发起' : '原会话已结束，请重新发起');
  expect(h.resume).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it('binds the persisted grant to the original continuation attempt across reopen and revokes it at settlement', async () => {
  const h = await fixture(); await h.create(); await h.click();
  const record = (await h.record())!;
  const base = { enabled: true, authorized: false, pattern: 'publish', approvalRequestId: record.taskId };
  const active = { taskId: record.continuationTaskId, attemptId: 'attempt_example', actorId: record.actorId, token: 'example-turn', command: 'dutydeck', url: 'http://localhost/example' };
  const task = { sessionId: record.sessionId, status: 'running' };
  const accepted = { task, request: { actor: { kind: 'channel', id: active.actorId, appId: record.appId }, key: 'lark:example', prompt: riskContinuationText(record) },
    input: { executionContext: { riskPolicy: base } } };
  const manager = async () => {
    await h.repos.config.set(larkBotsConfigKey, JSON.stringify([{ ...h.config, appSecret: 'fixture' }]));
    return new LarkGroupManager({ ...h.repos, sessions: { get: async () => h.session, list: async () => [h.session] }, execution: {
      getAcceptedTask: () => accepted, getTaskExecution: () => ({ task, currentAttempt: { attemptId: active.attemptId, state: 'active', number: 1 } })
    } } as any);
  };
  let group = await manager();
  expect(await group.riskPolicy(record.sessionId, base, active)).toMatchObject({ authorized: false, approvedAttempt: active.token });
  expect(await h.record()).toMatchObject({ status: 'started', startedAttempt: active.attemptId });
  h.restart(); group = await manager();
  expect((await group.riskPolicy(record.sessionId, base, active))?.approvedAttempt).toBe(active.token);
  for (const change of [{ taskId: 'queued_task' }, { attemptId: 'later_attempt' }, { actorId: 'ou_other' }])
    expect((await group.riskPolicy(record.sessionId, base, { ...active, ...change }))?.approvedAttempt).toBeUndefined();
  task.status = 'completed';
  expect((await group.riskPolicy(record.sessionId, base, active))?.approvedAttempt).toBeUndefined();
  expect((await group.riskPolicy(record.sessionId, { ...base, approvedAttempt: active.token }))?.approvedAttempt).toBeUndefined();
});

it('filters private delivery by the original requester and rechecks own-runs permission when clicked', async () => {
  const h = await fixture();
  let groupWide = 'ou_second';
  h.gate.mockImplementation(async (_app, _chat, actor, _action, _session, options) =>
    ({ allowed: actor === groupWide || actor === (options?.taskRequesterOpenId ?? 'ou_first') }));
  expect(await h.create()).toMatchObject({ approvers: ['Second'] });
  expect(h.service.callOpenApi.mock.calls.map(([, init]) => init.body.receive_id)).toEqual(['ou_second']);
  for (const actor of ['ou_first', 'ou_second']) expect(h.gate).toHaveBeenCalledWith(h.config.appId, h.event.chatId, actor,
    'high_risk.execute', h.session.id, { taskRequesterOpenId: h.request.actorId });
  groupWide = '';
  expect(await h.click('ou_second')).toMatchObject({ content: '你没有批准高危操作的权限' });
  expect((await h.record())?.status).toBe('pending');
  await expect(h.create({ taskId: 'task_other' })).rejects.toThrow('没有可送达的管理员');
  expect(h.service.callOpenApi).toHaveBeenCalledTimes(1);
});

it('isolates broken records and abandons an undeliverable rejection notice after five attempts across restart', async () => {
  const h = await fixture();
  await h.create();
  h.service.replyText.mockRejectedValue(new Error('original message unavailable'));
  await h.click('ou_first', 'reject');
  expect((await h.record())?.rejectionNoticeFailures).toBe(1);
  await h.create({ taskId: 'task_later' });
  await h.click('ou_second', 'approve', 'task_later');
  h.runtime.riskContinuationReady.mockReturnValue(true);
  h.restart();
  const badKey = riskApprovalKey(h.config.appId, '000_bad');
  await h.repos.config.set(badKey, '{');
  await h.reconcile();
  expect(h.resume).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task_later' }), h.config);
  expect(h.log.warn).toHaveBeenCalledWith(expect.objectContaining({ key: badKey }), '单条高危审批记录对账失败');
  for (let i = 0; i < 5; i++) await h.reconcile();
  h.restart();
  await h.reconcile();
  expect(await h.record()).toMatchObject({ status: 'rejected', rejectionNoticeAbandoned: true, rejectionNoticeFailures: 5 });
  expect(h.service.replyText).toHaveBeenCalledTimes(5);
  expect(h.log.warn).toHaveBeenCalledWith(expect.objectContaining({ taskId: h.request.taskId, attempts: 5 }), '高危操作拒绝通知已放弃');
});

it('finishes failed delivery after reopening between the last recipient save and the terminal status save', async () => {
  const h = await fixture();
  h.service.callOpenApi.mockRejectedValue(new Error('recipient unavailable'));
  const store = h.repos.config;
  const save = store.compareAndSet!.bind(store);
  vi.spyOn(store, 'compareAndSet').mockImplementation(async (key, old, next) => {
    if (JSON.parse(next).status === 'undeliverable') throw new Error('simulated shutdown');
    return save(key, old, next);
  });
  await expect(h.create()).rejects.toThrow('simulated shutdown');
  expect(await h.record()).toMatchObject({ status: 'pending', recipients: [{ attempted: true }, { attempted: true }] });
  h.restart();
  expect(await h.reconcile()).toBe(0);
  expect((await h.record())?.status).toBe('undeliverable');
  await expect(h.create()).rejects.toThrow('没有可送达的管理员');
  expect(h.service.callOpenApi).toHaveBeenCalledTimes(2);
  expect(h.resume).not.toHaveBeenCalled();
});
