#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const suiteDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(suiteDirectory, '../../..');
const manifestPath = resolve(suiteDirectory, 'cases.json');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function invariant(value, code) {
  if (!value) fail(code);
}

function parseJson(path, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(code);
  }
}

function parseJsonBytes(bytes, code) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(code);
  }
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function fixtureFiles(path) {
  const info = statSync(path);
  if (info.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) return fixtureFiles(child);
    invariant(entry.isFile(), 'FIXTURE_NON_REGULAR_ENTRY');
    return [child];
  });
}

function assertSyntheticFixtures(fixturePaths) {
  const files = fixturePaths.flatMap(fixtureFiles);
  for (const path of files) {
    const bytes = readFileSync(path);
    invariant(bytes.byteLength <= 1024 * 1024, 'FIXTURE_TOO_LARGE');
    const text = bytes.toString('utf8');
    invariant(!text.includes('/data00/'), 'FIXTURE_REAL_HOST_PATH_FORBIDDEN');
    invariant(!text.includes('/Users/'), 'FIXTURE_REAL_USER_PATH_FORBIDDEN');
    invariant(!/@(?:bytedance|byteintl|byted)\.(?:com|net)/i.test(text), 'FIXTURE_REAL_EMAIL_DOMAIN_FORBIDDEN');
    if (path.endsWith('.json') || path.endsWith('.jsonl')) {
      for (const match of text.matchAll(/"larkAppSecret"\s*:\s*"([^"]*)"/g)) {
        invariant(match[1].startsWith('SYNTHETIC_') && match[1].endsWith('_NEVER_VALID'), 'FIXTURE_SECRET_NOT_SYNTHETIC');
      }
    }
  }
}

