import { z } from 'zod';
import { inferAcpInsightClient } from '@dutydeck/acp-client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import type { RelayAskBroker, RelayAskRecord } from '@dutydeck/relay';
import { RuntimeError, type AgentEvent, type PermissionRequestData, type PolicyAction, type Session, type SessionSourceContext, type PublicTaskRecord } from '@dutydeck/shared';

export function taskLimit(value: string | undefined, fallback: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new RuntimeError('invalid_argument', 'limit must be an integer from 1 to 200', 400);
  return n;
}
export function taskWaiting(permissions: PermissionRequestData[], asks: RelayAskRecord[]) {
  return [
    ...permissions.filter(p => p.status === 'pending').map(p => ({ id: p.id, kind: 'approval', prompt: p.title.slice(0, 500),
      ...(p.operation ? { detail: [p.operation.command, p.operation.resource, p.operation.cwd].filter(Boolean).join('\n').slice(0, 2000) } : {}),
      options: [{ id: 'allow', label: '允许', kind: 'allow' }, { id: 'deny', label: '拒绝', kind: 'deny' }], free_text: false })),
    ...asks.filter(a => a.status === 'pending').map(a => ({ id: a.id, kind: 'question', prompt: a.question.slice(0, 500),
      options: (a.choices ?? []).map(c => ({ id: c.value ?? c.label, label: c.label, kind: 'answer' })), free_text: true }))
  ];
}
export function taskStatus(session: Session, tasks: PublicTaskRecord[], waiting: unknown[]): string {
  if (waiting.length) return 'waiting';
  if (session.archivedAt || session.state === 'stopped') return 'stopped';
  if (tasks.some(t => ['reconcile_required', 'legacy_unresolved'].includes(t.status))) return 'unknown';
  if (tasks.some(t => t.status === 'running') || ['thinking', 'running_tool', 'starting', 'interrupting'].includes(session.state)) return 'running';
  if (tasks.some(t => t.status === 'queued')) return 'queued';
  const latest = tasks.at(-1)?.status ?? session.state;
  return ({ completed: 'done', failed: 'failed', interrupted: 'stopped', cancelled: 'stopped', stopped: 'stopped' } as Record<string, string>)[latest] ?? 'unknown';
}
export function taskConversation(events: AgentEvent[], tasks: PublicTaskRecord[], limit: number) {
  const items: Array<{ role: string; text: string; at: string }> = [];
  const prompts = new Set<string>();
  const tools = new Map<string, { role: string; text: string; at: string }>();
  const finals = new Set<string>();
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  for (const [index, event] of ordered.entries()) {
    const d = event.data as Record<string, any>;
    if (!d || typeof d !== 'object') continue;
    const task = d.task ?? d;
    const taskId = event.taskId ?? d.taskId;
    if (event.type === 'task' && typeof task.prompt === 'string' && !prompts.has(task.id ?? taskId)) {
      prompts.add(task.id ?? taskId); items.push({ role: 'user', text: task.prompt, at: event.timestamp });
    } else if (event.type === 'text' && typeof d.text === 'string' && !d.audit) {
      const role = d.relay === 'answer' || d.role === 'user' ? 'user' : 'assistant';
      if (role === 'user' && !d.relay && taskId) {
        if (prompts.has(taskId)) continue;
        prompts.add(taskId);
      }
      const previous = items.at(-1);
      if (role === 'assistant' && !d.relay && previous?.role === 'assistant' && ordered[index - 1]?.taskId === event.taskId) previous.text += d.text;
      else items.push({ role, text: d.text, at: event.timestamp });
      finals.add(`${event.taskId ?? ''}\0${items.at(-1)!.text}`);
    } else if (event.type === 'completed') {
      const text = d.text ?? d.result ?? d.response;
      if (typeof text === 'string' && !finals.has(`${event.taskId ?? ''}\0${text}`)) items.push({ role: 'assistant', text, at: event.timestamp });
    } else if (event.type === 'tool_call' || event.type === 'tool_result') {
      const id = `${event.taskId ?? ''}:${d.id ?? d.toolCallId ?? event.id}`;
      const old = tools.get(id);
      const summary = String(d.name ?? d.toolName ?? old?.text.split(': ')[0] ?? d.title ?? 'tool') + ': ' + String(d.output ?? d.result ?? d.status ?? '').replace(/\s+/g, ' ').slice(0, 300);
      if (old) old.text = summary;
      else { const item = { role: 'tool', text: summary, at: event.timestamp }; tools.set(id, item); items.push(item); }
    }
  }
  for (const task of tasks) if (!prompts.has(task.id)) items.push({ role: 'user', text: task.prompt, at: task.createdAt });
  items.sort((a, b) => a.at.localeCompare(b.at));
  let truncated = items.length > limit;
  const recent = items.slice(-limit).map(item => {
    if (item.text.length <= 4000) return item;
    truncated = true;
    return { ...item, text: item.text.slice(0, 3999) + '…' };
  });
  return { items: recent, truncated };
}
export function taskClient(body: unknown): string | undefined {
  const client = (body as { client?: unknown } | undefined)?.client;
  if (client === undefined) return;
  if (typeof client !== 'string' || !/^[a-z0-9-]{1,32}$/.test(client)) throw new RuntimeError('invalid_argument', 'client must match [a-z0-9-]{1,32}', 400);
  return client;
}
export async function auditTaskClient(runtime: DutydeckRuntime, id: string, action: string, client?: string) {
  if (client) await runtime.recordClientAudit(id, action, client);
}
/** Source enrichment is optional; one slow provider must not hold the task list. */
export async function taskSources(sessions: Session[], source: (session: Session) => Promise<SessionSourceContext | undefined>, deadline: number) {
  const results = new Map<string, SessionSourceContext | undefined>();
  if (!sessions.length || Date.now() >= deadline) return results;
  let next = 0, expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const worker = async () => {
    while (!expired && Date.now() < deadline && next < sessions.length) {
      const session = sessions[next++]!;
      try { const value = await source(session); if (!expired) results.set(session.id, value); }
      catch { /* Keep the persisted origin when enrichment fails. */ }
    }
  };
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(4, sessions.length) }, worker)),
      new Promise<void>(resolve => { timer = setTimeout(() => { expired = true; resolve(); }, Math.max(0, deadline - Date.now())); })
    ]);
  } finally { expired = true; clearTimeout(timer); }
  return results;
}

