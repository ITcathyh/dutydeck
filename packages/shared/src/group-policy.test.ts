import { describe, expect, it } from 'vitest';
import {
  createFailClosedPolicyEvaluator,
  createGroupBindingInputSchema,
  evaluatePolicyAction,
  groupBindingSchema,
  inheritPresentationOverride,
  policyActions,
  presentationOverrideSchema,
  resolveGroupEffectiveConfig,
  roleAssignmentSchema,
  type ChannelBotGroupPolicy,
  type GroupBinding,
  type PolicyEvaluationInput,
  type PresentationSettings,
  type RoleAssignment
} from './index.js';

const now = '2026-08-30T00:00:00.000Z';

const presentationDefaults: PresentationSettings = {
  structuredAskCards: true,
  groupCardMention: false,
  pushIntervalMs: 1000,
  traceLimit: 50,
  hideTraceOnComplete: true,
  completionReactionOnly: false,
  silentProgress: false
};

function binding(overrides: Partial<GroupBinding> = {}): GroupBinding {
  const input = createGroupBindingInputSchema.parse({ id: 'binding-1', channelBotId: 'bot-1', externalChatId: 'chat-1' });
  return groupBindingSchema.parse({ ...input, schemaVersion: 1, revision: 1, state: 'staged', createdAt: now, updatedAt: now, ...overrides });
}

function assignment(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return roleAssignmentSchema.parse({
    schemaVersion: 1, id: 'role-1', revision: 1, channelBotId: 'bot-1', groupBindingId: 'binding-1',
    principalId: 'principal_alice', role: 'can_operate', operateScope: 'own_runs',
    actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: false }, state: 'active',
    createdAt: now, updatedAt: now, ...overrides
  });
}

function input(action: PolicyEvaluationInput['action'], overrides: Partial<PolicyEvaluationInput> = {}): PolicyEvaluationInput {
  const groupBinding = binding();
  return {
    action, now, mode: 'explain',
    principal: { id: 'principal_alice', channelBotId: 'bot-1', isOwner: false, isChatMember: true },
    channelBot: { id: 'bot-1', state: 'disabled' }, binding: groupBinding,
    effectiveConfig: resolveGroupEffectiveConfig(undefined, groupBinding), assignments: [],
    target: { channelBotId: 'bot-1', groupBindingId: 'binding-1', runOwnerPrincipalId: 'principal_alice' },
    sessionGroupTools: { read: true, discover: true, send: true }, ...overrides
  };
}

