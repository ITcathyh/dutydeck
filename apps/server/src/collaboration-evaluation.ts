import {
  collaborationSnapshotSchema,
  type CollaborationRepository,
  type CollaborationScope,
  type CollaborationSnapshot,
  type DecisionAction
} from '@dutydeck/shared';

export interface CollaborationEvaluationOptions {
  repository: CollaborationRepository;
  evaluate: (
    snapshot: CollaborationSnapshot,
    policyVersion: string
  ) => Promise<{
    action: DecisionAction;
    reason: string;
    evidenceIds: string[];
  }>;
  /** 接受以对齐统一构造签名；纯只读回放不产生时间戳，当前未使用。 */
  now?: () => Date;
}

export interface ReplayOptions {
  decisionIds: string[];
  policyVersion?: string;
}

export interface ReplayItemResult {
  decisionId: string;
  status: 'passed' | 'failed' | 'missing';
  expected?: DecisionAction;
  actual?: DecisionAction;
  reason: string;
}

export interface ReplayResult {
  results: ReplayItemResult[];
  passed: number;
  failed: number;
  missing: number;
}

const VALID_DECISION_ACTIONS = new Set<DecisionAction>(['silent', 'reply', 'act']);

function sameScope(target: CollaborationScope, actual?: CollaborationScope | null): boolean {
  return !!actual && actual.appId === target.appId && actual.chatId === target.chatId;
}

/**
 * 本群实体严格同 scope；团队材料只能来自同 app、已列明的来源群。
 */
function findCrossScopeReason(scope: CollaborationScope, snapshot: CollaborationSnapshot): string | undefined {
  if (!sameScope(scope, snapshot.scope)) {
    return 'Cross-scope snapshot detected';
  }
  if (!sameScope(scope, snapshot.settings.scope)) {
    return 'Cross-scope settings detected in snapshot';
  }
  if (snapshot.bootstrap && !sameScope(scope, snapshot.bootstrap.scope)) {
    return 'Cross-scope bootstrap detected in snapshot';
  }
  for (const observation of snapshot.observations) {
    if (!sameScope(scope, observation.scope)) {
      return `Cross-scope observation '${observation.id}' detected in snapshot`;
    }
  }
  for (const followup of snapshot.followups) {
    if (!sameScope(scope, followup.scope)) {
      return `Cross-scope followup '${followup.id}' detected in snapshot`;
    }
  }
  for (const mandate of snapshot.mandates) {
    if (!sameScope(scope, mandate.scope)) {
      return `Cross-scope mandate '${mandate.id}' detected in snapshot`;
    }
  }
  const team = snapshot.teamContext;
  if (team) {
    if (team.sources.some(source => source.scope.appId !== scope.appId)) return 'Cross-app team source detected in snapshot';
    const ids = new Set(snapshot.observations.map(item => item.id));
    for (const item of team.observations) {
      if (item.scope.appId !== scope.appId || !team.sources.some(source => sameScope(source.scope, item.scope))) {
        return `Unlisted team observation scope '${item.id}' detected in snapshot`;
      }
      if (ids.has(item.id)) return `Duplicate team evidence '${item.id}' detected in snapshot`;
      ids.add(item.id);
      if (item.source !== 'lark.message' && !(['lark.team.followup', 'lark.team.memory'].includes(item.source) && item.origin === 'external')) {
        return `Invalid team observation source or origin '${item.id}' detected in snapshot`;
      }
    }
  }
  return undefined;
}

export class CollaborationEvaluation {
  private readonly repository: CollaborationRepository;
  private readonly evaluate: (
    snapshot: CollaborationSnapshot,
    policyVersion: string
  ) => Promise<{
    action: DecisionAction;
    reason: string;
    evidenceIds: string[];
  }>;

  constructor(options: CollaborationEvaluationOptions) {
    this.repository = options.repository;
    this.evaluate = options.evaluate;
  }

