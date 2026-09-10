import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4325', trace: 'retain-on-failure' },
  outputDir: './.artifacts',
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4325 --strictPort',
    cwd: resolve(__dirname, '../../../apps/web'),
    url: 'http://127.0.0.1:4325/e2e/terminal.html',
    reuseExistingServer: !process.env.CI
  }
});
