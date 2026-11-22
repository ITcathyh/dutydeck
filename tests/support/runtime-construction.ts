import type { DutydeckRuntime, RuntimeOptions } from '@dutydeck/runtime';
import type { RepositoryBundle } from '@dutydeck/shared';
import { vi } from 'vitest';

const inputs = new WeakMap<DutydeckRuntime, { options: RuntimeOptions; repos: RepositoryBundle }>();
export const configureRuntime = vi.fn<(options: RuntimeOptions, repos: RepositoryBundle) => void>();

vi.mock('@dutydeck/runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('@dutydeck/runtime')>();
  return {
    ...runtime,
    DutydeckRuntime: class extends runtime.DutydeckRuntime {
      constructor(repos: RepositoryBundle, options: RuntimeOptions = {}) {
        configureRuntime(options, repos);
        super(repos, options);
        inputs.set(this, { repos, options });
      }
    },
  };
});

export function runtimeInputs(runtime: DutydeckRuntime) {
  const input = inputs.get(runtime);
  if (!input) throw new Error('Runtime constructor was not observed');
  return input;
}
