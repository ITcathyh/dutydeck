import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { RuntimeError } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { registerRecoveryRoutes } from './recovery-routes.js';
import { unknownTaskRuntime } from './task-resolution.test-helpers.js';

const body = { action: 'confirm_result', outcome: 'unknown', runId: 'run', taskId: 'task', attemptId: 'attempt', expectedRevision: 3, decisionId: 'decision', evidenceRefs: ['operator:reviewed'], resourceChecks: [] };
describe('execution recovery owner routes', () => {
  it('requires server-resolved installation owner and refuses client actor or unacknowledged retry', async () => {
    const runtime = { inspectExecutionRecovery: vi.fn().mockResolvedValue({ runId: 'run' }), probeExecutionRecovery: vi.fn().mockResolvedValue({ runId: 'run' }), confirmExecutionRecovery: vi.fn().mockResolvedValue({ replayed: false }), retirePtyExecution: vi.fn().mockResolvedValue({ replayed: false }), replaceNativeContext: vi.fn().mockResolvedValue({}) };
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 400 : error instanceof RuntimeError ? error.statusCode : 500).send({ error: error.message }));
    registerRecoveryRoutes(app, runtime as unknown as DutydeckRuntime, { authorize: request => request.headers.authorization === 'Bearer owner' });
    try {
      const headers = { authorization: 'Bearer owner' };
      expect((await app.inject({ method: 'GET', url: '/api/sessions/session/recovery' })).statusCode).toBe(403);
      expect(runtime.inspectExecutionRecovery).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'GET', url: '/api/sessions/session/recovery', headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/sessions/session/recovery/confirm', headers, payload: { ...body, actor: { kind: 'installation_owner', id: 'forged' } } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/sessions/session/recovery/confirm', headers, payload: { ...body, action: 'retry', outcome: undefined } })).statusCode).toBe(400);
      expect(runtime.confirmExecutionRecovery).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url: '/api/sessions/session/recovery/confirm', headers, payload: body })).statusCode).toBe(200);
      const replacement = { runId: 'run', resourceId: 'native', expectedRevision: 2, decisionId: 'replace' };
      expect((await app.inject({ method: 'POST', url: '/api/sessions/session/recovery/replace-native', headers, payload: replacement })).statusCode).toBe(200);
      expect(runtime.replaceNativeContext).toHaveBeenCalledWith('session', { kind: 'installation_owner', id: 'installation_owner' }, 'native', 2, 'replace', 'run');
      expect((await app.inject({ method: 'POST', url: '/api/sessions/session/recovery/retire-pty', headers, payload: { ...replacement, evidenceRefs: ['reviewed'], gone: true } })).statusCode).toBe(400);
      expect(runtime.retirePtyExecution).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url: '/api/sessions/session/recovery/retire-pty', headers, payload: { ...replacement, evidenceRefs: ['reviewed'] } })).statusCode).toBe(200);
      expect(runtime.confirmExecutionRecovery).toHaveBeenCalledWith('session', body, { kind: 'installation_owner', id: 'installation_owner' });
      expect((await app.inject({ method: 'POST', url: '/api/sessions/session/recovery/probe', headers, payload: { runId: 'run', gone: true } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it('validates steering recovery and supplies only the server-resolved owner to runtime', async () => {
    const runtime = { confirmSteeringRecovery: vi.fn().mockResolvedValue({ replayed: false }) };
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 400 : error instanceof RuntimeError ? error.statusCode : 500).send({ error: error.message }));
    registerRecoveryRoutes(app, runtime as unknown as DutydeckRuntime, { authorize: request => request.headers.authorization === 'Bearer owner' });
    const decision = { runId: 'run', taskId: 'task', operationId: 'operation', expectedRevision: 2, decisionId: 'decision', evidenceRefs: ['reviewed'], resourceChecks: [], action: 'delivered' };
    const url = '/api/sessions/session/recovery/steering', headers = { authorization: 'Bearer owner' };
    try {
      expect((await app.inject({ method: 'POST', url, payload: decision })).statusCode).toBe(403);
      for (const payload of [{ ...decision, actor: 'forged' }, { ...decision, expectedRevision: 0 }, { ...decision, evidenceRefs: [] }, { ...decision, action: 'not_delivered' }]) {
        expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
      }
      expect(runtime.confirmSteeringRecovery).not.toHaveBeenCalled();
      for (const payload of [decision, { ...decision, action: 'abandon' }, { ...decision, action: 'not_delivered', allowDuplicateEffects: true }]) {
        expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(200);
        expect(runtime.confirmSteeringRecovery).toHaveBeenLastCalledWith('session', payload, { kind: 'installation_owner', id: 'installation_owner' });
      }
    } finally { await app.close(); }
  });
  it('adds the Lark result deliveries of the session that failed or are waiting to retry', async () => {
    const runtime = { inspectExecutionRecovery: vi.fn().mockResolvedValue({ runId: 'run' }) };
    const deliveries = [{ sessionId: 'session', messageId: 'om_request', taskName: '任务', state: 'failed', error: '飞书拒收（230002）' }];
    const larkResultDeliveries = vi.fn(async (sessionId: string) => sessionId === 'session' ? deliveries : []);
    const app = Fastify();
    registerRecoveryRoutes(app, runtime as unknown as DutydeckRuntime, { authorize: () => true, larkResultDeliveries });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/sessions/session/recovery' })).json()).toEqual({ runId: 'run', larkResultDelivery: deliveries });
      expect((await app.inject({ method: 'GET', url: '/api/sessions/quiet/recovery' })).json()).toEqual({ runId: 'run' });
    } finally { await app.close(); }
  });
  it('denies recovery when the owner resolver was not installed', async () => {
    const app = Fastify(); registerRecoveryRoutes(app, {} as DutydeckRuntime);
    try { expect((await app.inject({ method: 'GET', url: '/api/sessions/session/recovery' })).statusCode).toBe(403); }
    finally { await app.close(); }
  });
});

