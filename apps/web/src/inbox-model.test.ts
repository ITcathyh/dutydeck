import { describe, expect, it, vi } from 'vitest';
import { ApiError, type InboxAction, type InboxItem } from './api';
import { classifyInboxFailure, formatWaiting, inboxBatchActions, inboxCoveredSessionIds, inboxKindCounts, interpretInboxResponse, isInboxSelectable, runInboxAction, runInboxBatch } from './inbox-model';

const api = (id: InboxAction['id'], path: string, body: Record<string, unknown> = {}): InboxAction => ({ id, label: id === 'approve' ? '批准' : id === 'reject' ? '拒绝' : id === 'confirm' ? '确认开始' : id === 'discard' ? '放弃修订' : '取消', type: 'api', method: 'POST', path, body });
const open: InboxAction = { id: 'open', label: '查看', type: 'open' };
const item = (id: string, kind: InboxItem['kind'], actions: InboxAction[], sessionId = 's1'): InboxItem => ({ id, kind, sessionId, sessionTitle: '会话', workspace: 'repo', title: id, createdAt: '2026-11-05T00:00:00Z', waitingMs: 60_000, actions });
const permission = (id: string) => item(`permission:s1:${id}`, 'permission', [api('approve', `/p/${id}`, { approved: true }), api('reject', `/p/${id}`, { approved: false }), open]);

describe('inbox 批量', () => {
  it('同类条目给出它们共有的直接动作，不含「查看」', () => {
    expect(inboxBatchActions([permission('1'), permission('2')]).map(action => action.id)).toEqual(['approve', 'reject']);
    expect(inboxBatchActions([permission('1')]).map(action => action.id)).toEqual(['approve', 'reject']);
  });

  it('混选不同类型、或没有共同接口动作时不提供批量', () => {
    const work = item('work_item_confirm:s1:w1', 'work_item_confirm', [api('confirm', '/w/1/confirm'), api('cancel', '/w/1/cancel')]);
    expect(inboxBatchActions([permission('1'), work])).toEqual([]);
    expect(inboxBatchActions([])).toEqual([]);
    const lark = item('result_acceptance:s1:t', 'result_acceptance', [{ id: 'lark_card', label: '请在飞书卡片上处理', type: 'lark_card' }, open]);
    expect(inboxBatchActions([lark])).toEqual([]);
    expect(isInboxSelectable(lark)).toBe(false);
    expect(isInboxSelectable(work)).toBe(false);
    expect(isInboxSelectable(permission('1'))).toBe(true);
  });

  it('计划修订是独立一类：批量只给放弃，确认修订必须逐项；不和待确认工作项混批；已无待确认修订按已失效处理', async () => {
    const revision = (n: number) => item(`work_item_revision:s1:w${n}`, 'work_item_revision', [api('confirm', `/w/${n}/confirm`, { expectedRevision: 3 }), api('discard', `/w/${n}/revision/discard`, { expectedRevision: 3 }), open]);
    expect(inboxBatchActions([revision(1), revision(2)]).map(action => action.id)).toEqual(['discard']);
    expect(inboxBatchActions([revision(1), item('work_item_confirm:s1:w3', 'work_item_confirm', [api('confirm', '/w/3/confirm')])])).toEqual([]);
    const call = async (action: InboxAction) => { if (action.path === '/w/2/revision/discard') throw new ApiError('none', 'WORK_ITEM_NO_PENDING_REVISION', 409); return {}; };
    const tally = await runInboxBatch([revision(1), revision(2)], 'discard', call, () => undefined);
    expect(tally).toEqual({ ok: 1, stale: 1, failed: 0 });
  });

  it('修订内容已被 Agent 替换（摘要不一致，409）时，确认和放弃都显示「已失效」而不是失败', async () => {
    const mismatch = new ApiError('The pending plan revision changed; review the latest revision before confirming', 'WORK_ITEM_REVISION_CONFIRM_MISMATCH', 409);
    const confirm = api('confirm', '/w/1/confirm', { expectedRevision: 3, revisionDigest: 'a'.repeat(64) });
    expect(await runInboxAction(confirm, async () => { throw mismatch; })).toMatchObject({ state: 'stale' });
    expect(await runInboxAction(api('discard', '/w/1/revision/discard'), async () => { throw mismatch; })).toMatchObject({ state: 'stale' });
    expect(classifyInboxFailure(new ApiError('boom', 'INTERNAL_ERROR', 500)).state).toBe('failed');
  });

  it('确认时修订影响已变（要停止或作废的步骤多于所见，409）也显示「已失效」', async () => {
    const changed = new ApiError('The revision now also stops or discards b; review the updated impact and confirm again', 'WORK_ITEM_REVISION_IMPACT_CHANGED', 409);
    expect(await runInboxAction(api('confirm', '/w/1/confirm', { expectedRevision: 3, revisionDigest: 'a'.repeat(64) }), async () => { throw changed; })).toMatchObject({ state: 'stale' });
  });

  it('计划批准、PR 确认推送、工作项首次确认、步骤请求一点就执行或需先看内容，只能逐项处理，不进批量', () => {
    const plan = (n: number) => item(`plan:s1:t${n}`, 'plan', [api('approve', `/plan/${n}`, { action: 'approve' }), api('cancel', `/plan/${n}`, { action: 'cancel' }), open]);
    const pr = (n: number) => item(`pull_request_confirm:s1:pr${n}`, 'pull_request_confirm', [api('confirm', `/pr/${n}/confirm`), open]);
    const step = (n: number) => item(`work_item_request:s1:w${n}:r`, 'work_item_request', [api('approve', `/w/${n}/respond`), api('reject', `/w/${n}/respond`), open]);
    const work = (n: number) => item(`work_item_confirm:s1:w${n}`, 'work_item_confirm', [api('confirm', `/w/${n}/confirm`), api('cancel', `/w/${n}/cancel`), open]);
    for (const make of [plan, pr, step, work]) {
      expect(inboxBatchActions([make(1), make(2)])).toEqual([]);
      expect(isInboxSelectable(make(1))).toBe(false);
    }
  });

  it('逐项调用现有接口：一项失败或已失效不影响其余，结果逐项上报', async () => {
    const items = [permission('1'), permission('2'), permission('3'), permission('4')];
    const call = vi.fn(async (action: InboxAction) => {
      if (action.path === '/p/2') throw new ApiError('Permission request is no longer active', 'PERMISSION_NOT_FOUND', 404);
      if (action.path === '/p/3') throw new ApiError('boom', 'INTERNAL_ERROR', 500);
      return { ok: true };
    });
    const seen: string[] = [];
    const tally = await runInboxBatch(items, 'approve', call, (it, result) => seen.push(`${it.id.split(':')[2]}:${result.state}`));
    expect(tally).toEqual({ ok: 2, stale: 1, failed: 1 });
    expect(call.mock.calls.map(([action]) => [action.path, action.body])).toEqual([['/p/1', { approved: true }], ['/p/2', { approved: true }], ['/p/3', { approved: true }], ['/p/4', { approved: true }]]);
    expect(seen).toEqual(['1:running', '1:ok', '2:running', '2:stale', '3:running', '3:failed', '4:running', '4:ok']);
  });

  it('拒绝动作带各自的请求体，缺少动作的条目记为失败而不是静默跳过', async () => {
    const call = vi.fn(async () => ({}));
    const results: string[] = [];
    const tally = await runInboxBatch([permission('1'), item('x', 'permission', [open])], 'reject', call, (_it, result) => results.push(result.state));
    expect(call).toHaveBeenCalledTimes(1);
    expect((call.mock.calls as unknown as InboxAction[][])[0]![0]).toMatchObject({ body: { approved: false } });
    expect(tally).toEqual({ ok: 1, stale: 0, failed: 1 });
    expect(results).toContain('failed');
  });
});

