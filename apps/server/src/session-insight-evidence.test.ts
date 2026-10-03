import { describe, expect, it } from 'vitest';
import {
  hostEvidenceSnapshotSchema,
  SESSION_INSIGHT_LIMITS,
  type AcceptedTask,
  type ExecutionTask,
  type TaskExecutionProjection,
  type UsageLedgerEntry,
  type VerificationResponse
} from '@dutydeck/shared';
import {
  buildHostEvidenceSnapshot,
  computeHostEvidenceDigest,
  type HostEvidenceInput
} from './session-insight-evidence.js';
import { SecurityRedactionError, type RedactionContext } from './session-insight-redaction.js';

const SESSION = 'ses_1';
const PRIVATE_ROOT = '/srv/dutydeck/private';
const context: RedactionContext = { canaryPaths: [PRIVATE_ROOT] };

function task(id: string, patch: Partial<ExecutionTask> = {}): ExecutionTask {
  return {
    id,
    sessionId: SESSION,
    prompt: `goal of ${id}`,
    status: 'running',
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    revision: 1,
    digestVersion: 'v1',
    ...patch
  };
}

function execution(
  t: ExecutionTask,
  patch: Partial<TaskExecutionProjection> = {}
): TaskExecutionProjection {
  return { task: t, attempts: [], blockers: [], ...patch };
}

function steering(
  steeringTaskId: string,
  targetTaskId: string,
  targetAttemptId: string,
  state: 'pending' | 'unknown' | 'delivered' | 'not_delivered' | 'abandoned',
  updatedAt = '2026-10-03T00:01:00.000Z'
): TaskExecutionProjection['steering'] {
  return {
    operationId: `steer_${steeringTaskId}`,
    sessionId: SESSION,
    runId: 'run_1',
    taskId: steeringTaskId,
    target: { taskId: targetTaskId, attemptId: targetAttemptId },
    actor: { kind: 'installation_owner', id: 'installation_owner' },
    controller: { accessId: 'a', instanceId: 'i', generation: 1 },
    state,
    revision: 2,
    createdAt: '2026-10-03T00:00:30.000Z',
    updatedAt
  };
}

function acceptedV2(id: string, model: string | undefined): AcceptedTask {
  return {
    task: task(id, { status: 'completed' }),
    replayValidation: 'complete',
    input: {
      version: 2,
      prompt: `goal of ${id}`,
      executionContext: { agentPrompt: `goal of ${id}` },
      contentSources: [],
      digest: 'a'.repeat(64),
      executionOptions: {
        ...(model ? { model } : {}),
        permissionMode: 'full-trust'
      }
    }
  };
}

function verification(
  id: string,
  patch: Partial<VerificationResponse> = {}
): VerificationResponse {
  return {
    schemaVersion: 1,
    revision: 1,
    id,
    sessionId: SESSION,
    taskId: `task_${id}`,
    command: 'npm test',
    cwd: '/workspace',
    status: 'passed',
    startedAt: '2026-10-03T00:02:00.000Z',
    output: '',
    outputTruncated: false,
    stale: false,
    ...patch
  };
}

function usage(id: string, patch: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  return {
    id,
    recordedAt: '2026-10-03T00:03:00.000Z',
    sessionId: SESSION,
    taskId: 'task_a',
    attemptId: 'att_1',
    category: 'explicit',
    origin: 'web',
    agentId: 'agent_1',
    costEstimated: false,
    dataStatus: 'estimated',
    costUsd: 0.01,
    ...patch
  };
}

function input(patch: Partial<HostEvidenceInput> = {}): HostEvidenceInput {
  return {
    capturedAt: '2026-10-03T00:05:00.000Z',
    executions: [execution(task('task_a'))],
    ...patch
  };
}

