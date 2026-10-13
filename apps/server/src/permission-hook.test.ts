import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayCapabilityRegistry } from '@dutydeck/relay';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import type { DriverPermissionDecision, PermissionRequestData, Session } from '@dutydeck/shared';
import { buildApp } from './app.js';
import { HookPermissionRequests, claudeToolKind, permissionHookDeadlineMs, runPermissionHook } from './permission-hook.js';

const env = { dutydeck_relay_url: 'http://127.0.0.1/api/relay', dutydeck_relay_token: 'fixture-token' };
const payload = { hook_event_name: 'PermissionRequest', session_id: 'native', cwd: '/repo', permission_mode: 'default',
  tool_name: 'Bash', tool_input: { command: 'pnpm test', description: 'Run the unit tests' } };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });

const session = (patch: Partial<Session> = {}): Session => ({
  id: 'ses_hook', agentId: 'claude-code', state: 'running_tool', cwd: '/repo', runId: 'run_1', source: 'lark', protocol: 'pty-cli',
  permissionMode: 'ask', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...patch,
});

function deferred() {
  let resolve!: (decision: DriverPermissionDecision) => void;
  const decision = new Promise<DriverPermissionDecision>(done => { resolve = done; });
  return { decision, resolve };
}

function fakeRuntime(current: Session | null = session()) {
  const requests: Array<Omit<PermissionRequestData, 'id' | 'status'>> = [];
  const pending: Array<ReturnType<typeof deferred>> = [];
  return {
    requests, pending,
    async getSession(id: string) { return current?.id === id ? current : undefined; },
    requestDriverPermission: vi.fn((_sessionId: string, request: Omit<PermissionRequestData, 'id' | 'status'>) => {
      requests.push(request);
      const next = deferred();
      pending.push(next);
      return { id: `hook_${pending.length}`, decision: next.decision };
    }),
  };
}

const respond = (...bodies: unknown[]) => vi.fn(async () => new Response(JSON.stringify(bodies.length > 1 ? bodies.shift() : bodies[0]), { status: 200 }));
const decision = (output: string) => JSON.parse(output).hookSpecificOutput.decision;

