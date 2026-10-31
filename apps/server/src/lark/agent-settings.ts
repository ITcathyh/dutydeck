import { z } from 'zod';
import { botFields, parsePairs } from '../settings-cli.js';
import { AgentCommandParamError } from './agent-command.js';
import type { SaveLarkConfigInput, StoredLarkConfig } from './config.js';
import { parseLarkQuietHours } from './notify-tier.js';

export const agentSettingsRequestSchema = z.object({ pairs: z.array(z.string()).min(1), dryRun: z.boolean().optional() }).strict();

export const agentSettingsKeys = ['defaultAgentId', 'defaultModel', 'defaultReasoningEffort', 'p2pMode', 'groupReplyMode',
  'notifyQuietHours', 'notifyMentionAction', 'notifyMentionDone', 'busyTriage', 'botLoopGuard'] as const;
const fields = Object.fromEntries(agentSettingsKeys.map(key => [key, botFields[key]]));

export function parseAgentSettings(pairs: string[]): SaveLarkConfigInput {
  let values: SaveLarkConfigInput;
  try { values = parsePairs(pairs, fields, 'dutydeck agent settings set --help'); }
  catch (error) { throw new AgentCommandParamError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error), [{ name: '<key=value>', reason: error instanceof Error ? error.message : String(error) }]); }
  if (!Object.keys(values).length) throw new AgentCommandParamError('INVALID_ARGUMENT', '至少给一个 key=value。', [{ name: '<key=value>', reason: '至少给一个设置' }]);
  if (values.notifyQuietHours?.trim() && !parseLarkQuietHours(values.notifyQuietHours)) throw new AgentCommandParamError('INVALID_ARGUMENT', 'notifyQuietHours 要是 22:00-08:00 这样的时段，或留空。', [{ name: 'notifyQuietHours', reason: '格式为 HH:MM-HH:MM，开始和结束时间不能相同' }]);
  return values;
}

export function showAgentSettings(config: StoredLarkConfig): Record<string, unknown> {
  return Object.fromEntries(agentSettingsKeys.map(key => [key, config[key] ?? (key === 'p2pMode' ? 'chat'
    : key === 'groupReplyMode' ? null : key === 'busyTriage' || key === 'botLoopGuard' ? false : key === 'notifyMentionAction' || key === 'notifyMentionDone' ? true : '')]));
}
export const agentSettingsConfirmKind = (appId: string) => `agent_settings.${appId}`;
