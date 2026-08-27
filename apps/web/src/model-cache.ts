import { api, type AgentModel, type AgentModelsResult } from './api';

type ModelCacheStorage = Pick<Storage, 'getItem' | 'setItem'>;
type CachedAgentModels = { savedAt: number; value: AgentModelsResult };

const CACHE_PREFIX = 'dockmux.agent_models.v1';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const browserStorage = (): ModelCacheStorage | undefined => {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; }
  catch { return undefined; }
};

const cacheKey = (agentId: string, model?: string) => `${CACHE_PREFIX}:${encodeURIComponent(agentId)}:${encodeURIComponent(model ?? '')}`;

const validOptions = (value: unknown): value is AgentModel[] => Array.isArray(value) && value.every(option => option && typeof option === 'object' && typeof (option as AgentModel).id === 'string' && typeof (option as AgentModel).name === 'string');

const validResult = (value: unknown): value is AgentModelsResult => {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<AgentModelsResult>;
  return validOptions(result.models) && validOptions(result.reasoningEfforts)
    && (result.defaultModel === undefined || typeof result.defaultModel === 'string')
    && (result.defaultReasoningEffort === undefined || typeof result.defaultReasoningEffort === 'string')
    && (result.source === undefined || result.source === 'acp' || result.source === 'cli' || result.source === 'agent');
};

export const agentModelsQueryKey = (agentId?: string, model?: string) => ['agent-models', agentId ?? '', model ?? ''] as const;

export function readCachedAgentModels(agentId: string, model?: string, storage: ModelCacheStorage | undefined = browserStorage(), now = Date.now()): AgentModelsResult | undefined {
  if (!agentId || !storage) return undefined;
  try {
    const raw = storage.getItem(cacheKey(agentId, model));
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as Partial<CachedAgentModels>;
    if (typeof cached.savedAt !== 'number' || now - cached.savedAt > CACHE_MAX_AGE_MS || !validResult(cached.value)) return undefined;
    return cached.value;
  } catch { return undefined; }
}

export function writeCachedAgentModels(agentId: string, model: string | undefined, value: AgentModelsResult, storage: ModelCacheStorage | undefined = browserStorage(), now = Date.now()): void {
  if (!agentId || !storage || !validResult(value)) return;
  try { storage.setItem(cacheKey(agentId, model), JSON.stringify({ savedAt: now, value } satisfies CachedAgentModels)); }
  catch { /* localStorage may be unavailable or full; the network result remains usable. */ }
}

export async function loadAgentModels(agentId: string, model?: string, refresh = false): Promise<AgentModelsResult> {
  const result = await api.agentModels(agentId, model, refresh);
  writeCachedAgentModels(agentId, model, result);
  return result;
}