  async replay(scope: CollaborationScope, options: ReplayOptions): Promise<ReplayResult> {
    const results: ReplayItemResult[] = [];
    let passed = 0;
    let failed = 0;
    let missing = 0;

    const mark = (
      item: ReplayItemResult,
      bucket: 'passed' | 'failed' | 'missing'
    ): void => {
      results.push(item);
      if (bucket === 'passed') passed++;
      else if (bucket === 'failed') failed++;
      else missing++;
    };

    for (const decisionId of options.decisionIds) {
      // 1. 原决策不存在 → missing，且不调用 evaluate
      const decision = await this.repository.getDecision(scope, decisionId);
      if (!decision) {
        mark(
          { decisionId, status: 'missing', reason: `Decision '${decisionId}' not found in scope` },
          'missing'
        );
        continue;
      }

      // 人工反馈 latest.expectedAction 优先，否则原 decision.action
      const feedbacks = await this.repository.listFeedback(scope, decisionId);
      const latestCorrection = [...feedbacks].reverse().find(f => f.expectedAction !== undefined);
      const expected: DecisionAction = latestCorrection?.expectedAction ?? decision.action;

      // 2. inputSnapshot 缺失 → missing（主控拍板：inputSnapshot 直接就是 snapshot）
      const rawSnapshot = decision.inputSnapshot as unknown;
      if (!rawSnapshot || typeof rawSnapshot !== 'object') {
        mark(
          { decisionId, status: 'missing', expected, reason: 'Missing inputSnapshot in decision' },
          'missing'
        );
        continue;
      }

      const snapshotData = rawSnapshot as Record<string, unknown>;

      // 关键字段缺失 → missing，保留具体 reason，不调用 evaluate
      if (!snapshotData.settings || !Array.isArray(snapshotData.observations)) {
        mark(
          {
            decisionId,
            status: 'missing',
            expected,
            reason: 'Missing settings or observations array in decision snapshot'
          },
          'missing'
        );
        continue;
      }

      // 3. shared snapshotSchema 安全解析：结构/字段残缺或非法属历史材料不足 → missing
      const parseResult = collaborationSnapshotSchema.safeParse(snapshotData);
      if (!parseResult.success) {
        mark(
          {
            decisionId,
            status: 'missing',
            expected,
            reason: `Decision snapshot failed schema validation: ${parseResult.error.issues[0]?.message ?? 'invalid snapshot'}`
          },
          'missing'
        );
        continue;
      }
      const snapshot = parseResult.data;

      // 4. 顶层及全部嵌套实体 scope 校验：任何跨 scope → failed，不调用 evaluate
      const crossScopeReason = findCrossScopeReason(scope, snapshot);
      if (crossScopeReason) {
        mark({ decisionId, status: 'failed', expected, reason: crossScopeReason }, 'failed');
        continue;
      }

      // 5. 历史材料缺失检查 → missing，不调用 evaluate
      if (snapshot.bootstrap?.missing && snapshot.bootstrap.missing.length > 0) {
        mark(
          {
            decisionId,
            status: 'missing',
            expected,
            reason: `Snapshot contains bootstrap missing elements: ${snapshot.bootstrap.missing.join(', ')}`
          },
          'missing'
        );
        continue;
      }

      const teamGap = snapshot.teamContext?.sources.find(source => source.status !== 'complete' || source.missing.length);
      if (teamGap) {
        mark({ decisionId, status: 'missing', expected, reason: `Team source '${teamGap.scope.chatId}' contains missing elements: ${teamGap.missing.join(', ') || teamGap.status}` }, 'missing');
        continue;
      }
      const observations = [...snapshot.observations, ...(snapshot.teamContext?.observations ?? [])];
      const observationMap = new Map(observations.map(obs => [obs.id, obs]));

      // 任一 observation.missing 非空即材料不足（即使本次模型选 silent 或未引用该条）
      const obsWithMissing = observations.find(obs => obs.missing && obs.missing.length > 0);
      if (obsWithMissing) {
        mark(
          {
            decisionId,
            status: 'missing',
            expected,
            reason: `Observation '${obsWithMissing.id}' contains missing elements: ${obsWithMissing.missing.join(', ')}`
          },
          'missing'
        );
        continue;
      }

      // 原 decision.evidenceIds 引用材料缺失 → missing
      let missingOriginalEvidenceId: string | undefined;
      for (const evId of decision.evidenceIds ?? []) {
        const obs = observationMap.get(evId);
        if (!obs || (obs.missing && obs.missing.length > 0)) {
          missingOriginalEvidenceId = evId;
          break;
        }
      }
      if (missingOriginalEvidenceId) {
        mark(
          {
            decisionId,
            status: 'missing',
            expected,
            reason: `Original decision evidence '${missingOriginalEvidenceId}' is missing from snapshot`
          },
          'missing'
        );
        continue;
      }

      // 6. 材料完整，调用只读 evaluate 回调
      const targetPolicyVersion = options.policyVersion || snapshot.settings.policyVersion || 'v1';

      let actualOutcome: { action: DecisionAction; reason: string; evidenceIds: string[] };
      try {
        actualOutcome = await this.evaluate(snapshot, targetPolicyVersion);
      } catch (err: unknown) {
        mark(
          {
            decisionId,
            status: 'failed',
            expected,
            reason: `Evaluation error: ${err instanceof Error ? err.message : String(err)}`
          },
          'failed'
        );
        continue;
      }

      // 7. 模型返回结果有效性：非法结果 failed
      if (!actualOutcome || typeof actualOutcome !== 'object') {
        mark(
          { decisionId, status: 'failed', expected, reason: 'Evaluation returned invalid result' },
          'failed'
        );
        continue;
      }

      if (!VALID_DECISION_ACTIONS.has(actualOutcome.action)) {
        mark(
          {
            decisionId,
            status: 'failed',
            expected,
            reason: `Evaluation returned invalid action '${String(actualOutcome.action)}'`
          },
          'failed'
        );
        continue;
      }

      if (typeof actualOutcome.reason !== 'string') {
        mark(
          {
            decisionId,
            status: 'failed',
            expected,
            actual: actualOutcome.action,
            reason: 'Evaluation returned non-string reason'
          },
          'failed'
        );
        continue;
      }

      if (!Array.isArray(actualOutcome.evidenceIds)) {
        mark(
          {
            decisionId,
            status: 'failed',
            expected,
            actual: actualOutcome.action,
            reason: 'Evaluation did not return valid evidenceIds array'
          },
          'failed'
        );
        continue;
      }

      // 完整材料时非 silent 无证据 → failed（不把模型无证据变绿）
      if (actualOutcome.action !== 'silent' && actualOutcome.evidenceIds.length === 0) {
        mark(
          {
            decisionId,
            status: 'failed',
            expected,
            actual: actualOutcome.action,
            reason: `Action '${actualOutcome.action}' has no supporting evidence`
          },
          'failed'
        );
        continue;
      }

      // 模型引用不存在的证据（幻觉） → failed
      const hallucinatedEvidenceId = actualOutcome.evidenceIds.find(evId => !observationMap.has(evId));
      if (hallucinatedEvidenceId) {
        mark(
          {
            decisionId,
            status: 'failed',
            expected,
            actual: actualOutcome.action,
            reason: `Evidence observation '${hallucinatedEvidenceId}' not found in snapshot`
          },
          'failed'
        );
        continue;
      }

      // 动作不符 → failed
      if (actualOutcome.action !== expected) {
        mark(
          {
            decisionId,
            status: 'failed',
            expected,
            actual: actualOutcome.action,
            reason: `Action mismatch: expected '${expected}', got '${actualOutcome.action}' (${actualOutcome.reason})`
          },
          'failed'
        );
        continue;
      }

      // 动作一致且证据充分合法 → passed
      mark(
        {
          decisionId,
          status: 'passed',
          expected,
          actual: actualOutcome.action,
          reason: actualOutcome.reason
        },
        'passed'
      );
    }

    return { results, passed, failed, missing };
  }
}
