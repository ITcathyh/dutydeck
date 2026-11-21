import { createRepositories } from '@dutydeck/storage';
import type { StoredLarkConfig } from './config.js';
import { larkBotsConfigKey } from './config.js';
import { DutydeckRuntime } from '@dutydeck/runtime';

// Test ledgers override the ID read. Use the runtime's own key lookup so both
// entry points observe the same accepted record and injected read failures.
export const readTestAcceptanceByKey = DutydeckRuntime.prototype.getAcceptedTaskByKey;

export async function createMemoryLarkRuntime(config: StoredLarkConfig) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
  await runtime.initialize([]);
  return {
    runtime, store: repos.config, cardMappings: repos.channelMappings,
    async close() {
      try { await runtime.shutdown(); } finally { repos.close(); }
    }
  };
}
