// Independent adjudication tests for the pairfob project submit/status JSON
// contract. Every case spawns a real temporary executable through the same
// execFile argument-array path submitProjectJob/getProjectStatus use; no
// worker, HTTP port or shared harness state is involved.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { submitProjectJob, getProjectStatus, parseEnvelope } from '../service/pairfob.mjs';

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MODULE_PATH = join(PLUGIN_ROOT, 'service', 'pairfob.mjs');

const SOCKET = '/tmp/pairfob-unit-fake.sock';
const TOKEN_FILE = '/tmp/pairfob-unit-fake.token';

// One dispatcher whose response is selected by the CASE env var per call.
// Submit cases always consume stdin fully before exiting (so the parent never
// hits an EPIPE on a script that stopped reading); status cases answer at once.
const DISPATCHER = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const c = process.env.CASE || 'ok-fake';
const logPath = process.env.CASE_LOG;
const argv = process.argv.slice(2);
const [group, command] = argv;
function emit(o, code) {
  process.stdout.write(JSON.stringify(o));
  process.exit(typeof code === 'number' ? code : 0);
}
function submit(input) {
  if (logPath) appendFileSync(logPath, JSON.stringify({ kind: 'submit', argv, input }) + '\\n');
  switch (c) {
    case 'ok-fake':
      return emit({ ok: true, data: { task_id: 'pt_000001', leader_id: 'pl_leader_1', phase: 'todo' } });
    case 'ok-go-ids':
      return emit({ ok: true, data: { task_id: 'pt_000000000000000000000001', leader_id: 'pl_000000000000000000000001', phase: 'doing' } });
    case 'trimmed-ids':
      return emit({ ok: true, data: { task_id: '  pt_000002 ', leader_id: ' pl_leader_2 ', phase: ' done ' } });
    case 'missing-leader':
      return emit({ ok: true, data: { task_id: 'pt_000003', phase: 'todo' } });
    case 'blank-task':
      return emit({ ok: true, data: { task_id: '   ', leader_id: 'pl_leader_3', phase: 'todo' } });
    case 'missing-phase':
      return emit({ ok: true, data: { task_id: 'pt_000004', leader_id: 'pl_leader_4' } });
    case 'unknown5':
      return emit({ ok: false, error: { code: 'unknown_outcome', message: 'maybe committed' } }, 5);
    case 'internal4':
      return emit({ ok: false, error: { code: 'internal', message: 'could not store project job' } }, 4);
    case 'internal0':
      return emit({ ok: false, error: { code: 'internal', message: 'weird exit zero' } }, 0);
    case 'usage2':
      return emit({ ok: false, error: { code: 'usage', message: 'bad flags' } }, 2);
    case 'unreachable1':
      return emit({ ok: false, error: { code: 'unreachable', message: 'no socket' } }, 1);
    case 'config2':
      return emit({ ok: false, error: { code: 'configuration_error', message: 'ROVETAP_PROJECT_SOCKET must be an absolute path' } }, 2);
    case 'submit-notfound4':
      return emit({ ok: false, error: { code: 'not_found', message: 'configured project leader does not exist' } }, 4);
    case 'project-closed4':
      return emit({ ok: false, error: { code: 'conflict', message: 'project leader is closed' } }, 4);
    case 'weird4':
      return emit({ ok: false, error: { code: 'future_code', message: 'unknown to this adapter' } }, 4);
    case 'forbidden4':
      return emit({ ok: false, error: { code: 'forbidden', message: 'bad token' } }, 4);
    case 'conflict4':
      return emit({ ok: false, error: { code: 'conflict', message: 'key reused differently' } }, 4);
    case 'invalid0':
      return emit({ ok: false, error: { code: 'invalid_argument', message: 'instruction required' } }, 0);
    case 'garbage0':
      process.stdout.write('hub said something non-JSON\\n');
      return process.exit(0);
    case 'drop7':
      process.stderr.write('simulated stdout loss after commit\\n');
      return process.exit(7);
    case 'sleep':
      return setTimeout(() => emit({ ok: true, data: {} }), 60_000);
    default:
      return emit({ ok: false, error: { code: 'no_such_case', message: c } }, 2);
  }
}
function status() {
  if (logPath) appendFileSync(logPath, JSON.stringify({ kind: 'status', argv }) + '\\n');
  switch (c) {
    case 'status-ok':
      return emit({ ok: true, data: { task_id: 'pt_000009', leader_id: 'pl_leader_9', phase: 'doing' } });
    case 'status-missing-leader':
      return emit({ ok: true, data: { task_id: 'pt_000010', phase: 'todo' } });
    case 'status-notfound4':
      return emit({ ok: false, error: { code: 'not_found', message: 'no task' } }, 4);
    case 'status-notfound0':
      return emit({ ok: false, error: { code: 'not_found', message: 'fake cli exit zero' } }, 0);
    case 'status-forbidden4':
      return emit({ ok: false, error: { code: 'forbidden', message: 'other project' } }, 4);
    case 'status-garbage':
      process.stdout.write('not json at all');
      return process.exit(0);
    default:
      return emit({ ok: true, data: { task_id: 'pt_000009', leader_id: 'pl_leader_9', phase: 'todo' } });
  }
}
if (group === 'project' && command === 'submit') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => submit(input));
} else {
  status();
}
`;

let rootDir = '';
let bin = '';
const extraDirs: string[] = [];

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'pairfob-adjudication-'));
  bin = join(rootDir, 'fake-pairfob-cases.mjs');
  await writeFile(bin, DISPATCHER);
  await chmod(bin, 0o755);
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(extraDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function submit(caseName: string, extra: Record<string, unknown> = {}) {
  return submitProjectJob({
    bin,
    project: 'rovetap',
    payload: { source_key: 'lark/cli_test/om_1', instruction: 'fix it' },
    socket: SOCKET,
    tokenFile: TOKEN_FILE,
    extraEnv: { CASE: caseName, ...extra },
    timeoutMs: 2_000,
  });
}

function status(caseName: string) {
  return getProjectStatus({
    bin,
    project: 'rovetap',
    sourceKey: 'lark/cli_test/om_1',
    socket: SOCKET,
    tokenFile: TOKEN_FILE,
    extraEnv: { CASE: caseName },
    timeoutMs: 2_000,
  });
}

describe('parseEnvelope basics', () => {
  it('parses a single JSON object and rejects empty/non-string output', () => {
    expect(parseEnvelope('{"ok":true}')).toEqual({ ok: true });
    expect(parseEnvelope('{"ok":true}\n')).toEqual({ ok: true }); // trailing newline only
    expect(parseEnvelope('')).toBeNull();
    expect(parseEnvelope('   \n ')).toBeNull();
    expect(parseEnvelope(null)).toBeNull();
    expect(parseEnvelope('plain text')).toBeNull();
  });

  it('accepts exactly one JSON object: log lines or concatenated objects are garbage', () => {
    expect(parseEnvelope('2026-11-25 hub starting\n{"ok":true}')).toBeNull();
    expect(parseEnvelope('{"ok":true}\ntrailing log line')).toBeNull();
    expect(parseEnvelope('{"ok":true}{"ok":false}')).toBeNull();
    expect(parseEnvelope('{"ok":true} {"ok":false}')).toBeNull();
    expect(parseEnvelope('[1,2,3]')).toBeNull();
    expect(parseEnvelope('"a json string"')).toBeNull();
  });

  it('does not rescan closing braces of huge concatenated garbage', () => {
    // Many concatenated valid objects must be rejected as one envelope; the old
    // brace-rescan fallback tried thousands of multi-object slices.
    const garbage = '{"a":1}'.repeat(20_000);
    const t0 = Date.now();
    expect(parseEnvelope(garbage)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('stays fast on an unterminated long string followed by many braces', () => {
    // Pathological for the old fallback: every closing-brace slice forces the
    // parser to rescan the same long unterminated string (quadratic work).
    const garbage = '{"a":"' + 'x'.repeat(30_000) + '}'.repeat(30_000);
    const t0 = Date.now();
    expect(parseEnvelope(garbage)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('returns null quickly for a megabyte of brace-heavy invalid output', () => {
    const garbage = '{oops}'.repeat(120_000) + '{"ok":true}';
    const t0 = Date.now();
    expect(parseEnvelope(garbage)).toBeNull(); // embedded object is not a single envelope
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('submitProjectJob success adjudication', () => {
  it('accepts the existing fake CLI id shapes pt_000001 / pl_leader_1', async () => {
    const r = await submit('ok-fake');
    expect(r.outcome).toBe('ok');
    if (r.outcome !== 'ok') throw new Error('narrow outcome');
    expect(r.taskId).toBe('pt_000001');
    expect(r.leaderId).toBe('pl_leader_1');
    expect(r.phase).toBe('todo');
  });

  it('accepts the real Go long id shapes from project_test.go', async () => {
    const r = await submit('ok-go-ids');
    expect(r).toMatchObject({
      outcome: 'ok',
      taskId: 'pt_000000000000000000000001',
      leaderId: 'pl_000000000000000000000001',
      phase: 'doing',
    });
  });

  it('trims blank padding so whitespace-only fields are usable values', async () => {
    const r = await submit('trimmed-ids');
    expect(r).toMatchObject({ outcome: 'ok', taskId: 'pt_000002', leaderId: 'pl_leader_2', phase: 'done' });
  });

  it.each([
    ['missing-leader'],
    ['blank-task'],
    ['missing-phase'],
  ])('treats incomplete success envelope %s as unknown (reconcile), never ok/rejected', async (name) => {
    const r = await submit(name);
    expect(r.outcome).toBe('unknown');
    if (r.outcome === 'unknown') expect(r.reason).toBe('incomplete_success_envelope');
  });
});

describe('submitProjectJob rejection vs reconcile-only', () => {
  it('maps exit 5 unknown_outcome to unknown, not rejected', async () => {
    const r = await submit('unknown5');
    expect(r.outcome).toBe('unknown');
    if (r.outcome === 'unknown') expect(r.reason).toContain('unknown_outcome');
  });

  it('does not reject on exit 4 with code internal (real CLI default mapping lands it on 4)', async () => {
    const r = await submit('internal4');
    expect(r.outcome).toBe('unknown');
    if (r.outcome === 'unknown') expect(r.reason).toContain('internal');
  });

  it('does not reject on exit 0 with code internal either', async () => {
    const r = await submit('internal0');
    expect(r.outcome).toBe('unknown');
    if (r.outcome === 'unknown') expect(r.reason).toContain('internal');
  });

  it('maps exit 1 unreachable envelope to the safe-retry unreachable outcome (dial failed before bytes)', async () => {
    // Mirrors cmd/pairfob/project.go: 'unreachable' is emitted only for the
    // unix dial error with uncertain=false, so the worker may resubmit as-is.
    const r = await submit('unreachable1');
    expect(r).toMatchObject({ outcome: 'unreachable', code: 'unreachable' });
  });

  it.each([
    ['usage2', 'usage'],
    ['weird4', 'future_code'],
  ])('keeps non-refusal code %s reconcile-only', async (caseName, code) => {
    const r = await submit(caseName);
    expect(r.outcome).toBe('unknown');
    if (r.outcome === 'unknown') expect(r.reason).toContain(code);
  });

  it.each([
    ['forbidden4', 'forbidden'],
    ['conflict4', 'conflict'],
    ['invalid0', 'invalid_argument'],
    ['config2', 'configuration_error'],
    ['submit-notfound4', 'not_found'],
    ['project-closed4', 'conflict'],
  ])('reports explicit terminal verdict %s as rejected with code and message', async (caseName, code) => {
    const r = await submit(caseName);
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') {
      expect(r.code).toBe(code);
      expect(r.message).toBeTruthy();
    }
  });

  it('treats unparseable exit-0 output as unknown', async () => {
    const r = await submit('garbage0');
    expect(r.outcome).toBe('unknown');
    if (r.outcome === 'unknown') expect(r.reason).toBe('missing_ok_envelope');
  });

  it('treats a committed-then-silent non-zero exit as unknown carrying exit code', async () => {
    const r = await submit('drop7');
    expect(r.outcome).toBe('unknown');
    if (r.outcome === 'unknown') expect(r.reason).toBe('exit_7');
  });

  it('maps timeout/kill to unknown instead of rejection', async () => {
    const r = await submitProjectJob({
      bin,
      project: 'rovetap',
      payload: { source_key: 'k', instruction: 'x' },
      extraEnv: { CASE: 'sleep' },
      timeoutMs: 40,
    });
    expect(r.outcome).toBe('unknown');
    if (r.outcome === 'unknown') expect(r.reason).toBe('timeout_or_signal');
  });

  it('reports a missing executable as not_spawned (safe to retry, never wrote)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pairfob-missing-'));
    extraDirs.push(dir);
    const r = await submitProjectJob({
      bin: join(dir, 'does-not-exist.mjs'),
      project: 'p',
      payload: {},
      extraEnv: { CASE: 'ok-fake' },
    });
    expect(r.outcome).toBe('not_spawned');
  });

  it('passes the argument-array contract, stdin JSON and project env to the CLI', async () => {
    const log = join(rootDir, 'case-log.jsonl');
    await submit('ok-fake', { CASE_LOG: log });
    const entry = JSON.parse((await readFile(log, 'utf8')).trim().split('\n')[0]);
    expect(entry.argv.slice(0, 4)).toEqual(['project', 'submit', '--project', 'rovetap']);
    expect(entry.argv).toContain('--stdin');
    expect(JSON.parse(entry.input)).toMatchObject({ source_key: 'lark/cli_test/om_1' });
  });
});

describe('getProjectStatus adjudication', () => {
  it('accepts a complete non-empty task/leader/phase envelope', async () => {
    const r = await status('status-ok');
    expect(r).toMatchObject({ outcome: 'ok', taskId: 'pt_000009', leaderId: 'pl_leader_9', phase: 'doing' });
  });

  it('refuses partial success identity and returns a retryable error', async () => {
    const r = await status('status-missing-leader');
    expect(r.outcome).toBe('error');
    if (r.outcome === 'error') expect(r.reason).toBe('incomplete_status');
  });

  it('maps real-CLI exit 4 not_found envelope to not_found', async () => {
    const r = await status('status-notfound4');
    expect(r).toEqual({ outcome: 'not_found', code: 'not_found' });
  });

  it('maps fake-style exit 0 not_found envelope to not_found', async () => {
    const r = await status('status-notfound0');
    expect(r).toEqual({ outcome: 'not_found', code: 'not_found' });
  });

  it('keeps other business errors retryable instead of not_found', async () => {
    const r = await status('status-forbidden4');
    expect(r.outcome).toBe('error');
    if (r.outcome === 'error') expect(r.reason).toContain('forbidden');
  });

  it('maps malformed output to malformed_status', async () => {
    const r = await status('status-garbage');
    expect(r.outcome).toBe('error');
    if (r.outcome === 'error') expect(r.reason).toBe('malformed_status');
  });

  it('maps a missing executable to a prefixed spawn error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pairfob-status-missing-'));
    extraDirs.push(dir);
    const r = await getProjectStatus({ bin: join(dir, 'nope.mjs'), project: 'p', sourceKey: 'k' });
    expect(r.outcome).toBe('error');
    if (r.outcome === 'error') expect(r.reason).toMatch(/^not_spawned:ENOENT/);
  });
});

describe('compatibility with the checked-in fake-pairfob fixture id format', () => {
  it('submit then status against test/fixtures/fake-pairfob.mjs returns usable identities', async () => {
    const fixture = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'fake-pairfob.mjs');
    await chmod(fixture, 0o755).catch(() => {});
    const hub = join(rootDir, 'fixture-hub.json');
    const options = {
      bin: fixture,
      project: 'rovetap',
      socket: SOCKET,
      tokenFile: TOKEN_FILE,
      extraEnv: { FAKE_PAIRFOB_HUB: hub, FAKE_PAIRFOB_MODE: 'ok' },
      timeoutMs: 2_000,
    };
    const s = await submitProjectJob({ ...options, payload: { source_key: 'lark/cli_fixture/om_9', instruction: 'x' } });
    expect(s).toMatchObject({ outcome: 'ok', taskId: 'pt_000001', leaderId: 'pl_leader_1', phase: 'todo' });
    const st = await getProjectStatus({ ...options, sourceKey: 'lark/cli_fixture/om_9' });
    expect(st).toMatchObject({ outcome: 'ok', taskId: 'pt_000001', leaderId: 'pl_leader_1', phase: 'todo' });
  });
});

// Runs submitProjectJob in a REAL child node process so an unhandled stream
// error (the EPIPE that killed the whole plugin on /bin/false CLIs) is observed
// as parent death, exactly like the deployed plugin subprocess.
const PARENT_SCRIPT = `
process.on('uncaughtException', (error) => {
  console.log('UNCAUGHT ' + String(error && error.code || '') + ' ' + String(error && error.message || error));
  process.exit(97);
});
const { submitProjectJob } = await import(process.env.PAIRFOB_MODULE);
const payload = { source_key: 'subprocess-once', blob: 'x'.repeat(Number(process.env.PAYLOAD_CHARS || '0')) };
const result = await submitProjectJob({
  bin: process.env.TARGET_BIN,
  project: 'p',
  payload,
  timeoutMs: 4000,
});
console.log('RESULT ' + JSON.stringify(result));
// A late EPIPE can surface just after the process callback; leave a window so
// an unhandled one kills us before the ALIVE marker is printed.
await new Promise((resolve) => setTimeout(resolve, 300));
console.log('ALIVE');
process.exit(0);
`;

const TARGET_IMMEDIATE_EXIT = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.TARGET_LOG, 'submit\\n');
// Deliberately never reads stdin and exits at once.
process.exit(0);
`;

