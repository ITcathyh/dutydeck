import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { vitestAliases } from './vitest.aliases';

const alias = {
  // Native ESM drizzle costs about 460 ms per test file (Node re-reads its exports map for every file); the CJS build about 80 ms.
  'drizzle-orm/better-sqlite3': fileURLToPath(new URL('./packages/storage/node_modules/drizzle-orm/better-sqlite3/index.cjs', import.meta.url)),
  'drizzle-orm/sqlite-core': fileURLToPath(new URL('./packages/storage/node_modules/drizzle-orm/sqlite-core/index.cjs', import.meta.url)),
  'drizzle-orm': fileURLToPath(new URL('./packages/storage/node_modules/drizzle-orm/index.cjs', import.meta.url)),
  '@dutydeck/shared/child-environment': fileURLToPath(new URL('./packages/shared/runtime/child-environment.mjs', import.meta.url)),
  '@dutydeck/shared/secret-guard': fileURLToPath(new URL('./packages/shared/runtime/secret-guard.mjs', import.meta.url)),
  '@dutydeck/shared/safe-git': fileURLToPath(new URL('./packages/shared/runtime/safe-git.mjs', import.meta.url)),
  ...vitestAliases,
  '@dutydeck/secret-provider': fileURLToPath(new URL('./packages/secret-provider/src/index.ts', import.meta.url))
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
    // 本地机器常被多人或多个 Agent 共用：默认只占四分之一的核（上限 16），CI 沿用 Vitest 默认；命令行 --maxWorkers 可覆盖。
    maxWorkers: process.env.CI ? undefined : Math.max(1, Math.min(16, Math.floor(availableParallelism() / 4))),
    // The forks pool queues every node-environment file before any jsdom file, so in one pool the web tests only started
    // after the node tests and their slowest files ran alone at the end. The web project uses the threads pool instead
    // (see apps/web/vitest.config.ts); pools run side by side, and this small cap keeps it from competing with node.
    poolOptions: { threads: { maxThreads: 3, minThreads: 1 } },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          // 注意 apps/** 收窄到 apps/server/**：apps/web 的测试归 web project（jsdom），
          // 否则同一份文件会被两个 project 各跑一遍。
          include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts', 'plugins/**/*.test.ts', 'builtin-plugins/**/*.test.ts', 'tests/**/*.test.ts'],
          setupFiles: [fileURLToPath(new URL('./tests/setup/node-env.ts', import.meta.url))],
          testTimeout: 15_000,
          hookTimeout: 15_000,
          // New test databases copy the schema the real migrations produced once per worker instead of replaying every
          // migration (about a third of the suite's time); see FRESH_SCHEMA_TEMPLATE_ENV in packages/storage/src/migrations.ts.
          env: { DUTYDECK_TEST_FRESH_SCHEMA_TEMPLATE: '1' }
        }
      },
      './apps/web/vitest.config.ts'
    ]
  }
});
