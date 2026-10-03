import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { evaluate, p95, validateManifest, type Manifest } from '../scripts/evaluate-token-efficiency.mts';
const runner = fileURLToPath(new URL('./fixtures/token-efficiency/local-runner.mts', import.meta.url));
const fixture = (fault?: string): Manifest => ({ version: 1, frozenConfig: { model: 'local-fixture', protocol: 'mock' }, repetitions: 1,
  runners: { legacy: [process.execPath, '--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), runner], optimized: [process.execPath, '--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), runner] },
  cases: [{ id: 'fact', type: 'retrieval', input: { messageId: 'm1', requiredWord: 'confirmed' }, toolData: { messages: [{ id: 'm1', text: 'ship on Friday' }, { id: 'm2', text: 'other message' }], fault }, files: { 'initial.txt': 'frozen' },
    checks: [{ kind: 'exact', path: ['fact'], value: 'ship on Friday' }, { kind: 'exact', path: ['requiredWord'], value: 'confirmed' }, { kind: 'schema', path: [], required: ['messageId', 'fact', 'requiredWord'] }] }] });

describe('paired token efficiency replay evaluator', () => {
  it('executes both arms, retains raw usage, deduplicates shared background receipts, and labels mock benefit unverified', async () => {
    const report = await evaluate(fixture());
    expect(report.status).toBe('unverified');
    expect(report.failures).toEqual([]);
    expect(report.providerVerified).toBe(false);
    expect(report.totals.legacy).toMatchObject({ input: 300, output: 30, total: 330, usageCoverage: 1 });
    expect(report.totals.optimized).toMatchObject({ input: 150, output: 30, total: 180 });
    expect(report.runs).toHaveLength(2);
    for (const run of report.runs) {
      expect(run.result?.attempts[0]?.rawUsage).toMatchObject({ fixture: true });
      expect(run.stderr).toContain('isolated workspace');
      expect(run.runnerWallMs).toBeGreaterThan(0);
    }
  });

  it.each(['wrong_answer', 'missing_constraint', 'missing_usage', 'missing_coverage', 'missing_child_inventory', 'forged_provider', 'conflicting_usage', 'latency', 'failed', 'config_changed', 'exit', 'broken_json'])('rejects %s instead of accepting apparent savings', async fault => {
    const report = await evaluate(fixture(fault));
    expect(report.status).toBe('fail');
    expect(report.failures.length).toBeGreaterThan(0);
    if (fault.includes('usage') || fault === 'missing_coverage') expect(report.usageCoverage).toBe('unverified');
    if (fault === 'latency') expect(report.latencyByType).toEqual([{ type: 'retrieval', legacy: 100, optimized: 120, maximumIncrease: .10, passed: false }]);
  });

  it.each(['malformed_attempts_object', 'malformed_attempts_null'])('returns a failed report for %s instead of throwing', async fault => {
    const report = await evaluate(fixture(fault));
    expect(report.status).toBe('fail');
    expect(report.usageCoverage).toBe('unverified');
    expect(report.modelVerification).toBe('unverified');
    expect(report.runs).toHaveLength(2);
    expect(report.failures.join(' ')).toContain('root_attempt_missing');
    expect(report.runs[1]!.result?.attempts).toEqual(fault === 'malformed_attempts_object' ? {} : [null]);
  });

  it('marks open quality needs_review and never substitutes model scoring for a hard gate', async () => {
    const manifest = fixture(); manifest.cases[0]!.needsReview = true;
    const report = await evaluate(manifest);
    expect(report.status).toBe('needs_review');
    expect(report.qualityReviewRequired).toBe(true);
  });

  it('deduplicates a background job across roots and does not hide failed costs', async () => {
    const manifest = fixture();
    manifest.cases.push({ ...manifest.cases[0]!, id: 'fact2', toolData: { ...(manifest.cases[0]!.toolData as object), fault: 'wrong_answer' } });
    const report = await evaluate(manifest);
    expect(report.status).toBe('fail');
    expect(report.totals.legacy).toMatchObject({ input: 500, output: 50, total: 550, runCount: 2 });
    expect(report.totals.optimized).toMatchObject({ input: 250, output: 50, total: 300, runCount: 2 });
  });

  it('kills timed out executions and rejects escaping fixtures and injected live environment', async () => {
    const manifest = fixture(); manifest.timeoutMs = 1;
    const report = await evaluate(manifest);
    expect(report.status).toBe('fail');
    expect(report.failures.join(' ')).toContain('runner_timeout');
    const unsafe = fixture(); unsafe.cases[0]!.files = { '../escaped.txt': 'no' };
    expect(() => validateManifest(unsafe)).toThrow('temporary workspace');
    unsafe.cases[0]!.files = {}; unsafe.providerEnv = ['dutydeck_group_tools_token'];
    expect(() => validateManifest(unsafe)).toThrow('live tools');
  });

  it('computes nearest-rank p95 from all samples, including the tail', () => {
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
    expect(p95([])).toBeNull();
  });
});