function validateManifest() {
  const manifest = parseJson(manifestPath, 'MANIFEST_INVALID_JSON');
  parseJson(resolve(suiteDirectory, 'case-manifest.schema.json'), 'MANIFEST_SCHEMA_INVALID_JSON');
  parseJson(resolve(suiteDirectory, 'real-lark-preflight.schema.json'), 'PREFLIGHT_SCHEMA_INVALID_JSON');

  invariant(manifest.schema_version === 1, 'MANIFEST_SCHEMA_VERSION_INVALID');
  invariant(manifest.suite_id === 'botmux-parity-v1', 'MANIFEST_SUITE_ID_INVALID');
  invariant(manifest.default_action === 'self_check_only', 'MANIFEST_DEFAULT_ACTION_UNSAFE');
  invariant(manifest.safety_contract?.starts_or_stops_listener === false, 'MANIFEST_LISTENER_MUTATION_UNSAFE');
  invariant(manifest.safety_contract?.writes_botmux_source === false, 'MANIFEST_BOTMUX_MUTATION_UNSAFE');
  invariant(manifest.safety_contract?.writes_dutydeck_database === false, 'MANIFEST_DUTYDECK_DB_MUTATION_UNSAFE');
  invariant(manifest.safety_contract?.uses_existing_credentials === false, 'MANIFEST_CREDENTIAL_POLICY_UNSAFE');
  invariant(manifest.safety_contract?.writes_only_disposable_test_state === true, 'MANIFEST_DISPOSABLE_STATE_POLICY_MISSING');
  invariant(manifest.safety_contract?.isolates_home_tmp_ports_tmux === true, 'MANIFEST_CASE_ISOLATION_POLICY_MISSING');
  invariant(manifest.safety_contract?.checks_tmux_residue === true, 'MANIFEST_TMUX_RESIDUE_POLICY_MISSING');
  invariant(manifest.safety_contract?.real_lark_requires_dedicated_test_app === true, 'MANIFEST_REAL_LARK_APP_POLICY_UNSAFE');
  invariant(manifest.safety_contract?.real_lark_requires_external_fencing === true, 'MANIFEST_REAL_LARK_FENCE_POLICY_UNSAFE');
  invariant(Array.isArray(manifest.cases) && manifest.cases.length > 0, 'MANIFEST_CASES_MISSING');

  const ids = new Set();
  const coverage = new Set();
  const fixturePaths = new Set();
  const allowedCaseKeys = new Set([
    'id', 'title', 'coverage', 'execution', 'expectation', 'command', 'required_env',
    'reason_code', 'blocked_by', 'fixtures', 'evidence_sources', 'supporting_evidence',
    'assertions', 'safety', 'preflight_schema',
  ]);
  for (const item of manifest.cases) {
    invariant(Object.keys(item).every(key => allowedCaseKeys.has(key)), 'CASE_FIELD_UNKNOWN');
    invariant(/^[a-z0-9-]+$/.test(item.id), 'CASE_ID_INVALID');
    invariant(!ids.has(item.id), 'CASE_ID_DUPLICATE');
    ids.add(item.id);
    invariant(typeof item.title === 'string' && item.title.length > 0, 'CASE_TITLE_MISSING');
    invariant(Array.isArray(item.coverage) && item.coverage.length > 0, 'CASE_COVERAGE_MISSING');
    for (const tag of item.coverage) coverage.add(tag);
    invariant(['offline', 'remote_opt_in', 'real_lark_opt_in', 'expected_blocked'].includes(item.execution), 'CASE_EXECUTION_INVALID');
    invariant(['pass', 'expected_blocked', 'skip'].includes(item.expectation), 'CASE_EXPECTATION_INVALID');

    if (item.expectation === 'expected_blocked') {
      invariant(item.execution === 'expected_blocked', 'BLOCKED_CASE_EXECUTION_UNSAFE');
      invariant(typeof item.reason_code === 'string' && item.reason_code.length > 0, 'BLOCKED_CASE_REASON_MISSING');
      invariant(Array.isArray(item.blocked_by) && item.blocked_by.length > 0, 'BLOCKED_CASE_DETAIL_MISSING');
      invariant(item.command === undefined, 'BLOCKED_CASE_COMMAND_FORBIDDEN');
    } else if (item.expectation === 'skip') {
      invariant(typeof item.reason_code === 'string' && item.reason_code.length > 0, 'SKIP_CASE_REASON_MISSING');
      invariant(item.command === undefined, 'SKIP_CASE_COMMAND_FORBIDDEN');
    } else {
      invariant(Array.isArray(item.command) && item.command.length > 0, 'PASS_CASE_COMMAND_MISSING');
      const commandText = item.command.join(' ');
      invariant(!/(^|\s)(?:apply|activate|cutover)(?:\s|$)/i.test(commandText), 'CASE_ACTIVATION_COMMAND_FORBIDDEN');
      invariant(!/(?:daemon|listener)\s+(?:start|stop|restart)/i.test(commandText), 'CASE_RUNTIME_LIFECYCLE_COMMAND_FORBIDDEN');
      const first = item.command[0];
      invariant(first === 'node', 'CASE_COMMAND_NOT_ALLOWLISTED');
      for (const token of item.command) {
        if (!/\.(?:ts|mts|mjs)$/.test(token) || !token.includes('/')) continue;
        const path = resolve(repositoryRoot, token);
        invariant(isWithin(repositoryRoot, path) && statSync(path).isFile(), 'CASE_COMMAND_TARGET_MISSING');
      }
    }

    for (const fixture of item.fixtures ?? []) {
      invariant(typeof fixture === 'string' && !isAbsolute(fixture), 'FIXTURE_PATH_INVALID');
      const path = resolve(suiteDirectory, fixture);
      invariant(isWithin(suiteDirectory, path), 'FIXTURE_PATH_ESCAPE');
      invariant(statSync(path).isFile() || statSync(path).isDirectory(), 'FIXTURE_PATH_MISSING');
      fixturePaths.add(path);
    }
    if (item.preflight_schema) {
      const path = resolve(suiteDirectory, item.preflight_schema);
      invariant(isWithin(suiteDirectory, path) && statSync(path).isFile(), 'PREFLIGHT_SCHEMA_MISSING');
    }
  }

  const identityCase = manifest.cases.find(item => item.id === 'app-chat-identity-preflight');
  invariant(identityCase?.execution === 'offline' && identityCase?.expectation === 'pass', 'IDENTITY_PREFLIGHT_OFFLINE_CASE_MISSING');
  invariant(identityCase.command.join(' ') === 'node tests/e2e/integration-contracts/checks/identity-preflight.mjs', 'IDENTITY_PREFLIGHT_EVIDENCE_TARGET_MISSING');

  const realLarkCase = manifest.cases.find(item => item.id === 'real-lark-dedicated-test-app');
  invariant(realLarkCase?.execution === 'real_lark_opt_in' && realLarkCase?.expectation === 'skip', 'REAL_LARK_CASE_MUST_REMAIN_OPT_IN_SKIP');
  for (const id of [
    'active-turn-result-reconstruction-after-restart',
    'schedule-executor-and-activation',
    'dual-consumer-fencing-and-rollback',
  ]) {
    const blocked = manifest.cases.find(item => item.id === id);
    invariant(blocked?.execution === 'expected_blocked' && blocked?.expectation === 'expected_blocked', `REQUIRED_BLOCKER_PROMOTED_${id.toUpperCase().replaceAll('-', '_')}`);
  }

  for (const tag of manifest.required_coverage ?? []) invariant(coverage.has(tag), `REQUIRED_COVERAGE_MISSING_${String(tag).toUpperCase()}`);
  assertSyntheticFixtures([...fixturePaths]);
  return manifest;
}

