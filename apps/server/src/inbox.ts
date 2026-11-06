import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  permissionRejectReasonMaxLength, readSessionTaskReport, sessionWorkspaceDirectory, workspaceName,
  type ConfigRepository, type InboxAction, type InboxItem, type InboxItemKind, type InboxResponse,
  type PermissionRequestData, type Session, type TaskRecord, type WorkItem
} from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import type { PullRequestService } from './pull-requests.js';
import type { WorkItemRequest } from './work-item-interactions.js';
import type { LarkInteraction } from './lark/workflow-interactions.js';
import { planTaskOf } from './plan-mode.js';
import { readPlanState } from './plan-routes.js';

/** 汇总只读已有对象，不新建存储；每个来源缺省时对应类型不出现。 */
export interface InboxSources {
  runtime: { getTasks(sessionId: string): Promise<TaskRecord[]>; getPendingPermissions?(sessionId: string): PermissionRequestData[] | Promise<PermissionRequestData[]> };
  store?: ConfigRepository;
  asks?: (sessionId: string) => Array<{ id: string; question: string; createdAt: string }>;
  workItems?: {
    list(sessionId: string, actorId: string): Promise<WorkItem[]>;
    requests?(sessionId: string, workId: string, actorId: string): Promise<WorkItemRequest[]>;
  };
  pullRequests?: Pick<PullRequestService, 'listPendingDecisions'>;
  /** 仍在等人点按钮的飞书计划卡与验收卡。 */
  larkCards?: () => Promise<LarkInteraction[]>;
}

export interface InboxOptions {
  /** 该会话下工作项的读身份；undefined 表示不读工作项。 */
  actorFor(session: Session): Promise<string | undefined> | string | undefined;
  kinds?: ReadonlySet<InboxItemKind>;
  now?: number;
}

const kindOrder: InboxItemKind[] = ['permission', 'question', 'task_report', 'plan', 'work_item_request', 'work_item_confirm', 'work_item_revision', 'work_item_answer', 'pull_request_confirm', 'pull_request_question', 'reconcile', 'result_acceptance'];
const oneLine = (value: string | undefined, max: number) => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const enc = encodeURIComponent;
const unknownStatuses = new Set(['reconcile_required', 'legacy_unresolved']);
const terminalWork = new Set(['completed', 'cancelled', 'cancelling', 'failed', 'blocked']);
const open: InboxAction = { id: 'open', label: '查看', type: 'open' };
const larkCard: InboxAction = { id: 'lark_card', label: '请在飞书卡片上处理', type: 'lark_card' };
const post = (id: InboxAction['id'], label: string, path: string, body: Record<string, unknown>, tone?: InboxAction['tone']): InboxAction => ({ id, label, type: 'api', method: 'POST', path, body, ...(tone ? { tone } : {}) });

async function mapLimit<T, R>(values: T[], limit: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; out[index] = await run(values[index]!); }
  }));
  return out;
}

