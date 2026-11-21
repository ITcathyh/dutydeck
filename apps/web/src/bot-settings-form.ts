import { botSettingDescriptors as fields, type BotSettingKey, type PublicLarkConfig } from '@dutydeck/shared';
import type { LarkBotConfig } from './api';

// The connection step owns workspace. The wizard's agent step and the detail page share these fields.
const agentFields = [
  'defaultAgentId', 'fallbackAgentId', 'fallbackModel', 'defaultModel', 'defaultReasoningEffort', 'preInjectPrompt',
  'replyPolishEnabled', 'replyPolishAgentId', 'replyPolishModel', 'reactionTriggerEmoji', 'listening',
  'groupToolsEnabled', 'groupToolsAllowSend', 'memoryEnabled', 'memoryAutoExtract', 'groupMemoryScope', 'claudeAutoMemory',
  'memoryAgentId', 'memoryModel', 'decisionAgentId', 'decisionModel', 'busyTriage', 'botLoopGuard',
  'responseAgentId', 'responseModel', 'riskControlMode'
] as const satisfies readonly BotSettingKey[];
type AgentField = typeof agentFields[number];
type AgentDraft = { [K in AgentField]: NonNullable<PublicLarkConfig[K]> };
export type SharedBotDraft = AgentDraft & { workspace: string; highRiskPattern: string; replyPolishTimeoutSeconds: string };

export function draftFromBot(bot?: LarkBotConfig): SharedBotDraft {
  const values = Object.fromEntries(agentFields.map(key => {
    const field = fields[key];
    return [key, bot?.[key] ?? ('displayDefault' in field ? field.displayDefault : field.default) ?? ''];
  })) as AgentDraft;
  return {
    ...values,
    workspace: bot?.workspace ?? '',
    highRiskPattern: bot?.highRiskPattern ?? '',
    // Older servers omitted these flags. Both editors preserve their historical fallback.
    listening: bot?.listening ?? true,
    memoryEnabled: bot?.memoryEnabled ?? (bot?.defaultGroupParticipation === 'selective'),
    busyTriage: bot?.busyTriage === true,
    botLoopGuard: bot?.botLoopGuard === true,
    replyPolishTimeoutSeconds: String((bot?.replyPolishTimeoutMs ?? fields.replyPolishTimeoutMs.displayDefault) / 1000)
  };
}

export function saveBodyFromDraft(draft: SharedBotDraft, step: 'lark' | 'agent' | 'detail') {
  if (step === 'lark') return { workspace: draft.workspace.trim() };
  const agent = Object.fromEntries(agentFields.map(key => [key, draft[key]])) as AgentDraft;
  return {
    ...agent,
    ...(step === 'detail' ? { workspace: draft.workspace } : {}),
    highRiskPattern: draft.highRiskPattern,
    replyPolishTimeoutMs: replyPolishTimeoutValue(draft.replyPolishTimeoutSeconds)
  };
}

export const secondsFromMs = (value: number | undefined) => value === undefined ? '' : String(Math.round(value / 1000));
export const msFromSeconds = (value: string) => {
  const seconds = Number(value.trim());
  return value.trim() && Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
};

function replyPolishTimeoutValue(seconds: string): number | null {
  if (!seconds.trim()) return null;
  const milliseconds = Number(seconds) * 1000;
  const rounded = Math.round(milliseconds);
  if (!Number.isSafeInteger(rounded) || rounded < 1 || rounded > fields.replyPolishTimeoutMs.max
    || Math.abs(milliseconds - rounded) > Number.EPSILON * Math.max(1, milliseconds) * 4) {
    throw new Error('优化等待时间须为正数，精确到毫秒，并在系统计时器可表示的范围内。');
  }
  return rounded;
}
