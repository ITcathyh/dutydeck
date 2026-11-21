import type { BoundExecutionRepository, RepositoryBundle } from '@dutydeck/shared';
import { vi } from 'vitest';

/** Observe the writer issued to the runtime, including after a restart. */
export function captureBoundExecution(repos: RepositoryBundle): () => BoundExecutionRepository {
  const bind = vi.spyOn(repos.execution, 'bind');
  return () => {
    const result = bind.mock.results.at(-1);
    if (result?.type !== 'return') throw new Error('The runtime has not bound its execution repository');
    return result.value;
  };
}
