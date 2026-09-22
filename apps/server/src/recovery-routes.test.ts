import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { RuntimeError } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { registerRecoveryRoutes } from './recovery-routes.js';

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
  it('denies recovery when the owner resolver was not installed', async () => {
    const app = Fastify(); registerRecoveryRoutes(app, {} as DutydeckRuntime);
    try { expect((await app.inject({ method: 'GET', url: '/api/sessions/session/recovery' })).statusCode).toBe(403); }
    finally { await app.close(); }
  });
});
