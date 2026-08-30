import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

const alias = {
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
  '@dockmux/terminal-renderer': fileURLToPath(new URL('./packages/terminal-renderer/src/index.ts', import.meta.url)),
  '@dockmux/skills': fileURLToPath(new URL('./packages/skills/src/index.ts', import.meta.url)),
      '@dockmux/workflow': fileURLToPath(new URL('./packages/workflow/src/index.ts', import.meta.url)),
      '@dockmux/relay': fileURLToPath(new URL('./packages/relay/src/index.ts', import.meta.url))
};

// 两个 project：
//   node — packages/** + apps/server/** + tests/**，environment node（原有行为，超时 15s 不变）
//   web  — apps/web/**，environment jsdom，见 apps/web/vitest.config.ts
//
// web project 之所以引用独立配置文件而不是内联：jsdom / @vitejs/plugin-react /
// @testing-library/* 只装在 apps/web 的 devDependencies，pnpm 不提升到根 node_modules，
// 内联 project 的 root 是仓库根目录，import 这些包会 ERR_MODULE_NOT_FOUND。
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          // 注意 apps/** 收窄到 apps/server/**：apps/web 的测试归 web project（jsdom），
          // 否则同一份文件会被两个 project 各跑一遍。
          include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts', 'tests/**/*.test.ts'],
          testTimeout: 15_000,
          hookTimeout: 15_000
        }
      },
      './apps/web/vitest.config.ts'
    ]
  }
});
