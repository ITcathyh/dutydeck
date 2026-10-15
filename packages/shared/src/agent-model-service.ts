/**
 * 可配置兼容 Claude API 模型服务（地址/密钥/认证方式）的适配器：Claude Code 家族，
 * 经 id 或 adapterId 命中。新增同类适配器时只改这里，server 与 Web 都消费这一份判定。
 */
export const agentModelServiceAdapterIds: readonly string[] = ['claude', 'claude-code'];

export const supportsAgentModelService = (agent: { id: string; adapterId?: string }) =>
  agentModelServiceAdapterIds.includes(agent.adapterId ?? agent.id);
