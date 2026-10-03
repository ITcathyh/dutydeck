import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export type Policy = 'legacy' | 'optimized';
export interface FrozenConfig { model: string; protocol: string; reasoningEffort?: string }
export type Check = { kind: 'exact' | 'includes' | 'excludes'; path: string[]; value: unknown } | { kind: 'schema'; path: string[]; required: string[]; allowExtra?: boolean };
export interface ReplayCase { id: string; type: string; input: unknown; toolData: unknown; files?: Record<string, string>; checks: Check[]; needsReview?: boolean }
export interface Manifest { version: 1; frozenConfig: FrozenConfig; repetitions: number; timeoutMs?: number; runners: Record<Policy, string[]>; cases: ReplayCase[]; providerEnv?: string[]; providerAuth?: 'codex_login' }
export interface ReplayRequest { version: 1; case: ReplayCase; policy: Policy; config: FrozenConfig; workspace: string; inputDigest: string }
export interface Usage { semantics: 'input_excludes_cache'; input: number; cacheRead: number; cacheWrite: number; output: number }
export interface ReplayAttempt { attemptId: string; usageRef: string; role: 'root' | 'child' | 'background'; source: 'mock' | 'provider'; model: string; protocol: string; rawUsage: unknown; usage?: Usage }
export interface ReplayResult { status: 'completed' | 'failed'; output: unknown; executionSource: 'mock' | 'provider'; inputDigest: string; config: FrozenConfig; latencyMs: number; attempts: ReplayAttempt[]; coverage: { complete: boolean; attemptIds: string[]; usageRefs: string[] } }
export interface ReplayRun { caseId: string; type: string; repetition: number; policy: Policy; runner: string[]; runnerWallMs: number; stderr: string; result?: ReplayResult; failures: string[]; quality: 'pass' | 'fail' | 'needs_review'; coverage: 'verified' | 'unverified' }
const policies: Policy[] = ['legacy', 'optimized'];
const metrics = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
const sameSet = (left: string[], right: string[]) => isDeepStrictEqual([...new Set(left)].sort(), [...new Set(right)].sort());

export function validateManifest(manifest: Manifest) {
  if (manifest.version !== 1 || !manifest.frozenConfig?.model || !manifest.frozenConfig?.protocol || !Number.isInteger(manifest.repetitions) || manifest.repetitions < 1
    || !Array.isArray(manifest.cases) || !manifest.cases.length || !policies.every(policy => strings(manifest.runners?.[policy]) && manifest.runners[policy].length)
    || (manifest.timeoutMs !== undefined && (!Number.isInteger(manifest.timeoutMs) || manifest.timeoutMs < 1))) throw new Error('Invalid replay manifest');
  if (manifest.providerAuth !== undefined && manifest.providerAuth !== 'codex_login') throw new Error('Invalid provider authentication source');
  if (new Set(manifest.cases.map(item => item.id)).size !== manifest.cases.length) throw new Error('Duplicate case ids');
  for (const item of manifest.cases) {
    if (!item.id || !item.type || !Array.isArray(item.checks) || !Object.hasOwn(item, 'input') || !Object.hasOwn(item, 'toolData')) throw new Error('Case needs frozen input, toolData, type and checks');
    for (const check of item.checks) {
      if (!['exact', 'includes', 'excludes', 'schema'].includes(check.kind) || !Array.isArray(check.path) || !check.path.every(part => typeof part === 'string')
        || (check.kind === 'schema' ? !strings(check.required) : !Object.hasOwn(check, 'value'))) throw new Error('Invalid machine quality check');
    }
    for (const [path, text] of Object.entries(item.files ?? {})) if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || typeof text !== 'string') throw new Error('Fixture files must stay inside the temporary workspace');
  }
  for (const key of manifest.providerEnv ?? []) if (!/^[A-Z_a-z][A-Z_a-z0-9]*$/.test(key) || /lark|feishu|group_tools|home|codex_home|node_options|path/i.test(key)) throw new Error('Provider environment must not inject live tools, homes or executable hooks');
}

