#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFilesResultSchema, engineVersionInfoSchema } from '@dutydeck/shared';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/server');
const sample = [
  { type: 'session_meta', payload: { id: 'sess_packverify_1', cwd: '/work/pack-verify' } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'pack verify prompt' } },
  { type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
  } } }
].map(row => JSON.stringify(row)).join('\n') + '\n';

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = { '--tarball': 'tarball', '--unpacked-dir': 'unpackedDir', '--fixture': 'fixture' }[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node scripts/verify-session-insight-package.mjs [--tarball path | --unpacked-dir path] [--fixture path]');
    }
    options[key] = resolve(args[++i]);
  }
  if (options.tarball && options.unpackedDir) throw new Error('Choose a tarball or unpacked package, not both.');
  return options;
}

/** Verify the actual distributed script with no checkout, PATH tools, loaders or inherited credentials. */
export function verifyPackageDirectory(packageRoot, options = {}) {
  const entrypoint = join(packageRoot, 'dist/assets/session-insight/cli.js');
  if (!existsSync(entrypoint) || !statSync(entrypoint).isFile()) {
    throw new Error('Packaged Node analyzer entrypoint is missing. Build the server first.');
  }
  assert.ok(existsSync(join(packageRoot, 'dist/assets/THIRD_PARTY_NOTICES.md')), 'Packaged third-party notices are missing.');
  const isolatedDir = mkdtempSync(join(tmpdir(), 'dutydeck-insight-runtime-'));
  try {
    const runOptions = {
      cwd: isolatedDir,
      env: { PATH: '', HOME: isolatedDir, TMPDIR: isolatedDir },
      encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL'
    };
    const versions = engineVersionInfoSchema.parse(JSON.parse(
      execFileSync(process.execPath, [entrypoint, 'version', '--json'], runOptions)
    ));
    assert.equal(versions.engineVersion, 'dutydeck-ts-v1');
    assert.equal(versions.parserVersion, 'ts-v1');
    assert.equal(versions.metricVersion, 'v2');
    const content = options.fixture ? readFileSync(options.fixture, 'utf8') : sample;
    assert.ok(content.trim(), 'Analysis fixture is empty.');
    const meta = JSON.parse(content.trim().split('\n')[0]);
    const nativeId = meta.payload?.id;
    assert.ok(typeof nativeId === 'string' && nativeId, 'A Codex session_meta fixture is required.');
    const snapshotPath = join(isolatedDir, 'snapshot.jsonl');
    writeFileSync(snapshotPath, content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const requestId = randomUUID();
    const request = {
      schemaVersion: 1, requestId,
      files: [{ sourceKey: 'packverify-primary', client: 'codex', path: snapshotPath,
        sha256, bytes: Buffer.byteLength(content), expectedNativeSessionId: nativeId,
        expectedStream: { kind: 'main', nativeAgentId: null } }],
      limits: { maxLineBytes: 4194304, maxTraceEvents: 20000 }
    };
    const result = analyzeFilesResultSchema.parse(JSON.parse(
      execFileSync(process.execPath, [entrypoint, 'analyze', '--format', 'json'], {
        ...runOptions, input: JSON.stringify(request)
      })
    ));
    assert.equal(result.requestId, requestId);
    for (const key of ['schemaVersion', 'engineVersion', 'parserVersion', 'metricVersion']) {
      assert.equal(result[key], versions[key], `Analysis ${key} differs from handshake.`);
    }
    assert.equal(result.files.length, 1);
    const file = result.files[0];
    assert.notEqual(file.status, 'error');
    assert.equal(file.sourceKey, 'packverify-primary');
    assert.equal(file.client, 'codex');
    assert.equal(file.sha256, sha256);
    assert.equal(file.nativeSessionId, nativeId);
    assert.deepEqual(file.streamIdentity, { kind: 'main', nativeAgentId: null });
    assert.ok(file.coverage.rawLines > 0 && file.coverage.parsedLines > 0, 'Analyzer must process non-empty input.');
    const rows = content.trim().split('\n').map(line => JSON.parse(line));
    const usages = rows.filter(row => row.type === 'event_msg' && row.payload?.type === 'token_count')
      .map(row => row.payload.info?.total_token_usage).filter(Boolean);
    assert.ok(usages.length, 'Fixture must include cumulative usage evidence.');
    assert.equal(file.metrics.rawOutput.value, usages.at(-1).output_tokens);
    assert.equal(file.metrics.rawTotal.value, usages.at(-1).total_tokens);
    assert.ok(file.metrics.rawOutput.value > 0 && file.metrics.rawTotal.value > 0);
    const hasReset = rows.some(row => row.type === 'session_reset' || row.payload?.type === 'session_reset');
    if (!hasReset && usages[0].output_tokens > 0) {
      assert.equal(file.metrics.output.value, null, 'A non-zero first counter has no confirmed baseline.');
      assert.equal(file.metrics.output.status, 'partial');
      assert.ok(file.metrics.output.reasonCodes.includes('UNKNOWN_BASELINE'));
    }
    return { entrypoint: 'dist/assets/session-insight/cli.js', versions, runtime: 'verified with empty PATH and isolated cwd', bytes: statSync(entrypoint).size };
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
}

export async function runVerify(options = {}) {
  const extraction = mkdtempSync(join(tmpdir(), 'dutydeck-insight-package-'));
  try {
    let packageRoot = options.unpackedDir;
    if (!packageRoot) {
      let tarball = options.tarball;
      if (!tarball) {
        // Package existing build output; prepack would rebuild the same files.
        const output = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', extraction], {
          cwd: serverDir, encoding: 'utf8'
        });
        tarball = join(extraction, JSON.parse(output)[0].filename);
      }
      execFileSync('tar', ['-xzf', tarball, '-C', extraction]);
      packageRoot = join(extraction, 'package');
    }
    return verifyPackageDirectory(packageRoot, options);
  } finally {
    rmSync(extraction, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runVerify(parseArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(`Session insight package verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
