import { AgentGroupToolHttpClient } from './agent-tools-cli.js';

export interface MemoryCliClientOptions { env?: NodeJS.ProcessEnv; fetcher?: typeof globalThis.fetch }

const path = '/memory';

export function runMemoryList(options: MemoryCliClientOptions & { topic?: string } = {}): Promise<Record<string, unknown>> {
  const query = options.topic ? `?topic=${encodeURIComponent(options.topic)}` : '';
  return new AgentGroupToolHttpClient(options).request(`${path}${query}`);
}

export function runMemoryShow(topic: string, options: MemoryCliClientOptions = {}): Promise<Record<string, unknown>> {
  return new AgentGroupToolHttpClient(options).request(`${path}/topics/${encodeURIComponent(topic)}`);
}

export function runMemorySearch(query: string, options: MemoryCliClientOptions & { topic?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({ q: query });
  if (options.topic) params.set('topic', options.topic);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  return new AgentGroupToolHttpClient(options).request(`${path}/search?${params.toString()}`);
}

export function runMemoryAdd(content: string, options: MemoryCliClientOptions & { topic?: string } = {}): Promise<Record<string, unknown>> {
  return new AgentGroupToolHttpClient(options).request(path, {
    method: 'POST',
    body: JSON.stringify({ content, ...(options.topic ? { topic: options.topic } : {}) })
  });
}

export function runMemoryRemove(id: string, options: MemoryCliClientOptions = {}): Promise<Record<string, unknown>> {
  return new AgentGroupToolHttpClient(options).request(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
