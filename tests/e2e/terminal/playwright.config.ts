import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Config is synchronous; ask a short-lived child to select an available port.
const port = Number(process.env.DUTYDECK_TERMINAL_E2E_PORT ?? execFileSync(process.execPath, ['-e', `
  const server = require('node:net').createServer();
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(String(server.address().port));
    server.close();
  });
`], { encoding: 'utf8' }));
process.env.DUTYDECK_TERMINAL_E2E_PORT = String(port);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  workers: 2,
  use: { baseURL, trace: 'retain-on-failure' },
  outputDir: './.artifacts',
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: resolve(__dirname, '../../../apps/web'),
    url: `${baseURL}/e2e/terminal.html`,
    reuseExistingServer: false
  }
});