export function checkQuality(item: ReplayCase, output: unknown): string[] {
  const failures: string[] = [];
  for (const [index, check] of item.checks.entries()) {
    const value = check.path.reduce<unknown>((node, part) => node !== null && typeof node === 'object' && Object.hasOwn(node, part) ? (node as Record<string, unknown>)[part] : undefined, output);
    let passed = false;
    if (check.kind === 'exact') passed = isDeepStrictEqual(value, check.value);
    if (check.kind === 'includes' || check.kind === 'excludes') {
      const matches = typeof value === 'string' && typeof check.value === 'string' ? value.includes(check.value) : Array.isArray(value) ? value.some(entry => isDeepStrictEqual(entry, check.value)) : undefined;
      passed = matches !== undefined && (check.kind === 'includes' ? matches : !matches);
    }
    if (check.kind === 'schema') passed = value !== null && typeof value === 'object' && !Array.isArray(value) && check.required.every(key => Object.hasOwn(value, key))
      && (check.allowExtra === true || Object.keys(value).every(key => check.required.includes(key)));
    if (!passed) failures.push(`quality_check_${index}:${check.kind}:${check.path.join('.')}`);
  }
  return failures;
}

export function validateResult(request: ReplayRequest, result: ReplayResult): string[] {
  if (!result || typeof result !== 'object') return ['runner_result_invalid'];
  const failures: string[] = [];
  if (result.status !== 'completed') failures.push('execution_failed');
  if (!['mock', 'provider'].includes(result.executionSource)) failures.push('execution_source_missing');
  if (result.inputDigest !== request.inputDigest || !isDeepStrictEqual(result.config, request.config)) failures.push('frozen_input_or_model_changed');
  if (!nonnegative(result.latencyMs)) failures.push('latency_missing');
  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  if (!attempts.length || !attempts.some(attempt => attempt?.role === 'root')) failures.push('root_attempt_missing');
  const seen = new Map<string, ReplayAttempt>();
  for (const attempt of attempts) {
    if (!attempt || typeof attempt !== 'object') { failures.push('attempt_invalid'); continue; }
    if (attempt.source === 'provider' && attempt.rawUsage && typeof attempt.rawUsage === 'object' && 'fixture' in attempt.rawUsage && attempt.rawUsage.fixture === true) failures.push('mock_usage_cannot_be_provider');
    if (!attempt.attemptId || !attempt.usageRef || !['root', 'child', 'background'].includes(attempt.role) || attempt.source !== result.executionSource
      || attempt.model !== request.config.model || attempt.protocol !== request.config.protocol) failures.push(`attempt_identity_or_source:${attempt.attemptId ?? 'unknown'}`);
    if (!Object.hasOwn(attempt, 'rawUsage') || attempt.rawUsage === null || !attempt.usage || attempt.usage.semantics !== 'input_excludes_cache' || !metrics.every(key => nonnegative(attempt.usage?.[key]))) failures.push(`usage_unverified:${attempt.attemptId ?? 'unknown'}`);
    const prior = seen.get(attempt.usageRef);
    // A shared background receipt may appear under several roots. It must describe one identical execution.
    if (prior && !isDeepStrictEqual(prior, attempt)) failures.push(`conflicting_usage_ref:${attempt.usageRef}`);
    seen.set(attempt.usageRef, attempt);
  }
  if (!result.coverage?.complete || !strings(result.coverage.attemptIds) || !strings(result.coverage.usageRefs)
    || !sameSet(result.coverage.attemptIds, attempts.map(attempt => attempt?.attemptId)) || !sameSet(result.coverage.usageRefs, attempts.map(attempt => attempt?.usageRef))) failures.push('coverage_unverified');
  return failures;
}

