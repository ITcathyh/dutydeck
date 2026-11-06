import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { permissionRejectReasonMaxLength, type ConfigRepository, type InboxAction, type Session, type TaskRecord, type WorkItem } from '@dutydeck/shared';
import { signSessionShareToken } from './auth/auth.js';
import { buildApp } from './app.js';
import { collectInbox, registerInboxRoutes, type InboxSources } from './inbox.js';
import type { PendingPullRequestDecision } from './pull-requests.js';
import { listPendingLarkDecisionCards, type LarkInteraction } from './lark/workflow-interactions.js';
import { planPrompt } from './plan-mode.js';
import { PullRequestService } from './pull-requests.js';
import { CiProviderRegistry } from './ci-providers.js';

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, agentId: 'codex', state: 'idle', cwd: `/repo/${id}`, runId: `run-${id}`, createdAt: ago(600), updatedAt: ago(30), ...extra } as Session);
const task = (id: string, sessionId: string, extra: Partial<TaskRecord> = {}): TaskRecord => ({ id, sessionId, prompt: `做 ${id}`, status: 'completed', createdAt: ago(100), updatedAt: ago(90), ...extra } as TaskRecord);
const memoryStore = (entries: Record<string, string> = {}): ConfigRepository => ({ get: async key => entries[key], set: async (key, value) => { entries[key] = value; }, list: async prefix => Object.entries(entries).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) } as unknown as ConfigRepository);
const workItem = (id: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  id, parentSessionId: 's1', title: `工作项 ${id}`, goal: '把事情做完', revision: 3, status: 'running', createdAt: ago(50), updatedAt: ago(20),
  plan: { title: 't', outputStepId: 'out', steps: [{ id: 'ask', title: '确认范围', kind: 'wait', instruction: '要不要包含 docs？', dependsOn: [] }, { id: 'out', title: '输出', kind: 'agent', agentId: 'codex', instruction: 'x', dependsOn: ['ask'] }] },
  steps: [{ id: 'ask', status: 'pending', attempts: [] }, { id: 'out', status: 'pending', attempts: [] }], delivery: { status: 'pending', attempts: 0 }, ...extra
} as WorkItem);

function sources(extra: Partial<InboxSources> & { tasks?: Record<string, TaskRecord[]>; permissions?: Record<string, unknown[]> } = {}): InboxSources {
  const { tasks = {}, permissions = {}, ...rest } = extra;
  return { runtime: { getTasks: async (id: string) => tasks[id] ?? [], getPendingPermissions: (id: string) => (permissions[id] ?? []) as never }, store: memoryStore(), ...rest };
}
const actions = (item: { actions: Array<{ id: string }> }) => item.actions.map(action => action.id);

