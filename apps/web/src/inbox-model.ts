import type { InboxAction, InboxItem, InboxItemKind } from './api';

export type InboxResult =
  | { state: 'running' }
  | { state: 'ok'; message?: string }
  /** 对象在决定之前已经变化，原接口拒绝了这次旧决定。 */
  | { state: 'stale'; message: string }
  | { state: 'failed'; message: string };

/**
 * 各对象现有接口用来拒绝「决定时对象已变化」的错误码：
 * 权限已被处理、计划已不是最新或已决定、工作项版本变了或已不在等待、计划修订内容或影响已变、工作项步骤请求已失效。
 */
const staleCodes = new Set([
  'PERMISSION_NOT_FOUND', 'PERMISSION_EXPIRED', 'PERMISSION_RESOLVING',
  'PLAN_STALE', 'PLAN_EXPIRED', 'PLAN_ALREADY_DECIDED',
  'WORK_ITEM_CONFLICT', 'WORK_ITEM_NOT_AWAITING_CONFIRMATION', 'WORK_ITEM_NO_PENDING_REVISION', 'WORK_ITEM_REVISION_CONFIRM_MISMATCH', 'WORK_ITEM_REVISION_IMPACT_CHANGED', 'WORK_ITEM_NOT_WAITING', 'WORK_ITEM_TASK_REVOKED', 'WORK_ITEM_REQUEST_EXPIRED',
  'PR_NOT_FOUND', 'PR_CARD_STALE'
]);

export function classifyInboxFailure(error: unknown): Exclude<InboxResult, { state: 'running' | 'ok' }> {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return typeof code === 'string' && staleCodes.has(code) ? { state: 'stale', message } : { state: 'failed', message };
}

/**
 * 有些接口在对象已变化时不报错而是回当前状态：PR 确认在记录不再是「待确认」时返回 200 和当前状态，
 * 权限接口在请求已不存在时可能返回 false。这两种都按已失效显示，不能当成功。
 */
export function interpretInboxResponse(action: InboxAction, response: unknown): Exclude<InboxResult, { state: 'running' }> {
  if (response === false) return { state: 'stale', message: '这条请求已经被处理或已失效。' };
  if (action.id === 'confirm' && action.path?.includes('/pull-requests/')) {
    const body = response as { message?: string; pullRequest?: { status?: string } } | null;
    const status = body?.pullRequest?.status;
    if (status !== 'pushing' && status !== 'open') return { state: 'stale', message: body?.message ?? '这份 PR 清单已不在待确认状态。' };
  }
  return { state: 'ok' };
}

export async function runInboxAction(action: InboxAction, call: (action: InboxAction) => Promise<unknown>): Promise<Exclude<InboxResult, { state: 'running' }>> {
  try { return interpretInboxResponse(action, await call(action)); }
  catch (error) { return classifyInboxFailure(error); }
}

/**
 * 可批量的动作白名单：只有不会开始执行、也不需要先看内容的决定。
 * 权限批准、计划批准、PR 确认推送、工作项确认（含确认修订）一点就会执行，必须逐项看过内容再点，所以不在其中。
 */
const batchable: Partial<Record<InboxItemKind, ReadonlySet<InboxAction['id']>>> = {
  permission: new Set(['reject']),
  work_item_revision: new Set(['discard'])
};
const isBatchAction = (item: InboxItem, action: InboxAction) => action.type === 'api' && batchable[item.kind]?.has(action.id) === true;

/** 可以多选的条目：至少有一个可批量的动作。 */
export const isInboxSelectable = (item: InboxItem) => item.actions.some(action => isBatchAction(item, action));

/**
 * 批量只对同类条目开放，且只给这些条目都有的可批量动作，逐项调用现有接口，不引入新的后端批量语义。
 * 混选不同类型时返回空。
 */
export function inboxBatchActions(items: InboxItem[]): Array<Pick<InboxAction, 'id' | 'label' | 'tone'>> {
  const [first] = items;
  if (!first || items.some(item => item.kind !== first.kind)) return [];
  return first.actions.filter(action => isBatchAction(first, action) && items.every(item => item.actions.some(other => isBatchAction(item, other) && other.id === action.id)))
    .map(({ id, label, tone }) => ({ id, label, tone }));
}

/** 批量逐项执行：每项独立成败，一项失败不影响后面。 */
export async function runInboxBatch(
  items: InboxItem[], actionId: InboxAction['id'], call: (action: InboxAction) => Promise<unknown>,
  onResult: (item: InboxItem, result: InboxResult) => void
): Promise<Record<'ok' | 'stale' | 'failed', number>> {
  const tally = { ok: 0, stale: 0, failed: 0 };
  for (const item of items) {
    const action = item.actions.find(candidate => isBatchAction(item, candidate) && candidate.id === actionId);
    if (!action) { tally.failed++; onResult(item, { state: 'failed', message: '该条目没有这个动作。' }); continue; }
    onResult(item, { state: 'running' });
    const result = await runInboxAction(action, call);
    tally[result.state]++;
    onResult(item, result);
  }
  return tally;
}

export function formatWaiting(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/** 这些类型的条目对应会话本身「需要决定 / 需要恢复」的状态，总览里该会话不再重复占一行。 */
const sessionDecisionKinds: ReadonlySet<InboxItemKind> = new Set(['permission', 'question', 'task_report', 'reconcile']);
export const inboxCoveredSessionIds = (items: InboxItem[]) => new Set(items.filter(item => sessionDecisionKinds.has(item.kind)).map(item => item.sessionId));

export function inboxKindCounts(items: InboxItem[]): Array<{ kind: InboxItemKind; count: number }> {
  const counts = new Map<InboxItemKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => ({ kind, count }));
}
