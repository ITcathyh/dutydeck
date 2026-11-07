import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');

if (!process.env.DUTYDECK_E2E_RUN_ID) {
  process.env.DUTYDECK_E2E_RUN_ID = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}`;
}
const runId = process.env.DUTYDECK_E2E_RUN_ID;

if (!process.env.DUTYDECK_E2E_ARTIFACT_DIR) {
  process.env.DUTYDECK_E2E_ARTIFACT_DIR = join(REPO_ROOT, 'artifacts/e2e', runId);
}
const artifactDir = process.env.DUTYDECK_E2E_ARTIFACT_DIR;

// Each test owns its server, database, HOME, tmux socket and ports (harness.ts / lark-fixture.ts), so files run on
// parallel workers. Half the CPUs, capped at 4: more workers mostly add load-induced timeouts on shared machines.
const requestedWorkers = Number(process.env.DUTYDECK_E2E_WORKERS);
const workers = Number.isInteger(requestedWorkers) && requestedWorkers > 0
  ? requestedWorkers
  : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
mkdirSync(artifactDir, { recursive: true });

let gitSha = 'unknown';
let gitDirty = false;
try {
  gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  gitDirty = Boolean(status);
} catch {}

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers,
  outputDir: join(artifactDir, 'test-results'),
  metadata: {
    runId,
    artifactDir,
    gitSha,
    gitDirty,
    boundary: 'mock CLI (Claude Code v2.1.267) & synthetic transports; real Chromium, Fastify HTTP, SQLite, Git worktrees and DutydeckRuntime',
    createdAt: new Date().toISOString()
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: join(artifactDir, 'html'), open: 'never' }],
    ['json', { outputFile: join(artifactDir, 'results.json') }]
  ],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 960 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off'
  },
  projects: [
    {
      name: 'core',
      testIgnore: '**/lark.spec.ts',
    },
    {
      name: 'extended',
      testMatch: '**/lark.spec.ts',
      timeout: 180_000,
    }
  ]
});
