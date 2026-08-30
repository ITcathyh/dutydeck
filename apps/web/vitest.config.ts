import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Web 侧测试 project（jsdom 环境）。
//
// 为什么单独一个配置文件、而不是写在根 vitest.config.ts 的 projects 内联对象里：
// jsdom / @vitejs/plugin-react / @testing-library/* 只装在 apps/web 的 devDependencies，
// pnpm 不做提升，所以它们在仓库根目录**不可解析**（node -e "import('jsdom')" 在根会
// ERR_MODULE_NOT_FOUND）。把 project 拆成独立配置文件后，该 project 的 root 就是 apps/web，
// 插件 import 与 environment: 'jsdom' 的解析都发生在 apps/web 下，才能找到这些包。
//
// ⚠️ 下面的 alias 表与根 vitest.config.ts 保持一致，新增 @dockmux/* 包时两处都要加。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@dockmux/acp-client': fileURLToPath(new URL('../../packages/acp-client/src/index.ts', import.meta.url)),
      '@dockmux/runtime': fileURLToPath(new URL('../../packages/agent-runtime/src/index.ts', import.meta.url)),
      '@dockmux/config': fileURLToPath(new URL('../../packages/config/src/index.ts', import.meta.url)),
      '@dockmux/renderer': fileURLToPath(new URL('../../packages/renderer/src/index.ts', import.meta.url)),
      '@dockmux/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@dockmux/storage': fileURLToPath(new URL('../../packages/storage/src/index.ts', import.meta.url)),
      '@dockmux/transports': fileURLToPath(new URL('../../packages/transports/src/index.ts', import.meta.url)),
      '@dockmux/pty-driver': fileURLToPath(new URL('../../packages/pty-driver/src/index.ts', import.meta.url)),
      '@dockmux/cli-adapters': fileURLToPath(new URL('../../packages/cli-adapters/src/index.ts', import.meta.url)),
      '@dockmux/session-backends': fileURLToPath(new URL('../../packages/session-backends/src/index.ts', import.meta.url)),
      '@dockmux/terminal-renderer': fileURLToPath(new URL('../../packages/terminal-renderer/src/index.ts', import.meta.url)),
      '@dockmux/skills': fileURLToPath(new URL('../../packages/skills/src/index.ts', import.meta.url)),
      '@dockmux/workflow': fileURLToPath(new URL('../../packages/workflow/src/index.ts', import.meta.url)),
      '@dockmux/relay': fileURLToPath(new URL('../../packages/relay/src/index.ts', import.meta.url))
    }
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: false,
    setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))],
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 15_000,
    hookTimeout: 15_000
  }
});
