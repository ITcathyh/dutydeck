import { createRepositories } from '../src/index.js';
import type { RepositoryBundle } from '@dutydeck/shared';

let repos: RepositoryBundle | undefined;
let claim: { release(): void } | undefined;

process.on('message', async (message: { id: number; action: string; path: string; instanceId?: string }) => {
  try {
    if (message.action === 'open') {
      repos = createRepositories(message.path, { mode: 'runtime' });
      claim = repos.control.attachRuntime(message.instanceId ?? 'worker-instance');
      process.send?.({ id: message.id, value: true });
      return;
    }
    if (message.action === 'close') {
      claim?.release();
      claim = undefined;
      repos?.close();
      repos = undefined;
      process.send?.({ id: message.id, value: true });
      return;
    }
    throw new Error(`Unknown action: ${message.action}`);
  } catch (error) {
    process.send?.({ id: message.id, error: String(error) });
  }
});

process.send?.({ event: 'ready' });