describe('inbox 失效判定', () => {
  it('各对象现有接口拒绝旧决定的错误码按「已失效」显示，其余按失败', () => {
    for (const code of ['PERMISSION_NOT_FOUND', 'PERMISSION_EXPIRED', 'PLAN_STALE', 'PLAN_ALREADY_DECIDED', 'PLAN_EXPIRED', 'WORK_ITEM_CONFLICT', 'WORK_ITEM_NOT_AWAITING_CONFIRMATION', 'WORK_ITEM_REQUEST_EXPIRED', 'PR_NOT_FOUND']) {
      expect(classifyInboxFailure(new ApiError('x', code, 409)).state, code).toBe('stale');
    }
    expect(classifyInboxFailure(new ApiError('无权', 'POLICY_DENIED', 403))).toEqual({ state: 'failed', message: '无权' });
    expect(classifyInboxFailure(new Error('network'))).toEqual({ state: 'failed', message: 'network' });
  });

  it('PR 确认在记录已不是待确认时返回 200 与当前状态，要按已失效处理；权限接口回 false 同理', () => {
    const confirm = api('confirm', '/api/sessions/s1/pull-requests/pr1/confirm');
    expect(interpretInboxResponse(confirm, { message: '已取消，没有推送任何内容。', pullRequest: { status: 'cancelled' } })).toEqual({ state: 'stale', message: '已取消，没有推送任何内容。' });
    expect(interpretInboxResponse(confirm, { message: '已确认', pullRequest: { status: 'pushing' } })).toEqual({ state: 'ok' });
    expect(interpretInboxResponse(api('approve', '/p/1'), false).state).toBe('stale');
    expect(interpretInboxResponse(api('approve', '/p/1'), { ok: true }).state).toBe('ok');
  });

  it('runInboxAction 把异常转成结果而不抛出', async () => {
    expect(await runInboxAction(api('approve', '/p/1'), async () => { throw new ApiError('gone', 'PLAN_STALE', 409); })).toEqual({ state: 'stale', message: 'gone' });
  });
});

describe('inbox 展示辅助', () => {
  it('等待时长按分钟、小时、天取整', () => {
    expect([0, 59_000, 60_000, 59 * 60_000, 3 * 3_600_000, 50 * 3_600_000].map(formatWaiting)).toEqual(['不到 1 分钟', '不到 1 分钟', '1 分钟', '59 分钟', '3 小时', '2 天']);
  });

  it('只有权限、提问、等你决定的报告、结果未知会让会话在总览里不再重复列出；各类计数按出现顺序', () => {
    const items = [permission('1'), item('q', 'question', [open], 's2'), item('p', 'plan', [open], 's3'), item('r', 'reconcile', [open], 's4')];
    expect([...inboxCoveredSessionIds(items)].sort()).toEqual(['s1', 's2', 's4']);
    expect(inboxKindCounts(items)).toEqual([{ kind: 'permission', count: 1 }, { kind: 'question', count: 1 }, { kind: 'plan', count: 1 }, { kind: 'reconcile', count: 1 }]);
  });
});