describe('collectInbox', () => {
  it('把权限、提问、结果未知、等你决定的收尾报告汇成条目，并带等待时长与现有接口', async () => {
    const store = memoryStore({ 'task_report/t2': JSON.stringify({ schemaVersion: 1, taskId: 't2', sessionId: 's1', status: 'waiting', question: '发布哪个版本？', reportedAt: ago(15) }) });
    const items = await collectInbox(sources({
      store,
      tasks: { s1: [task('t1', 's1', { status: 'reconcile_required', updatedAt: ago(5) }), task('t2', 's1', { createdAt: ago(20) })] },
      permissions: { s1: [{ id: 'p1', title: '运行 rm -rf build', status: 'pending', operation: { source: 'acp_tool_call', command: 'rm -rf build' } }] },
      asks: id => id === 's1' ? [{ id: 'a1', question: '用哪个分支？', createdAt: ago(8) }] : []
    }), [session('s1', { name: '发版' })], { actorFor: () => undefined, now: NOW });
    expect(items.map(item => item.kind)).toEqual(['permission', 'question', 'task_report', 'reconcile']);
    const [permission] = items;
    expect(permission).toMatchObject({ id: 'permission:s1:p1', sessionTitle: '发版', workspace: 's1', waitingMs: 30 * 60_000, detail: 'rm -rf build' });
    expect(permission!.actions[0]).toMatchObject({ id: 'approve', type: 'api', method: 'POST', path: '/api/sessions/s1/permissions/p1', body: { approved: true } });
    expect(permission!.actions[1]).toMatchObject({ id: 'reject', reasonMaxLength: permissionRejectReasonMaxLength });
    expect(permission!.actions[1]!.body).toStrictEqual({ approved: false });
    expect(permission!.actions[0]).not.toHaveProperty('reasonMaxLength');
    expect(items[2]).toMatchObject({ title: '发布哪个版本？', waitingMs: 15 * 60_000 });
  });

  it('计划：Web 会话给出批准/取消接口，过期、已决定、飞书会话（只在飞书卡上决定）各自处理', async () => {
    const plan = (id: string, sessionId: string, updated: string) => task(id, sessionId, { prompt: planPrompt('整理依赖'), updatedAt: updated, createdAt: updated });
    const store = memoryStore({ 'plan.web.s3.t3': JSON.stringify({ state: 'cancelled', action: 'cancel', at: ago(1) }) });
    const larkPlan = { kind: 'plan', state: 'pending', sessionId: 's4', taskId: 't4', updatedAt: ago(40), expiresAt: new Date(NOW + 3_600_000).toISOString() } as LarkInteraction;
    const items = await collectInbox(sources({
      store, larkCards: async () => [larkPlan],
      tasks: { s1: [plan('t1', 's1', ago(10))], s2: [plan('t2', 's2', new Date(NOW - 25 * 3_600_000).toISOString())], s3: [plan('t3', 's3', ago(10))], s4: [plan('t4', 's4', ago(40))] }
    }), [session('s1'), session('s2'), session('s3'), session('s4', { source: 'lark', sourceId: 'cli_x:oc_1' })], { actorFor: () => undefined, now: NOW });
    expect(items.map(item => item.id)).toEqual(['plan:s4:t4', 'plan:s1:t1']);
    expect(items[1]).toMatchObject({ revision: 't1', title: '整理依赖' });
    expect(items[1]!.actions.slice(0, 2)).toMatchObject([{ id: 'approve', path: '/api/sessions/s1/plan/t1', body: { action: 'approve' } }, { id: 'cancel', body: { action: 'cancel' } }]);
    expect(actions(items[0]!)).toEqual(['lark_card', 'open']);
  });

  it('飞书计划卡对应的计划已不是会话里最新任务时不再算待处理；验收卡单独成类', async () => {
    const cards = [
      { kind: 'plan', state: 'pending', sessionId: 's1', taskId: 't1', updatedAt: ago(40) },
      { kind: 'result', state: 'pending', sessionId: 's1', taskId: 't3', taskName: '修复登录', updatedAt: ago(5) }
    ] as LarkInteraction[];
    const items = await collectInbox(sources({
      larkCards: async () => cards,
      tasks: { s1: [task('t1', 's1', { prompt: planPrompt('x'), createdAt: ago(60) }), task('t2', 's1', { createdAt: ago(30) }), task('t3', 's1', { createdAt: ago(20) })] }
    }), [session('s1', { source: 'lark', sourceId: 'cli_x:oc_1' })], { actorFor: () => undefined, now: NOW });
    expect(items.map(item => item.kind)).toEqual(['result_acceptance']);
    expect(items[0]).toMatchObject({ title: '修复登录', waitingMs: 5 * 60_000 });
  });

  it('工作项：待确认带 expectedRevision，等待回答与步骤请求按类型给出动作；已结束的不列；工作项自己的会话不重复列', async () => {
    const waiting = workItem('w2', { status: 'waiting', steps: [{ id: 'ask', status: 'waiting', attempts: [] }, { id: 'out', status: 'pending', attempts: [] }] });
    const running = workItem('w3', { steps: [{ id: 'ask', status: 'running', attempts: [] }, { id: 'out', status: 'pending', attempts: [] }] });
    const items = await collectInbox(sources({
      permissions: { child: [{ id: 'cp', title: '子步骤权限', status: 'pending' }] },
      workItems: {
        list: async (_sid, actor) => actor === 'owner' ? [workItem('w1', { status: 'awaiting_confirmation' }), waiting, running, workItem('w4', { status: 'completed' }), workItem('w5', { status: 'cancelled' })] : [],
        requests: async () => [{ stepId: 'ask', sessionId: 'child', taskId: 'ct', requestId: 'r1', kind: 'permission', text: '写文件' }, { stepId: 'ask', sessionId: 'child', taskId: 'ct', requestId: 'r2', kind: 'question', text: '选哪个' }]
      }
    }), [session('s1'), session('child', { source: 'work_item' })], { actorFor: () => 'owner', now: NOW });
    expect(items.map(item => `${item.kind}:${item.id.split(':').slice(2).join(':')}`)).toEqual(['work_item_request:w3:r1', 'work_item_request:w3:r2', 'work_item_confirm:w1', 'work_item_answer:w2:ask']);
    const confirm = items.find(item => item.kind === 'work_item_confirm')!;
    expect(confirm).toMatchObject({ revision: 3, waitingMs: 50 * 60_000 });
    expect(confirm.actions.slice(0, 2)).toMatchObject([{ id: 'confirm', path: '/api/sessions/s1/work-items/w1/confirm', body: { expectedRevision: 3 } }, { id: 'cancel', path: '/api/sessions/s1/work-items/w1/cancel', body: { expectedRevision: 3 } }]);
    expect(items[0]!.actions[0]).toMatchObject({ id: 'approve', path: '/api/sessions/s1/work-items/w3/respond', body: { stepId: 'ask', taskId: 'ct', requestId: 'r1', kind: 'permission', answer: 'approve' } });
    expect(actions(items[1]!)).toEqual(['open']);
    expect(items.some(item => item.id.includes(':child:'))).toBe(false);
  });

  it('工作项待确认的计划修订：目标保持 running/waiting/failed 时也列出，确认与放弃都带 expectedRevision 和摘要；已结束的不列；首次确认前的目标不再另列「确认开始」', async () => {
    const digest = 'abcdef0123456789'.repeat(4);
    const pendingRevision = {
      version: 2, requestedAt: ago(8), source: 'agent', reason: '范围变了', confirmationReasons: ['新增了写文件步骤'], digest,
      impact: { keep: ['ask'], rerun: ['out', 'done'], stop: ['out'], discard: ['done'], remove: ['old1', 'old2'], add: ['extra'] },
      plan: { title: 't', outputStepId: 'out', steps: [] }
    } as WorkItem['pendingRevision'];
    const waitingStep = { steps: [{ id: 'ask', status: 'waiting', attempts: [] }, { id: 'out', status: 'pending', attempts: [] }] } as Partial<WorkItem>;
    const items = await collectInbox(sources({
      workItems: { list: async () => [
        workItem('w1', { status: 'awaiting_confirmation', pendingRevision }), workItem('w2', { status: 'running', pendingRevision }),
        workItem('w3', { status: 'failed', pendingRevision }), workItem('w4', { status: 'waiting', pendingRevision, ...waitingStep }),
        workItem('w5', { status: 'cancelled', pendingRevision }), workItem('w6', { status: 'completed', pendingRevision })] }
    }), [session('s1')], { actorFor: () => 'owner', now: NOW });
    const ids = items.map(item => `${item.kind}:${item.id.split(':').slice(2).join(':')}`);
    expect(ids).toEqual(expect.arrayContaining(['work_item_revision:w1', 'work_item_revision:w2', 'work_item_revision:w3', 'work_item_revision:w4', 'work_item_answer:w4:ask']));
    expect(ids.filter(id => id.startsWith('work_item_revision'))).toHaveLength(4);
    expect(ids.some(id => id.endsWith(':w5') || id.endsWith(':w6') || id.startsWith('work_item_confirm'))).toBe(false);
    const revisions = items.filter(item => item.kind === 'work_item_revision');
    expect(revisions.map(item => item.id.split(':')[2])).toEqual(['w1', 'w2', 'w3', 'w4']);
    const [first] = revisions;
    expect(first).toMatchObject({ revision: 3, waitingMs: 8 * 60_000, title: '工作项 w1' });
    for (const text of ['修订到第 2 版', '摘要 abcdef012345', '保留 1', '重跑 2', '停止 1', '作废已完成结果 1', '删除 2', '新增 1', '新增了写文件步骤']) expect(first!.detail).toContain(text);
    expect(first!.detail).not.toContain(digest);
    for (const item of revisions) {
      const id = item.id.split(':')[2];
      expect(item.actions.slice(0, 3)).toMatchObject([
        { id: 'confirm', path: `/api/sessions/s1/work-items/${id}/confirm`, body: { expectedRevision: 3, revisionDigest: digest } },
        { id: 'discard', path: `/api/sessions/s1/work-items/${id}/revision/discard`, body: { expectedRevision: 3, revisionDigest: digest } },
        { id: 'open' }
      ]);
    }
  });

  it('failed 的目标只有带待确认修订时才列出', async () => {
    const pendingRevision = { version: 2, requestedAt: ago(3), source: 'agent', confirmationReasons: [], digest: 'f'.repeat(64), impact: { keep: [], rerun: [], stop: [], remove: [], add: [] }, plan: { title: 't', outputStepId: 'out', steps: [] } } as WorkItem['pendingRevision'];
    const items = await collectInbox(sources({ workItems: { list: async () => [workItem('w1', { status: 'failed', pendingRevision })] } }), [session('s1')], { actorFor: () => 'owner', now: NOW });
    expect(items.map(item => item.kind)).toEqual(['work_item_revision']);
    expect(items.map(item => item.id)).toEqual(['work_item_revision:s1:w1']);
    const bare = await collectInbox(sources({ workItems: { list: async () => [workItem('w2', { status: 'failed' })] } }), [session('s1')], { actorFor: () => 'owner', now: NOW });
    expect(bare).toEqual([]);
  });

  it('blocked 的目标带待确认修订时只给放弃，不给确认；不带修订的不列', async () => {
    const pendingRevision = { version: 2, requestedAt: ago(3), source: 'agent', confirmationReasons: [], digest: 'e'.repeat(64), impact: { keep: [], rerun: [], stop: [], remove: [], add: [] }, plan: { title: 't', outputStepId: 'out', steps: [] } } as WorkItem['pendingRevision'];
    const items = await collectInbox(sources({ workItems: { list: async () => [workItem('w1', { status: 'blocked', pendingRevision }), workItem('w2', { status: 'blocked' })] } }), [session('s1')], { actorFor: () => 'owner', now: NOW });
    expect(items.map(item => item.id)).toEqual(['work_item_revision:s1:w1']);
    expect(actions(items[0]!)).toEqual(['discard', 'open']);
    expect(items[0]!.actions[0]).toMatchObject({ path: '/api/sessions/s1/work-items/w1/revision/discard', body: { expectedRevision: 3, revisionDigest: 'e'.repeat(64) } });
  });

  it('没有读身份的会话不查工作项', async () => {
    let called = 0;
    const items = await collectInbox(sources({ workItems: { list: async () => { called++; return [workItem('w1', { status: 'awaiting_confirmation' })]; } } }), [session('s1')], { actorFor: () => undefined, now: NOW });
    expect(items).toEqual([]);
    expect(called).toBe(0);
  });

  it('PR：确认清单可确认，未回答的评审意见只能在飞书卡上答；只含可见会话', async () => {
    const pr = (id: string, sessionId: string) => ({ id, sessionId, title: `改动 ${id}`, repository: 'o/r', branch: 'dutydeck/x', target: 'main', files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }], expiresAt: ago(-20) }) as never;
    const pending: PendingPullRequestDecision[] = [
      { kind: 'confirm', pullRequest: pr('pr1', 's1'), revision: 1, createdAt: ago(12) },
      { kind: 'question', pullRequest: pr('pr2', 's1'), revision: 4, createdAt: ago(3), question: { commentId: 'c9', question: '要不要重命名？', excerpt: '建议改名' } },
      { kind: 'confirm', pullRequest: pr('pr3', 'hidden'), revision: 1, createdAt: ago(1) }
    ];
    const items = await collectInbox(sources({ pullRequests: { listPendingDecisions: async () => pending } }), [session('s1')], { actorFor: () => undefined, now: NOW });
    expect(items.map(item => item.id)).toEqual(['pull_request_confirm:s1:pr1', 'pull_request_question:s1:pr2:c9']);
    expect(items[0]).toMatchObject({ revision: 1, waitingMs: 12 * 60_000 });
    expect(items[0]!.detail).toContain('2 个文件：src/a.ts、src/b.ts');
    expect(items[0]!.actions[0]).toMatchObject({ id: 'confirm', path: '/api/sessions/s1/pull-requests/pr1/confirm' });
    expect(actions(items[1]!)).toEqual(['lark_card', 'open']);
  });

  it('kinds 限定类型；已归档会话不出现；同类按等待最久的在前', async () => {
    const store = memoryStore();
    const base = { store, permissions: { s1: [{ id: 'p1', title: 'a', status: 'pending' }], s2: [{ id: 'p2', title: 'b', status: 'pending' }], s3: [{ id: 'p3', title: 'c', status: 'pending' }] } };
    const sessions = [session('s1', { updatedAt: ago(5) }), session('s2', { updatedAt: ago(50) }), session('s3', { archivedAt: ago(1) })];
    expect((await collectInbox(sources(base), sessions, { actorFor: () => undefined, now: NOW })).map(item => item.id)).toEqual(['permission:s2:p2', 'permission:s1:p1']);
    expect(await collectInbox(sources(base), sessions, { actorFor: () => undefined, now: NOW, kinds: new Set(['plan']) })).toEqual([]);
  });
});