async function runCommand(command: string[], request: ReplayRequest, timeoutMs: number, providerEnv: string[]) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: request.workspace, TMPDIR: request.workspace, CODEX_HOME: join(request.workspace, '.codex'), DUTYDECK_REPLAY: '1', DUTYDECK_DISABLE_EXTERNAL_WRITES: '1' };
  for (const key of providerEnv) if (process.env[key] !== undefined) env[key] = process.env[key];
  return await new Promise<{ stdout: string; stderr: string; runnerWallMs: number }>((resolvePromise, reject) => {
    const began = performance.now();
    const child = spawn(command[0]!, command.slice(1), { cwd: request.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', ended = false;
    const stop = () => { try { process.platform !== 'win32' && child.pid ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); } catch { /* Already exited. */ } };
    const timer = setTimeout(() => { stop(); reject(new Error('runner_timeout')); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += String(chunk); if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) { stop(); reject(new Error('runner_output_too_large')); } });
    child.stderr.on('data', chunk => { if (stderr.length < 32_768) stderr += String(chunk).slice(0, 32_768 - stderr.length); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { ended = true; clearTimeout(timer); code === 0 ? resolvePromise({ stdout, stderr, runnerWallMs: performance.now() - began }) : reject(new Error(`runner_exit:${code ?? signal}:${stderr}`)); });
    child.stdin.on('error', error => { if (!ended) reject(error); });
    child.stdin.end(JSON.stringify(request));
  });
}

export const p95 = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1]! : null;
export function summarize(runs: ReplayRun[]) {
  const failures = runs.flatMap(run => run.failures.map(failure => `${run.caseId}:${run.policy}:${run.repetition}:${failure}`));
  const totals = Object.fromEntries(policies.map(policy => {
    const unique = new Map<string, ReplayAttempt>();
    for (const run of runs.filter(item => item.policy === policy)) for (const attempt of Array.isArray(run.result?.attempts) ? run.result!.attempts : []) {
      if (!attempt || typeof attempt !== 'object' || !attempt.usageRef) continue;
      const previous = unique.get(attempt.usageRef);
      if (previous && !isDeepStrictEqual(previous, attempt)) failures.push(`${policy}:conflicting_global_usage_ref:${attempt.usageRef}`);
      unique.set(attempt.usageRef, attempt);
    }
    const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const attempt of unique.values()) for (const key of metrics) if (nonnegative(attempt.usage?.[key])) tokens[key] += attempt.usage![key];
    const selected = runs.filter(run => run.policy === policy);
    return [policy, { ...tokens, total: metrics.reduce((sum, key) => sum + tokens[key], 0), uniqueUsageRefs: [...unique.keys()], completed: selected.filter(run => run.result?.status === 'completed').length, qualityPassed: selected.filter(run => run.quality === 'pass').length, runCount: selected.length, usageCoverage: selected.length ? selected.filter(run => run.coverage === 'verified').length / selected.length : 0 }];
  })) as Record<Policy, { input: number; cacheRead: number; cacheWrite: number; output: number; total: number; uniqueUsageRefs: string[]; completed: number; qualityPassed: number; runCount: number; usageCoverage: number }>;
  const latencyByType = [...new Set(runs.map(run => run.type))].map(type => {
    const latency = (policy: Policy) => p95(runs.filter(run => run.type === type && run.policy === policy).flatMap(run => nonnegative(run.result?.latencyMs) ? [run.result!.latencyMs] : []));
    const legacy = latency('legacy'), optimized = latency('optimized');
    const passed = legacy !== null && optimized !== null && optimized <= legacy * 1.10;
    if (!passed) failures.push(`latency_p95:${type}`);
    return { type, legacy, optimized, maximumIncrease: .10, passed };
  });
  const coverage = runs.length > 0 && runs.every(run => run.coverage === 'verified') && policies.every(policy => totals[policy].runCount > 0);
  if (!coverage) failures.push('usage_coverage_unverified');
  if (totals.optimized.total >= totals.legacy.total) failures.push('total_tokens_not_reduced');
  const needsReview = runs.some(run => run.quality === 'needs_review');
  const providerVerified = runs.length > 0 && runs.every(run => run.result?.executionSource === 'provider');
  const executionScopes = [...new Set(runs.map(run => (run.result as ReplayResult & { executionScope?: string } | undefined)?.executionScope ?? 'fixture_tool_pipeline'))];
  const modelVerification = runs.every(run => Array.isArray(run.result?.attempts) && run.result.attempts.every(attempt => attempt && attempt.rawUsage && typeof attempt.rawUsage === 'object' && 'modelSource' in attempt.rawUsage && attempt.rawUsage.modelSource === 'reported')) ? 'verified' : 'unverified';
  return { executionScopes, modelVerification, fullPipelineVerified: providerVerified && executionScopes.every(scope => scope === 'full_agent_pipeline'), status: failures.length ? 'fail' : needsReview ? 'needs_review' : providerVerified ? 'pass' : 'unverified', failures, providerVerified, qualityReviewRequired: needsReview, usageCoverage: coverage ? 'verified' : 'unverified', totals, latencyByType, tokenReduction: totals.legacy.total > 0 ? 1 - totals.optimized.total / totals.legacy.total : null, cost: 'unverified', runs };
}