const TARGET_NONZERO_REJECT = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.TARGET_LOG, 'submit\\n');
process.stdout.write(JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'explicit refusal' } }));
// Never reads stdin either; large parent writes race the exit and can EPIPE.
process.exit(4);
`;

describe('submitProjectJob subprocess resilience: EPIPE, exactly-once, immediate/non-zero exits', () => {
  let parentBin = '';

  beforeAll(async () => {
    parentBin = join(rootDir, 'epipe-parent.mjs');
    await writeFile(parentBin, PARENT_SCRIPT);
    const immediate = join(rootDir, 'immediate-exit.mjs');
    const reject = join(rootDir, 'nonzero-reject.mjs');
    await writeFile(immediate, TARGET_IMMEDIATE_EXIT);
    await writeFile(reject, TARGET_NONZERO_REJECT);
    await chmod(immediate, 0o755);
    await chmod(reject, 0o755);
  });

  function runParent(targetBin: string, targetLog: string, payloadChars: number) {
    const proc = spawnSync(process.execPath, [parentBin], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PAIRFOB_MODULE: MODULE_PATH,
        TARGET_BIN: targetBin,
        TARGET_LOG: targetLog,
        PAYLOAD_CHARS: String(payloadChars),
      },
    });
    const resultLine = (proc.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
    return {
      status: proc.status,
      stdout: proc.stdout ?? '',
      stderr: proc.stderr ?? '',
      result: resultLine ? JSON.parse(resultLine.slice('RESULT '.length)) : null,
    };
  }

  it('survives the real /bin/false immediate exit with a large unread stdin and returns unknown', () => {
    if (!existsSync('/bin/false')) return; // platform without /bin/false: nothing real to spawn
    const r = runParent('/bin/false', join(rootDir, 'bin-false-unused.log'), 300_000);
    expect(r.status, `parent stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('ALIVE');
    expect(r.stdout).not.toContain('UNCAUGHT');
    expect(r.result).toMatchObject({ outcome: 'unknown', reason: 'exit_1' });
  });

  it('spawns an immediate-exit CLI exactly once and classifies the receipt gap as unknown', async () => {
    const bin = join(rootDir, 'immediate-exit.mjs');
    const log = join(rootDir, 'immediate-invocations.log');
    const r = runParent(bin, log, 300_000);
    expect(r.status, `parent stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('ALIVE');
    expect(r.stdout).not.toContain('UNCAUGHT EPIPE');
    expect(r.result).toMatchObject({ outcome: 'unknown', reason: 'missing_ok_envelope' });
    const lines = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(1); // one request -> one CLI submission, no wrapper retry
  });

  it('keeps the explicit non-zero rejection even when the rejecting CLI never reads stdin', async () => {
    const bin = join(rootDir, 'nonzero-reject.mjs');
    const log = join(rootDir, 'reject-invocations.log');
    const r = runParent(bin, log, 300_000);
    expect(r.status, `parent stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('ALIVE');
    expect(r.stdout).not.toContain('UNCAUGHT EPIPE');
    expect(r.result).toMatchObject({ outcome: 'rejected', code: 'forbidden' });
    const lines = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });
});