describe('GET /api/inbox', () => {
  const apps: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
  const runtime = { listSessions: async () => [session('s1'), session('s2'), session('s3', { archivedAt: ago(1) })] };

  it('只返回当前请求能读的会话的条目', async () => {
    const app = Fastify(); apps.push(app);
    registerInboxRoutes(app, runtime as never, {
      sources: sources({ permissions: { s1: [{ id: 'p1', title: 'a', status: 'pending' }], s2: [{ id: 'p2', title: 'b', status: 'pending' }], s3: [{ id: 'p3', title: 'c', status: 'pending' }] } }),
      canView: async (request, sessionId) => !String(request.headers['x-hide'] ?? '').split(',').includes(sessionId)
    });
    const all = (await app.inject({ method: 'GET', url: '/api/inbox' })).json();
    expect(all.items.map((item: { id: string }) => item.id).sort()).toEqual(['permission:s1:p1', 'permission:s2:p2']);
    expect(typeof all.generatedAt).toBe('string');
    const partial = (await app.inject({ method: 'GET', url: '/api/inbox', headers: { 'x-hide': 's2' } })).json();
    expect(partial.items.map((item: { id: string }) => item.id)).toEqual(['permission:s1:p1']);
  });

  it('执行策略批量判定可见性：复用本次会话列表、保持顺序、不逐个读会话；没有批量接口时逐个判定结果相同', async () => {
    const listed = [session('s1'), session('hidden'), session('s2'), session('s3', { archivedAt: ago(1) })];
    const stub = () => ({ listSessions: vi.fn(async () => listed), getTasks: async () => [], getPendingPermissions: (id: string) => [{ id: `p_${id}`, title: id, status: 'pending' }], getSession: vi.fn(async (id: string) => listed.find(item => item.id === id)) });
    const decide = (id: string) => ({ allowed: id !== 'hidden' });
    const ids = (response: { json(): { items: Array<{ id: string }> } }) => response.json().items.map(item => item.id);
    const batched = stub();
    const authorizeMany = vi.fn(async (_request: unknown, sessionIds: string[]) => sessionIds.map(decide));
    const authorize = vi.fn(async (_request: unknown, id: string) => decide(id));
    const batchApp = await buildApp(batched as any, { executionPolicy: { authorize, authorizeMany } as any }); apps.push(batchApp);
    const batchedIds = ids(await batchApp.inject({ method: 'GET', url: '/api/inbox' }));
    expect(batchedIds).toEqual(['permission:s1:p_s1', 'permission:s2:p_s2']);
    expect(authorizeMany.mock.calls.map(call => call.slice(1, 4))).toEqual([[['s1', 'hidden', 's2'], 'session', 'task.view_result']]);
    expect(authorizeMany.mock.calls[0]![4]).toBe(await batched.listSessions.mock.results[0]!.value);
    expect(batched.listSessions).toHaveBeenCalledTimes(1);
    expect(batched.getSession).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    const single = stub();
    const singleApp = await buildApp(single as any, { executionPolicy: { authorize } as any }); apps.push(singleApp);
    expect(ids(await singleApp.inject({ method: 'GET', url: '/api/inbox' }))).toEqual(batchedIds);
    expect(authorize.mock.calls.map(call => call[1])).toEqual(['s1', 'hidden', 's2']);
  });

  it('工作项只用工作项接口授权出的身份读取，没有身份则不列', async () => {
    const app = Fastify(); apps.push(app);
    const seen: string[] = [];
    registerInboxRoutes(app, runtime as never, {
      sources: sources({ workItems: { list: async (_sid, actor) => { seen.push(actor); return [workItem('w1', { status: 'awaiting_confirmation' })]; } } }),
      canView: async () => true,
      workItemActor: async (_request, sessionId) => sessionId === 's1' ? 'actor-1' : undefined
    });
    const items = (await app.inject({ method: 'GET', url: '/api/inbox' })).json().items;
    expect(items.map((item: { id: string }) => item.id)).toEqual(['work_item_confirm:s1:w1']);
    expect(seen).toEqual(['actor-1']);
  });

  it('分享链接读不到：带 share 的请求一律 401，即使 token 对这个会话有效', async () => {
    const stub: any = { listSessions: async () => [session('s1')], getTasks: async () => [], getPendingPermissions: () => [{ id: 'p1', title: 'a', status: 'pending' }], getSession: async (id: string) => ({ id }) };
    const app = await buildApp(stub, { auth: { mode: 'token', getToken: async () => 'secret-token', localOnly: false, getShareSecret: async () => 'share-secret' } });
    apps.push(app);
    const remote = { remoteAddress: '8.8.8.8' } as const;
    const share = signSessionShareToken('share-secret', 's1');
    expect((await app.inject({ method: 'GET', url: `/api/inbox?share=${share}`, ...remote })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/inbox', ...remote })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/api/inbox', headers: { authorization: 'Bearer secret-token' }, ...remote });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items.map((item: { id: string }) => item.id)).toEqual(['permission:s1:p1']);
  });
});