describe('result-unknown task routes', () => {
  const setup = async () => {
    const h = await unknownTaskRuntime();
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 400 : error instanceof RuntimeError ? error.statusCode : 500).send({ error: { code: (error as RuntimeError).code, message: error.message } }));
    registerRecoveryRoutes(app, h.runtime, { authorize: request => request.headers.authorization === 'Bearer owner' });
    return { h, app, headers: { authorization: 'Bearer owner' }, list: `/api/sessions/${h.session.id}/unknown-tasks`, url: `/api/sessions/${h.session.id}/unknown-tasks/${h.task.id}` };
  };

  it('lists the stuck task with its facts and retries the original prompt only after acknowledgement', async () => {
    const { h, app, headers, list, url } = await setup();
    try {
      expect((await app.inject({ method: 'GET', url: list })).statusCode).toBe(403);
      const [item] = (await app.inject({ method: 'GET', url: list, headers })).json();
      expect(item).toMatchObject({ taskId: h.task.id, prompt: 'original', actionable: true, kind: 'attempt', reasonCode: 'AGENT_IDLE_TIMEOUT' });
      expect(item.factLines).toHaveLength(3);
      expect(item.factLines[0]).toContain('结果未知');
      expect((await app.inject({ method: 'POST', url, payload: { target: item.target, action: 'failed' } })).statusCode).toBe(403);
      const unacknowledged = await app.inject({ method: 'POST', url, headers, payload: { target: item.target, action: 'retry' } });
      expect(unacknowledged.statusCode).toBe(400);
      expect(await h.status()).toBe('reconcile_required');
      const retried = await app.inject({ method: 'POST', url, headers, payload: { target: item.target, action: 'retry', allowDuplicateEffects: true } });
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toMatchObject({ replayed: false, status: 'queued' });
      await vi.waitFor(async () => expect(await h.status()).toBe('completed'));
      expect(h.prompts).toEqual(['original', 'original']);
      // 同一个人再点一次只是回放；另一个动作被拒，写明谁在什么时候处理过。
      expect((await app.inject({ method: 'POST', url, headers, payload: { target: item.target, action: 'retry', allowDuplicateEffects: true } })).json()).toMatchObject({ replayed: true });
      const late = await app.inject({ method: 'POST', url, headers, payload: { target: item.target, action: 'failed' } });
      expect(late.statusCode).toBe(409);
      expect(late.json().error.message).toMatch(/^这一轮已经处理过：Web 管理员 于 .+ 已重新执行。$/);
      expect((await app.inject({ method: 'GET', url: list, headers })).json()).toEqual([]);
      expect(h.prompts).toEqual(['original', 'original']);
    } finally { await app.close(); await h.close(); }
  });

  it('settles as failed or completed with the operator and time on record', async () => {
    for (const action of ['failed', 'completed'] as const) {
      const { h, app, headers, list, url } = await setup();
      try {
        const [item] = (await app.inject({ method: 'GET', url: list, headers })).json();
        expect((await app.inject({ method: 'POST', url, headers, payload: { target: item.target, action } })).json()).toMatchObject({ status: action });
        const settlement = h.repos.execution.getTaskExecution(h.task.id)!.currentAttempt!.settlement as any;
        expect(settlement.decision).toMatchObject({ decisionId: `manual:${item.target}:${action}:web:installation_owner`,
          evidenceRefs: ['manual_resolution', 'operator:web:installation_owner', expect.stringMatching(/^at:\d{4}-/)] });
        expect(h.prompts).toEqual(['original']);
      } finally { await app.close(); await h.close(); }
    }
  });
});
