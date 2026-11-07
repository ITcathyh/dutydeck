import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSessionScheduleInputSchema, updateSessionScheduleInputSchema, previewSessionSchedule, resolveScheduleDeadline, type PublicSessionSchedule, type SessionAutomationList } from '@dutydeck/shared';
import { executeLocalRuntimeRequest, type LocalRuntimeRequestDependencies } from './local-runtime-request.js';
import { AgentGroupToolHttpClient } from './lark/agent-tools-cli.js';

export type ScheduleCliAction = 'create' | 'list' | 'show' | 'update' | 'enable' | 'disable' | 'run' | 'delete' | 'history';
export interface ScheduleCliInput {
  session?: string; agent?: string; cwd?: string; model?: string; permissionMode?: string; workspace?: string;
  name?: string; prompt?: string; cron?: string; every?: string; at?: string; timezone?: string; mode?: string;
  until?: string; deadline?: string; template?: string; conditionCommand?: string; conditionTimeout?: string;
  additional?: boolean;
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
  for (const key of ['name', 'prompt', 'timezone', 'mode'] as const) if (input[key] !== undefined) values[key] = input[key];
  if (input.until !== undefined) values.completionCondition = input.until;
  if (input.template !== undefined) {
    const match = /^(.+)@(\d+)$/.exec(input.template.trim());
    if (!match) argument('--template takes <template-id>@<version>');
    values.workTemplate = { id: match![1], version: Number(match![2]) };
  }
  if (input.conditionTimeout !== undefined && input.conditionCommand === undefined) argument('--condition-timeout needs --condition-command');
  if (input.conditionCommand !== undefined) {
    const timeout = input.conditionTimeout === undefined ? undefined : Number(input.conditionTimeout);
    if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= 20)) argument('--condition-timeout takes whole seconds from 1 to 20');
    if (!input.conditionCommand.trim()) {
      if (create) argument('--condition-command must not be empty');
      if (timeout !== undefined) argument('--condition-timeout cannot be used when clearing --condition-command');
      values.precondition = null;
    } else values.precondition = { command: input.conditionCommand, ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}) };
  }
  if (create) {
    if (input.additional) values.additional = true;
    values.timezone ??= Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    if (input.deadline !== undefined) values.deadlineAt = deadline(input.deadline, String(values.timezone));
    const parsed = createSessionScheduleInputSchema.parse({ dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }, ...values });
    if (!previewSessionSchedule({ id: 'preview', ...parsed }, new Date())) argument('The time rule has no upcoming run time: the --at time has passed or falls in a skipped DST gap, or the --cron never matches');
    return parsed;
  }
  // Validate before any request; the actual revision is captured from the server below. A local deadline is resolved in the schedule's timezone once it is read.
  return updateSessionScheduleInputSchema.parse({ ...values, ...(input.deadline !== undefined ? { deadlineAt: deadline(input.deadline, String(values.timezone ?? 'UTC')) } : {}), expectedRevision: 1 });
}

function deadline(value: string, timezone: string) {
  try { return resolveScheduleDeadline(value, timezone); }
  catch { return argument('--deadline takes an ISO time with offset or YYYY-MM-DDTHH:mm in the schedule timezone'); }
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
  if (action === 'history' && input.session) {
    const record = await request('GET', automationPath(input.session)) as SessionAutomationList;
    const owner = record.schedules.find(schedule => schedule.id === id)?.sessionId ?? record.occurrences.find(occurrence => occurrence.scheduleId === id)?.sessionId ?? input.session;
    return request('GET', `${automationPath(owner)}/schedules/${path(id!)}/history`);
  }
  const sessionIds = input.session ? [input.session] : (await request('GET', '/api/sessions') as Array<{ id: string }>).map(session => session.id);
  const records = await Promise.all(sessionIds.map(async sessionId => ({ sessionId, ...await request('GET', automationPath(sessionId)) as SessionAutomationList })));
  if (action === 'list') return { schedules: [...new Map(records.flatMap(record => record.schedules).map(schedule => [schedule.id, schedule])).values()] };
  if (action === 'history') {
    const owner = records.find(record => record.schedules.some(schedule => schedule.id === id) || record.occurrences.some(occurrence => occurrence.scheduleId === id));
    if (!owner) throw new ScheduleCliError('SCHEDULE_NOT_FOUND', 'Schedule not found on this runtime; use --session for deleted schedule history');
    const sourceSessionId = owner.schedules.find(schedule => schedule.id === id)?.sessionId ?? owner.occurrences.find(occurrence => occurrence.scheduleId === id)?.sessionId ?? owner.sessionId;
    return request('GET', `${automationPath(sourceSessionId)}/schedules/${path(id!)}/history`);
  }
  const found = records.flatMap(record => record.schedules).find(schedule => schedule.id === id);
  // An explicitly targeted session can still read the tombstone after deletion.
  const schedule = found ?? (input.session ? (await request('GET', `${automationPath(input.session)}/schedules/${path(id!)}`) as { schedule: PublicSessionSchedule }).schedule : undefined);
  if (!schedule) throw new ScheduleCliError('SCHEDULE_NOT_FOUND', 'Schedule not found on this runtime; use --session to inspect a deleted schedule');
  if (action === 'show') {
    const precondition = records.find(record => record.schedules.some(item => item.id === schedule.id))?.preconditions?.[schedule.id];
    return { schedule, ...(precondition ? { precondition } : {}) };
  }
  const endpoint = `${automationPath(schedule.sessionId)}/schedules/${path(schedule.id)}`;
  const expectedRevision = input.expectedRevision === undefined ? schedule.revision : Number(input.expectedRevision);
  if (action === 'delete') return request('DELETE', endpoint, { expectedRevision });
  if (action === 'run') return request('POST', `${endpoint}/run`, { expectedRevision, idempotencyKey: input.idempotencyKey ?? randomUUID() });
  if (action === 'enable' || action === 'disable') return request('PATCH', endpoint, { expectedRevision, enabled: action === 'enable' });
  const timezone = (config as { timezone?: string } | undefined)?.timezone ?? schedule.timezone;
  return request('PATCH', endpoint, { ...config, ...(input.deadline !== undefined ? { deadlineAt: deadline(input.deadline, timezone) } : {}), expectedRevision });
}

export interface ScheduleRequestCliInput { turn?: string; prompt?: string; name?: string; every?: string; cron?: string; at?: string; mode?: string; additional?: boolean; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch }
/** 飞书会话里的 Agent 替这一轮发起人设置定时任务：宿主发确认卡，对方点「启用」才开始（见 agent-request-tools.ts）。 */
export async function runScheduleRequest(input: ScheduleRequestCliInput): Promise<Record<string, unknown>> {
  const every = input.every === undefined ? undefined : Number(input.every);
  if (every !== undefined && !Number.isInteger(every)) argument('--every takes whole minutes, e.g. --every 15');
  return new AgentGroupToolHttpClient(input).request('/schedules', {
    method: 'POST',
    headers: { 'x-dutydeck-work-turn': input.turn ?? '' },
    body: JSON.stringify({ prompt: input.prompt, name: input.name, every, cron: input.cron, at: input.at, mode: input.mode, ...(input.additional ? { additional: true } : {}) })
  });
}
