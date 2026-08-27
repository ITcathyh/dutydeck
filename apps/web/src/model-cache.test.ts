import { describe, expect, it, vi } from 'vitest';
import { readCachedAgentModels, writeCachedAgentModels } from './model-cache';

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); })
  };
};

const result = {
  models: [{ id: 'opus', name: 'Opus' }],
  defaultModel: 'opus',
  reasoningEfforts: [{ id: 'max', name: 'Max' }],
  defaultReasoningEffort: 'max',
  source: 'acp' as const
};

describe('agent model cache', () => {
  it('reuses the last successful model result for the same agent and model', () => {
    const storage = memoryStorage();
    writeCachedAgentModels('claude', 'opus', result, storage, 1_000);
    expect(readCachedAgentModels('claude', 'opus', storage, 2_000)).toEqual(result);
    expect(readCachedAgentModels('claude', 'sonnet', storage, 2_000)).toBeUndefined();
  });

  it('ignores expired and malformed cache entries', () => {
    const storage = memoryStorage();
    writeCachedAgentModels('claude', 'opus', result, storage, 1_000);
    expect(readCachedAgentModels('claude', 'opus', storage, 8 * 24 * 60 * 60_000)).toBeUndefined();
    storage.setItem('dockmux.agent_models.v1:claude:opus', '{bad json');
    expect(readCachedAgentModels('claude', 'opus', storage, 2_000)).toBeUndefined();
  });

  it('does not fail when browser storage rejects writes', () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(() => writeCachedAgentModels('claude', 'opus', result, storage)).not.toThrow();
  });
});
