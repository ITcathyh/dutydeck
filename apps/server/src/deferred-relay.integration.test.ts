import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayAskBroker, RelayCapabilityRegistry } from '@dutydeck/relay';
import { buildApp } from './app.js';
import { runNativeAskHook } from './native-ask-hook.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const native = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [
  { question: '确认写入？', options: [{ label: '确认' }, { label: '取消' }] },
  { question: '第二道问题不能登记', options: [{ label: '下一步' }] }
] } };
const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
async function harness(options: { ackFailure?: boolean; native?: boolean; missingAttempt?: boolean } = {}) {
  const order: string[] = [];
  let child: ChildProcess | undefined;
  let activeTaskId = 'task_original';
  let activeAttemptId = 'attempt_original';
  const runtime = {
    getSession: async (id: string) => ({ id, state: 'running', cwd: '/tmp' }),
    getActiveTaskContext: () => ({ taskId: activeTaskId, ...(options.missingAttempt ? {} : { attemptId: activeAttemptId }), actorId: 'ou_original' }),
    getTaskRecovery: async () => ({ status: 'running' }), subscribe: () => () => {},
    deferTurn: vi.fn(async (_id, taskId, askId, stop, attemptId) => {
      expect(askId).toBe('confirmation_fixture');
      expect(attemptId).toBe('attempt_original');
      if (taskId !== activeTaskId || attemptId !== activeAttemptId) throw Object.assign(new Error('old task'), { code: 'TASK_NOT_ACTIVE' });
      if (!stop) return;
      order.push('interrupt');
      if (child?.pid && !options.native) process.kill(-child.pid, 'SIGTERM');
    })
  };
  const capabilities = new RelayCapabilityRegistry({ get: runtime.getSession }, 'http://localhost', 'fixture');
  const broker = new RelayAskBroker({ publish: async () => {} });
  const handler = vi.fn(async () => { order.push('registered'); return { status: 'deferred' as const, askId: 'confirmation_fixture', reason: 'deferred confirmation' }; });
  broker.addDeferredHandler(handler);
  const app = await buildApp(runtime as any, { auth: { mode: 'token', getToken: async () => 'access', localOnly: false }, relay: { runtime: runtime as any, broker, capabilities } });
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.endsWith('/deferred-ack')) {
      order.push('ack');
      if (options.ackFailure) return reply.code(503).send({ error: 'fixture unavailable' });
    }
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const env = { ...process.env, NODE_OPTIONS: '--conditions=development',
    dutydeck_relay_url: `http://127.0.0.1:${address.port}/api/relay`, dutydeck_relay_token: capabilities.tokenFor('ses_fixture') };
  cleanups.push(async () => { if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    await app.close(); broker.close(); });
  const launch = () => {
    const args = options.native ? ['--import', 'tsx', cli, 'session', 'native-ask']
      : ['--import', 'tsx', cli, 'session', 'ask', '确认写入？', '--choices', '[{"label":"确认"},{"label":"取消"}]', '--json'];
    // A semicolon, intentionally: a nonzero CLI exit alone does not stop shell continuation.
    child = options.native ? spawn(process.execPath, args, { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('/bin/sh', ['-c', `"${process.execPath}" ${args.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')}; echo UNSAFE_WRITE_AFTER_ASK`], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; order.push('output'); });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    if (options.native) child.stdin!.end(JSON.stringify(native)); else child.stdin!.end();
    const exit = new Promise<{ code: number | null; signal: string | null }>(resolve => child!.on('exit', (code, signal) => resolve({ code, signal })));
    return { child, exit, get stdout() { return stdout; }, get stderr() { return stderr; } };
  };
  return { app, capabilities, runtime, handler, order, launch, env, newerTask: () => { activeTaskId = 'task_new'; }, newerAttempt: () => { activeAttemptId = 'attempt_new'; } };
}