describe('收件箱拒绝原因', () => {
  it('按条目上的拒绝动作提交：不填原因时请求体不变，填了原因交给 Agent，超长原因被原接口拒绝', async () => {
    const resolved: unknown[][] = [];
    const stub: any = {
      listSessions: async () => [session('s1')], getTasks: async () => [], getSession: async (id: string) => ({ id }),
      getPendingPermissions: () => [{ id: 'p1', title: 'a', status: 'pending' }],
      resolvePermission: async (...args: unknown[]) => { resolved.push(args); return true; }
    };
    const app = await buildApp(stub);
    try {
      const [item] = (await app.inject({ method: 'GET', url: '/api/inbox' })).json().items;
      const reject = (item.actions as InboxAction[]).find(action => action.id === 'reject')!;
      expect(reject.reasonMaxLength).toBe(permissionRejectReasonMaxLength);
      const submit = (reason?: string) => app.inject({ method: reject.method!, url: reject.path!, payload: reason === undefined ? reject.body : { ...reject.body, reason } });
      expect((await submit()).statusCode).toBe(200);
      expect((await submit('改用 pnpm')).statusCode).toBe(200);
      expect(resolved).toEqual([['s1', 'p1', false, undefined], ['s1', 'p1', false, '改用 pnpm']]);
      const tooLong = await submit('x'.repeat(reject.reasonMaxLength! + 1));
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json()).toMatchObject({ error: { code: 'INVALID_PERMISSION_REASON' } });
      expect(resolved).toHaveLength(2);
    } finally { await app.close(); }
  });
});

