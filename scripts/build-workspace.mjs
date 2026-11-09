#!/usr/bin/env node
// Builds the workspace packages, the Web UI and the server bundle, then records a fingerprint of the build inputs.
//   node scripts/build-workspace.mjs               always build (pnpm build)
//   node scripts/build-workspace.mjs --if-changed  skip when the inputs match the last successful build (e2e, verify:package)
//   node scripts/build-workspace.mjs --typecheck   after a build of the same inputs, check only the esbuild-bundled server (pnpm typecheck)
// The fingerprint covers every non-ignored file under the build roots except test files, which no build output contains,
// plus the Node version and install state, so any source, lockfile or patch edit rebuilds. It lives in apps/server/dist,
// which the server build recreates.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = join(root, 'apps/server/dist/.build-inputs');
const inputs = ['apps', 'packages', 'builtin-plugins', 'patches', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'THIRD_PARTY_NOTICES.md', 'scripts/build-workspace.mjs'];
const steps = [
  ['pnpm', ['build:packages']],
  ['pnpm', ['--filter', '@dutydeck/web', 'build']],
  ['pnpm', ['--filter', 'dutydeck', 'build']]
];

function fingerprint() {
  const hash = createHash('sha256');
  hash.update(`node ${process.version}\n`);
  const modules = join(root, 'node_modules/.modules.yaml');
  if (existsSync(modules)) hash.update(readFileSync(modules));
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inputs, ':(exclude,glob)**/*.test.ts', ':(exclude,glob)**/*.test.tsx'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean).sort();
  for (const file of new Set(files)) {
    const path = join(root, file);
    // A tracked file deleted from the working tree hashes as absent.
    hash.update(`${file}\0${existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '-'}\n`);
  }
  return hash.digest('hex');
}

function outputsPresent() {
  const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json')))
    .filter(entry => JSON.parse(readFileSync(join(root, 'packages', entry.name, 'package.json'), 'utf8')).scripts?.build)
    .map(entry => join('packages', entry.name, 'dist'));
  return [...packages, 'apps/web/dist/index.html', 'apps/server/dist/cli.js'].every(path => existsSync(join(root, path)));
}

const before = fingerprint();
const builtFromInputs = outputsPresent() && existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === before;
if (process.argv.includes('--typecheck')) {
  // tsc already checked the packages and the Web UI during that build.
  const args = builtFromInputs ? ['--filter', 'dutydeck', 'typecheck'] : ['-r', 'typecheck'];
  process.exit(spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' }).status ?? 1);
}
if (process.argv.includes('--if-changed') && builtFromInputs) {
  console.log('[build] inputs unchanged since the last build; reusing it (pnpm build forces a rebuild)');
  process.exit(0);
}
for (const [command, args] of steps) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Record the inputs as they were when the build started; an edit made during the build rebuilds next time.
writeFileSync(stampPath, `${before}\n`);
