import { z } from 'zod';

/**
 * 可配置兼容 Claude API 模型服务（地址/密钥/认证方式）的适配器：Claude Code 家族，
 * 经 id 或 adapterId 命中。新增同类适配器时只改这里，server 与 Web 都消费这一份判定。
 */
export const agentModelServiceAdapterIds: readonly string[] = ['claude', 'claude-code'];

export const supportsAgentModelService = (agent: { id: string; adapterId?: string }) =>
  agentModelServiceAdapterIds.includes(agent.adapterId ?? agent.id);

export interface AgentModel { id: string; name: string }
export interface AgentProfile { id: string; name: string }
export interface AgentModelsResult { models: AgentModel[]; profiles?: AgentProfile[]; defaultModel?: string; reasoningEfforts: AgentModel[]; defaultReasoningEffort?: string; source?: 'acp' | 'cli' | 'agent'; protocol?: 'acp' }

const text = z.string().trim().max(512);
const baseUrl = text.refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}, '服务地址必须是 HTTP(S) URL，不能包含账号、查询参数或片段');
export const agentModelSettingsPatchSchema = z.object({
  model: text.optional(), baseUrl: baseUrl.optional(), authMode: z.enum(['bearer', 'api-key']).optional(),
  apiKey: z.string().trim().min(1).max(4096).refine(value => !/[\s\x00-\x1f\x7f]/.test(value), 'API Key 不能包含空白或控制字符').optional(), clearApiKey: z.boolean().optional()
}).strict().refine(value => !(value.apiKey && value.clearApiKey), '不能同时设置和清除 API Key');
export type AgentModelSettingsPatch = z.infer<typeof agentModelSettingsPatchSchema>;