describe('WP1a group policy and action evaluator', () => {
  it('explains group overrides over Bot defaults and clamps group-tools at the Bot ceiling', () => {
    const policy: ChannelBotGroupPolicy = {
      schemaVersion: 1, id: 'policy-1', revision: 1, channelBotId: 'bot-1',
      defaults: { agentDefinitionId: 'agent-default', workspace: '/bot-default', model: 'model-default' },
      routingDefaults: { groupReplyMode: 'chat', mentionPolicy: 'always' },
      accessPolicy: { mode: 'owner_only', principalIds: [] },
      groupToolsPolicy: { readCeiling: true, discoverCeiling: true, sendCeiling: false, readDefault: false, discoverDefault: true, sendDefault: false },
      createdAt: now, updatedAt: now
    };
    const effective = resolveGroupEffectiveConfig(policy, binding({
      oncall: true,
      agentOverride: { mode: 'set', value: 'agent-group' },
      modelOverride: { mode: 'clear' },
      routingOverride: { groupReplyMode: { mode: 'set', value: 'chat-topic' }, mentionPolicy: { mode: 'set', value: 'topic' } },
      groupToolsOverride: { read: 'allow', discover: 'deny', send: 'allow' }
    }));

    expect(effective.agent).toEqual({ value: 'agent-group', source: 'group_override' });
    expect(effective.workspace).toEqual({ value: '/bot-default', source: 'bot_default' });
    expect(effective.model).toEqual({ value: undefined, source: 'group_clear' });
    expect(effective.routing).toMatchObject({ groupReplyMode: { value: 'chat-topic', source: 'group_override' }, mentionPolicy: { value: 'topic', source: 'group_override' } });
    expect(effective.groupTools).toMatchObject({ read: { allowed: true }, discover: { allowed: false }, send: { allowed: false, requested: true, source: 'bot_ceiling' } });
    expect(effective.talkGrant).toBe('oncall_chat_members');
  });

  it('resolves presentation per group, field by field, over the Bot presentation defaults', () => {
    const overridden = binding({
      presentationOverride: presentationOverrideSchema.parse({
        ...inheritPresentationOverride,
        groupCardMention: { mode: 'set', value: true },
        hideTraceOnComplete: { mode: 'set', value: false },
        traceLimit: { mode: 'set', value: 5 },
        pushIntervalMs: { mode: 'set', value: 4000 }
      })
    });
    const effective = resolveGroupEffectiveConfig(undefined, overridden, presentationDefaults);
    expect(effective.presentation.groupCardMention).toEqual({ value: true, source: 'group_override' });
    expect(effective.presentation.hideTraceOnComplete).toEqual({ value: false, source: 'group_override' });
    expect(effective.presentation.traceLimit).toEqual({ value: 5, source: 'group_override' });
    expect(effective.presentation.pushIntervalMs).toEqual({ value: 4000, source: 'group_override' });
    // 没被覆盖的字段仍然来自 Bot 默认，包括取值为 false 的布尔项。
    expect(effective.presentation.structuredAskCards).toEqual({ value: true, source: 'bot_default' });
    expect(effective.presentation.completionReactionOnly).toEqual({ value: false, source: 'bot_default' });
    expect(effective.presentation.silentProgress).toEqual({ value: false, source: 'bot_default' });
  });

  it('turns the two new quiet presentation modes on per group and leaves them off by default', () => {
    const quiet = binding({
      presentationOverride: presentationOverrideSchema.parse({
        ...inheritPresentationOverride,
        completionReactionOnly: { mode: 'set', value: true },
        silentProgress: { mode: 'set', value: true }
      })
    });
    expect(resolveGroupEffectiveConfig(undefined, quiet, presentationDefaults).presentation).toMatchObject({
      completionReactionOnly: { value: true, source: 'group_override' },
      silentProgress: { value: true, source: 'group_override' }
    });
    // 默认绑定不覆盖任何一项；没有 Bot 呈现默认时全部保持未解析。
    expect(binding().presentationOverride).toEqual(inheritPresentationOverride);
    expect(resolveGroupEffectiveConfig(undefined, binding()).presentation).toMatchObject({
      completionReactionOnly: { value: undefined, source: 'unconfigured' },
      silentProgress: { value: undefined, source: 'unconfigured' }
    });
    expect(resolveGroupEffectiveConfig(undefined, binding(), presentationDefaults).presentation).toMatchObject({
      completionReactionOnly: { value: false, source: 'bot_default' },
      silentProgress: { value: false, source: 'bot_default' }
    });
  });

  it('rejects the retired inherit-only presentation override shape', () => {
    expect(presentationOverrideSchema.safeParse({ mode: 'inherit' }).success).toBe(false);
    expect(presentationOverrideSchema.safeParse({ ...inheritPresentationOverride, pushIntervalMs: { mode: 'set', value: 100 } }).success).toBe(false);
    expect(presentationOverrideSchema.safeParse({ ...inheritPresentationOverride, traceLimit: { mode: 'set', value: 0 } }).success).toBe(false);
    // traceLimit 会以 traceLimit * 30 驱动事件回放，群级取值必须封顶。
    expect(presentationOverrideSchema.safeParse({ ...inheritPresentationOverride, traceLimit: { mode: 'set', value: 200 } }).success).toBe(true);
    expect(presentationOverrideSchema.safeParse({ ...inheritPresentationOverride, traceLimit: { mode: 'set', value: 201 } }).success).toBe(false);
  });

  it('lets open/oncall policy contribute talk only, never operate or admin', () => {
    const oncall = binding({ oncall: true });
    const effective = resolveGroupEffectiveConfig(undefined, oncall);
    expect(evaluatePolicyAction(input('task.create', { binding: oncall, effectiveConfig: effective })).allowed).toBe(true);
    expect(evaluatePolicyAction(input('task.create', { binding: oncall, effectiveConfig: effective, target: undefined }))).toMatchObject({ allowed: true, source: 'group_policy' });
    expect(evaluatePolicyAction(input('queue.cancel', { binding: oncall, effectiveConfig: effective }))).toMatchObject({ allowed: false, code: 'operate_scope_required' });
    expect(evaluatePolicyAction(input('group_binding.update', { binding: oncall, effectiveConfig: effective }))).toMatchObject({ allowed: false, code: 'admin_required' });
    const denied = binding({ oncall: true, accessOverride: { mode: 'disabled', principalIds: [] } });
    const deniedEffective = resolveGroupEffectiveConfig(undefined, denied);
    expect(deniedEffective.talkGrant).toBe('none');
    expect(evaluatePolicyAction(input('task.create', { binding: denied, effectiveConfig: deniedEffective }))).toMatchObject({ allowed: false, code: 'talk_required' });
  });

  it('enforces own/group/bot operate scopes against the target Run', () => {
    const own = assignment({ operateScope: 'own_runs' });
    expect(evaluatePolicyAction(input('queue.cancel', { assignments: [own] })).allowed).toBe(true);
    expect(evaluatePolicyAction(input('queue.cancel', { assignments: [own], target: { channelBotId: 'bot-1', groupBindingId: 'binding-1', runOwnerPrincipalId: 'principal_bob' } }))).toMatchObject({ allowed: false, code: 'operate_scope_required' });
    const group = assignment({ id: 'role-group', operateScope: 'group_runs' });
    expect(evaluatePolicyAction(input('run.interrupt', { assignments: [group] })).allowed).toBe(true);
    expect(evaluatePolicyAction(input('run.interrupt', { assignments: [group], target: { channelBotId: 'bot-1', groupBindingId: 'binding-other' } }))).toMatchObject({ allowed: false, code: 'operate_scope_required' });
    const bot = assignment({ id: 'role-bot', groupBindingId: undefined, operateScope: 'bot_runs' });
    expect(evaluatePolicyAction(input('run.restart', { assignments: [bot], target: { channelBotId: 'bot-1', groupBindingId: 'binding-other' } })).allowed).toBe(true);
  });

  it('requires independent terminal-write, high-risk and group-tools-send gates', () => {
    const operate = assignment({ operateScope: 'bot_runs' });
    expect(evaluatePolicyAction(input('terminal.write', { assignments: [operate] }))).toMatchObject({ allowed: false, code: 'terminal_write_gate_required' });
    expect(evaluatePolicyAction(input('high_risk.execute', { assignments: [operate] }))).toMatchObject({ allowed: false, code: 'high_risk_gate_required' });

    const terminalOnly = assignment({ operateScope: 'bot_runs', actionGates: { terminalWrite: true, highRisk: false, groupToolsSend: false } });
    expect(evaluatePolicyAction(input('terminal.write', { assignments: [terminalOnly] })).allowed).toBe(true);
    expect(evaluatePolicyAction(input('high_risk.execute', { assignments: [terminalOnly] }))).toMatchObject({ allowed: false, code: 'high_risk_gate_required' });

    const groupBinding = binding({ groupToolsOverride: { read: 'allow', discover: 'allow', send: 'allow' } });
    const policy: ChannelBotGroupPolicy = {
      schemaVersion: 1, id: 'policy-tools', revision: 1, channelBotId: 'bot-1', defaults: {},
      routingDefaults: { groupReplyMode: 'chat', mentionPolicy: 'always' }, accessPolicy: { mode: 'owner_only', principalIds: [] },
      groupToolsPolicy: { readCeiling: true, discoverCeiling: true, sendCeiling: true, readDefault: false, discoverDefault: false, sendDefault: false }, createdAt: now, updatedAt: now
    };
    const effective = resolveGroupEffectiveConfig(policy, groupBinding);
    expect(evaluatePolicyAction(input('group_tools.send', { binding: groupBinding, effectiveConfig: effective, assignments: [operate] }))).toMatchObject({ allowed: false, code: 'group_tools_send_gate_required' });
    const send = assignment({ operateScope: 'bot_runs', actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: true } });
    expect(evaluatePolicyAction(input('group_tools.send', { binding: groupBinding, effectiveConfig: effective, assignments: [send] })).allowed).toBe(true);
  });

  it('fails closed when used as an unwired execution adapter and covers every declared action', () => {
    const failClosed = createFailClosedPolicyEvaluator();
    expect(failClosed(input('task.create'))).toMatchObject({ allowed: false, code: 'permission_evaluator_unwired', source: 'integration' });
    expect(evaluatePolicyAction({ ...input('task.create'), mode: 'enforce', assignments: [assignment({ role: 'can_talk', operateScope: 'none' })] })).toMatchObject({ allowed: false, code: 'channel_bot_disabled' });
    for (const action of policyActions) expect(evaluatePolicyAction(input(action))).toMatchObject({ action, allowed: expect.any(Boolean), code: expect.any(String) });
  });
});
