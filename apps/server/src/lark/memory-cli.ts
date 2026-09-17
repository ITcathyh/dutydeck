import { AgentGroupToolHttpClient } from './agent-tools-cli.js';

interface MemoryCliClientOptions { env?: NodeJS.ProcessEnv; fetcher?: typeof globalThis.fetch }

const path = '/memory';

export function runMemoryList(options: MemoryCliClientOptions = {}): Promise<Record<string, unknown>> {
  return new AgentGroupToolHttpClient(options).request(path);
}

export function runMemoryAdd(content: string, options: MemoryCliClientOptions = {}): Promise<Record<string, unknown>> {
  return new AgentGroupToolHttpClient(options).request(path, { method: 'POST', body: JSON.stringify({ content }) });
}

export function runMemoryRemove(id: string, options: MemoryCliClientOptions = {}): Promise<Record<string, unknown>> {
  return new AgentGroupToolHttpClient(options).request(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
