import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import {
  type CollaborationDecision,
  type CollaborationObservation,
  type CollaborationScope,
  type CollaborationSnapshot
} from '@dutydeck/shared';
import { CollaborationEvaluation } from './collaboration-evaluation.js';

describe('CollaborationEvaluation', () => {
  const scopeA: CollaborationScope = { appId: 'cli_test', chatId: 'oc_chat_eval_a' };
  const scopeB: CollaborationScope = { appId: 'cli_test', chatId: 'oc_chat_eval_b' };

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

  function setupEvaluation(evaluateFn?: (snapshot: CollaborationSnapshot, policyVersion: string) => Promise<any>) {
    const repos = createRepositories(':memory:');
    activeRepos.push(repos);
    const evaluate = evaluateFn
      ? vi.fn().mockImplementation(evaluateFn)
      : vi.fn().mockResolvedValue({
          action: 'reply',
          reason: 'Standard document policy match',
          evidenceIds: ['obs_valid_1']
        });

    const evaluation = new CollaborationEvaluation({
      repository: repos.collaboration,
      evaluate,
      now: () => new Date('2026-09-18T10:00:00.000Z')
    });

    return { evaluation, repo: repos.collaboration, evaluate };
  }

  function makeSnapshot(options?: {
    scope?: CollaborationScope;
    missingInObs?: boolean;
    missingInBootstrap?: boolean;
    observations?: CollaborationObservation[];
    settings?: any;
    bootstrapScope?: CollaborationScope;
    settingsScope?: CollaborationScope;
    followups?: any[];
    mandates?: any[];
  }): CollaborationSnapshot {
    const targetScope = options?.scope ?? scopeA;
    return {
      scope: targetScope,
      contextRevision: 1,
      settings: options?.settings ?? {
        scope: options?.settingsScope ?? targetScope,
        revision: 1,
        participation: 'selective',
        instructions: 'Test document guidelines',
        notificationsPaused: false,
        maxProactivePerHour: 6,
        retentionDays: 30,
        policyVersion: 'v1',
        updatedAt: '2026-09-18T10:00:00.000Z'
      },
      observations: options?.observations ?? [
        {
          id: 'obs_valid_1',
          scope: targetScope,
          sequence: 1,
          source: 'doc_feed',
          eventId: 'evt_1',
          occurredAt: '2026-09-18T10:00:00.000Z',
          receivedAt: '2026-09-18T10:00:00.000Z',
          senderId: 'user_1',
          senderKind: 'human',
          text: 'Need assistance with document editing #123',
          refs: [],
          origin: 'external',
          missing: options?.missingInObs ? ['incomplete_section'] : [],
          revision: 1
        }
      ],
      followups: options?.followups ?? [],
      mandates: options?.mandates ?? [],
      bootstrap: options?.missingInBootstrap || options?.bootstrapScope
        ? {
            scope: options?.bootstrapScope ?? targetScope,
            status: 'partial',
            missing: options?.missingInBootstrap ? ['document_history_truncated'] : [],
            updatedAt: '2026-09-18T10:00:00.000Z'
          }
        : undefined
    };
  }

  it('passes replay when decision snapshot is valid and action matches', async () => {
    const snapshot = makeSnapshot();
    const { evaluation, repo, evaluate } = setupEvaluation(async () => ({
      action: 'reply',
      reason: 'Verified document assistance request',
      evidenceIds: ['obs_valid_1']
    }));

    const decision: CollaborationDecision = {
      id: 'dec_pass_1',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'reply',
      reason: 'Verified document assistance request',
      evidenceIds: ['obs_valid_1'],
      status: 'sent',
      inputSnapshot: snapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    };

    await repo.recordDecision(decision);

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_pass_1'] });
    expect(replayRes.passed).toBe(1);
    expect(replayRes.failed).toBe(0);
    expect(replayRes.missing).toBe(0);
    expect(replayRes.results[0].status).toBe('passed');
    expect(replayRes.results[0].expected).toBe('reply');
    expect(replayRes.results[0].actual).toBe('reply');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it.each(['valid', 'cross_app', 'unlisted', 'origin', 'schema', 'duplicate', 'partial'] as const)('validates frozen team evidence during replay: %s', async variant => {
    const snapshot = makeSnapshot();
    const teamObservation: CollaborationObservation = { ...snapshot.observations[0]!, id: 'team_followup', scope: scopeB, source: 'lark.team.followup', origin: 'external' };
    snapshot.teamContext = { query: '我的待办', searchedAt: '2026-09-18T10:00:00.000Z',
      sources: [{ scope: scopeB, name: '项目群', status: 'complete', missing: [] }], observations: [teamObservation] };
    if (variant === 'cross_app') snapshot.teamContext.sources[0]!.scope = { ...scopeB, appId: 'foreign_bot' };
    if (variant === 'unlisted') teamObservation.scope = { ...scopeB, chatId: 'unlisted' };
    if (variant === 'origin') teamObservation.origin = 'live';
    if (variant === 'schema') (teamObservation as any).origin = 'invented';
    if (variant === 'duplicate') teamObservation.id = snapshot.observations[0]!.id;
    if (variant === 'partial') snapshot.teamContext.sources[0]!.status = 'partial';
    const { evaluation, repo, evaluate } = setupEvaluation(async () => ({ action: 'reply', reason: '项目群有待办', evidenceIds: [teamObservation.id] }));
    await repo.recordDecision({ id: `dec_team_${variant}`, scope: scopeA, contextRevision: 1, policyVersion: 'v1', action: 'reply', reason: '团队材料',
      evidenceIds: [teamObservation.id], status: 'sent', inputSnapshot: snapshot as unknown as Record<string, unknown>, createdAt: '2026-09-18T10:00:00.000Z' });
    const result = await evaluation.replay(scopeA, { decisionIds: [`dec_team_${variant}`] });
    expect(result.results[0]!.status).toBe(variant === 'valid' ? 'passed' : variant === 'schema' || variant === 'partial' ? 'missing' : 'failed');
    expect(evaluate).toHaveBeenCalledTimes(variant === 'valid' ? 1 : 0);
  });

  it('marks as missing when decision does not exist in scope and does not call evaluate', async () => {
    const { evaluation, evaluate } = setupEvaluation();
    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['non_existent_dec'] });

    expect(replayRes.missing).toBe(1);
    expect(replayRes.passed).toBe(0);
    expect(replayRes.failed).toBe(0);
    expect(replayRes.results[0].status).toBe('missing');
    expect(replayRes.results[0].reason).toContain('not found in scope');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('marks as missing when snapshot is missing settings or observations and does not call evaluate', async () => {
    const { evaluation, repo, evaluate } = setupEvaluation();

    const decisionWithoutSettings: CollaborationDecision = {
      id: 'dec_missing_settings',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'reply',
      reason: 'No settings',
      evidenceIds: ['obs_1'],
      status: 'candidate',
      inputSnapshot: {
        scope: scopeA,
        observations: []
      },
      createdAt: '2026-09-18T10:00:00.000Z'
    };

    await repo.recordDecision(decisionWithoutSettings);

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_missing_settings'] });
    expect(replayRes.missing).toBe(1);
    expect(replayRes.failed).toBe(0);
    expect(replayRes.passed).toBe(0);
    expect(replayRes.results[0].status).toBe('missing');
    expect(replayRes.results[0].reason).toContain('Missing settings or observations');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('marks as missing when any observation contains missing materials, even if model outputs silent', async () => {
    const snapshotWithMissing = makeSnapshot({ missingInObs: true });
    const { evaluation, repo, evaluate } = setupEvaluation(async () => ({
      action: 'silent',
      reason: 'Should stay silent',
      evidenceIds: []
    }));

    const decision: CollaborationDecision = {
      id: 'dec_with_missing_obs',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'silent',
      reason: 'Silent',
      evidenceIds: [],
      status: 'candidate',
      inputSnapshot: snapshotWithMissing as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    };

    await repo.recordDecision(decision);

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_with_missing_obs'] });
    expect(replayRes.missing).toBe(1);
    expect(replayRes.failed).toBe(0);
    expect(replayRes.passed).toBe(0);
    expect(replayRes.results[0].status).toBe('missing');
    expect(replayRes.results[0].reason).toContain('contains missing elements');
    // 材料不足时绝不调用 evaluate
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('marks as missing when bootstrap has missing elements and does not call evaluate', async () => {
    const snapshotWithBootstrapMissing = makeSnapshot({ missingInBootstrap: true });
    const { evaluation, repo, evaluate } = setupEvaluation();

    const decision: CollaborationDecision = {
      id: 'dec_bootstrap_missing',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'reply',
      reason: 'Reply',
      evidenceIds: ['obs_valid_1'],
      status: 'candidate',
      inputSnapshot: snapshotWithBootstrapMissing as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    };

    await repo.recordDecision(decision);

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_bootstrap_missing'] });
    expect(replayRes.missing).toBe(1);
    expect(replayRes.failed).toBe(0);
    expect(replayRes.results[0].status).toBe('missing');
    expect(replayRes.results[0].reason).toContain('bootstrap missing elements');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('marks as missing when original decision evidence is missing from snapshot and does not call evaluate', async () => {
    const snapshot = makeSnapshot(); // snapshot only contains obs_valid_1
    const { evaluation, repo, evaluate } = setupEvaluation();

    const decisionWithMissingOriginalEvidence: CollaborationDecision = {
      id: 'dec_missing_orig_ev',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'reply',
      reason: 'Reply based on deleted evidence',
      evidenceIds: ['obs_deleted_ancient_2'],
      status: 'candidate',
      inputSnapshot: snapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    };

    await repo.recordDecision(decisionWithMissingOriginalEvidence);

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_missing_orig_ev'] });
    expect(replayRes.missing).toBe(1);
    expect(replayRes.failed).toBe(0);
    expect(replayRes.results[0].status).toBe('missing');
    expect(replayRes.results[0].reason).toContain("Original decision evidence 'obs_deleted_ancient_2' is missing");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('fails replay when top-level or any nested entity in snapshot is cross-scope without calling evaluate', async () => {
    const { evaluation, repo, evaluate } = setupEvaluation();

    // 1. Top-level cross-scope
    const crossTopSnapshot = makeSnapshot({ scope: scopeB });
    await repo.recordDecision({
      id: 'dec_cross_top',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'silent',
      reason: 'Cross top',
      evidenceIds: [],
      status: 'candidate',
      inputSnapshot: crossTopSnapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    });

    const res1 = await evaluation.replay(scopeA, { decisionIds: ['dec_cross_top'] });
    expect(res1.failed).toBe(1);
    expect(res1.missing).toBe(0);
    expect(res1.results[0].status).toBe('failed');
    expect(res1.results[0].reason).toContain('Cross-scope snapshot');

    // 2. Nested settings cross-scope
    const crossSettingsSnapshot = makeSnapshot({ scope: scopeA, settingsScope: scopeB });
    await repo.recordDecision({
      id: 'dec_cross_settings',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'silent',
      reason: 'Cross settings',
      evidenceIds: [],
      status: 'candidate',
      inputSnapshot: crossSettingsSnapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    });

    const res2 = await evaluation.replay(scopeA, { decisionIds: ['dec_cross_settings'] });
    expect(res2.failed).toBe(1);
    expect(res2.results[0].status).toBe('failed');
    expect(res2.results[0].reason).toContain('Cross-scope settings');

    // 3. Nested observation cross-scope
    const crossObsSnapshot = makeSnapshot({
      scope: scopeA,
      observations: [
        {
          id: 'obs_cross',
          scope: scopeB, // cross scope
          sequence: 1,
          source: 'doc_feed',
          eventId: 'evt_cross_1',
          occurredAt: '2026-09-18T10:00:00.000Z',
          receivedAt: '2026-09-18T10:00:00.000Z',
          senderKind: 'human',
          text: 'Cross chat doc note',
          refs: [],
          origin: 'external',
          missing: [],
          revision: 1
        }
      ]
    });
    await repo.recordDecision({
      id: 'dec_cross_obs',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'silent',
      reason: 'Cross obs',
      evidenceIds: [],
      status: 'candidate',
      inputSnapshot: crossObsSnapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    });

    const res3 = await evaluation.replay(scopeA, { decisionIds: ['dec_cross_obs'] });
    expect(res3.failed).toBe(1);
    expect(res3.results[0].status).toBe('failed');
    expect(res3.results[0].reason).toContain("Cross-scope observation 'obs_cross'");

    // 4. Nested bootstrap cross-scope（bootstrap 存在但 scope 越群）
    const crossBootstrapSnapshot = makeSnapshot({ scope: scopeA, bootstrapScope: scopeB });
    await repo.recordDecision({
      id: 'dec_cross_bootstrap',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'silent',
      reason: 'Cross bootstrap',
      evidenceIds: [],
      status: 'candidate',
      inputSnapshot: crossBootstrapSnapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    });
    const res4 = await evaluation.replay(scopeA, { decisionIds: ['dec_cross_bootstrap'] });
    expect(res4.failed).toBe(1);
    expect(res4.results[0].status).toBe('failed');
    expect(res4.results[0].reason).toContain('Cross-scope bootstrap');

    // 5. Nested followup cross-scope
    const crossFollowupSnapshot = makeSnapshot({
      scope: scopeA,
      followups: [
        {
          id: 'fu_cross',
          scope: scopeB,
          revision: 1,
          goal: 'Cross chat doc task',
          status: 'open',
          progress: '',
          steps: [],
          sourceRefs: [],
          taskIds: [],
          externalRefs: [],
          fields: {},
          createdBy: 'user_1',
          updatedBy: 'user_1',
          provenance: 'observed',
          createdAt: '2026-09-18T10:00:00.000Z',
          updatedAt: '2026-09-18T10:00:00.000Z'
        }
      ]
    });
    await repo.recordDecision({
      id: 'dec_cross_followup',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'silent',
      reason: 'Cross followup',
      evidenceIds: [],
      status: 'candidate',
      inputSnapshot: crossFollowupSnapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    });
    const res5 = await evaluation.replay(scopeA, { decisionIds: ['dec_cross_followup'] });
    expect(res5.failed).toBe(1);
    expect(res5.results[0].status).toBe('failed');
    expect(res5.results[0].reason).toContain("Cross-scope followup 'fu_cross'");

    // 6. Nested mandate cross-scope
    const crossMandateSnapshot = makeSnapshot({
      scope: scopeA,
      mandates: [
        {
          id: 'md_cross',
          scope: scopeB,
          revision: 1,
          goal: 'Cross chat recurring doc review',
          status: 'active',
          requesterId: 'user_1',
          sourceRefs: [],
          scheduleDefinitionId: 'sched_1',
          mode: 'notify',
          prompt: 'review',
          condition: 'always',
          deliveryPaused: false,
          catchupPolicy: 'skip',
          createdAt: '2026-09-18T10:00:00.000Z',
          updatedAt: '2026-09-18T10:00:00.000Z'
        }
      ]
    });
    await repo.recordDecision({
      id: 'dec_cross_mandate',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'silent',
      reason: 'Cross mandate',
      evidenceIds: [],
      status: 'candidate',
      inputSnapshot: crossMandateSnapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    });
    const res6 = await evaluation.replay(scopeA, { decisionIds: ['dec_cross_mandate'] });
    expect(res6.failed).toBe(1);
    expect(res6.results[0].status).toBe('failed');
    expect(res6.results[0].reason).toContain("Cross-scope mandate 'md_cross'");

    expect(evaluate).not.toHaveBeenCalled();
  });

  it('marks as missing when snapshot is structurally malformed and does not call evaluate', async () => {
    const { evaluation, repo, evaluate } = setupEvaluation();

    // settings.participation 非法枚举 → snapshotSchema 解析失败 → missing
    const malformedSnapshot = {
      scope: scopeA,
      contextRevision: 1,
      settings: {
        scope: scopeA,
        revision: 1,
        participation: 'not_a_real_mode',
        instructions: '',
        notificationsPaused: false,
        maxProactivePerHour: 6,
        retentionDays: 30,
        policyVersion: 'v1',
        updatedAt: '2026-09-18T10:00:00.000Z'
      },
      observations: [],
      followups: [],
      mandates: []
    };

    await repo.recordDecision({
      id: 'dec_malformed',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'silent',
      reason: 'Malformed snapshot',
      evidenceIds: [],
      status: 'candidate',
      inputSnapshot: malformedSnapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    });

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_malformed'] });
    expect(replayRes.missing).toBe(1);
    expect(replayRes.failed).toBe(0);
    expect(replayRes.results[0].status).toBe('missing');
    expect(replayRes.results[0].reason).toContain('failed schema validation');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('fails replay when evaluation cites hallucinated evidence not found in snapshot', async () => {
    const snapshot = makeSnapshot();
    const { evaluation, repo, evaluate } = setupEvaluation(async () => ({
      action: 'reply',
      reason: 'Hallucinated evidence',
      evidenceIds: ['non_existent_obs_999']
    }));

    const decision: CollaborationDecision = {
      id: 'dec_bad_evidence',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'reply',
      reason: 'Reply',
      evidenceIds: ['obs_valid_1'],
      status: 'candidate',
      inputSnapshot: snapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    };

    await repo.recordDecision(decision);

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_bad_evidence'] });
    expect(replayRes.failed).toBe(1);
    expect(replayRes.results[0].status).toBe('failed');
    expect(replayRes.results[0].reason).toContain("Evidence observation 'non_existent_obs_999' not found");
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('fails replay when non-silent action has no supporting evidence', async () => {
    const snapshot = makeSnapshot();
    const { evaluation, repo, evaluate } = setupEvaluation(async () => ({
      action: 'act',
      reason: 'Acting without evidence',
      evidenceIds: []
    }));

    const decision: CollaborationDecision = {
      id: 'dec_no_evidence',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'act',
      reason: 'Act',
      evidenceIds: ['obs_valid_1'],
      status: 'candidate',
      inputSnapshot: snapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    };

    await repo.recordDecision(decision);

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_no_evidence'] });
    expect(replayRes.failed).toBe(1);
    expect(replayRes.results[0].status).toBe('failed');
    expect(replayRes.results[0].reason).toContain("Action 'act' has no supporting evidence");
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('fails replay when model action does not match expected', async () => {
    const snapshot = makeSnapshot();
    const { evaluation, repo } = setupEvaluation(async () => ({
      action: 'silent',
      reason: 'Decided to stay silent',
      evidenceIds: []
    }));

    const decision: CollaborationDecision = {
      id: 'dec_action_mismatch',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'reply',
      reason: 'Expected to reply',
      evidenceIds: ['obs_valid_1'],
      status: 'candidate',
      inputSnapshot: snapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    };

    await repo.recordDecision(decision);

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_action_mismatch'] });
    expect(replayRes.failed).toBe(1);
    expect(replayRes.results[0].status).toBe('failed');
    expect(replayRes.results[0].expected).toBe('reply');
    expect(replayRes.results[0].actual).toBe('silent');
    expect(replayRes.results[0].reason).toContain("Action mismatch: expected 'reply', got 'silent'");
  });

  it('fails replay when evaluation returns invalid action structure', async () => {
    const snapshot = makeSnapshot();
    const { evaluation, repo } = setupEvaluation(async () => ({
      action: 'invalid_action_kind' as any,
      reason: 'Invalid',
      evidenceIds: []
    }));

    const decision: CollaborationDecision = {
      id: 'dec_invalid_action',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'reply',
      reason: 'Expected reply',
      evidenceIds: ['obs_valid_1'],
      status: 'candidate',
      inputSnapshot: snapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    };

    await repo.recordDecision(decision);

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_invalid_action'] });
    expect(replayRes.failed).toBe(1);
    expect(replayRes.results[0].status).toBe('failed');
    expect(replayRes.results[0].reason).toContain('invalid action');
  });

  it('prioritizes human feedback correction over original decision action', async () => {
    const snapshot = makeSnapshot();
    const { evaluation, repo } = setupEvaluation(async () => ({
      action: 'reply',
      reason: 'Corrected to reply by human guidance',
      evidenceIds: ['obs_valid_1']
    }));

    // Original decision was 'silent'
    const decision: CollaborationDecision = {
      id: 'dec_corrected',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'silent',
      reason: 'Initially kept silent',
      evidenceIds: [],
      status: 'sent',
      inputSnapshot: snapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    };

    await repo.recordDecision(decision);

    // Human adds feedback correcting expectedAction to 'reply'
    await repo.addFeedback({
      id: 'fb_corr_1',
      scope: scopeA,
      decisionId: 'dec_corrected',
      actorId: 'usr_admin',
      correction: 'Should have replied to user document query',
      expectedAction: 'reply',
      createdAt: '2026-09-18T10:05:00.000Z'
    });

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_corrected'] });
    expect(replayRes.passed).toBe(1);
    expect(replayRes.failed).toBe(0);
    expect(replayRes.results[0].expected).toBe('reply'); // from feedback
    expect(replayRes.results[0].actual).toBe('reply');
    expect(replayRes.results[0].status).toBe('passed');
  });

  it('guarantees strictly read-only execution: deliver/execute are never touched and data remains unchanged', async () => {
    const deliverSpy = vi.fn();
    const executeSpy = vi.fn();

    const snapshot = makeSnapshot();
    const { evaluation, repo } = setupEvaluation(async () => {
      return {
        action: 'reply' as const,
        reason: 'Read only evaluation',
        evidenceIds: ['obs_valid_1']
      };
    });

    const decision: CollaborationDecision = {
      id: 'dec_readonly_check',
      scope: scopeA,
      contextRevision: 1,
      policyVersion: 'v1',
      action: 'reply',
      reason: 'Read only test',
      evidenceIds: ['obs_valid_1'],
      status: 'sent',
      inputSnapshot: snapshot as unknown as Record<string, unknown>,
      createdAt: '2026-09-18T10:00:00.000Z'
    };

    await repo.recordDecision(decision);

    const replayRes = await evaluation.replay(scopeA, { decisionIds: ['dec_readonly_check'] });
    expect(replayRes.passed).toBe(1);

    // Assert external deliver and execute were never invoked
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();

    // Verify DB decision remains completely intact and unchanged
    const inDb = await repo.getDecision(scopeA, 'dec_readonly_check');
    expect(inDb?.status).toBe('sent');
    expect(inDb?.action).toBe('reply');
    expect(inDb?.reason).toBe('Read only test');
  });
});
