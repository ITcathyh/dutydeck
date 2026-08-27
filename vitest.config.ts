import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@dockmux/acp-client': fileURLToPath(new URL('./packages/acp-client/src/index.ts', import.meta.url)),
      '@dockmux/runtime': fileURLToPath(new URL('./packages/agent-runtime/src/index.ts', import.meta.url)),
      '@dockmux/config': fileURLToPath(new URL('./packages/config/src/index.ts', import.meta.url)),
      '@dockmux/renderer': fileURLToPath(new URL('./packages/renderer/src/index.ts', import.meta.url)),
      '@dockmux/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@dockmux/storage': fileURLToPath(new URL('./packages/storage/src/index.ts', import.meta.url)),
      '@dockmux/transports': fileURLToPath(new URL('./packages/transports/src/index.ts', import.meta.url)),
      '@dockmux/pty-driver': fileURLToPath(new URL('./packages/pty-driver/src/index.ts', import.meta.url)),
      '@dockmux/cli-adapters': fileURLToPath(new URL('./packages/cli-adapters/src/index.ts', import.meta.url)),
      '@dockmux/session-backends': fileURLToPath(new URL('./packages/session-backends/src/index.ts', import.meta.url)),
      '@dockmux/terminal-renderer': fileURLToPath(new URL('./packages/terminal-renderer/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000
  }
});
