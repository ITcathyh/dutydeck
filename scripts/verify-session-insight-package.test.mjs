import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseArgs, runVerify, verifyPackageDirectory } from './verify-session-insight-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('package verifier rejects obsolete or ambiguous arguments', () => {
  assert.throws(() => parseArgs(['--allow-unlicensed-for-local-debug']));
  assert.throws(() => parseArgs(['--tarball']));
  assert.throws(() => parseArgs(['--tarball', '/one', '--unpacked-dir', '/two']));
  assert.deepEqual(parseArgs(['--unpacked-dir', '/tmp/package']), { unpackedDir: '/tmp/package' });
});

test('package verifier rejects missing entrypoint, stale analyzer versions and fabricated empty output', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'insight-package-test-'));
  try {
    assert.throws(() => verifyPackageDirectory(temporary), /entrypoint is missing/);
    const assets = join(temporary, 'dist/assets');
    mkdirSync(join(assets, 'session-insight'), { recursive: true });
    writeFileSync(join(assets, 'THIRD_PARTY_NOTICES.md'), 'test');
    const handshake = parserVersion => writeFileSync(join(assets, 'session-insight/cli.js'), `process.stdout.write(JSON.stringify({ schemaVersion: 1, engineVersion: "dutydeck-ts-v1", parserVersion: "${parserVersion}", metricVersion: "v2" }));`);
    // A current handshake passes the version check, so the rejection must come from the fabricated analysis output.
    handshake('ts-v2');
    assert.throws(() => verifyPackageDirectory(temporary), error => error.name === 'ZodError' && error.issues.some(issue => issue.path[0] === 'requestId'));
    handshake('ts-v1');
    assert.throws(() => verifyPackageDirectory(temporary), /'ts-v1' !== 'ts-v2'/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('built analyzer runs after npm packing, outside the checkout and without Go or PATH tools', async () => {
  const entrypoint = join(root, 'apps/server/dist/assets/session-insight/cli.js');
  assert.ok(existsSync(entrypoint), 'Run pnpm build before package verification tests.');
  const report = await runVerify();
  assert.equal(report.versions.engineVersion, 'dutydeck-ts-v1');
  assert.equal(report.versions.metricVersion, 'v2');
  assert.equal(report.runtime, 'verified with empty PATH and isolated cwd');
  assert.ok(report.bytes > 0);
  const fixture = join(root, 'tests/fixtures/session-insight/real-native/codex.jsonl');
  const sampleReport = await runVerify({ fixture });
  assert.equal(sampleReport.versions.parserVersion, 'ts-v2');
});

test('built CLI rejects invalid requests with exit 2 and no raw error details', () => {
  const entrypoint = join(root, 'apps/server/dist/assets/session-insight/cli.js');
  const invalidPath = {
    schemaVersion: 1, requestId: '00000000-0000-4000-8000-000000000001',
    files: [{ sourceKey: 'test', client: 'codex', path: 'relative_PRIVATE_CANARY', sha256: 'a'.repeat(64),
      bytes: 1, expectedNativeSessionId: 'test', expectedStream: { kind: 'main', nativeAgentId: null } }],
    limits: { maxLineBytes: 4194304, maxTraceEvents: 20000 }
  };
  for (const input of ['{invalid PRIVATE_CANARY', JSON.stringify({ schemaVersion: 2 }), JSON.stringify(invalidPath)]) {
    assert.throws(() => execFileSync(process.execPath, [entrypoint, 'analyze', '--format', 'json'], {
      env: { PATH: '' }, input, encoding: 'utf8', timeout: 5000
    }), error => error.status === 2 && !String(error.stderr).includes('PRIVATE_CANARY'));
  }
});
