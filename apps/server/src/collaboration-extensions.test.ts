import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type CollaborationScope } from '@dutydeck/shared';
import { CollaborationExtensions } from './collaboration-extensions.js';

describe('CollaborationExtensions', () => {
  const scopeA: CollaborationScope = { appId: 'cli_test', chatId: 'oc_chat_a' };
  const scopeB: CollaborationScope = { appId: 'cli_test', chatId: 'oc_chat_b' };
  const actorUser = 'usr_alice';

  let activeRepos: Array<ReturnType<typeof createRepositories>> = [];

  afterEach(() => {
    for (const r of activeRepos) {
      try {
        r.control.close();
      } catch {
        // ignore cleanup error
      }
    }
    activeRepos = [];
  });

  function setupExtensions(options?: {
    authorize?: (scope: CollaborationScope, actorId: string, action: 'event' | 'query' | 'action') => Promise<boolean>;
    onObservation?: (snapshot: any) => void | Promise<void>;
  }) {
    const repos = createRepositories(':memory:');
    activeRepos.push(repos);
    const authorize = options?.authorize ?? (async () => true);
    const extensions = new CollaborationExtensions({
      repository: repos.collaboration,
      authorize,
      now: () => new Date('2026-09-18T10:00:00.000Z'),
      onObservation: options?.onObservation
    });

    return { extensions, repo: repos.collaboration };
  }

  describe('Source / Ingest', () => {
    it('throws error when registering duplicate source', () => {
      const { extensions } = setupExtensions();
      const sourceDef = {
        verify: async () => ({ scope: scopeA, actorId: actorUser }),
        parse: () => ({
          eventId: 'ev_1',
          occurredAt: '2026-09-18T10:00:00.000Z',
          senderKind: 'human' as const,
          text: 'Document update notification'
        })
      };
      extensions.registerSource('doc-sync-source', sourceDef);
      expect(() => extensions.registerSource('doc-sync-source', sourceDef)).toThrow(/already registered/);
    });

    it('returns 404 when ingesting unregistered source', async () => {
      const { extensions } = setupExtensions();
      await expect(extensions.ingest('unregistered', {}, {})).rejects.toThrow(RuntimeError);
      try {
        await extensions.ingest('unregistered', {}, {});
      } catch (err) {
        expect((err as RuntimeError).statusCode).toBe(404);
      }
    });

    it('rejects verification failures with 403', async () => {
      const { extensions } = setupExtensions();
      extensions.registerSource('failing-verify', {
        verify: async () => undefined,
        parse: () => ({
          eventId: 'ev_1',
          occurredAt: '2026-09-18T10:00:00.000Z',
          senderKind: 'human',
          text: 'Document outline shared'
        })
      });

      await expect(extensions.ingest('failing-verify', {}, {})).rejects.toThrow(RuntimeError);
      try {
        await extensions.ingest('failing-verify', {}, {});
      } catch (err) {
        expect((err as RuntimeError).statusCode).toBe(403);
      }
    });

    it('rejects unauthorized actor with 403', async () => {
      const { extensions } = setupExtensions({
        authorize: async (_scope, _actor, action) => action !== 'event'
      });

      extensions.registerSource('test-auth', {
        verify: async () => ({ scope: scopeA, actorId: actorUser }),
        parse: () => ({
          eventId: 'ev_1',
          occurredAt: '2026-09-18T10:00:00.000Z',
          senderKind: 'human',
          text: 'Meeting minutes uploaded'
        })
      });

      await expect(extensions.ingest('test-auth', {}, {})).rejects.toThrow(RuntimeError);
      try {
        await extensions.ingest('test-auth', {}, {});
      } catch (err) {
        expect((err as RuntimeError).statusCode).toBe(403);
      }
    });

    it('prevents body from overriding verified scope and actorId, forces external origin', async () => {
      const { extensions, repo } = setupExtensions();

      extensions.registerSource('webhook', {
        verify: async ({ headers }) => {
          if (headers['x-auth'] !== 'secret') return undefined;
          return { scope: scopeA, actorId: actorUser };
        },
        parse: (body: any) => ({
          eventId: body.eventId,
          occurredAt: '2026-09-18T10:00:00.000Z',
          senderKind: 'human',
          text: body.text
        })
      });

      const bodyWithSpoof = {
        eventId: 'evt_spoof_1',
        text: 'Proposal section draft',
        scope: scopeB, // Malicious scope attempt
        senderId: 'attacker_root',
        origin: 'live' // Malicious origin attempt
      };

      const result = await extensions.ingest('webhook', bodyWithSpoof, { 'x-auth': 'secret' });
      expect(result.created).toBe(true);
      expect(result.observation.scope).toEqual(scopeA);
      expect(result.observation.senderId).toBe(actorUser);
      expect(result.observation.origin).toBe('external');
      expect(result.observation.source).toBe('webhook');

      // Verify in repository
      const obsInRepo = await repo.listObservations(scopeA);
      expect(obsInRepo.length).toBe(1);
      expect(obsInRepo[0].scope).toEqual(scopeA);
      expect(obsInRepo[0].senderId).toBe(actorUser);
      expect(obsInRepo[0].origin).toBe('external');

      // Ensure scopeB has nothing
      const obsB = await repo.listObservations(scopeB);
      expect(obsB.length).toBe(0);
    });

    it('deduplicates identical events and advances contextRevision only on change', async () => {
      const onObservation = vi.fn();
      const { extensions } = setupExtensions({ onObservation });

      extensions.registerSource('event-stream', {
        verify: async () => ({ scope: scopeA, actorId: actorUser }),
        parse: (body: any) => ({
          eventId: body.eventId,
          occurredAt: '2026-09-18T10:00:00.000Z',
          senderKind: 'human',
          text: body.text
        })
      });

      // 1. Initial event
      const res1 = await extensions.ingest('event-stream', { eventId: 'evt_100', text: 'first version' }, {});
      expect(res1.created).toBe(true);
      expect(res1.changed).toBe(true);
      expect(onObservation).toHaveBeenCalledTimes(1);

      // 2. Duplicate identical event
      const res2 = await extensions.ingest('event-stream', { eventId: 'evt_100', text: 'first version' }, {});
      expect(res2.created).toBe(false);
      expect(res2.changed).toBe(false);
      expect(res2.contextRevision).toBe(res1.contextRevision);
      // Identical repeat should not trigger onObservation
      expect(onObservation).toHaveBeenCalledTimes(1);

      // 3. Changed event with same eventId
      const res3 = await extensions.ingest('event-stream', { eventId: 'evt_100', text: 'edited version' }, {});
      expect(res3.created).toBe(false);
      expect(res3.changed).toBe(true);
      expect(res3.contextRevision).toBeGreaterThan(res1.contextRevision);
      expect(onObservation).toHaveBeenCalledTimes(2);
    });
  });

  describe('Query', () => {
    it('throws error when registering duplicate query', () => {
      const { extensions } = setupExtensions();
      const queryDef = {
        parse: (input: any) => input,
        query: async () => ({ evidence: [], missing: [] })
      };
      extensions.registerQuery('mock-q', queryDef);
      expect(() => extensions.registerQuery('mock-q', queryDef)).toThrow(/already registered/);
    });

    it('returns 404 for unregistered query', async () => {
      const { extensions } = setupExtensions();
      await expect(extensions.query('not-found', scopeA, actorUser, {})).rejects.toThrow(RuntimeError);
      try {
        await extensions.query('not-found', scopeA, actorUser, {});
      } catch (err) {
        expect((err as RuntimeError).statusCode).toBe(404);
      }
    });

    it('rejects unauthorized query with 403', async () => {
      const { extensions } = setupExtensions({
        authorize: async (_scope, _actor, action) => action !== 'query'
      });

      extensions.registerQuery('q1', {
        parse: (i: any) => i,
        query: async () => ({ evidence: [], missing: [] })
      });

      await expect(extensions.query('q1', scopeA, actorUser, {})).rejects.toThrow(RuntimeError);
      try {
        await extensions.query('q1', scopeA, actorUser, {});
      } catch (err) {
        expect((err as RuntimeError).statusCode).toBe(403);
      }
    });

    it('strictly checks scope consistency and rejects cross-scope evidence', async () => {
      const { extensions } = setupExtensions();

      extensions.registerQuery('leaky-query', {
        parse: (i: any) => i,
        query: async () => ({
          evidence: [
            {
              id: 'ev_leaked',
              scope: scopeB, // Cross-scope leakage!
              text: 'Confidential draft notes from workspace B',
              occurredAt: '2026-09-18T10:00:00.000Z'
            }
          ],
          missing: []
        })
      });

      await expect(extensions.query('leaky-query', scopeA, actorUser, {})).rejects.toThrow(/Cross-scope evidence/);
    });

    it('validates evidence bounds and retains missing', async () => {
      const { extensions } = setupExtensions();

      extensions.registerQuery('bounded-query', {
        parse: (input: any) => ({ key: String(input.key) }),
        query: async (input, { scope }) => ({
          evidence: [
            {
              id: 'ev_valid',
              scope,
              text: `Search hit for document ${input.key}`,
              occurredAt: '2026-09-18T10:00:00.000Z'
            }
          ],
          missing: ['section_history_truncated']
        })
      });

      const res = await extensions.query('bounded-query', scopeA, actorUser, { key: 'doc_123' });
      expect(res.evidence.length).toBe(1);
      expect(res.evidence[0].id).toBe('ev_valid');
      expect(res.evidence[0].scope).toEqual(scopeA);
      expect(res.missing).toEqual(['section_history_truncated']);
    });
  });

  describe('Action (Execute & Reconcile)', () => {
    it('throws error when registering duplicate action', () => {
      const { extensions } = setupExtensions();
      const actionDef = {
        parse: (i: any) => i,
        execute: async () => ({ receipt: 'ack' })
      };
      extensions.registerAction('act-1', actionDef);
      expect(() => extensions.registerAction('act-1', actionDef)).toThrow(/already registered/);
    });

    it('rejects execution when authorization is revoked after intent', async () => {
      const executeFn = vi.fn().mockResolvedValue({ receipt: 'ok' });

      const { extensions, repo } = setupExtensions({
        authorize: async () => false // 入口即撤权
      });

      extensions.registerAction('guarded-act', {
        parse: (i: any) => i,
        execute: executeFn
      });

      await expect(
        extensions.execute('guarded-act', scopeA, actorUser, 'act_revoke_1', { data: 1 })
      ).rejects.toThrow(RuntimeError);

      expect(executeFn).not.toHaveBeenCalled();
      // 撤权时不得落任何意图记录
      await expect(repo.getAction(scopeA, 'act_revoke_1')).resolves.toBeUndefined();
    });

    it('executes action once for same key and returns cached receipt on repeat', async () => {
      const executeFn = vi.fn().mockResolvedValue({ receipt: 'doc_receipt_999' });
      const { extensions, repo } = setupExtensions();

      extensions.registerAction('document-publish', {
        parse: (i: any) => ({ docId: String(i.docId) }),
        execute: executeFn
      });

      const input = { docId: 'doc_123' };
      const res1 = await extensions.execute('document-publish', scopeA, actorUser, 'act_tx_1', input);

      expect(res1.status).toBe('succeeded');
      expect(res1.receipt).toBe('doc_receipt_999');
      expect(executeFn).toHaveBeenCalledTimes(1);

      // Repeat with same key and input
      const res2 = await extensions.execute('document-publish', scopeA, actorUser, 'act_tx_1', input);
      expect(res2.status).toBe('succeeded');
      expect(res2.receipt).toBe('doc_receipt_999');
      // Must not execute a second time!
      expect(executeFn).toHaveBeenCalledTimes(1);

      // Verify in repository
      const inDb = await repo.getAction(scopeA, 'act_tx_1');
      expect(inDb?.status).toBe('succeeded');
      expect(inDb?.receipt).toBe('doc_receipt_999');
    });

    it('conflicts with 409 when same actionId is called with different input', async () => {
      const { extensions } = setupExtensions();

      extensions.registerAction('format-markdown', {
        parse: (i: any) => ({ template: String(i.template) }),
        execute: async () => ({ receipt: 'ack' })
      });

      await extensions.execute('format-markdown', scopeA, actorUser, 'act_dep_1', { template: 'standard' });

      // Call same actionId with conflicting input
      await expect(
        extensions.execute('format-markdown', scopeA, actorUser, 'act_dep_1', { template: 'academic' })
      ).rejects.toThrow(RuntimeError);

      try {
        await extensions.execute('format-markdown', scopeA, actorUser, 'act_dep_1', { template: 'academic' });
      } catch (err) {
        expect((err as RuntimeError).statusCode).toBe(409);
      }
    });

    it('marks action as unknown on external call failure and recovers via reconcile', async () => {
      let callCount = 0;
      const executeFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network timeout waiting for remote document converter ack');
        }
        return { receipt: 'doc_ack_recovery' };
      });

      const reconcileFn = vi.fn().mockResolvedValue({
        status: 'succeeded' as const,
        receipt: 'recovered_from_document_status_check'
      });

      const { extensions, repo } = setupExtensions();

      extensions.registerAction('document-converter', {
        parse: (i: any) => ({ target: String(i.target) }),
        execute: executeFn,
        reconcile: reconcileFn
      });

      // 1. Initial execution fails
      const initialFailure = extensions.execute('document-converter', scopeA, actorUser, 'act_lost_1', { target: 'pdf' });
      await expect(initialFailure).rejects.toThrow(RuntimeError);
      await initialFailure.catch(err => {
        expect((err as RuntimeError).code).toBe('ACTION_EXECUTION_UNKNOWN');
      });

      // Check DB: state is unknown
      const actionAfterFail = await repo.getAction(scopeA, 'act_lost_1');
      expect(actionAfterFail?.status).toBe('unknown');
      expect(actionAfterFail?.error).toContain('Network timeout');

      // 2. Second execution attempt should NOT re-run execute; it must reconcile!
      const recovered = await extensions.execute('document-converter', scopeA, actorUser, 'act_lost_1', { target: 'pdf' });
      expect(recovered.status).toBe('succeeded');
      expect(recovered.receipt).toBe('recovered_from_document_status_check');

      // Execute was NOT called again!
      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(reconcileFn).toHaveBeenCalledTimes(1);

      // Verify DB updated
      const finalDbAction = await repo.getAction(scopeA, 'act_lost_1');
      expect(finalDbAction?.status).toBe('succeeded');
      expect(finalDbAction?.receipt).toBe('recovered_from_document_status_check');
    });

    it('keeps unknown status and does not retry when reconcile handler is missing', async () => {
      const executeFn = vi.fn().mockRejectedValue(new Error('Remote document service did not acknowledge the request'));
      const { extensions, repo } = setupExtensions();

      // Handler WITHOUT reconcile
      extensions.registerAction('no-reconcile', {
        parse: (i: any) => i,
        execute: executeFn
      });

      await expect(
        extensions.execute('no-reconcile', scopeA, actorUser, 'act_no_rec_1', { key: 'val' })
      ).rejects.toThrow();

      expect(executeFn).toHaveBeenCalledTimes(1);

      // Re-invoke
      const retryResult = await extensions.execute('no-reconcile', scopeA, actorUser, 'act_no_rec_1', { key: 'val' });
      expect(retryResult.status).toBe('unknown');
      // executeFn was NOT called again
      expect(executeFn).toHaveBeenCalledTimes(1);

      const dbAction = await repo.getAction(scopeA, 'act_no_rec_1');
      expect(dbAction?.status).toBe('unknown');
    });

    it('does not implicitly re-execute an action already in terminal failed status', async () => {
      const executeFn = vi.fn().mockRejectedValueOnce(new Error('first call lost'));
      const { extensions } = setupExtensions();

      extensions.registerAction('terminal-fail', {
        parse: (i: any) => i,
        execute: executeFn,
        reconcile: async () => ({ status: 'failed' as const, error: 'external confirmed permanent failure' })
      });

      const input = { v: 1 };

      // 首次外部调用异常 → unknown
      await expect(
        extensions.execute('terminal-fail', scopeA, actorUser, 'act_failed_1', input)
      ).rejects.toThrow(RuntimeError);

      // 第二次只核对，外部确认永久失败 → failed，不重新 execute
      const reconciled = await extensions.execute('terminal-fail', scopeA, actorUser, 'act_failed_1', input);
      expect(reconciled.status).toBe('failed');
      expect(executeFn).toHaveBeenCalledTimes(1);

      // 第三次：failed 终态不得隐式新执行
      const again = await extensions.execute('terminal-fail', scopeA, actorUser, 'act_failed_1', input);
      expect(again.status).toBe('failed');
      expect(executeFn).toHaveBeenCalledTimes(1);
    });
  });
});