export async function collectInbox(sources: InboxSources, sessions: Session[], options: InboxOptions): Promise<InboxItem[]> {
  const now = options.now ?? Date.now();
  const want = (kind: InboxItemKind) => !options.kinds || options.kinds.has(kind);
  const sessionIds = new Set(sessions.map(session => session.id));
  const pullRequests = sources.pullRequests && (want('pull_request_confirm') || want('pull_request_question'))
    ? (await sources.pullRequests.listPendingDecisions().catch(() => [])).filter(entry => sessionIds.has(entry.pullRequest.sessionId)) : [];
  const larkCards = sources.larkCards && (want('plan') || want('result_acceptance'))
    ? (await sources.larkCards().catch(() => [])).filter(record => sessionIds.has(record.sessionId)) : [];

  const perSession = await mapLimit(sessions.filter(session => !session.archivedAt), 8, async session => {
    const items: InboxItem[] = [];
    const sid = session.id;
    const managed = session.source === 'work_item';
    const tasks: TaskRecord[] = await sources.runtime.getTasks(sid).catch(() => []);
    const workspace = workspaceName(sessionWorkspaceDirectory(session));
    const sessionTitle = session.name?.trim() || oneLine([...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.prompt, 60) || workspace;
    const add = (kind: InboxItemKind, objectId: string, createdAt: string, fields: Pick<InboxItem, 'title' | 'actions'> & Partial<Pick<InboxItem, 'detail' | 'revision' | 'expiresAt' | 'taskId'>>) => {
      if (!want(kind)) return;
      const waitingMs = Math.max(0, now - (Date.parse(createdAt) || now));
      items.push({ id: `${kind}:${sid}:${objectId}`, kind, sessionId: sid, sessionTitle, workspace, createdAt, waitingMs, ...fields });
    };

    // 工作项步骤的会话由工作项管理：权限与提问从原工作项处理，这里不重复列。
    if (!managed) {
      for (const request of want('permission') ? await sources.runtime.getPendingPermissions?.(sid) ?? [] : []) {
        add('permission', request.id, session.updatedAt, {
          title: oneLine(request.title, 160), detail: oneLine(request.operation?.command ?? request.operation?.resource, 200) || undefined,
          actions: [
            post('approve', '批准', `/api/sessions/${enc(sid)}/permissions/${enc(request.id)}`, { approved: true }, 'primary'),
            { ...post('reject', '拒绝', `/api/sessions/${enc(sid)}/permissions/${enc(request.id)}`, { approved: false }, 'danger'), reasonMaxLength: permissionRejectReasonMaxLength }, open]
        });
      }
      for (const ask of want('question') ? sources.asks?.(sid) ?? [] : []) add('question', ask.id, ask.createdAt, { title: oneLine(ask.question, 160), actions: [open] });
    }
    for (const task of want('reconcile') ? tasks.filter(task => unknownStatuses.has(task.status)) : []) {
      add('reconcile', task.id, task.updatedAt, { taskId: task.id, title: oneLine(task.prompt, 120) || '结果未知的任务', detail: '执行结果未知，需要先核对是否已经执行。', actions: [open] });
    }
    if (sources.store && !managed) {
      const report = want('task_report') ? await readSessionTaskReport(sources.store, sid, tasks).catch(() => undefined) : undefined;
      if (report?.status === 'waiting') add('task_report', report.taskId, report.reportedAt, { taskId: report.taskId, title: oneLine(report.question, 160), actions: [open] });
      if (session.source !== 'lark' && want('plan')) {
        const plan = await readPlanState(sources.store, session, tasks).catch(() => undefined);
        if (plan?.state === 'pending' && plan.taskId) {
          const task = tasks.find(item => item.id === plan.taskId)!;
          const path = `/api/sessions/${enc(sid)}/plan/${enc(plan.taskId)}`;
          add('plan', plan.taskId, task.updatedAt, {
            taskId: plan.taskId, revision: plan.taskId, expiresAt: plan.expiresAt, title: oneLine(planTaskOf(task.prompt), 160) || '先出计划的计划',
            actions: [post('approve', '批准计划', path, { action: 'approve' }, 'primary'), post('cancel', '取消', path, { action: 'cancel' }, 'danger'), { ...open, label: '查看计划 / 提修改意见' }]
          });
        }
      }
    }
    for (const card of larkCards.filter(record => record.sessionId === sid)) {
      const task = tasks.find(item => item.id === card.taskId);
      if (!task) continue;
      if (card.kind === 'plan') {
        const latest = tasks.reduce<TaskRecord | undefined>((last, item) => !last || Date.parse(item.createdAt) >= Date.parse(last.createdAt) ? item : last, undefined);
        if (latest?.id !== task.id || task.status !== 'completed' || (card.expiresAt && Date.parse(card.expiresAt) <= now)) continue;
        add('plan', card.taskId, card.cardCreatedAt ?? card.updatedAt, { taskId: card.taskId, revision: card.taskId, expiresAt: card.expiresAt, title: oneLine(planTaskOf(task.prompt), 160) || '先出计划的计划', actions: [larkCard, open] });
      } else add('result_acceptance', card.taskId, card.cardCreatedAt ?? card.updatedAt, { taskId: card.taskId, title: oneLine(card.taskName || task.prompt, 160), actions: [larkCard, open] });
    }
    const actor = sources.workItems && !managed && (want('work_item_confirm') || want('work_item_revision') || want('work_item_answer') || want('work_item_request')) ? await options.actorFor(session) : undefined;
    if (actor && sources.workItems) {
      for (const item of await sources.workItems.list(sid, actor).catch(() => [] as WorkItem[])) {
        // failed 的目标仍可带待确认修订（确认后按新计划继续）；blocked 的只能放弃修订；其余已结束或结果未知的不列。
        if (terminalWork.has(item.status) && !(['failed', 'blocked'].includes(item.status) && item.pendingRevision)) continue;
        const base = `/api/sessions/${enc(sid)}/work-items/${enc(item.id)}`;
        const pending = item.pendingRevision;
        if (pending) {
          const impact = pending.impact;
          const counts = [['保留', impact.keep], ['重跑', impact.rerun], ['停止', impact.stop], ['作废已完成结果', impact.discard ?? []], ['删除', impact.remove], ['新增', impact.add]].filter(([, ids]) => (ids as string[]).length).map(([label, ids]) => `${label} ${(ids as string[]).length}`).join('、');
          // 目标保持原状态，只靠 pendingRevision 标记；请求体带摘要，确认或放弃的就是这里列出的那份修订，Agent 替换修订后旧决定会被拒绝。
          const body = { expectedRevision: item.revision, revisionDigest: pending.digest };
          add('work_item_revision', item.id, pending.requestedAt, {
            revision: item.revision, title: oneLine(item.title, 160),
            detail: oneLine([`修订到第 ${pending.version} 版（摘要 ${pending.digest.slice(0, 12)}）`, counts && `步骤 ${counts}`, pending.reason, ...pending.confirmationReasons].filter(Boolean).join(' · '), 300),
            // 阻塞时确认必然被拒（先处理阻塞），只给放弃。
            actions: [...item.status === 'blocked' ? [] : [post('confirm', '确认修订', `${base}/confirm`, body, 'primary')], post('discard', '放弃修订', `${base}/revision/discard`, body, 'danger'), open]
          });
          // 首次确认前的目标已经由这一条覆盖，不再另列「确认开始」：那个按钮会改为应用修订。
          if (item.status === 'awaiting_confirmation') continue;
        }
        if (item.status === 'awaiting_confirmation') {
          add('work_item_confirm', item.id, item.createdAt, {
            revision: item.revision, title: oneLine(item.title, 160), detail: `${item.plan.steps.length} 个步骤 · ${oneLine(item.goal, 120)}`,
            actions: [post('confirm', '确认开始', `${base}/confirm`, { expectedRevision: item.revision }, 'primary'), post('cancel', '取消', `${base}/cancel`, { expectedRevision: item.revision }, 'danger'), open]
          });
          continue;
        }
        for (const step of item.steps.filter(step => step.status === 'waiting')) {
          const definition = item.plan.steps.find(candidate => candidate.id === step.id);
          add('work_item_answer', `${item.id}:${step.id}`, item.updatedAt, { revision: item.revision, title: `${oneLine(item.title, 80)} · ${oneLine(definition?.title, 60)}`, detail: oneLine(definition?.instruction, 200), actions: [open] });
        }
        if (sources.workItems.requests && item.steps.some(step => step.status === 'running')) {
          for (const request of await sources.workItems.requests(sid, item.id, actor).catch(() => [] as WorkItemRequest[])) {
            const respond = (answer: string) => ({ stepId: request.stepId, taskId: request.taskId, requestId: request.requestId, kind: request.kind, answer });
            add('work_item_request', `${item.id}:${request.requestId}`, item.updatedAt, {
              revision: item.revision, title: `${oneLine(item.title, 80)} · ${oneLine(request.text, 100)}`,
              actions: request.kind === 'permission'
                ? [post('approve', '批准', `${base}/respond`, respond('approve'), 'primary'), post('reject', '拒绝', `${base}/respond`, respond('reject'), 'danger'), open]
                : [open]
            });
          }
        }
      }
    }
    for (const entry of pullRequests.filter(entry => entry.pullRequest.sessionId === sid)) {
      const pr = entry.pullRequest;
      if (entry.kind === 'confirm') {
        add('pull_request_confirm', pr.id, entry.createdAt, {
          revision: entry.revision, expiresAt: pr.expiresAt, title: oneLine(pr.title, 160), detail: oneLine(`${pr.repository} · ${pr.branch} → ${pr.target} · ${pr.files.length} 个文件：${pr.files.slice(0, 8).map(file => file.path).join('、')}${pr.files.length > 8 ? ` 等 ${pr.files.length} 个` : ''}`, 400),
          actions: [post('confirm', '确认推送并开 PR', `/api/sessions/${enc(sid)}/pull-requests/${enc(pr.id)}/confirm`, {}, 'primary'), open]
        });
      } else add('pull_request_question', `${pr.id}:${entry.question.commentId}`, entry.createdAt, { revision: entry.revision, title: `${oneLine(pr.title, 80)} · ${oneLine(entry.question.question, 100)}`, detail: oneLine(entry.question.excerpt, 200), actions: [larkCard, open] });
    }
    return items;
  });

  return perSession.flat().sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || b.waitingMs - a.waitingMs);
}