describe('buildHostEvidenceSnapshot 基本投影与 schema', () => {
  it('目标 / steering / 验证 / 模型 / 费用投影齐全且通过严格 schema', () => {
    const target = task('task_a', { currentAttemptId: 'att_1' });
    const steerTask = task('task_steer', { status: 'completed' });
    const snapshot = buildHostEvidenceSnapshot(
      {
        capturedAt: '2026-10-03T00:05:00.000Z',
        executions: [
          execution(steerTask, { steering: steering('task_steer', 'task_a', 'att_1', 'delivered') }),
          execution(target)
        ],
        accepted: [acceptedV2('task_a', 'frozen-model-x')],
        verifications: [verification('v1')],
        usageEntries: [usage('u1')]
      },
      context
    );

    expect(() => hostEvidenceSnapshotSchema.parse(snapshot)).not.toThrow();

    // 目标按 createdAt,id 稳定排序，attemptId 取冻结 currentAttemptId。
    expect(snapshot.taskGoals.map(g => g.taskId)).toEqual(['task_a', 'task_steer']);
    expect(snapshot.taskGoals[0]!.attemptId).toBe('att_1');

    // steering 保留真实 target task/attempt；delivered 只是投递完成。
    expect(snapshot.steeringRelations).toEqual([
      {
        steeringTaskId: 'task_steer',
        targetTaskId: 'task_a',
        targetAttemptId: 'att_1',
        completed: true
      }
    ]);

    // 验证来自真实记录字段。
    expect(snapshot.verificationSnapshot[0]).toMatchObject({
      taskId: 'task_v1',
      passed: true,
      stale: false,
      attemptId: null
    });

    // 模型配置来自 accepted 冻结输入，不是 session 当前模型。
    expect(snapshot.modelConfigs).toEqual([
      { taskId: 'task_a', attemptId: null, configuredModel: 'frozen-model-x' }
    ]);

    // 费用投影 recordedAt 范围独立，不另造合计口径。
    expect(snapshot.usageLedgerProjection).toMatchObject({
      recordedAtRange: {
        start: '2026-10-03T00:03:00.000Z',
        end: '2026-10-03T00:03:00.000Z'
      },
      totalCostEstimate: 0.01,
      currency: 'USD',
      hasUnpricedUsage: false
    });
  });

  it('steering 未投递时 completed=false，且不产生任何独立成功字段', () => {
    const snapshot = buildHostEvidenceSnapshot(
      input({
        executions: [
          execution(task('task_steer'), {
            steering: steering('task_steer', 'task_a', 'att_1', 'not_delivered')
          })
        ]
      })
    );
    expect(snapshot.steeringRelations[0]!.completed).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('modelSuccess');
  });
});

