import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSessionScheduleInputSchema, updateSessionScheduleInputSchema, previewSessionSchedule, type PublicSessionSchedule, type SessionAutomationList } from '@dutydeck/shared';
import { executeLocalRuntimeRequest, type LocalRuntimeRequestDependencies } from './local-runtime-request.js';
import { AgentGroupToolHttpClient } from './lark/agent-tools-cli.js';

export type ScheduleCliAction = 'create' | 'list' | 'show' | 'update' | 'enable' | 'disable' | 'run' | 'delete' | 'history';
export interface ScheduleCliInput {
  session?: string; agent?: string; cwd?: string; model?: string; permissionMode?: string; workspace?: string;
  name?: string; prompt?: string; cron?: string; every?: string; at?: string; timezone?: string;
  input?: string; file?: string; expectedRevision?: string; idempotencyKey?: string;
  instance?: string; url?: string; database?: string;
}
export class ScheduleCliError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ScheduleCliError'; }
}

const path = encodeURIComponent;
const automationPath = (sessionId: string) => `/api/sessions/${path(sessionId)}/automation`;
const argument = (message: string): never => { throw new ScheduleCliError('SCHEDULE_ARGUMENT_INVALID', message); };

async function configuration(input: ScheduleCliInput, create: boolean) {
  if (input.input !== undefined && input.file !== undefined) argument('Use only one of --input and --file');
  let values: Record<string, unknown> = {};
  const raw = input.file !== undefined ? await readFile(input.file, 'utf8') : input.input;
  if (raw !== undefined) {
    try { values = JSON.parse(raw); } catch { argument('Schedule configuration must be valid JSON'); }
    if (!values || typeof values !== 'object' || Array.isArray(values)) argument('Schedule configuration must be a JSON object');
  }
  const triggers = [input.cron, input.every, input.at].filter(value => value !== undefined);
  if (triggers.length > 1) argument('Use only one of --cron, --every and --at');
  if (input.cron !== undefined) values.trigger = { kind: 'cron', expression: input.cron };
  if (input.at !== undefined) values.trigger = { kind: 'at', localDateTime: input.at };
  if (input.every !== undefined) values.trigger = { kind: 'interval', everySeconds: Number(input.every) * 60, anchorAt: new Date().toISOString() };
  for (const key of ['name', 'prompt', 'timezone'] as const) if (input[key] !== undefined) values[key] = input[key];
  if (create) {
    const parsed = createSessionScheduleInputSchema.parse({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }, ...values });
    previewSessionSchedule({ id: 'preview', ...parsed }, new Date());
    return parsed;
  }
  // Validate before any request; the actual revision is captured from the server below.
  return updateSessionScheduleInputSchema.parse({ ...values, expectedRevision: 1 });
}

