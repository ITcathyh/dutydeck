import type { AgentModelSettingsPatch, AgentModelsResult, PublicAgent } from '@dutydeck/shared';
import { json, send } from './client';

export type Agent = PublicAgent;

const botAgentPath = (id: string, appId?: string) => appId
  ? `/api/lark/bots/${encodeURIComponent(appId)}/agents/${encodeURIComponent(id)}`
  : `/api/agents/${encodeURIComponent(id)}`;
const agentModelsUrl = (id: string, model?: string, refresh = false, appId?: string) => {
  const query = new URLSearchParams();
  if (model) query.set('model', model);
  if (refresh) query.set('refresh', '1');
  const suffix = query.toString();
  return `${botAgentPath(id, appId)}/models${suffix ? `?${suffix}` : ''}`;
};

export type AgentModelSettings = { agentId: string; appId?: string; model: string; baseUrl: string; authMode: 'bearer' | 'api-key'; hasApiKey: boolean; apiKeyAvailable: boolean; appliesTo: 'next_process' };

export type AgentConfigSettings = { id: string; codexProfile: string };
export const agentConfigApi = {
  get: (id: string) => json<AgentConfigSettings>(`/api/agents/${encodeURIComponent(id)}/config`, { cache: 'no-store' }),
  set: (id: string, codexProfile: string | null) => send<Agent>('PATCH', `/api/agents/${encodeURIComponent(id)}/config`, { codexProfile })
};
const modelSettingsUrl = (id: string, appId?: string) => `${botAgentPath(id, appId)}/model-settings`;
export const agentModelSettingsApi = {
  get: (id: string, appId?: string) => json<AgentModelSettings>(modelSettingsUrl(id, appId), { cache: 'no-store' }),
  set: (id: string, body: AgentModelSettingsPatch, appId?: string) => send<AgentModelSettings>('PUT', modelSettingsUrl(id, appId), body)
};

export const agentRequests = {
  agents: () => json<Agent[]>('/api/agents'),
  agentModels: (id: string, model?: string, refresh = false, appId?: string) => json<AgentModelsResult>(agentModelsUrl(id, model, refresh, appId)),
};