describe('digest 稳定性', () => {
  const baseline = input({
    accepted: [acceptedV2('task_a', 'm1')],
    verifications: [verification('v1')],
    usageEntries: [usage('u1')]
  });

  it('capturedAt 改变但业务事实相同，digest 不变', () => {
    const a = buildHostEvidenceSnapshot({ ...baseline, capturedAt: '2026-10-03T00:05:00.000Z' });
    const b = buildHostEvidenceSnapshot({ ...baseline, capturedAt: '2026-10-03T09:00:00.000Z' });
    expect(a.digest).toBe(b.digest);
  });

  it('目标事实改变 digest 变', () => {
    const a = buildHostEvidenceSnapshot(baseline);
    const changed = input({
      ...baseline,
      executions: [execution(task('task_a', { prompt: 'changed goal' }))]
    });
    const b = buildHostEvidenceSnapshot(changed);
    expect(a.digest).not.toBe(b.digest);
  });

  it('模型配置事实改变 digest 变', () => {
    const a = buildHostEvidenceSnapshot(baseline);
    const b = buildHostEvidenceSnapshot({ ...baseline, accepted: [acceptedV2('task_a', 'm2')] });
    expect(a.digest).not.toBe(b.digest);
  });

  it('验证事实（passed/stale）改变 digest 变', () => {
    const a = buildHostEvidenceSnapshot(baseline);
    const b = buildHostEvidenceSnapshot({
      ...baseline,
      verifications: [verification('v1', { status: 'failed', passed: undefined } as never)]
    });
    expect(a.digest).not.toBe(b.digest);

    const c = buildHostEvidenceSnapshot({
      ...baseline,
      verifications: [verification('v1', { stale: true, staleReason: 'record_fingerprint_missing' })]
    });
    expect(a.digest).not.toBe(c.digest);
    expect(c.verificationSnapshot[0]!.stale).toBe(true);
  });

  it('费用事实改变 digest 变', () => {
    const a = buildHostEvidenceSnapshot(baseline);
    const b = buildHostEvidenceSnapshot({
      ...baseline,
      usageEntries: [usage('u1', { costUsd: 0.02 })]
    });
    expect(a.digest).not.toBe(b.digest);
  });

  it('executions / usage 数组输入顺序不同，事实投影相同则 digest 相同', () => {
    const other = execution(task('task_b', { createdAt: '2026-10-03T00:00:30.000Z' }));
    const first = execution(task('task_a'));
    const u1 = usage('u1', { recordedAt: '2026-10-03T00:03:00.000Z' });
    const u2 = usage('u2', { recordedAt: '2026-10-03T00:04:00.000Z' });

    const a = buildHostEvidenceSnapshot(
      input({ executions: [other, first], usageEntries: [u2, u1] })
    );
    const b = buildHostEvidenceSnapshot(
      input({ executions: [first, other], usageEntries: [u1, u2] })
    );
    expect(a.digest).toBe(b.digest);
    expect(a.taskGoals.map(g => g.taskId)).toEqual(['task_a', 'task_b']);
    expect(a.usageLedgerProjection!.recordedAtRange).toEqual({
      start: '2026-10-03T00:03:00.000Z',
      end: '2026-10-03T00:04:00.000Z'
    });
  });

  it('computeHostEvidenceDigest 不受对象键插入顺序影响', () => {
    const facts = {
      taskGoals: [],
      omittedGoalsCount: 0,
      steeringRelations: [],
      omittedSteeringCount: 0,
      verificationSnapshot: [],
      omittedVerificationsCount: 0,
      modelConfigs: [],
      omittedModelConfigsCount: 0
    };
    const reordered = {
      omittedModelConfigsCount: 0,
      modelConfigs: [],
      omittedVerificationsCount: 0,
      verificationSnapshot: [],
      omittedSteeringCount: 0,
      steeringRelations: [],
      omittedGoalsCount: 0,
      taskGoals: []
    };
    expect(computeHostEvidenceDigest(facts)).toBe(computeHostEvidenceDigest(reordered));
  });

  it('反例：仅被省略的旧目标变化、可见列表与计数完全不变时，digest 仍必须变化', () => {
    const baseMs = Date.parse('2026-10-03T00:00:00.000Z');
    const goalCount = 400;
    const buildExecutions = (oldestPrompt: string) =>
      Array.from({ length: goalCount }, (_, i) =>
        execution(
          task(`task_${String(i).padStart(4, '0')}`, {
            status: 'completed',
            createdAt: new Date(baseMs + i * 1000).toISOString(),
            // 最旧的 task_0000 会被限量省略（活跃/最新优先，它排最后）。
            prompt: i === 0 ? oldestPrompt : 'x'.repeat(1500)
          })
        )
      );

    const a = buildHostEvidenceSnapshot(input({ executions: buildExecutions('old version A') }), context);
    const b = buildHostEvidenceSnapshot(input({ executions: buildExecutions('old version B changed') }), context);

    // 两个快照都真的发生了 goal 省略。
    expect(a.omittedGoalsCount).toBeGreaterThan(0);
    expect(b.omittedGoalsCount).toBe(a.omittedGoalsCount);

    // 可见目标列表逐条完全一致（被改的旧目标在两侧都不可见）。
    expect(b.taskGoals).toEqual(a.taskGoals);
    expect(b.taskGoals.map(g => g.taskId)).not.toContain('task_0000');

    // 但 digest 必须捕捉到被省略事实的变化，否则 cache freshness 漏检。
    expect(b.digest).not.toBe(a.digest);
  });

  it('反例：被省略的验证状态变化、可见验证列表不变时 digest 变化', () => {
    const baseMs = Date.parse('2026-10-03T00:00:00.000Z');
    // 大量 ~3KiB 验证超过 96KiB 固定预算，最旧几条被省略。
    const buildVerifications = (oldestStatus: VerificationResponse['status']) =>
      Array.from({ length: 50 }, (_, i) =>
        verification(`v${i}`, {
          taskId: `task_${String(i).padStart(4, '0')}`,
          startedAt: new Date(baseMs + i * 1000).toISOString(),
          status: i === 0 ? oldestStatus : 'passed',
          error: 'e'.repeat(3000)
        })
      );

    const a = buildHostEvidenceSnapshot(input({ verifications: buildVerifications('passed') }), context);
    const b = buildHostEvidenceSnapshot(input({ verifications: buildVerifications('failed') }), context);

    expect(a.omittedVerificationsCount).toBeGreaterThan(0);
    expect(b.verificationSnapshot).toEqual(a.verificationSnapshot);
    expect(b.verificationSnapshot.map(v => v.taskId)).not.toContain('task_0000');
    expect(b.digest).not.toBe(a.digest);
  });

  it('无法关联任务的验证（forced omitted）变化也进入 digest', () => {
    const a = buildHostEvidenceSnapshot(
      input({ verifications: [verification('1', { taskId: undefined, status: 'passed' })] })
    );
    const b = buildHostEvidenceSnapshot(
      input({ verifications: [verification('1', { taskId: undefined, status: 'failed' })] })
    );
    expect(a.verificationSnapshot).toHaveLength(0);
    expect(b.verificationSnapshot).toHaveLength(0);
    expect(a.omittedVerificationsCount).toBe(1);
    expect(b.omittedVerificationsCount).toBe(1);
    expect(b.digest).not.toBe(a.digest);
  });
});

