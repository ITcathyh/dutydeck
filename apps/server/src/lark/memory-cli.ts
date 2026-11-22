import { AgentGroupToolHttpClient } from '../agent-host/http-client.js';

export interface MemoryCliClientOptions { turn?: string; env?: NodeJS.ProcessEnv; fetcher?: typeof globalThis.fetch }

export function runMemoryList(options: MemoryCliClientOptions & { topic?: string } = {}): Promise<Record<string, unknown>> {
  const query = options.topic ? `?topic=${encodeURIComponent(options.topic)}` : '';
  return new AgentGroupToolHttpClient(options).callLegacy('memory.list', [], {}, query);
}

export function runMemoryShow(topic: string, options: MemoryCliClientOptions = {}): Promise<Record<string, unknown>> {
  return new AgentGroupToolHttpClient(options).callLegacy('memory.show', [topic]);
}

export function runMemorySearch(query: string, options: MemoryCliClientOptions & { topic?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
  return new AgentGroupToolHttpClient(options).callLegacy('memory.search', [query], { ...options, topic: options.topic || undefined });
}

export function runMemoryAdd(content: string, options: MemoryCliClientOptions & { topic?: string } = {}): Promise<Record<string, unknown>> {
  return new AgentGroupToolHttpClient(options).callLegacy('memory.add', [content], { topic: options.topic || undefined });
}

export function runMemoryRemove(id: string, options: MemoryCliClientOptions = {}): Promise<Record<string, unknown>> {
  return new AgentGroupToolHttpClient(options).callLegacy('memory.remove', [id]);
}
