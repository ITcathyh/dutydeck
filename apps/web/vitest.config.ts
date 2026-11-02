import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { vitestAliases } from '../../vitest.aliases';

// Web 侧测试 project（jsdom 环境）。
//
// 为什么单独一个配置文件、而不是写在根 vitest.config.ts 的 projects 内联对象里：
// jsdom / @vitejs/plugin-react / @testing-library/* 只装在 apps/web 的 devDependencies，
// pnpm 不做提升，所以它们在仓库根目录**不可解析**（node -e "import('jsdom')" 在根会
// ERR_MODULE_NOT_FOUND）。把 project 拆成独立配置文件后，该 project 的 root 就是 apps/web，
// 插件 import 与 environment: 'jsdom' 的解析都发生在 apps/web 下，才能找到这些包。
export default defineConfig({
  plugins: [react()],
  resolve: { alias: vitestAliases },
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
