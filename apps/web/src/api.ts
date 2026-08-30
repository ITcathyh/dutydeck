export type PermissionMode = 'ask' | 'approve-reads' | 'deny-all' | 'full-trust';
export type Agent = { id: string; name: string; version?: string; model?: string; cwd?: string; protocol: string; permissionMode: PermissionMode };
export type AgentModel = { id: string; name: string };
export type AgentModelsResult = { models: AgentModel[]; defaultModel?: string; reasoningEfforts: AgentModel[]; defaultReasoningEffort?: string; source?: 'acp' | 'cli' | 'agent' };
export type SkillReference = { name: string; description: string; path: string; source: 'workspace' | 'user' };
export type LarkAllowedUser = { openId: string; name: string };
export type RiskControlMode = 'off' | 'guidance' | 'enforced';
export type LarkBotConfig = { configured: true; appId: string; name: string; tabLabel: string; setupComplete: boolean; workspace?: string; webBaseUrl?: string; defaultAgentId?: string; defaultModel?: string; defaultReasoningEffort?: string; fullTrustConfirmed: boolean; preInjectPrompt: string; listening: boolean; activeListening: boolean; groupToolsEnabled: boolean; groupToolsAllowSend: boolean; pushIntervalMs: number; traceLimit?: number; hideTraceOnComplete: boolean; allowedUsers: LarkAllowedUser[]; allowedEmails: string[]; allowedBots: LarkAllowedUser[]; peerBotsAllowed: boolean; highRiskAllowedUsers: LarkAllowedUser[]; highRiskAllowedEmails: string[]; highRiskPattern: string; riskControlMode: RiskControlMode };
export type LarkConfig = { configured: boolean; bots: LarkBotConfig[]; listeningDisabled: boolean };
export type LarkHookStatus = { agentId?: string; supported: boolean; installed: boolean; writable: boolean; trustRequired: boolean; hooksPath?: string; reason?: string; trustInstructions?: string };
export type LarkOpenPlatformSetupJob = {
  id: string;
  appId: string;
  status: 'preparing' | 'waiting_for_scan' | 'configuring' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  qrDataUrl?: string;
  scanConfirmed?: boolean;
  accountName?: string;
  tenantName?: string;
  result?: { status: 'ready'; scopeCount: number; eventCount: number; callbackCount: number; versionId: string };
  error?: string;
};
export type Session = { id: string; agentId: string; state: string; cwd: string; model?: string; reasoningEffort?: string; permissionMode?: PermissionMode; source?: string; sourceId?: string; archivedAt?: string; runId: string; createdAt: string; updatedAt: string; systemPrompt?: string };
export type DockEvent = { id: string; sequence: number; type: string; timestamp: string; data: any; raw?: string };
export type Task = { id: string; sessionId: string; prompt: string; status: string; createdAt: string; updatedAt: string };
export type RunSummary = { sessionId: string; taskId: string; prompt: string; status: string; queuedCount: number; updatedAt: string };
export type EventWindowQuery = { before?: number; after?: number; limit?: number; direction?: 'backward' | 'forward' };
export type BrowserAuthState = { authenticated: boolean; required: boolean };
export const UNAUTHORIZED_EVENT = 'dockmux:unauthorized';
const json = async <T,>(url: string, init?: RequestInit): Promise<T> => { const response = await fetch(url, { credentials: 'same-origin', ...init }); const data = await response.json(); if (!response.ok) { if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)); throw new Error(data.error?.message ?? response.statusText); } return data; };
const agentModelsUrl = (id: string, model?: string, refresh = false) => {
  const query = new URLSearchParams();
  if (model) query.set('model', model);
  if (refresh) query.set('refresh', '1');
  const suffix = query.toString();
  return `/api/agents/${id}/models${suffix ? `?${suffix}` : ''}`;
};
export const eventsUrl = (id: string, query: EventWindowQuery = {}) => {
  const params = new URLSearchParams();
  if (query.before !== undefined) params.set('before', String(query.before));
  if (query.after !== undefined) params.set('after', String(query.after));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.direction) params.set('direction', query.direction);
  const suffix = params.toString();
  return `/api/sessions/${id}/events${suffix ? `?${suffix}` : ''}`;
};
export const RUN_SUMMARY_ENDPOINT = '/api/sessions/summaries';
export const api = {
  authStatus: () => json<BrowserAuthState>('/api/auth/status', { cache: 'no-store' }),
  login: (token: string) => json<BrowserAuthState>('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }),
  logout: () => json<BrowserAuthState>('/api/auth/logout', { method: 'POST' }),
  agents: () => json<Agent[]>('/api/agents'), agentModels: (id: string, model?: string, refresh = false) => json<AgentModelsResult>(agentModelsUrl(id, model, refresh)), sessions: () => json<Session[]>('/api/sessions'), events: (id: string, query?: EventWindowQuery) => json<DockEvent[]>(eventsUrl(id, query)), tasks: (id: string) => json<Task[]>(`/api/sessions/${id}/tasks`),
  // 跨运行标题的最小只读契约；服务端接入前 UI 仅使用当前已加载 tasks 的真实 prompt，不伪造摘要。
  runSummaries: () => json<RunSummary[]>(RUN_SUMMARY_ENDPOINT),
  create: (body: { agentId: string; cwd?: string; model?: string; reasoningEffort?: string; permissionMode?: PermissionMode }) => json<Session>('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  send: (id: string, prompt: string, mode: 'queue' | 'interrupt' = 'queue') => json<{ accepted: true; task: Task }>(`/api/sessions/${id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, mode }) }),
  setSessionModel: (id: string, model: string) => json<Session>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) }),
  setSessionReasoningEffort: (id: string, reasoningEffort: string) => json<Session>(`/api/sessions/${id}/config`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reasoningEffort }) }),
  cancelQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}`, { method: 'DELETE' }),
  steerQueued: (id: string, taskId: string) => json<Task>(`/api/sessions/${id}/queue/${taskId}/steer`, { method: 'POST' }),
  larkConfig: () => json<LarkConfig>('/api/lark/config'),
  startLarkOpenPlatformSetup: (appId: string, forceLogin = false) => json<LarkOpenPlatformSetupJob>('/api/lark/open-platform/configure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, forceLogin }) }),
  larkOpenPlatformSetupJob: (jobId: string) => json<LarkOpenPlatformSetupJob>(`/api/lark/open-platform/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' }),
  inspectLarkBot: (body: { appId: string; appSecret: string }) => json<{ appName: string; openId: string; avatarUrl?: string; activateStatus?: number }>('/api/lark/bot/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  saveLarkConfig: (body: { stage: 'lark' | 'agent'; originalAppId?: string; appId?: string; appSecret?: string; workspace?: string; webBaseUrl?: string; defaultAgentId?: string; defaultModel?: string; defaultReasoningEffort?: string; fullTrustConfirmed?: boolean; preInjectPrompt?: string; listening?: boolean; groupToolsEnabled?: boolean; groupToolsAllowSend?: boolean; pushIntervalMs?: number; traceLimit?: number | null; allowedUsers?: LarkAllowedUser[]; allowedUserNames?: string[]; allowedEmails?: string[]; allowedBots?: LarkAllowedUser[]; allowedBotNames?: string[]; peerBotsAllowed?: boolean; highRiskAllowedUsers?: LarkAllowedUser[]; highRiskAllowedUserNames?: string[]; highRiskAllowedEmails?: string[]; highRiskPattern?: string; riskControlMode?: RiskControlMode }) => json<LarkConfig>('/api/lark/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  deleteLarkConfig: (appId: string) => json<LarkConfig>(`/api/lark/config/${encodeURIComponent(appId)}`, { method: 'DELETE' }),
  larkHookStatus: (appId: string, agentId?: string) => {
    const query = new URLSearchParams({ appId });
    if (agentId) query.set('agentId', agentId);
    return json<LarkHookStatus>(`/api/lark/hooks/status?${query.toString()}`);
  },
  installLarkHook: (appId: string, highRiskPattern: string) => json<LarkHookStatus>('/api/lark/hooks/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, highRiskPattern }) }),
  systemCapabilities: () => json<{ platform: string; directoryPicker: boolean; filePicker: boolean }>('/api/system/capabilities'),
  skills: (cwd?: string) => json<SkillReference[]>(`/api/system/skills${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  selectDirectory: () => json<{ path: string }>('/api/system/select-directory', { method: 'POST' }),
  selectFile: () => json<{ path: string }>('/api/system/select-file', { method: 'POST' }),
  archive: (id: string) => json<Session>(`/api/sessions/${id}/archive`, { method: 'POST' }),
  restart: (id: string) => json<Session>(`/api/sessions/${id}/restart`, { method: 'POST' }),
  action: (id: string, action: string) => json(`/api/sessions/${id}/${action}`, { method: 'POST' }),
  permission: (id: string, permissionId: string, approved: boolean) => json(`/api/sessions/${id}/permissions/${permissionId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved }) })
};
