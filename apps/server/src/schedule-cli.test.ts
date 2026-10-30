import { describe, expect, it, vi } from 'vitest';
import { runScheduleCli, runScheduleRequest, type ScheduleCliInput } from './schedule-cli.js';
import { createCliProgram } from './cli-program.js';

const target = { url: 'http://127.0.0.1:4310', database: '/tmp/schedule-cli.db' };
const schedule = { id: 'schedule_1', sessionId: 'ses_1', revision: 4, name: 'Morning', enabled: false };
function fixture() {
  const requests: Array<{ path: string; method: string; body: any; auth: string | undefined }> = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body, auth: (init?.headers as Record<string, string>)?.authorization });
    let response: unknown = { schedule };
    if (path.endsWith('/sessions')) response = method === 'POST' ? { id: 'ses_new' } : [{ id: 'ses_1' }];
    if (path.endsWith('/automation')) response = { schedules: [schedule], subscriptions: [], occurrences: [{ id: 'occ_1', scheduleId: 'schedule_1', scheduledForUtc: '2026-10-15T00:00:00.000Z', runStatus: 'completed' }] };
    if (path.endsWith('/run')) response = { occurrence: { id: 'occ_manual' } };
    if (path.endsWith('/history')) response = { occurrences: [{ id: 'occ_1', scheduleId: 'schedule_1', scheduledForUtc: '2026-10-15T00:00:00.000Z', runStatus: 'completed' }] };
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  });
  return { requests, fetcher, run: (action: Parameters<typeof runScheduleCli>[0], input: ScheduleCliInput = {}, id?: string) => runScheduleCli(action, id, { ...target, ...input }, { fetcher, readToken: () => 'owner-token' }) };
}