describe('PullRequestService.listPendingDecisions', () => {
  const sha = 'a'.repeat(40);
  const record = (id: string, extra: Record<string, unknown>) => ({
    schemaVersion: 1, id, revision: 2, sessionId: 's1', provider: 'fake', repository: { owner: 'o', name: 'r', slug: 'o/r' }, status: 'proposed', title: `PR ${id}`, body: 'b', branch: `dutydeck/${id}`, target: 'main', baseSha: sha,
    files: [], excluded: [], commits: [], contents: [], paths: [], ciRounds: 0, reviewRounds: 0, fingerprints: {}, handledComments: [], ownComments: [], questions: [],
    expiresAt: new Date(NOW + 600_000).toISOString(), createdAt: ago(30), updatedAt: ago(10), ...extra
  });

  it('只列未过期的确认清单和已开出 PR 上未回答的评审意见', async () => {
    const q = (commentId: string, answer?: string) => ({ commentId, question: `问题 ${commentId}`, excerpt: '节选', ...(answer ? { answer } : {}) });
    const rows = [
      record('pr_confirm', {}),
      record('pr_expired', { expiresAt: ago(1) }),
      record('pr_open', { status: 'open', questions: [q('c1'), q('c2', 'apply')] }),
      record('pr_merged', { status: 'merged', questions: [q('c3')] }),
      record('pr_cancelled', { status: 'cancelled' })
    ];
    const entries = Object.fromEntries(rows.map(row => [`pull_request/record/${row.id}`, JSON.stringify(row)]));
    const service = new PullRequestService({ repositories: { config: { ...memoryStore(entries), compareAndSet: async () => true } } as never, runtime: {} as never, providers: new CiProviderRegistry(), clock: () => new Date(NOW) });
    const pending = await service.listPendingDecisions();
    expect(pending.map(entry => entry.kind === 'confirm' ? `confirm:${entry.pullRequest.id}` : `question:${entry.pullRequest.id}:${entry.question.commentId}`).sort()).toEqual(['confirm:pr_confirm', 'question:pr_open:c1']);
    expect(pending.find(entry => entry.kind === 'confirm')).toMatchObject({ revision: 2, createdAt: ago(30) });
  });
});

describe('listPendingLarkDecisionCards', () => {
  it('跨机器人只取仍在等人点按钮的计划卡和验收卡', async () => {
    const record = (kind: string, state: string) => JSON.stringify({ kind, state, sessionId: 's1', taskId: 't1' });
    const store = memoryStore({
      'lark.interaction.app1.a': record('plan', 'pending'), 'lark.interaction.app2.b': record('result', 'pending'),
      'lark.interaction.app1.c': record('plan', 'approved'), 'lark.interaction.app1.d': record('permission', 'pending'), 'other.key': record('plan', 'pending')
    });
    expect((await listPendingLarkDecisionCards(store)).map(item => item.kind).sort()).toEqual(['plan', 'result']);
  });
});
