import { RuntimeError, type ExecutionActor, type UnknownTaskAction, type UnknownTaskFacts, type UnknownTaskResolution } from '@dutydeck/shared';

// 结果未知（reconcile_required）的任务由请求人或管理员在飞书卡片、Web 上处理：重新执行、标为已完成、标为失败。
// 两端共用这里的决定编号、处理记录和事实摘要（按钮文字与重复执行提醒在 @dutydeck/shared）；状态迁移由运行时 resolveUnknownTask 在账本里完成。

export type UnknownTaskOperator = { channel: 'lark' | 'web'; id: string };
export interface UnknownTaskRuntime {
  inspectUnknownTask(id: string, taskId: string, target?: string): Promise<UnknownTaskFacts>;
  resolveUnknownTask(id: string, input: UnknownTaskResolution, actor: ExecutionActor): Promise<{ replayed: boolean; task: { id: string; status: string } }>;
}

/** 账本里人工决定一律记为安装者（与 `dutydeck recovery` 同一身份），真正的操作人写进决定编号和证据。 */
const installationOwner = { kind: 'installation_owner', id: 'installation_owner' } as const;

const doneLabels: Record<UnknownTaskAction | 'other', string> = { retry: '已重新执行', completed: '已标为已完成', failed: '已标为失败', other: '已按结果未知处理' };

/** 决定编号：目标 + 动作 + 操作人。同一人同一动作的重复提交（重复回调、重启后重放）只回放。 */
export const unknownTaskDecisionId = (target: string, action: UnknownTaskAction, operator: UnknownTaskOperator) =>
  `manual:${target}:${action}:${operator.channel}:${operator.id}`;

/** 从决定编号读回操作人；不是这里生成的编号（管理员命令、飞书「放弃」等）返回 undefined。 */
export function unknownTaskDecisionOperator(decisionId: string): UnknownTaskOperator | undefined {
  if (!decisionId.startsWith('manual:')) return undefined;
  const parts = decisionId.split(':');
  const [channel, id] = parts.slice(-2);
  return parts.length >= 5 && (channel === 'lark' || channel === 'web') && id ? { channel, id } : undefined;
}

/** 与飞书卡片上的截止时间同一写法。 */
export const formatUnknownTaskTime = (value: string | Date) => `${new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`;
const operatorText = (operator: UnknownTaskOperator, mention: boolean) =>
  operator.channel === 'web' ? 'Web 管理员' : mention ? `<at id=${operator.id}></at>` : `飞书用户 ${operator.id}`;

/** 处理记录：谁、什么时候、做了什么。mention 为真时飞书用户写成 @，卡片上显示名字；不是这里记下的决定（管理员命令等）只写时间。 */
export function describeUnknownTaskResolution(resolution: NonNullable<UnknownTaskFacts['resolution']>, mention = false) {
  const operator = unknownTaskDecisionOperator(resolution.decisionId);
  return `${operator ? `${operatorText(operator, mention)} 于 ` : ''}${formatUnknownTaskTime(resolution.at)} ${doneLabels[resolution.action]}`;
}

const reasons: Record<string, string> = {
  PREVIOUS_RUNTIME_RESULT_UNKNOWN: '服务重启切断了这一轮',
  DAEMON_SHUTDOWN: '服务重启切断了这一轮',
  AGENT_IDLE_TIMEOUT: '长时间没有输出被系统停止，没能确认 Agent 已经停下',
  DRIVER_RESULT_UNKNOWN: 'Agent 没有返回这一轮的执行结果',
  DRIVER_INPUT_UNCONFIRMED: '没能确认消息送到了 Agent',
  STEERING_DELIVERY_UNKNOWN: '插话没能确认送达正在执行的那一轮'
};
const submissions: Record<NonNullable<UnknownTaskFacts['submission']>, string> = {
  not_submitted: '没有', intent_recorded: '已开始提交，没有收到 Agent 的确认', acknowledged: 'Agent 已确认收到', legacy_unknown: '旧版本记录，无法确定'
};