function validatePrivatePreflight(pathInput) {
  invariant(typeof pathInput === 'string' && pathInput.length > 0, 'PREFLIGHT_PATH_REQUIRED');
  const linkInfo = lstatSync(pathInput);
  invariant(linkInfo.isFile() && !linkInfo.isSymbolicLink(), 'PREFLIGHT_FILE_INVALID');
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(pathInput, constants.O_RDONLY | noFollow);
  let data;
  try {
    const before = fstatSync(fd, { bigint: true });
    invariant(before.isFile(), 'PREFLIGHT_FILE_INVALID');
    if (process.platform !== 'win32') {
      invariant((Number(before.mode) & 0o077) === 0, 'PREFLIGHT_FILE_MODE_UNSAFE');
      if (typeof process.getuid === 'function') invariant(before.uid === BigInt(process.getuid()), 'PREFLIGHT_FILE_OWNER_INVALID');
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    invariant(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs, 'PREFLIGHT_CHANGED_DURING_READ');
    data = parseJsonBytes(bytes, 'PREFLIGHT_INVALID_JSON');
  } finally {
    closeSync(fd);
  }
  const exactKeys = (value, keys, code) => {
    invariant(value && typeof value === 'object' && !Array.isArray(value), code);
    invariant(Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'), code);
  };
  exactKeys(data, [
    'schema_version', 'dedicated_test_app', 'production_app', 'app_ref', 'chat_ref',
    'identity_validation', 'external_fencing', 'valid_until',
  ], 'PREFLIGHT_FIELDS_INVALID');
  invariant(data.schema_version === 1, 'PREFLIGHT_VERSION_INVALID');
  invariant(data.dedicated_test_app === true && data.production_app === false, 'PREFLIGHT_TEST_APP_ATTESTATION_INVALID');
  invariant(/^app_[a-f0-9]{24}$/.test(data.app_ref), 'PREFLIGHT_APP_REF_INVALID');
  invariant(/^chat_[a-f0-9]{24}$/.test(data.chat_ref), 'PREFLIGHT_CHAT_REF_INVALID');

  exactKeys(data.identity_validation, [
    'target_app_bot_identity_verified', 'chat_membership_verified', 'principal_app_scope_verified', 'evidence_ref',
  ], 'PREFLIGHT_IDENTITY_FIELDS_INVALID');
  invariant(data.identity_validation.target_app_bot_identity_verified === true, 'PREFLIGHT_BOT_IDENTITY_UNVERIFIED');
  invariant(data.identity_validation.chat_membership_verified === true, 'PREFLIGHT_CHAT_MEMBERSHIP_UNVERIFIED');
  invariant(data.identity_validation.principal_app_scope_verified === true, 'PREFLIGHT_PRINCIPAL_SCOPE_UNVERIFIED');
  invariant(/^evidence_[a-f0-9]{24}$/.test(data.identity_validation.evidence_ref), 'PREFLIGHT_IDENTITY_EVIDENCE_INVALID');

  exactKeys(data.external_fencing, [
    'source_listener_drained', 'source_reconnect_inhibited', 'target_listener_disabled',
    'schedule_writer', 'generation', 'watermark_ref', 'evidence_ref',
  ], 'PREFLIGHT_FENCE_FIELDS_INVALID');
  invariant(data.external_fencing.source_listener_drained === true, 'PREFLIGHT_SOURCE_NOT_DRAINED');
  invariant(data.external_fencing.source_reconnect_inhibited === true, 'PREFLIGHT_SOURCE_RECONNECT_NOT_INHIBITED');
  invariant(data.external_fencing.target_listener_disabled === true, 'PREFLIGHT_TARGET_LISTENER_NOT_DISABLED');
  invariant(data.external_fencing.schedule_writer === 'botmux_only', 'PREFLIGHT_SCHEDULE_WRITER_INVALID');
  invariant(Number.isInteger(data.external_fencing.generation) && data.external_fencing.generation > 0, 'PREFLIGHT_GENERATION_INVALID');
  invariant(/^watermark_[a-f0-9]{24}$/.test(data.external_fencing.watermark_ref), 'PREFLIGHT_WATERMARK_REF_INVALID');
  invariant(/^evidence_[a-f0-9]{24}$/.test(data.external_fencing.evidence_ref), 'PREFLIGHT_FENCE_EVIDENCE_INVALID');

  const validUntil = Date.parse(data.valid_until);
  invariant(Number.isFinite(validUntil) && validUntil > Date.now(), 'PREFLIGHT_EXPIRED');
  invariant(validUntil - Date.now() <= 4 * 60 * 60 * 1000, 'PREFLIGHT_VALIDITY_TOO_LONG');
  return true;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isolatedTmuxSessions(env) {
  const result = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function execute(item) {
  const allowedRemoteKeys = new Set(item.execution === 'remote_opt_in' ? (item.required_env ?? []) : []);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    if (allowedRemoteKeys.has(key)) return true;
    return !/(?:TOKEN|SECRET|COOKIE|CREDENTIAL|AUTHORIZATION|LARK|FEISHU|BOTMUX|DUTYDECK_)/i.test(key);
  }));
  const privateRoot = mkdtempSync(resolve(tmpdir(), 'dutydeck-integration-contracts-case-'));
  const isolatedHome = resolve(privateRoot, 'home');
  const isolatedTmp = resolve(privateRoot, 'tmp');
  const isolatedTmux = resolve(privateRoot, 'tmux');
  for (const path of [privateRoot, isolatedHome, isolatedTmp, isolatedTmux]) {
    if (path !== privateRoot) mkdirSync(path, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(path, 0o700);
  }
  Object.assign(env, {
    HOME: isolatedHome,
    TMPDIR: isolatedTmp,
    TMP: isolatedTmp,
    TEMP: isolatedTmp,
    TMUX_TMPDIR: isolatedTmux,
    PORT: '0',
    NODE_ENV: 'test',
    NO_COLOR: '1',
  });
  delete env.TMUX;
  let result;
  let residue = [];
  try {
    result = spawnSync(item.command[0], item.command.slice(1), {
      cwd: repositoryRoot,
      env,
      stdio: 'inherit',
      timeout: 300_000,
    });
    residue = isolatedTmuxSessions(env);
    if (result.status === 77 && residue.length === 0) {
      return {
        case_id: item.id,
        status: 'skip',
        reason_code: 'CASE_DEPENDENCY_UNAVAILABLE',
        exit_code: 77,
      };
    }
    return {
      case_id: item.id,
      status: result.status === 0 && residue.length === 0 ? 'pass' : 'fail',
      exit_code: result.status ?? 1,
      ...(residue.length > 0 ? { reason_code: 'ISOLATED_TMUX_RESIDUE', tmux_residual_sessions: residue.length } : {}),
    };
  } finally {
    spawnSync('tmux', ['kill-server'], { cwd: repositoryRoot, env, stdio: 'ignore' });
    rmSync(privateRoot, { recursive: true, force: true });
  }
}

function summarize(results, action, suiteId) {
  const counts = { pass: 0, fail: 0, skip: 0, expected_blocked: 0 };
  for (const result of results) {
    if (Object.hasOwn(counts, result.status)) counts[result.status] += 1;
  }
  return {
    suite_id: suiteId,
    action,
    status: counts.fail === 0 ? 'pass' : 'fail',
    counts,
    total: results.length,
  };
}

function disposition(item, args) {
  const flags = new Set(args);
  if (item.execution === 'expected_blocked') {
    return { case_id: item.id, status: 'expected_blocked', reason_code: item.reason_code };
  }
  if (item.execution === 'real_lark_opt_in') {
    if (!flags.has('--allow-real-lark')) {
      return { case_id: item.id, status: 'skip', reason_code: 'REAL_LARK_OPT_IN_REQUIRED' };
    }
    const preflightIndex = args.indexOf('--preflight');
    invariant(preflightIndex >= 0 && args[preflightIndex + 1], 'PREFLIGHT_PATH_REQUIRED');
    validatePrivatePreflight(args[preflightIndex + 1]);
    return { case_id: item.id, status: 'skip', reason_code: item.reason_code };
  }
  if (item.execution === 'remote_opt_in' && !flags.has('--allow-remote-open')) {
    return { case_id: item.id, status: 'skip', reason_code: 'REMOTE_OPEN_OPT_IN_REQUIRED' };
  }
  for (const name of item.required_env ?? []) invariant(process.env[name], `REQUIRED_ENV_MISSING_${name}`);
  return execute(item);
}

function usage() {
  return [
    'Usage:',
    '  node tests/e2e/integration-contracts/runner.mjs --self-check',
    '  node tests/e2e/integration-contracts/runner.mjs --list',
    '  node tests/e2e/integration-contracts/runner.mjs --run-offline',
    '  node tests/e2e/integration-contracts/runner.mjs --run-case <id> [--allow-remote-open]',
    '  node tests/e2e/integration-contracts/runner.mjs --validate-real-lark-preflight <private-file>',
    '  node tests/e2e/integration-contracts/runner.mjs --run-case real-lark-dedicated-test-app --allow-real-lark --preflight <private-file>',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const manifest = validateManifest();
  if (args.length === 0 || args.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.includes('--self-check')) {
    print({
      suite_id: manifest.suite_id,
      status: 'pass',
      action: 'self_check',
      case_count: manifest.cases.length,
      offline_case_count: manifest.cases.filter(item => item.execution === 'offline').length,
      expected_blocked_count: manifest.cases.filter(item => item.expectation === 'expected_blocked').length,
      executed_case_count: 0,
    });
    return;
  }
  if (args.includes('--list')) {
    for (const item of manifest.cases) print({ id: item.id, execution: item.execution, expectation: item.expectation, reason_code: item.reason_code ?? null });
    return;
  }
  const validateIndex = args.indexOf('--validate-real-lark-preflight');
  if (validateIndex >= 0) {
    validatePrivatePreflight(args[validateIndex + 1]);
    print({ status: 'pass', action: 'validate_real_lark_preflight', credentials_read: false, listener_changed: false });
    return;
  }
  if (args.includes('--run-offline')) {
    const results = manifest.cases.map(item => item.execution === 'offline'
      ? execute(item)
      : disposition(item, []));
    for (const result of results) print(result);
    const summary = summarize(results, 'run_offline', manifest.suite_id);
    print(summary);
    if (summary.counts.fail > 0) process.exitCode = 1;
    return;
  }
  const runIndex = args.indexOf('--run-case');
  if (runIndex >= 0) {
    const id = args[runIndex + 1];
    const item = manifest.cases.find(candidate => candidate.id === id);
    invariant(item, 'CASE_NOT_FOUND');
    const result = disposition(item, args);
    print(result);
    print(summarize([result], 'run_case', manifest.suite_id));
    if (result.status === 'fail') process.exitCode = 1;
    return;
  }
  fail('UNKNOWN_ARGUMENT');
}

try {
  main();
} catch (error) {
  print({ status: 'fail', action: 'runner', error_code: error?.code ?? 'RUNNER_FAILED' });
  process.exitCode = 1;
}