describe('Claude PermissionRequest hook over the session relay', () => {
  it('runs the generated hook as a real subprocess, polls through the relay route and returns the approval to Claude', async () => {
    const runtime = fakeRuntime();
    const capabilities = new RelayCapabilityRegistry({ async get(id) { return id === 'ses_hook' ? { id, state: 'running_tool' } : undefined; } },
      'http://127.0.0.1', 'test-secret');
    // 等待窗口压到 50ms，让 hook 至少经历一次 pending → 续等。
    const permissions = new HookPermissionRequests(runtime, { waitMs: 50 });
    const app = await buildApp(runtime as any, { relay: { runtime: runtime as any, capabilities, permissions } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    cleanup.push(() => app.close());
    const port = (app.server.address() as { port: number }).port;
    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const hookEnv = { ...capabilities.environmentFor('ses_hook'), dutydeck_relay_url: `http://127.0.0.1:${port}/api/relay`,
      dutydeck_relay_command: `'${process.execPath}' --import tsx '${cli}'`, FIXTURE_API_KEY: 'fixture-key-value' };
    const args = createCliAdapter('claude-code').buildArgs({ sessionId: 'ses_hook', permissionMode: 'ask', env: hookEnv });
    const hook = JSON.parse(args[args.indexOf('--settings') + 1]!).hooks.PermissionRequest[0].hooks[0];
    expect(hook.command).not.toContain(hookEnv.dutydeck_relay_token);
    const run = (input: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile('/bin/sh', ['-c', hook.command], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { ...process.env, ...hookEnv, NODE_OPTIONS: '--conditions=development' }, timeout: 15_000,
      }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      child.stdin!.end(input);
    });
    const approved = run(JSON.stringify({ ...payload, tool_input: { command: 'deploy --api-key fixture-key-value', description: 'Deploy' } }));
    await vi.waitFor(() => expect(runtime.pending).toHaveLength(1), { timeout: 10_000 });
    // 让 hook 至少续等一轮，再给出批准。
    await new Promise(resolve => setTimeout(resolve, 200));
    runtime.pending[0]!.resolve({ approved: true });
    const result = await approved;
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(runtime.requests).toEqual([{ title: 'Deploy', operation: { source: 'claude_permission_hook', kind: 'execute', cwd: '/repo', command: 'deploy --api-key [REDACTED]' } }]);
    expect(JSON.stringify(runtime.requests)).not.toContain('fixture-key-value');

    // stdin 读不懂也要明确拒绝，不能退回无人处理的终端确认。
    const unreadable = await run('not json');
    expect(decision(unreadable.stdout).behavior).toBe('deny');
  }, 30_000);

  it('accepts the permission route only with the session capability', async () => {
    const runtime = fakeRuntime();
    const capabilities = new RelayCapabilityRegistry({ async get(id) { return { id, state: 'idle' }; } }, 'http://127.0.0.1', 'test-secret');
    const app = await buildApp(runtime as any, { auth: { mode: 'token', getToken: async () => 'access-token', localOnly: false },
      relay: { runtime: runtime as any, capabilities, permissions: new HookPermissionRequests(runtime, { waitMs: 10 }) } });
    cleanup.push(() => app.close());
    const url = '/api/relay/sessions/self/permission';
    expect((await app.inject({ method: 'POST', url, payload: { toolName: 'Bash' }, remoteAddress: '203.0.113.7' })).statusCode).toBe(401);
    const accepted = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${capabilities.tokenFor('ses_hook')}` },
      payload: { toolName: 'Bash', command: 'pnpm test' }, remoteAddress: '203.0.113.7' });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'pending' });
  });

  it('keeps the native confirmation without relay credentials or for other hook events', async () => {
    const fetcher = vi.fn();
    expect(await runPermissionHook(payload, { env: {}, fetcher })).toBe('');
    expect(await runPermissionHook({ ...payload, hook_event_name: 'PreToolUse' }, { env, fetcher })).toBe('');
    expect(fetcher).not.toHaveBeenCalled();
    // 服务端答复 native（非飞书会话、没有进行中的轮次）时同样不输出。
    expect(await runPermissionHook(payload, { env, fetcher: respond({ status: 'native' }) })).toBe('');
  });

  it('denies with the reviewer reason, including the 24-hour timeout', async () => {
    const output = await runPermissionHook(payload, { env, fetcher: respond({ status: 'rejected', reason: '超过 24 小时未处理，已自动拒绝' }) });
    expect(decision(output)).toEqual({ behavior: 'deny', message: '超过 24 小时未处理，已自动拒绝' });
    expect(decision(await runPermissionHook(payload, { env, fetcher: respond({ status: 'rejected' }) })).message).toContain('用户拒绝');
  });

  it('fails closed when the relay is unavailable, errors, or the request expired', async () => {
    const thrown = await runPermissionHook(payload, { env, fetcher: vi.fn(async () => { throw new Error('connect fixture-secret'); }) });
    expect(decision(thrown).behavior).toBe('deny');
    expect(thrown).not.toContain('fixture-secret');
    const failed = await runPermissionHook(payload, { env, fetcher: vi.fn(async () => new Response('{}', { status: 503 })) });
    expect(decision(failed).behavior).toBe('deny');
    expect(decision(await runPermissionHook(payload, { env, fetcher: respond({ status: 'expired' }) })).message).toContain('失效');
    expect(decision(await runPermissionHook({ ...payload, tool_name: '' }, { env, fetcher: vi.fn() })).behavior).toBe('deny');
  });

  it('keeps polling while pending and stops with a denial after its own 24-hour deadline', async () => {
    let clock = 0;
    const fetcher = vi.fn(async () => { clock += permissionHookDeadlineMs / 2; return new Response(JSON.stringify({ status: 'pending', permissionId: 'p1' })); });
    const output = await runPermissionHook(payload, { env, fetcher, now: () => clock });
    expect(decision(output)).toEqual({ behavior: 'deny', message: expect.stringContaining('超过 24 小时未处理') });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ permissionId: 'p1' });
    const approved = respond({ status: 'pending', permissionId: 'p2' }, { status: 'approved' });
    expect(decision(await runPermissionHook(payload, { env, fetcher: approved }))).toEqual({ behavior: 'allow' });
    expect(approved).toHaveBeenCalledTimes(2);
  });
});

describe('HookPermissionRequests', () => {
  const facts = { toolName: 'Bash', title: 'Run tests', cwd: '/repo', command: 'pnpm test' };

  it('registers a Lark ask session request with the driver and returns the decision across polls', async () => {
    const runtime = fakeRuntime();
    const requests = new HookPermissionRequests(runtime, { waitMs: 5 });
    const first = await requests.submit('ses_hook', facts);
    expect(first).toEqual({ status: 'pending', permissionId: expect.any(String) });
    expect(runtime.requests).toEqual([{ title: 'Run tests', operation: { source: 'claude_permission_hook', kind: 'execute', cwd: '/repo', command: 'pnpm test' } }]);
    const permissionId = (first as { permissionId: string }).permissionId;
    // 别的会话拿不到这条请求的裁决。
    expect(await requests.submit('ses_other', { permissionId })).toEqual({ status: 'expired' });
    runtime.pending[0]!.resolve({ approved: false, reason: '超过 24 小时未处理，已自动拒绝' });
    expect(await requests.submit('ses_hook', { permissionId })).toEqual({ status: 'rejected', reason: '超过 24 小时未处理，已自动拒绝' });
    // 裁决只交一次；之后的轮询当作失效。
    expect(await requests.submit('ses_hook', { permissionId })).toEqual({ status: 'expired' });
  });

  it.each([
    ['a non-Lark session', session({ source: 'web' })],
    ['a full-trust session', session({ permissionMode: 'full-trust' })],
    ['a missing session', null],
  ])('answers native for %s without registering anything', async (_label, current) => {
    const runtime = fakeRuntime(current);
    expect(await new HookPermissionRequests(runtime).submit('ses_hook', facts)).toEqual({ status: 'native' });
    expect(runtime.requestDriverPermission).not.toHaveBeenCalled();
  });

  it('answers native when the session has no running turn', async () => {
    const runtime = fakeRuntime();
    runtime.requestDriverPermission.mockReturnValueOnce(undefined as never);
    expect(await new HookPermissionRequests(runtime).submit('ses_hook', facts)).toEqual({ status: 'native' });
  });

  it('auto-approves only reads and searches in approve-reads sessions', async () => {
    const runtime = fakeRuntime(session({ permissionMode: 'approve-reads' }));
    const requests = new HookPermissionRequests(runtime, { waitMs: 5 });
    expect(await requests.submit('ses_hook', { toolName: 'Read', resource: '/etc/hosts' })).toEqual({ status: 'approved' });
    expect(await requests.submit('ses_hook', { toolName: 'Grep', resource: 'TODO' })).toEqual({ status: 'approved' });
    expect(runtime.requestDriverPermission).not.toHaveBeenCalled();
    expect((await requests.submit('ses_hook', { toolName: 'WebFetch', resource: 'https://example.com' })).status).toBe('pending');
    expect((await requests.submit('ses_hook', { toolName: 'Edit', resource: 'src/a.ts' })).status).toBe('pending');
    expect(runtime.requests.map(request => request.operation?.kind)).toEqual(['fetch', 'edit']);
  });

  it('rejects malformed bodies before touching the session', async () => {
    const runtime = fakeRuntime();
    const requests = new HookPermissionRequests(runtime);
    await expect(requests.submit('ses_hook', [])).rejects.toMatchObject({ code: 'RELAY_INVALID_PERMISSION', statusCode: 400 });
    await expect(requests.submit('ses_hook', { toolName: '' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.submit('ses_hook', { toolName: 'Bash', command: 'x'.repeat(1301) })).rejects.toMatchObject({ statusCode: 400 });
    expect(runtime.requestDriverPermission).not.toHaveBeenCalled();
  });

  it('maps Claude tools to ACP tool kinds', () => {
    expect(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'mcp__x__y'].map(claudeToolKind))
      .toEqual(['execute', 'edit', 'edit', 'edit', 'edit', 'read', 'search', 'search', 'search', 'fetch', 'fetch', 'other']);
  });
});