export async function runScheduleCli(action: ScheduleCliAction, id: string | undefined, input: ScheduleCliInput, dependencies: LocalRuntimeRequestDependencies = {}): Promise<unknown> {
  if (input.instance !== undefined && !/^[a-z0-9-]+$/.test(input.instance)) argument('Instance ids contain only a-z, 0-9 and -');
  if (input.expectedRevision !== undefined && (!/^\d+$/.test(input.expectedRevision) || Number(input.expectedRevision) < 1)) argument('--expected-revision must be a positive integer');
  if (!['create', 'list'].includes(action) && !id?.trim()) argument('Schedule ID is required');
  if (action === 'create' && Boolean(input.session) === Boolean(input.agent)) argument('Choose an existing --session or create one with --agent');
  if (action === 'create' && input.session && [input.cwd, input.model, input.permissionMode, input.workspace].some(value => value !== undefined)) argument('--cwd, --workspace, --model and --permission-mode only apply with --agent; an existing session keeps its configuration');
  if (input.workspace !== undefined && !['shared', 'worktree'].includes(input.workspace)) argument('--workspace must be shared or worktree');
  if (input.permissionMode !== undefined && !['ask', 'approve-reads', 'full-trust', 'deny-all'].includes(input.permissionMode)) argument('Unknown permission mode');
  const config = action === 'create' || action === 'update' ? await configuration(input, action === 'create') : undefined;
  const request = (method: string, endpoint: string, body?: unknown) => executeLocalRuntimeRequest({
    url: input.url, database: input.database, method,
    endpoint: input.instance ? endpoint.replace(/^\/api\//, `/api/instances/${input.instance}/`) : endpoint, body,
    errorSpec: { databaseRequired: 'SCHEDULE_DATABASE_REQUIRED', daemonUnavailable: 'SCHEDULE_DAEMON_UNAVAILABLE', localRuntimeRequired: 'SCHEDULE_LOCAL_RUNTIME_REQUIRED', requestFailed: 'SCHEDULE_REQUEST_FAILED', requestFailedMessage: (status, message) => message ?? `Schedule request failed with HTTP ${status}` },
    createError: (code, message) => new ScheduleCliError(code, message)
  }, dependencies);
  if (action === 'create') {
    const session = input.session ?? (await request('POST', '/api/sessions', { agentId: input.agent, ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.workspace ? { workspaceMode: input.workspace } : {}), ...(input.model ? { model: input.model } : {}), ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}) }) as { id: string }).id;
    try { return await request('POST', `${automationPath(session)}/schedules`, config); }
    catch (error) {
      if (!input.session) throw new ScheduleCliError('SCHEDULE_CREATE_FAILED', `Session ${session} was created, but the schedule save failed or its result is unknown. Inspect with dutydeck schedule list --session ${session}; retry with --session ${session} only if the schedule is absent. ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  if (action === 'history' && input.session) return request('GET', `${automationPath(input.session)}/schedules/${path(id!)}/history`);
  const sessionIds = input.session ? [input.session] : (await request('GET', '/api/sessions') as Array<{ id: string }>).map(session => session.id);
  const records = await Promise.all(sessionIds.map(async sessionId => ({ sessionId, ...await request('GET', automationPath(sessionId)) as SessionAutomationList })));
  if (action === 'list') return { schedules: records.flatMap(record => record.schedules) };
  if (action === 'history') {
    const owner = records.find(record => record.schedules.some(schedule => schedule.id === id) || record.occurrences.some(occurrence => occurrence.scheduleId === id));
    if (!owner) throw new ScheduleCliError('SCHEDULE_NOT_FOUND', 'Schedule not found on this runtime; use --session for deleted schedule history');
    return request('GET', `${automationPath(owner.sessionId)}/schedules/${path(id!)}/history`);
  }
  const found = records.flatMap(record => record.schedules).find(schedule => schedule.id === id);
  // An explicitly targeted session can still read the tombstone after deletion.
  const schedule = found ?? (input.session ? (await request('GET', `${automationPath(input.session)}/schedules/${path(id!)}`) as { schedule: PublicSessionSchedule }).schedule : undefined);
  if (!schedule) throw new ScheduleCliError('SCHEDULE_NOT_FOUND', 'Schedule not found on this runtime; use --session to inspect a deleted schedule');
  if (action === 'show') return { schedule };
  const endpoint = `${automationPath(schedule.sessionId)}/schedules/${path(schedule.id)}`;
  const expectedRevision = input.expectedRevision === undefined ? schedule.revision : Number(input.expectedRevision);
  if (action === 'delete') return request('DELETE', endpoint, { expectedRevision });
  if (action === 'run') return request('POST', `${endpoint}/run`, { expectedRevision, idempotencyKey: input.idempotencyKey ?? randomUUID() });
  if (action === 'enable' || action === 'disable') return request('PATCH', endpoint, { expectedRevision, enabled: action === 'enable' });
  return request('PATCH', endpoint, { ...config, expectedRevision });
}

export interface ScheduleRequestCliInput { turn?: string; prompt?: string; name?: string; every?: string; cron?: string; at?: string; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch }
/** 飞书会话里的 Agent 替这一轮发起人设置定时任务：宿主发确认卡，对方点「启用」才开始（见 agent-request-tools.ts）。 */
export async function runScheduleRequest(input: ScheduleRequestCliInput): Promise<Record<string, unknown>> {
  const every = input.every === undefined ? undefined : Number(input.every);
  if (every !== undefined && !Number.isInteger(every)) argument('--every takes whole minutes, e.g. --every 15');
  return new AgentGroupToolHttpClient(input).request('/schedules', {
    method: 'POST',
    headers: { 'x-dutydeck-work-turn': input.turn ?? '' },
    body: JSON.stringify({ prompt: input.prompt, name: input.name, every, cron: input.cron, at: input.at })
  });
}