export interface InboxRouteOptions {
  sources: InboxSources;
  /** 与会话列表同一道读权限；不可见的会话整个不出现。 */
  canView(request: FastifyRequest, sessionId: string): Promise<boolean>;
  /** 批量版 canView：判定与逐个 canView 相同，保持顺序；listed 是本次 listSessions 的结果，避免逐个重读会话。 */
  canViewMany?(request: FastifyRequest, sessions: Session[], listed: Session[]): Promise<Session[]>;
  /** 工作项读权限（沿用工作项接口的 task.view_result 判定），返回读身份。 */
  workItemActor?(request: FastifyRequest, sessionId: string): Promise<string | undefined>;
}

/** GET /api/inbox：只读汇总。分享链接不在分享白名单里，认证中间件对带 share 的请求一律 401。 */
export function registerInboxRoutes(app: FastifyInstance, runtime: Pick<DutydeckRuntime, 'listSessions'>, options: InboxRouteOptions) {
  app.get('/api/inbox', async (request): Promise<InboxResponse> => {
    const listed = await runtime.listSessions();
    const sessions = listed.filter(session => !session.archivedAt);
    const visible = options.canViewMany ? await options.canViewMany(request, sessions, listed) : (await Promise.all(sessions.map(async session => await options.canView(request, session.id) ? session : undefined))).filter((session): session is Session => Boolean(session));
    const now = Date.now();
    const items = await collectInbox(options.sources, visible, { now, actorFor: session => options.workItemActor?.(request, session.id).catch(() => undefined) });
    return { generatedAt: new Date(now).toISOString(), items };
  });
}
