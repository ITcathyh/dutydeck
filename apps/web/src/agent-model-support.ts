import { agentModelServiceAdapterIds } from '@dutydeck/shared';
import type { Agent } from './api';

/**
 * 该 Agent 是否支持模型服务配置：以服务端 PublicAgent.modelServiceSettings 标志为准；
 * 旧版服务端不返回该标志时按内建适配器 id 兜底（自定义 adapterId 的 Agent 需新版服务端）。
 * Agent 列表尚未加载时用 fallbackId 判 id。
 */
export const supportsModelServiceSettings = (agent?: Pick<Agent, 'id' | 'modelServiceSettings'>, fallbackId?: string): boolean => {
  if (agent?.modelServiceSettings !== undefined) return agent.modelServiceSettings;
  return agentModelServiceAdapterIds.includes(agent?.id ?? fallbackId ?? '');
};