export async function evaluate(manifest: Manifest, manifestDirectory = process.cwd()) {
  validateManifest(manifest);
  // Freeze a JSON snapshot before either arm executes, including tool data, checks and initial files.
  manifest = JSON.parse(JSON.stringify(manifest)) as Manifest;
  const runs: ReplayRun[] = [];
  for (const item of manifest.cases) for (let repetition = 0; repetition < manifest.repetitions; repetition++) {
    // Alternate paired ordering, avoiding a systematic warm-up advantage.
    for (const policy of repetition % 2 ? [...policies].reverse() : policies) {
      const workspace = await mkdtemp(join(tmpdir(), 'dutydeck-token-replay-'));
      const runner = manifest.runners[policy].map((arg, index) => arg.startsWith('./') || (index === 0 && arg.includes(sep) && !isAbsolute(arg)) ? resolve(manifestDirectory, arg) : arg);
      const inputDigest = hash({ case: item, config: manifest.frozenConfig });
      const request: ReplayRequest = { version: 1, case: item, policy, config: manifest.frozenConfig, workspace, inputDigest };
      const run: ReplayRun = { caseId: item.id, type: item.type, repetition, policy, runner, runnerWallMs: 0, stderr: '', failures: [], quality: 'fail', coverage: 'unverified' };
      try {
        if (manifest.providerAuth === 'codex_login') {
          const authPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
          const auth = await readFile(authPath);
          await mkdir(join(workspace, '.codex'), { recursive: true });
          await writeFile(join(workspace, '.codex', 'auth.json'), auth, { mode: 0o600 });
        }
        for (const [path, text] of Object.entries(item.files ?? {})) { const file = join(workspace, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); }
        const executed = await runCommand(runner, request, manifest.timeoutMs ?? 120_000, manifest.providerEnv ?? []);
        run.runnerWallMs = executed.runnerWallMs; run.stderr = executed.stderr;
        const result = JSON.parse(executed.stdout) as ReplayResult;
        run.result = result;
        const protocolFailures = validateResult(request, result);
        const qualityFailures = checkQuality(item, result.output);
        run.failures = [...protocolFailures, ...qualityFailures];
        run.quality = result.status !== 'completed' || qualityFailures.length ? 'fail' : item.needsReview || !item.checks.length ? 'needs_review' : 'pass';
        run.coverage = protocolFailures.some(failure => /usage|coverage|attempt|source|frozen/.test(failure)) ? 'unverified' : 'verified';
      } catch (error) { run.failures.push(error instanceof Error ? error.message : String(error)); }
      finally { await rm(workspace, { recursive: true, force: true }); }
      runs.push(run);
    }
  }
  return { version: 1, manifestDigest: hash(manifest), frozenConfig: manifest.frozenConfig, repetitions: manifest.repetitions, ...summarize(runs) };
}

async function main() {
  const [manifestPath, reportPath] = process.argv.slice(2);
  if (!manifestPath || !reportPath) throw new Error('Usage: node --import tsx scripts/evaluate-token-efficiency.mts <manifest.json> <report.json>');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  const report = await evaluate(manifest, dirname(resolve(manifestPath)));
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: report.status, report: resolve(reportPath), failures: report.failures }) + '\n');
  if (report.status !== 'pass') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
