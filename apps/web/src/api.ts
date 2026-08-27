export type Agent = { id: string; name: string; version?: string; model?: string; cwd?: string; protocol: string; permissionMode: string };
export type AgentModel = { id: string; name: string };
export type AgentModelsResult = { models: AgentModel[]; defaultModel?: string; reasoningEfforts: AgentModel[]; defaultReasoningEffort?: string; source?: 'acp' | 'cli' | 'agent' };
export type SkillReference = { name: string; description: string; path: string; source: 'workspace' | 'user' };
export type LarkAllowedUser = { openId: string; name: string };
export type LarkBotConfig = { configured: true; appId: string; name: string; tabLabel: string; setupComplete: boolean; workspace?: string; webBaseUrl?: string; defaultAgentId?: string; defaultModel?: string; defaultReasoningEffort?: string; preInjectPrompt: string; listening: boolean; activeListening: boolean; groupToolsEnabled: boolean; groupToolsAllowSend: boolean; pushIntervalMs: number; traceLimit?: number; hideTraceOnComplete: boolean; allowedUsers: LarkAllowedUser[]; allowedEmails: string[]; allowedBots: LarkAllowedUser[]; peerBotsAllowed: boolean; highRiskAllowedUsers: LarkAllowedUser[]; highRiskAllowedEmails: string[]; highRiskPattern: string; gateEnabled: boolean; softGateEnabled: boolean; hardGateEnabled: boolean; hookTrustConfirmed: boolean };
export type LarkConfig = { configured: boolean; bots: LarkBotConfig[]; listeningDisabled: boolean };
export type LarkHookStatus = { agentId?: string; supported: boolean; installed: boolean; writable: boolean; trustRequired: boolean; hooksPath?: string; reason?: string; trustInstructions?: string };
export type Session = { id: string; agentId: string; state: string; cwd: string; model?: string; reasoningEffort?: string; permissionMode?: 'full-trust'; source?: string; sourceId?: string; archivedAt?: string; runId: string; createdAt: string; updatedAt: string; systemPrompt?: string };
export type DockEvent = { id: string; sequence: number; type: string; timestamp: string; data: any; raw?: string };
export type Task = { id: string; sessionId: string; prompt: string; status: string; createdAt: string; updatedAt: string };
const json = async <T,>(url: string, init?: RequestInit): Promise<T> => { const response = await fetch(url, init); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? response.statusText); return data; };
const agentModelsUrl = (id: string, model?: string, refresh = false) => {
  const query = new URLSearchParams();
  if (model) query.set('model', model);
  if (refresh) query.set('refresh', '1');
  const suffix = query.toString();
  return `/api/agents/${id}/models${suffix ? `?${suffix}` : ''}`;
};
export const api = {
  agents: () => json<Agent[]>('/api/agents'), agentModels: (id: string, model?: string, refresh = false) => json<AgentModelsResult>(agentModelsUrl(id, model, refresh)), sessions: () => json<Session[]>('/api/sessions'), events: (id: string) => json<DockEvent[]>(`/api/sessions/${id}/events`), tasks: (id: string) => json<Task[]>(`/api/sessions/${id}/tasks`),
  create: (body: any) => json<Session>('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  send: (id: string, prompt: string, mode: 'queue' | 'interrupt' = 'queue') => json<{ accepted: true; task: Task }>(`/api/sessions/${id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, mode }) }),
  setSessionModel: (id: string, model: string) => json<Session>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) }),
  setSessionReasoningEffort: (id: string, reasoningEffort: string) => json<Session>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reasoningEffort }) }),
  cancelQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}`, { method: 'DELETE' }),
  steerQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}/steer`, { method: 'POST' }),
  larkConfig: () => json<LarkConfig>('/api/lark/config'),
  inspectLarkBot: (body: { appId: string; appSecret: string }) => json<{ appName: string; openId: string; avatarUrl?: string; activateStatus?: number }>('/api/lark/bot/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  saveLarkConfig: (body: { stage: 'lark' | 'agent'; originalAppId?: string; appId?: string; appSecret?: string; workspace?: string; webBaseUrl?: string; defaultAgentId?: string; defaultModel?: string; defaultReasoningEffort?: string; preInjectPrompt?: string; listening?: boolean; groupToolsEnabled?: boolean; groupToolsAllowSend?: boolean; pushIntervalMs?: number; traceLimit?: number | null; allowedUsers?: LarkAllowedUser[]; allowedUserNames?: string[]; allowedEmails?: string[]; allowedBots?: LarkAllowedUser[]; allowedBotNames?: string[]; peerBotsAllowed?: boolean; highRiskAllowedUsers?: LarkAllowedUser[]; highRiskAllowedUserNames?: string[]; highRiskAllowedEmails?: string[]; highRiskPattern?: string; gateEnabled?: boolean; softGateEnabled?: boolean; hardGateEnabled?: boolean; hookTrustConfirmed?: boolean }) => json<LarkConfig>('/api/lark/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteLarkConfig: (appId: string) => json<LarkConfig>(`/api/lark/config/${encodeURIComponent(appId)}`, { method: 'DELETE' }),
  larkHookStatus: (appId: string) => json<LarkHookStatus>(`/api/lark/hooks/status?appId=${encodeURIComponent(appId)}`),
  installLarkHook: (appId: string, highRiskPattern: string) => json<LarkHookStatus>('/api/lark/hooks/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, highRiskPattern }) }),
  systemCapabilities: () => json<{ platform: string; directoryPicker: boolean; filePicker: boolean }>('/api/system/capabilities'),
  skills: (cwd?: string) => json<SkillReference[]>(`/api/system/skills${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  selectDirectory: () => json<{ path: string }>('/api/system/select-directory', { method: 'POST' }),
  selectFile: () => json<{ path: string }>('/api/system/select-file', { method: 'POST' }),
  archive: (id: string) => json<Session>(`/api/sessions/${id}/archive`, { method: 'POST' }),
  action: (id: string, action: string) => json(`/api/sessions/${id}/${action}`, { method: 'POST' }),
  permission: (id: string, permissionId: string, approved: boolean) => json(`/api/sessions/${id}/permissions/${permissionId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved }) })
};
