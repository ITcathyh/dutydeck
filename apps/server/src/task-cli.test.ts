import { describe, expect, it, vi } from 'vitest';
import { runTaskCli, taskError, taskExitCode, TaskCliError } from './task-cli.js';
import { createCliProgram } from './cli-program.js';

const target = { url: 'http://127.0.0.1:4310', database: '/placeholder.db' };
function deps(responses: unknown[] = [{}]) {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(responses.shift() ?? {}), { headers: { 'content-type': 'application/json' } }));
  return { fetcher, readState: () => undefined, readToken: () => 'local-token' };
}
describe('open task CLI', () => {
  it('registers all commands and inherits exact runtime options', async () => {
    const task = vi.fn();
    for (const args of [['list'], ['archive', 's', '--client', 'rovetap'], ['read', 's'], ['send', 's', '--text', 'hello'], ['interrupt', 's'], ['decide', 's', '--waiting', 'p', '--option', 'deny']]) {
      await createCliProgram('test', { task }).parseAsync(['node', 'dutydeck', '--database', target.database, 'task', ...args, '--url', target.url, '--json']);
      expect(task).toHaveBeenLastCalledWith(expect.objectContaining({ action: args[0], ...target, json: true }));
    }
  });
  it('requests the recent projection and preserves its separate archive capabilities', async () => {
    const task = vi.fn();
    await createCliProgram('test', { task }).parseAsync(['node', 'dutydeck', 'task', 'list', '--recent', '--limit', '200', '--json']);
    expect(task).toHaveBeenCalledWith(expect.objectContaining({ action: 'list', recent: true, limit: '200', json: true }));
    const d = deps([{ tasks: [{ id: 's', actions: ['send'] }], archivable: ['s'] }]);
    expect(await runTaskCli({ action: 'list', recent: true, limit: '200', ...target }, d)).toEqual({ tasks: [{ id: 's', actions: ['send'] }], archivable: ['s'] });
    expect(String(d.fetcher.mock.calls[0]![0])).toBe(`${target.url}/api/tasks?recent=true&limit=200`);
    for (const response of [{ tasks: [] }, { tasks: [], archivable: ['missing'] }, { tasks: [], archivable: [3] }]) {
      await expect(runTaskCli({ action: 'list', recent: true, ...target }, deps([response]))).rejects.toMatchObject({ code: 'unavailable' });
    }
  });
  it('archives through the existing route with an audited client and a verified receipt', async () => {
    const d = deps([{ id: 's/a', archivedAt: '2026-11-11T00:00:00.000Z' }]);
    expect(await runTaskCli({ action: 'archive', id: 's/a', client: 'rovetap', ...target }, d)).toEqual({ archived: true });
    expect(String(d.fetcher.mock.calls[0]![0])).toBe(`${target.url}/api/sessions/s%2Fa/archive`);
    expect(JSON.parse(d.fetcher.mock.calls[0]![1]!.body as string)).toEqual({ client: 'rovetap' });
    expect(d.fetcher).toHaveBeenCalledOnce();
  });
  it.each([{}, { id: 'other', archivedAt: '2026-11-11T00:00:00Z' }, { id: 's' }, { id: 's', archivedAt: true }, { id: 's', archivedAt: 'now' }, { id: 's', archivedAt: '2026-02-30T00:00:00Z' }, { id: 's', archivedAt: '2026-11-11T00:00:00+99:99' }])('rejects an unconfirmed archive receipt without retrying: %j', async response => {
    const d = deps([response]);
    await expect(runTaskCli({ action: 'archive', id: 's', ...target }, d)).rejects.toMatchObject({ code: 'unknown_outcome', exitCode: 5 });
    expect(d.fetcher).toHaveBeenCalledOnce();
  });
  it('passes the root database and send JSON flags to Lark send', async () => {
    const larkSend = vi.fn();
    await createCliProgram('test', { larkSend }).parseAsync(['node', 'dutydeck', '--database', '/placeholder.db', 'lark', 'send', 'Archive', '--app', 'cli_example', '--reply-to', 'om_example', '--in-thread', '--json']);
    expect(larkSend).toHaveBeenCalledWith('Archive', expect.objectContaining({ json: true, database: '/placeholder.db', app: 'cli_example', replyTo: 'om_example', inThread: true }));
  });

  it('reads list/read projections with local authentication', async () => {
    const d = deps([{ tasks: [] }, { items: [], truncated: false }]);
    expect(await runTaskCli({ action: 'list', ...target }, d)).toEqual({ tasks: [] });
    expect(await runTaskCli({ action: 'read', id: 's/a', limit: '3', ...target }, d)).toEqual({ items: [], truncated: false });
    expect(String(d.fetcher.mock.calls[0]![0])).toBe(`${target.url}/api/tasks?limit=50`);
    expect(String(d.fetcher.mock.calls[1]![0])).toContain('/api/tasks/s%2Fa?limit=3');
    expect(d.fetcher.mock.calls[0]![1]!.headers).toMatchObject({ authorization: 'Bearer local-token' });
  });
  it.each([{ limit: '201' }, { limit: '0' }, { limit: '1.5' }, { client: 'Bad name' }, { url: 'invalid-url' }])('rejects invalid arguments before I/O %j', async options => {
    const d = deps();
    await expect(runTaskCli({ action: 'list', ...target, ...options }, d)).rejects.toMatchObject({ code: 'invalid_argument', exitCode: 2 });
    expect(d.fetcher).not.toHaveBeenCalled();
  });
  it('queues stdin with an audited client and interrupts an active task', async () => {
    const d = { ...deps([{ accepted: true }, { interrupted: true }, { interrupted: false }]), readStdin: async () => 'hello' };
    expect(await runTaskCli({ action: 'send', id: 's', stdin: true, client: 'phone', ...target }, d)).toEqual({ task_id: 's', accepted: true });
    expect(JSON.parse(d.fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ prompt: 'hello', client: 'phone', strictSteer: true });
    expect(await runTaskCli({ action: 'interrupt', id: 's', ...target }, d)).toEqual({ state: 'interrupting' });
    expect(await runTaskCli({ action: 'interrupt', id: 's', ...target }, d)).toEqual({ state: 'idle' });
    await expect(runTaskCli({ action: 'send', id: 's', text: 'x', stdin: true, ...target }, d)).rejects.toBeInstanceOf(TaskCliError);
    await expect(runTaskCli({ action: 'send', id: 's', text: 'x', mode: 'interrupt', ...target }, d)).rejects.toBeInstanceOf(TaskCliError);
  });
  it('decides permissions and answers choices/free text using existing routes', async () => {
    const d = deps([{ kind: 'approval' }, { id: 'w', status: 'rejected' }, { kind: 'question', options: [{ id: 'yes' }], free_text: true }, { ok: true, ask: { id: 'w', status: 'answered' } }, { kind: 'question', options: [], free_text: true }, { ok: true, ask: { id: 'w', status: 'answered' } }]);
    const input = { action: 'decide' as const, id: 's', waiting: 'w', client: 'phone', ...target };
    expect(await runTaskCli({ ...input, option: 'deny', text: 'use a test directory' }, d)).toEqual({ resolved: true });
    expect(JSON.parse(d.fetcher.mock.calls[1]![1]!.body as string)).toEqual({ approved: false, reason: 'use a test directory', client: 'phone' });
    await runTaskCli({ ...input, option: 'yes' }, d);
    expect(String(d.fetcher.mock.calls[3]![0])).toContain('/api/relay/sessions/s/asks/w/answer');
    await runTaskCli({ ...input, option: 'answer', text: 'custom answer' }, d);
    expect(JSON.parse(d.fetcher.mock.calls[5]![1]!.body as string)).toEqual({ answer: 'custom answer', client: 'phone' });
  });
  it('rejects malformed responses and maps HTTP authorization and uncertain server writes', async () => {
    const d = deps([{}, { items: [], truncated: 'bad' }, {}]);
    await expect(runTaskCli({ action: 'list', ...target }, d)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(runTaskCli({ action: 'read', id: 's', ...target }, d)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(runTaskCli({ action: 'send', id: 's', text: 'hello', ...target }, d)).rejects.toMatchObject({ code: 'unknown_outcome' });
    for (const [status, code] of [[403, 'forbidden'], [500, 'unknown_outcome']] as const) {
      const fetcher = async () => new Response(JSON.stringify({ error: { code: 'SERVER_POLICY', message: 'reason' } }), { status });
      await expect(runTaskCli({ action: 'interrupt', id: 's', ...target }, { ...deps(), fetcher })).rejects.toMatchObject({ code });
    }
  });

  it.each(['send', 'interrupt', 'decide', 'archive'] as const)('treats damaged 5xx write receipts for %s as unknown', async action => {
    for (const failure of ['html', 'body', 'unavailable', 'malformed', 'missing', 'reset']) {
      const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'GET') return new Response(JSON.stringify({ kind: 'approval' }));
        if (failure === 'reset') throw Object.assign(new TypeError('connection reset'), { cause: { code: 'ECONNRESET' } });
        if (failure === 'malformed') return new Response('Invalid JSON');
        if (failure === 'missing') return new Response('{}');
        if (failure === 'html') return new Response('Bad gateway', { status: 502 });
        if (failure === 'body') return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('read failed')); } }), { status: 503 });
        return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'No definitive execution receipt' } }), { status: 503 });
      });
      await expect(runTaskCli({ action, id: 's', text: action === 'send' ? 'hello' : undefined, waiting: 'p', option: 'allow', ...target }, { ...deps(), fetcher })).rejects.toMatchObject({ code: 'unknown_outcome', exitCode: 5 });
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    }
  });
  it('reports an unconfirmed answer receipt as unknown without retrying', async () => {
    const d = deps([{ kind: 'question', options: [], free_text: true }, {}]);
    await expect(runTaskCli({ action: 'decide', id: 's', waiting: 'w', option: 'answer', text: 'yes', ...target }, d)).rejects.toMatchObject({ code: 'unknown_outcome', exitCode: 5 });
    expect(d.fetcher).toHaveBeenCalledTimes(2);
  });
  it('uses unavailable only for proven pre-connection failures', async () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
      const fetcher = vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); });
      await expect(runTaskCli({ action: 'interrupt', id: 's', ...target }, { ...deps(), fetcher })).rejects.toMatchObject({ code: 'unavailable', exitCode: 3 });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it('does not mistake an accepted interrupt for a completed original turn', async () => {
    const d = deps([{ interrupted: true }, { interrupted: true, state: 'interrupting' }, { interrupted: true, state: 'interrupted' }, { interrupted: false, state: 'idle' }]);
    for (const state of ['interrupting', 'interrupting', 'interrupted', 'idle']) expect(await runTaskCli({ action: 'interrupt', id: 's', ...target }, d)).toEqual({ state });
  });

  it('preserves definitive errors and never retries an uncertain write', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('connection lost'); });
    const d = { ...deps(), fetcher };
    await expect(runTaskCli({ action: 'interrupt', id: 's', ...target }, d)).rejects.toMatchObject({ code: 'unknown_outcome', exitCode: 5 });
    await expect(runTaskCli({ action: 'list', ...target }, d)).rejects.toMatchObject({ code: 'unavailable', exitCode: 3 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const failed = { ...deps(), fetcher: vi.fn(async () => new Response(JSON.stringify({ error: { code: 'RELAY_ASK_SETTLED', message: 'handled elsewhere' } }), { status: 409 })) };
    await expect(runTaskCli({ action: 'decide', id: 's', waiting: 'w', option: 'allow', ...target }, failed)).rejects.toMatchObject({ code: 'already_resolved', exitCode: 4 });
  });
  it.each([['INVALID_INPUT', 'invalid_argument', 2], ['SESSION_NOT_FOUND', 'not_found', 4], ['PERMISSION_RESOLVING', 'already_resolved', 4], ['PERMISSION_EXPIRED', 'unknown_outcome', 5], ['POLICY_DENIED', 'forbidden', 1], ['conflict', 'conflict', 1], ['unavailable', 'unavailable', 3]])('maps %s to a stable error', (source, code, exit) => {
    expect(taskError(source, 'reason')).toMatchObject({ code, message: 'reason', exitCode: exit });
    expect(taskExitCode(code)).toBe(exit);
  });
});
