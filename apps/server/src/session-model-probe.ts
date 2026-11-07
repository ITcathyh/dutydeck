import type { AgentConfig } from '@dutydeck/shared';
import { discoverAgentModels, type AgentModelsResult } from './agent-models.js';

/** Web 配置路由与飞书 /model、/effort 共用的会话探测：10 秒内读不到可选值返回 undefined，探测失败照常抛出。 */
export async function discoverSessionAgentModels(probeAgent: AgentConfig, model: string | undefined): Promise<AgentModelsResult | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([discoverAgentModels(probeAgent, model), new Promise<undefined>(resolve => { timer = setTimeout(resolve, 10_000, undefined); })]);
  } finally { clearTimeout(timer); }
}