describe('验证语义', () => {
  it('只有 status=passed 才判定通过；prompt 中的 test 关键词无关', () => {
    const snapshot = buildHostEvidenceSnapshot(
      input({
        executions: [
          execution(task('task_a', { prompt: 'please run npm test and tell me' })),
          execution(task('task_b', { status: 'failed' }))
        ],
        verifications: [
          verification('1', { taskId: 'task_a', status: 'unverified' }),
          verification('2', { taskId: 'task_b', status: 'failed' })
        ]
      })
    );
    const byTask = Object.fromEntries(snapshot.verificationSnapshot.map(v => [v.taskId, v.passed]));
    expect(byTask).toEqual({ task_a: false, task_b: false });
  });

  it('stale / 缺 fingerprint 原样保留为未知风险，不当新鲜通过', () => {
    const snapshot = buildHostEvidenceSnapshot(
      input({
        verifications: [
          verification('1', { status: 'passed', stale: true, staleReason: 'code_changed' }),
          verification('2', {
            status: 'passed',
            stale: true,
            staleReason: 'record_fingerprint_missing'
          })
        ]
      })
    );
    for (const v of snapshot.verificationSnapshot) {
      expect(v.passed).toBe(true);
      expect(v.stale).toBe(true);
    }
  });

  it('无 taskId 的验证记录计入 omittedVerificationsCount', () => {
    const snapshot = buildHostEvidenceSnapshot(
      input({
        verifications: [verification('1', { taskId: undefined })]
      })
    );
    expect(snapshot.verificationSnapshot).toHaveLength(0);
    expect(snapshot.omittedVerificationsCount).toBe(1);
  });
});

describe('费用语义：未知不是 0', () => {
  it('有 token 但未计价：totalCostEstimate=null，不写 0', () => {
    const snapshot = buildHostEvidenceSnapshot(
      input({
        usageEntries: [
          usage('u1', {
            dataStatus: 'unpriced',
            costUsd: undefined,
            unpricedReason: 'unknown_model',
            inputTokens: 1000
          })
        ]
      })
    );
    expect(snapshot.usageLedgerProjection!.hasUnpricedUsage).toBe(true);
    expect(snapshot.usageLedgerProjection!.totalCostEstimate).toBeNull();
    expect(snapshot.usageLedgerProjection!.currency).toBeNull();
  });

  it('无用量行：不给 totalCostEstimate 键，与真实 0 区分', () => {
    const snapshot = buildHostEvidenceSnapshot(
      input({
        usageEntries: [usage('u1', { dataStatus: 'unavailable', costUsd: undefined })]
      })
    );
    expect('totalCostEstimate' in snapshot.usageLedgerProjection!).toBe(false);
    expect(snapshot.usageLedgerProjection!.hasUnpricedUsage).toBe(false);
  });

  it('空账本：范围两端为 null，无合计', () => {
    const snapshot = buildHostEvidenceSnapshot(input({ usageEntries: [] }));
    expect(snapshot.usageLedgerProjection!.recordedAtRange).toEqual({ start: null, end: null });
    expect('totalCostEstimate' in snapshot.usageLedgerProjection!).toBe(false);
  });

  it('部分计价部分未计价：整体合计未知', () => {
    const snapshot = buildHostEvidenceSnapshot(
      input({
        usageEntries: [
          usage('u1', { costUsd: 0.01 }),
          usage('u2', { dataStatus: 'unpriced', costUsd: undefined })
        ]
      })
    );
    expect(snapshot.usageLedgerProjection!.totalCostEstimate).toBeNull();
    expect(snapshot.usageLedgerProjection!.hasUnpricedUsage).toBe(true);
  });
});