export function registerTaskRoutes(app: FastifyInstance, runtime: DutydeckRuntime, options: {
  broker?: RelayAskBroker;
  filterViewable(request: FastifyRequest, sessions: Session[]): Promise<Session[]>;
  authorize(request: FastifyRequest, id: string, boundary: 'session' | 'high_risk', action: PolicyAction): Promise<unknown>;
  can(request: FastifyRequest, id: string, boundary: 'session' | 'high_risk', action: PolicyAction): Promise<boolean>;
  source(session: Session): Promise<SessionSourceContext | undefined>;
}) {
  app.get<{ Querystring: { limit?: string; recent?: string } }>('/api/tasks', async request => {
    const now = Date.now();
    const deadline = now + 3000;
    const recent = request.query.recent === 'true';
    if (request.query.recent !== undefined && !['true', 'false'].includes(request.query.recent)) throw new RuntimeError('invalid_argument', 'recent must be true or false', 400);
    const limit = taskLimit(request.query.limit, 50);
    const visible = (await options.filterViewable(request, await runtime.listSessions()))
      .filter(session => !session.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const candidates = [];
    for (const session of recent ? visible : visible.slice(0, limit)) {
      const records = await runtime.getTasks(session.id);
      const waiting = taskWaiting(await runtime.getPendingPermissions(session.id), options.broker?.listPending(session.id) ?? []);
      const status = taskStatus(session, records, waiting);
      const updatedAt = recent && status === 'done' ? records.at(-1)?.updatedAt ?? session.updatedAt : session.updatedAt;
      if (recent && !['running', 'queued', 'waiting'].includes(status)) {
        const completedAt = Date.parse(updatedAt);
        if (status !== 'done' || (records.length > 0 && records.at(-1)?.status !== 'completed')
          || !z.string().datetime({ offset: true }).safeParse(updatedAt).success || !Number.isFinite(completedAt) || completedAt > now || completedAt < now - 24 * 60 * 60 * 1000) continue;
      }
      candidates.push({ session, records, waiting, status, updatedAt });
    }
    if (recent) candidates.sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.updatedAt.localeCompare(a.updatedAt));
    const selected = candidates.slice(0, limit);
    const sources = await taskSources(selected.map(item => item.session), options.source, deadline);
    const agents = await runtime.listAgents();
    const tasks = [];
    const archivable = [];
    for (const { session, records, waiting, status, updatedAt } of selected) {
      const agent = agents.find(a => a.id === session.agentId);
      const family = agent ? inferAcpInsightClient(agent) : undefined;
      const source = sources.get(session.id);
      const origin = source?.topic ?? source?.chat;
      const verifications = await runtime.getVerifications(session.id);
      const verification = verifications.find(v => !v.taskId || v.taskId === records.at(-1)?.id);
      const actions = [];
      const mutable = !session.archivedAt && session.source !== 'work_item' && session.state !== 'stopped' && !records.some(t => ['reconcile_required', 'legacy_unresolved'].includes(t.status));
      if (mutable && await options.can(request, session.id, 'session', 'turn.append')) actions.push('send');
      const canInterrupt = (recent && session.source !== 'work_item' || mutable && ['running', 'waiting', 'queued'].includes(status)) && await options.can(request, session.id, 'session', 'run.interrupt');
      if (mutable && ['running', 'waiting', 'queued'].includes(status) && canInterrupt) actions.push('interrupt');
      if (recent && session.source !== 'work_item' && canInterrupt) archivable.push(session.id);
      if (waiting.some(w => w.kind === 'approval') && runtime.getDriver(session.id)?.resolvePermission && await options.can(request, session.id, 'high_risk', 'high_risk.execute')
        || waiting.some(w => w.kind === 'question') && await options.can(request, session.id, 'session', 'turn.append')) actions.push('decide');
      tasks.push({ id: session.id, title: session.name || records[0]?.prompt.slice(0, 80) || session.id, status, updated_at: updatedAt,
        agent: family === 'claude' || family === 'codex' ? family : 'other', agent_label: agent?.name ?? session.agentId, cwd: session.cwd,
        origin: { kind: source ? 'lark' : ['lark', 'web', 'schedule', 'trigger'].includes(session.source ?? '') ? session.source : 'other', label: source?.topic?.title ?? source?.chat.name ?? session.source ?? 'other', ...(origin?.url ? { url: origin.url } : {}) },
        waiting, verification: { state: verification && !verification.stale && ['passed', 'failed'].includes(verification.status) ? verification.status : 'none', summary: verification ? `${verification.command}: ${verification.status}${verification.stale ? ' (stale)' : ''}`.slice(0, 200) : '' }, actions });
    }
    return recent ? { tasks, archivable } : { tasks };
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/tasks/:id', async request => {
    const limit = taskLimit(request.query.limit, 40);
    await options.authorize(request, request.params.id, 'session', 'task.view_result');
    if (!await runtime.getSession(request.params.id)) throw new RuntimeError('not_found', 'Task not found', 404);
    return taskConversation(await runtime.getEvents(request.params.id), await runtime.getTasks(request.params.id), limit);
  });
  app.get<{ Params: { id: string; waitingId: string } }>('/api/sessions/:id/waiting/:waitingId', async request => {
    const { id, waitingId } = request.params;
    await options.authorize(request, id, 'session', 'task.view_result');
    if (!await runtime.getSession(id)) throw new RuntimeError('not_found', 'Task not found', 404);
    const waiting = taskWaiting(await runtime.getPendingPermissions(id), options.broker?.listPending(id) ?? []).find(w => w.id === waitingId);
    if (waiting) return waiting;
    if (options.broker?.get(waitingId)?.sessionId === id || (await runtime.getEvents(id)).some(e => e.type === 'permission_request' && (e.data as PermissionRequestData).id === waitingId)) throw new RuntimeError('already_resolved', 'This request has already been handled', 409);
    throw new RuntimeError('not_found', 'Waiting request not found', 404);
  });
}
