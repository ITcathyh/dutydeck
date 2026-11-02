import { fileURLToPath, URL } from 'node:url';

export const vitestAliases = {
  '@dutydeck/plugin-sdk': fileURLToPath(new URL('./packages/plugin-sdk/src/index.ts', import.meta.url)),
  '@dutydeck/acp-client': fileURLToPath(new URL('./packages/acp-client/src/index.ts', import.meta.url)),
  '@dutydeck/runtime': fileURLToPath(new URL('./packages/agent-runtime/src/index.ts', import.meta.url)),
  '@dutydeck/config': fileURLToPath(new URL('./packages/config/src/index.ts', import.meta.url)),
  '@dutydeck/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
  '@dutydeck/storage': fileURLToPath(new URL('./packages/storage/src/index.ts', import.meta.url)),
  '@dutydeck/transports': fileURLToPath(new URL('./packages/transports/src/index.ts', import.meta.url)),
  '@dutydeck/pty-driver': fileURLToPath(new URL('./packages/pty-driver/src/index.ts', import.meta.url)),
  '@dutydeck/cli-adapters': fileURLToPath(new URL('./packages/cli-adapters/src/index.ts', import.meta.url)),
  '@dutydeck/session-backends': fileURLToPath(new URL('./packages/session-backends/src/index.ts', import.meta.url)),
  '@dutydeck/terminal-renderer': fileURLToPath(new URL('./packages/terminal-renderer/src/index.ts', import.meta.url)),
  '@dutydeck/relay': fileURLToPath(new URL('./packages/relay/src/index.ts', import.meta.url))
};