describe('512 KiB 宿主证据限额与 omittedCounts', () => {
  const baseMs = Date.parse('2026-10-03T00:00:00.000Z');
  const goalCount = 400;

  function hugeInput(overwriteOldestGoalPrompt?: string) {
    const executions = Array.from({ length: goalCount }, (_, i) => {
      const t = task(`task_${String(i).padStart(4, '0')}`, {
        createdAt: new Date(baseMs + i * 1000).toISOString(),
        prompt:
          i === 0 && overwriteOldestGoalPrompt !== undefined
            ? overwriteOldestGoalPrompt
            : 'x'.repeat(1500)
      });
      // 前 30 个任务各自携带一条 steering，注入下一个任务（挂在执行投影上）。
      return i < 30
        ? execution(t, {
            steering: steering(
              `task_${String(i).padStart(4, '0')}`,
              `task_${String((i + 1) % goalCount).padStart(4, '0')}`,
              'att_target',
              'delivered',
              new Date(baseMs + i * 1000).toISOString()
            )
          })
        : execution(t);
    });
    // 每条验证带约 3 KiB 摘要，50 条（~150 KiB）必然超过其 96 KiB 固定预算。
    const verifications = Array.from({ length: 50 }, (_, i) =>
      verification(`v${i}`, {
        taskId: `task_${String(i).padStart(4, '0')}`,
        startedAt: new Date(baseMs + i * 1000).toISOString(),
        error: 'e'.repeat(3000)
      })
    );
    const accepted = Array.from({ length: 50 }, (_, i) =>
      acceptedV2(`task_${String(i).padStart(4, '0')}`, 'm')
    );
    return { executions, verifications, accepted };
  }

  it('巨大历史 goals 下三类关键证据仍非空，侧类超自身预算时独立省略，计数守恒', () => {
    const { executions, verifications, accepted } = hugeInput();
    const snapshot = buildHostEvidenceSnapshot(input({ executions, verifications, accepted }), context);

    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    expect(bytes).toBeLessThanOrEqual(SESSION_INSIGHT_LIMITS.maxHostEvidenceBytes);
    expect(() => hostEvidenceSnapshotSchema.parse(snapshot)).not.toThrow();

    // 计数守恒：保留 + 省略 = 输入总数。
    expect(snapshot.taskGoals.length + snapshot.omittedGoalsCount).toBe(goalCount);
    expect(snapshot.verificationSnapshot.length + snapshot.omittedVerificationsCount).toBe(50);
    expect(snapshot.modelConfigs.length + snapshot.omittedModelConfigsCount).toBe(50);
    expect(snapshot.steeringRelations.length + snapshot.omittedSteeringCount).toBe(30);

    // 新预算策略：即使 goals 巨大，verification/steering/model 仍保留非空关键证据。
    expect(snapshot.verificationSnapshot.length).toBeGreaterThan(0);
    expect(snapshot.steeringRelations.length).toBeGreaterThan(0);
    expect(snapshot.modelConfigs.length).toBeGreaterThan(0);

    // verification 自身（~150KiB）超过其 96KiB 固定预算，被独立限量并准确计数；
    // steering/model 体积小，应全部保留；goals 仍占大头且有省略。
    expect(snapshot.verificationSnapshot.length).toBeLessThan(50);
    expect(snapshot.omittedVerificationsCount).toBeGreaterThan(0);
    expect(snapshot.steeringRelations).toHaveLength(30);
    expect(snapshot.modelConfigs).toHaveLength(50);
    expect(snapshot.taskGoals.length).toBeGreaterThan(0);
    expect(snapshot.omittedGoalsCount).toBeGreaterThan(0);

    // 验证按最新开始优先：保留的是编号较大的（较新）验证，被省的是较旧的。
    const keptTaskIds = snapshot.verificationSnapshot.map(v => v.taskId);
    expect(keptTaskIds).toContain('task_0049');
    expect(keptTaskIds).not.toContain('task_0000');

    // goals 按最新优先：最新目标保留、最旧目标省略。
    const keptGoalIds = snapshot.taskGoals.map(g => g.taskId);
    expect(keptGoalIds).toContain(`task_${String(goalCount - 1).padStart(4, '0')}`);
    expect(keptGoalIds).not.toContain('task_0000');

    // 确定性：同样输入两次结果一致（digest 与各类条数相同）。
    const again = buildHostEvidenceSnapshot(input({ executions, verifications, accepted }), context);
    expect(again.digest).toBe(snapshot.digest);
    expect(again.taskGoals.length).toBe(snapshot.taskGoals.length);
    expect(again.verificationSnapshot.length).toBe(snapshot.verificationSnapshot.length);
  });

  it('当前活跃的旧目标即使不最新也被优先保留', () => {
    const executions = [
      // 旧但仍 running。
      execution(
        task('task_old_active', {
          status: 'running',
          createdAt: new Date(baseMs).toISOString(),
          prompt: 'x'.repeat(1500)
        })
      ),
      // 大量更新的已完成目标。
      ...Array.from({ length: goalCount - 1 }, (_, i) =>
        execution(
          task(`task_${String(i).padStart(4, '0')}`, {
            status: 'completed',
            createdAt: new Date(baseMs + (i + 1) * 1000).toISOString(),
            prompt: 'x'.repeat(1500)
          })
        )
      )
    ];
    const snapshot = buildHostEvidenceSnapshot(input({ executions }), context);
    expect(snapshot.omittedGoalsCount).toBeGreaterThan(0);
    expect(snapshot.taskGoals.map(g => g.taskId)).toContain('task_old_active');
  });

  it('小数据集零省略', () => {
    const snapshot = buildHostEvidenceSnapshot(
      input({
        verifications: [verification('1')],
        accepted: [acceptedV2('task_a', 'm1')]
      })
    );
    expect(snapshot.omittedGoalsCount).toBe(0);
    expect(snapshot.omittedVerificationsCount).toBe(0);
    expect(snapshot.omittedSteeringCount).toBe(0);
    expect(snapshot.omittedModelConfigsCount).toBe(0);
  });
});