/** 已知事实的三行摘要：最后状态、是否已提交给 Agent、最后输出时间。飞书卡片与 Web 共用。 */
export function unknownTaskFactLines(facts: UnknownTaskFacts) {
  return [
    `最后状态：结果未知，${reasons[facts.reasonCode ?? ''] ?? '执行结果没有确认'}`,
    `是否已提交给 Agent：${facts.kind === 'steering' ? '插话可能已送达，也可能没有'
      // 提交回执没落库但已经有输出：Agent 收到并开始执行了。
      : facts.submission !== 'acknowledged' && facts.lastOutputAt ? '已提交，Agent 已开始执行并有输出' : submissions[facts.submission ?? 'legacy_unknown']}`,
    `最后输出：${facts.lastOutputAt ? formatUnknownTaskTime(facts.lastOutputAt) : facts.kind === 'steering' ? '插话没有单独的输出' : '这一轮没有输出'}`
  ];
}

const settledCodes = new Set(['TASK_NOT_RESULT_UNKNOWN', 'ATTEMPT_REVISION_CONFLICT', 'ATTEMPT_NOT_CURRENT', 'ATTEMPT_ALREADY_SETTLED',
  'STEERING_REVISION_CONFLICT', 'STEERING_ALREADY_SETTLED', 'EXECUTION_OPERATION_CONFLICT', 'RECOVERY_DECISION_CONFLICT']);
const blockedCodes = new Set(['SESSION_RESOURCE_BLOCKED', 'RESOURCE_OBSERVATION_CONFLICT', 'RESOURCE_OBSERVATION_REQUIRED']);

/**
 * 按人的选择处理一条结果未知的任务。返回处理后的任务状态与这次是否只是回放。
 * 失败时抛 RuntimeError，message 是给操作人看的中文说明：已被别人处理（写明谁、何时、做了什么）、Agent 还没停下、执行进程没确认停止等。
 */
export async function resolveUnknownTask(runtime: UnknownTaskRuntime, input: {
  sessionId: string; taskId: string; target: string; action: UnknownTaskAction; operator: UnknownTaskOperator; at?: Date;
}) {
  const at = input.at ?? new Date();
  const decisionId = unknownTaskDecisionId(input.target, input.action, input.operator);
  const resolution: UnknownTaskResolution = {
    taskId: input.taskId, target: input.target, decisionId, action: input.action,
    evidenceRefs: ['manual_resolution', `operator:${input.operator.channel}:${input.operator.id}`, `at:${at.toISOString()}`],
    ...(input.action === 'completed' ? { verifiedOutputText: `${operatorText(input.operator, false)} 于 ${formatUnknownTaskTime(at)} 人工标为已完成。这一轮的执行结果没有经系统确认，执行过程见执行记录。` } : {}),
    ...(input.action === 'retry' ? { allowDuplicateEffects: true as const } : {})
  };
  try {
    const result = await runtime.resolveUnknownTask(input.sessionId, resolution, installationOwner);
    return { replayed: result.replayed, status: result.task.status, decisionId };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && settledCodes.has(code)) {
      const facts = await runtime.inspectUnknownTask(input.sessionId, input.taskId, input.target).catch(() => undefined);
      throw new RuntimeError('UNKNOWN_TASK_ALREADY_RESOLVED', facts?.resolution ? `这一轮已经处理过：${describeUnknownTaskResolution(facts.resolution)}。`
        : '这一轮已经不在结果未知状态，请刷新查看最新状态。', 409);
    }
    if (code === 'RECOVERY_EXECUTION_ACTIVE') throw new RuntimeError(code, 'Agent 还在执行或没有确认已经停下，现在处理可能和它同时进行。等它停下后再试。', 409);
    if (typeof code === 'string' && blockedCodes.has(code)) {
      throw new RuntimeError('SESSION_RESOURCE_BLOCKED', '上一轮的执行进程还没确认停止，现在处理可能和它同时进行。请稍后再试；一直不行的话请管理员用 `dutydeck recovery` 核对。', 409);
    }
    if (code === 'SESSION_ARCHIVED' || code === 'SESSION_NOT_ACCEPTING') throw new RuntimeError(code, '这个会话已归档或已停止，不能再处理。', 409);
    throw error;
  }
}
