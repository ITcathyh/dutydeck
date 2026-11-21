import { json, send } from './client';

export type LarkMemoryGroupStatus = {
  appId: string;
  pool: string;
  shared: boolean;
  liveEntries: number;
  topics: number;
  pendingTurns: number;
  running?: { kind: 'extraction' | 'consolidation'; sessionId?: string; startedAt: string };
  lastRun?: {
    kind: 'extraction' | 'consolidation';
    at: string;
    ok: boolean;
    added: number;
    superseded: number;
    retired: number;
    retopiced: number;
    rejected: number;
    error?: string;
  };
  lastRunLabel?: string;
  lastExtractionAt?: string;
  lastConsolidationAt?: string;
  lastFailureAt?: { extraction?: string; consolidation?: string };
};

export type LarkMemoryStatusResult = {
  appId: string;
  enabled: boolean;
  /** 当前群记忆范围；旧服务端缺省按 shared 处理。groups 始终是各群共享池（per-group 时不再被读写，数据保留）。 */
  groupMemoryScope?: 'shared' | 'per-group';
  claudeAutoMemory?: 'inherit' | 'off';
  groups: LarkMemoryGroupStatus;
};

export type LarkTurnMemoryEntry = { id: string; content: string; topic: string; source: 'user' | 'agent' | 'extraction' | 'consolidation'; createdAt: string; deletedAt?: string };
/** 一轮任务注入了哪些记忆、新写入了哪些记忆；按任务记录，newest first。 */
export type LarkTurnMemory = { taskId: string; at: string; shared: boolean; perGroup?: boolean; injected: LarkTurnMemoryEntry[]; written: LarkTurnMemoryEntry[] };

export interface MemoryManagementEntry extends LarkTurnMemoryEntry {
  supersedes?: string[];
  supersededBy?: string;
  origin?: { label: string; sessionId?: string; taskId?: string };
}
export interface MemoryPoolView { scope?: string; entries: MemoryManagementEntry[]; fingerprint: string; historyNotice: string }
export interface MemoryWrite { content: string; topic?: string; expectedFingerprint: string }
export interface ProjectMemorySummary { id: string; name: string; enabled: boolean; count?: number }

export const memoryRequests = {
  larkMemoryStatus: (appId: string) => json<LarkMemoryStatusResult>(`/api/lark/bots/${encodeURIComponent(appId)}/memory/status`, { cache: 'no-store' }),
  memoryPool: (sessionId: string, q = '') => json<MemoryPoolView>(`/api/sessions/${encodeURIComponent(sessionId)}/memory-pool${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  reviseMemoryPool: (sessionId: string, entryId: string, body: MemoryWrite) => send('PATCH', `/api/sessions/${encodeURIComponent(sessionId)}/memory-pool/${encodeURIComponent(entryId)}`, body),
  removeMemoryPool: (sessionId: string, entryId: string) => json(`/api/sessions/${encodeURIComponent(sessionId)}/memory-pool/${encodeURIComponent(entryId)}`, { method: 'DELETE' }),
  projectMemories: () => json<{ projects: ProjectMemorySummary[] }>('/api/project-memory'),
  createProjectMemory: (name: string) => send<{ project: ProjectMemorySummary }>('POST', '/api/project-memory', { name }),
  projectMemory: (id: string, q = '') => json<MemoryPoolView & ProjectMemorySummary>(`/api/project-memory/${encodeURIComponent(id)}${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  setProjectMemoryEnabled: (id: string, enabled: boolean) => send('PATCH', `/api/project-memory/${encodeURIComponent(id)}`, { enabled }),
  writeProjectMemory: (id: string, body: MemoryWrite, entryId?: string) => send(entryId ? 'PATCH' : 'POST', `/api/project-memory/${encodeURIComponent(id)}/entries${entryId ? `/${encodeURIComponent(entryId)}` : ''}`, body),
  removeProjectMemory: (id: string, entryId: string) => json(`/api/project-memory/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' }),
  projectMemoryBinding: (sessionId: string) => json<{ projectId: string | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/project-memory`),
  bindProjectMemory: (sessionId: string, projectId: string | null) => send('PUT', `/api/sessions/${encodeURIComponent(sessionId)}/project-memory`, { projectId }),
  sessionMemory: (sessionId: string) => json<{ turns: LarkTurnMemory[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/memory`, { cache: 'no-store' }),
  forgetSessionMemory: (sessionId: string, taskId: string, memoryId: string) => json<{ removed: { id: string } }>(`/api/sessions/${encodeURIComponent(sessionId)}/memory/${encodeURIComponent(taskId)}/entries/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }),
};
