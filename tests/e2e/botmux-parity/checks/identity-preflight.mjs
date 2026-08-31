#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const targets = [
  'apps/server/src/lark/identity-preflight.test.ts',
  'apps/server/src/identity-preflight.service.test.ts',
  'apps/server/src/identity-preflight-cli.test.ts',
];

// The service test intentionally creates a disposable access token. Keep all
// child output private even on failure so neither that token nor fake-Lark
// canaries can cross the parity runner's public output boundary.
const result = spawnSync(process.execPath, [
  'node_modules/vitest/vitest.mjs',
  'run',
  ...targets,
  '--project',
  'node',
], {
  cwd: repositoryRoot,
  env: { ...process.env, NO_COLOR: '1' },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 300_000,
});

if (result.status === 0) {
  process.stdout.write(`${JSON.stringify({
    check: 'identity_preflight_loopback',
    status: 'pass',
    evidence_targets: targets.length,
    network_scope: 'loopback_fake_lark_only',
    activation_changed: false,
    listener_readiness: 'blocked',
  })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({
    check: 'identity_preflight_loopback',
    status: 'fail',
    error_code: result.error?.code === 'ETIMEDOUT' ? 'IDENTITY_PREFLIGHT_EVIDENCE_TIMEOUT' : 'IDENTITY_PREFLIGHT_EVIDENCE_FAILED',
  })}\n`);
  process.exitCode = result.status ?? 1;
}