describe('deferred relay delivery and host stop handshake', () => {
  it('flushes a real relay CLI result before ACK and prevents the next shell command', async () => {
    const h = await harness(); const process = h.launch();
    await vi.waitFor(() => expect(h.order).toContain('ack'), { timeout: 15_000 });
    await process.exit;
    expect(JSON.parse(process.stdout)).toMatchObject({ status: 'deferred', askId: 'confirmation_fixture' });
    expect(process.stdout).not.toContain('UNSAFE_WRITE_AFTER_ASK');
    expect(h.order.indexOf('output')).toBeLessThan(h.order.indexOf('interrupt'));
    expect(h.runtime.deferTurn).toHaveBeenCalledWith('ses_fixture', 'task_original', 'confirmation_fixture', true, 'attempt_original');
  });
  it('native deferred JSON stops the whole hook after the first question, and ACK failure keeps valid output', async () => {
    const h = await harness({ native: true, ackFailure: true }); const process = h.launch();
    expect(await process.exit).toMatchObject({ code: 0 });
    const output = JSON.parse(process.stdout);
    expect(output).toMatchObject({ continue: false, hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(output.stopReason).toContain('deferred:confirmation_fixture');
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(h.order).toContain('ack');
    expect(h.runtime.deferTurn).toHaveBeenCalledExactlyOnceWith('ses_fixture', 'task_original', 'confirmation_fixture', false, 'attempt_original');
  });
  it('keeps a relay CLI inside its tool when ACK transport fails, rather than resuming a shell chain', async () => {
    const h = await harness({ ackFailure: true }); const process = h.launch();
    await vi.waitFor(() => expect(h.order).toContain('ack'), { timeout: 15_000 });
    expect(process.child.exitCode).toBeNull();
    expect(process.stdout).not.toContain('UNSAFE_WRITE_AFTER_ASK');
    expect(JSON.parse(process.stdout).status).toBe('deferred');
  });
  it('late or forged ACK cannot interrupt another session or a newer turn', async () => {
    const h = await harness();
    const headers = { authorization: `Bearer ${h.capabilities.tokenFor('ses_fixture')}` };
    const registered = await h.app.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers, payload: { question: 'Q', choices: [{ label: 'Y' }] } });
    expect(registered.json().status).toBe('deferred');
    expect((await h.app.inject({ method: 'POST', url: '/api/relay/sessions/self/deferred-ack', headers: { authorization: `Bearer ${h.capabilities.tokenFor('ses_other')}` }, payload: { askId: 'confirmation_fixture' } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: '/api/relay/sessions/self/deferred-ack', headers, payload: { askId: 'forged' } })).statusCode).toBe(404);
    h.newerTask();
    expect((await h.app.inject({ method: 'POST', url: '/api/relay/sessions/self/deferred-ack', headers, payload: { askId: 'confirmation_fixture' } })).statusCode).toBe(200);
    await vi.waitFor(() => expect(h.runtime.deferTurn).toHaveBeenCalledTimes(2));
    expect(h.runtime.deferTurn).toHaveBeenCalledWith('ses_fixture', 'task_original', 'confirmation_fixture', true, 'attempt_original');
  });
  it('late ACK cannot cancel a new attempt of the same task', async () => {
    const h = await harness();
    const headers = { authorization: `Bearer ${h.capabilities.tokenFor('ses_fixture')}` };
    await h.app.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers, payload: { question: 'Q', choices: [{ label: 'Y' }] } });
    h.newerAttempt();
    await h.app.inject({ method: 'POST', url: '/api/relay/sessions/self/deferred-ack', headers, payload: { askId: 'confirmation_fixture' } });
    await vi.waitFor(() => expect(h.runtime.deferTurn).toHaveBeenCalledTimes(2));
    expect(h.runtime.deferTurn).toHaveBeenLastCalledWith('ses_fixture', 'task_original', 'confirmation_fixture', true, 'attempt_original');
    expect(h.order).not.toContain('interrupt');
  });
  it('fails closed without binding or cancelling when an active task has no verified attempt', async () => {
    const h = await harness({ missingAttempt: true });
    const headers = { authorization: `Bearer ${h.capabilities.tokenFor('ses_fixture')}` };
    const response = await h.app.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers, payload: { question: 'Q', choices: [{ label: 'Y' }] } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'RELAY_DEFERRED_NOT_ACTIVE' } });
    expect(h.runtime.deferTurn).not.toHaveBeenCalled();
    const ack = await h.app.inject({ method: 'POST', url: '/api/relay/sessions/self/deferred-ack', headers, payload: { askId: 'confirmation_fixture' } });
    expect(ack.statusCode).toBe(404);
    expect(h.order).not.toContain('interrupt');
  });
  it('fails closed when an unknown client omits the deferred ACK', async () => {
    const h = await harness();
    const headers = { authorization: `Bearer ${h.capabilities.tokenFor('ses_fixture')}` };
    const response = await h.app.inject({ method: 'POST', url: '/api/relay/sessions/self/ask', headers, payload: { question: 'Q', choices: [{ label: 'Y' }] } });
    expect(response.json().status).toBe('deferred');
    await vi.waitFor(() => expect(h.runtime.deferTurn).toHaveBeenCalledWith('ses_fixture', 'task_original', 'confirmation_fixture', true, 'attempt_original'), { timeout: 7_000 });
  }, 10_000);
  it('native function returns explicit deferred, denies the tool and does not submit the next question', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'deferred', askId: 'r1' })));
    const output = JSON.parse(await runNativeAskHook(native, { env: { dutydeck_relay_url: 'http://localhost', dutydeck_relay_token: 'token' }, fetcher }));
    expect(output.continue).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.hookSpecificOutput.updatedInput).toBeUndefined();
  });
});