describe('schedule CLI', () => {
  it('creates an idle session and a disabled schedule without sending a prompt to a task endpoint', async () => {
    const f = fixture();
    await f.run('create', { agent: 'codex', cwd: '/project', workspace: 'worktree', name: 'Daily', prompt: 'Review changes', cron: '0 9 * * *', timezone: 'UTC' });
    expect(f.requests).toEqual([
      { path: '/api/sessions', method: 'POST', body: { agentId: 'codex', cwd: '/project', workspaceMode: 'worktree' }, auth: 'Bearer owner-token' },
      { path: '/api/sessions/ses_new/automation/schedules', method: 'POST', body: { name: 'Daily', prompt: 'Review changes', trigger: { kind: 'cron', expression: '0 9 * * *' }, timezone: 'UTC', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' } }, auth: 'Bearer owner-token' }
    ]);
  });

  it('sends the execution mode on create and update and validates it before any request', async () => {
    const f = fixture();
    await f.run('create', { session: 'ses_1', name: 'Deploy', prompt: 'Update and deploy', cron: '0 2 * * *', timezone: 'UTC', mode: 'fresh' });
    expect(f.requests.at(-1)).toMatchObject({ path: '/api/sessions/ses_1/automation/schedules', method: 'POST', body: { name: 'Deploy', mode: 'fresh' } });
    await f.run('update', { session: 'ses_1', mode: 'session' }, 'schedule_1');
    expect(f.requests.at(-1)).toMatchObject({ method: 'PATCH', body: { expectedRevision: 4, mode: 'session' } });
    const count = f.requests.length;
    await expect(f.run('create', { session: 'ses_1', name: 'Bad', prompt: 'x', every: '5', mode: 'reuse' })).rejects.toThrow();
    await expect(f.run('update', { session: 'ses_1', mode: 'independent' }, 'schedule_1')).rejects.toThrow();
    expect(f.requests).toHaveLength(count);
    const handler = vi.fn();
    await createCliProgram('test', { schedule: handler }).parseAsync(['node', 'dutydeck', 'schedule', 'update', 'schedule_1', '--mode', 'fresh']);
    expect(handler).toHaveBeenCalledWith('update', 'schedule_1', expect.objectContaining({ mode: 'fresh' }));
  });

  it('validates input before requests and preserves the created session ID on a partial failure', async () => {
    const f = fixture();
    for (const input of [
      { agent: 'codex', session: 'ses_1' },
      { agent: 'codex', name: 'bad', prompt: 'bad', every: '0' },
      { agent: 'codex', name: 'bad', prompt: 'bad', cron: 'invalid cron' },
      { agent: 'codex', name: 'bad', prompt: 'bad', cron: '* * * * *', timezone: 'Bad/Zone' },
      { session: 'ses_1', cwd: '/other', name: 'bad', prompt: 'bad', every: '1' }
    ]) await expect(f.run('create', input)).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
    f.fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ id: 'ses_keep' })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: 'DENIED', message: 'No access' } }), { status: 403 }));
    await expect(f.run('create', { agent: 'codex', name: 'New', prompt: 'Do work', every: '10' })).rejects.toThrow('Inspect with dutydeck schedule list --session ses_keep; retry with --session ses_keep only if the schedule is absent');
  });

  it('uses read revisions for changes, preserves explicit CAS, and reuses manual idempotency keys', async () => {
    const f = fixture();
    for (const action of ['enable', 'disable', 'delete', 'run', 'update'] as const) {
      await f.run(action, { session: 'ses_1', expectedRevision: action === 'delete' ? '3' : undefined, idempotencyKey: 'safe-retry', ...(action === 'update' ? { input: '{"prompt":"Updated","dstPolicy":{"gap":"shift_forward","overlap":"second"}}' } : {}) }, 'schedule_1');
    }
    expect(f.requests.filter(item => item.method !== 'GET').map(item => ({ method: item.method, body: item.body }))).toEqual([
      { method: 'PATCH', body: { expectedRevision: 4, enabled: true } },
      { method: 'PATCH', body: { expectedRevision: 4, enabled: false } },
      { method: 'DELETE', body: { expectedRevision: 3 } },
      { method: 'POST', body: { expectedRevision: 4, idempotencyKey: 'safe-retry' } },
      { method: 'PATCH', body: { expectedRevision: 4, prompt: 'Updated', dstPolicy: { gap: 'shift_forward', overlap: 'second' } } }
    ]);
  });

  it('lists all sessions and preserves deleted schedule history with instance routing', async () => {
    const f = fixture();
    expect(await f.run('list', { instance: 'bot-a' })).toEqual({ schedules: [schedule] });
    expect(f.requests.map(item => item.path)).toEqual(['/api/instances/bot-a/sessions', '/api/instances/bot-a/sessions/ses_1/automation']);
    expect(await f.run('history', { session: 'ses_1' }, 'schedule_1')).toEqual({ occurrences: [expect.objectContaining({ id: 'occ_1' })] });
    expect(f.requests.at(-1)!.path).toBe('/api/sessions/ses_1/automation/schedules/schedule_1/history');
    expect(await f.run('history', {}, 'schedule_1')).toEqual({ occurrences: [expect.objectContaining({ id: 'occ_1' })] });
    expect(f.requests.at(-1)!.path).toBe('/api/sessions/ses_1/automation/schedules/schedule_1/history');
  });

  it('uses the local-runtime authentication boundary', async () => {
    const f = fixture();
    await expect(f.run('list', { url: 'https://example.com' })).rejects.toMatchObject({ code: 'SCHEDULE_LOCAL_RUNTIME_REQUIRED' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('wires all management commands and runtime flags through Commander', async () => {
    const handler = vi.fn();
    const program = createCliProgram('test', { schedule: handler });
    await program.parseAsync(['node', 'dutydeck', 'schedule', 'create', '--agent', 'codex', '--cwd', '/project', '--workspace', 'worktree', '--name', 'Daily', '--prompt', 'Review', '--cron', '0 9 * * *', '--timezone', 'UTC', '--instance', 'bot-a', '--url', target.url, '--database', target.database]);
    expect(handler).toHaveBeenCalledWith('create', undefined, expect.objectContaining({ agent: 'codex', workspace: 'worktree', cron: '0 9 * * *', instance: 'bot-a', ...target }));
    for (const action of ['list', 'show', 'update', 'enable', 'disable', 'run', 'delete', 'history']) {
      const fresh = createCliProgram('test', { schedule: handler });
      await fresh.parseAsync(['node', 'dutydeck', 'schedule', action, ...(action === 'list' ? [] : ['schedule_1']), '--session', 'ses_1']);
      expect(handler).toHaveBeenLastCalledWith(action, action === 'list' ? undefined : 'schedule_1', expect.objectContaining({ session: 'ses_1' }));
    }
  });

  it('sends an Agent schedule request with this turn token over the session capability', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => { calls.push({ url: String(url), init: init! }); return new Response(JSON.stringify({ pendingConfirmation: true }), { headers: { 'content-type': 'application/json' } }); });
    const env = { dutydeck_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dutydeck_group_tools_token: 'v1.token' };
    await expect(runScheduleRequest({ turn: 'turn-1', every: '15', prompt: '看看有没有结论', env, fetcher })).resolves.toEqual({ pendingConfirmation: true });
    expect(calls[0]!.url).toBe('http://127.0.0.1:4310/api/lark/agent-tools/schedules');
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('authorization')).toBe('Bearer v1.token');
    expect(headers.get('x-dutydeck-work-turn')).toBe('turn-1');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ prompt: '看看有没有结论', every: 15 });
    await expect(runScheduleRequest({ turn: 'turn-1', every: '15m', prompt: 'x', env, fetcher })).rejects.toMatchObject({ code: 'SCHEDULE_ARGUMENT_INVALID' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const handler = vi.fn();
    await createCliProgram('test', { scheduleRequest: handler }).parseAsync(['node', 'dutydeck', 'schedule', 'request', '--turn', 'turn-1', '--cron', '0 9 * * *', '--prompt', '汇总告警']);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ turn: 'turn-1', cron: '0 9 * * *', prompt: '汇总告警' }));
    await runScheduleRequest({ turn: 'turn-1', cron: '0 2 * * *', prompt: '部署', mode: 'fresh', env, fetcher });
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ prompt: '部署', cron: '0 2 * * *', mode: 'fresh' });
  });
});