describe('脱敏与限长', () => {
  it('goal 与验证摘要中的凭据和私有路径不泄露，且不超过 4 KiB', () => {
    const snapshot = buildHostEvidenceSnapshot(
      input({
        executions: [
          execution(
            task('task_a', {
              prompt: `fix host ${PRIVATE_ROOT}/x authorization: Bearer goalsecret`
            })
          )
        ],
        verifications: [
          verification('1', {
            command: `npm test --token cmdsecret`,
            error: `failed reading ${PRIVATE_ROOT}/log`
          })
        ]
      }),
      context
    );
    const serialized = JSON.stringify(snapshot);
    for (const leak of ['goalsecret', 'cmdsecret', PRIVATE_ROOT, 'huang']) {
      expect(serialized).not.toContain(leak);
    }
    for (const goal of snapshot.taskGoals) {
      expect(Buffer.byteLength(goal.goal, 'utf8')).toBeLessThanOrEqual(4096);
    }
  });

  it('长 goal 先脱敏后截取', () => {
    const snapshot = buildHostEvidenceSnapshot(
      input({
        executions: [
          execution(task('task_a', { prompt: 'authorization: Bearer ' + 's'.repeat(5000) }))
        ]
      }),
      context
    );
    expect(Buffer.byteLength(snapshot.taskGoals[0]!.goal, 'utf8')).toBeLessThanOrEqual(4096);
    expect(snapshot.taskGoals[0]!.goal).not.toContain('s'.repeat(100));
  });

  it('identity 含私有路径 canary 或凭据时拒绝发布', () => {
    expect(() =>
      buildHostEvidenceSnapshot(
        input({ executions: [execution(task(`${PRIVATE_ROOT}/bad`))] }),
        context
      )
    ).toThrow(/would rewrite/);
    expect(() =>
      buildHostEvidenceSnapshot(
        input({ executions: [execution(task('task_a', { currentAttemptId: 'token=LEAK' }))] }),
        context
      )
    ).toThrow(SecurityRedactionError);
  });
});
