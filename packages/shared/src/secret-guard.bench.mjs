import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { secretGuardHookCommand as candidateHookCommand } from '../runtime/secret-guard.mjs';

const quantile = (sorted, q) => {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[lower + 1] - sorted[lower]) * fraction;
};

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);
  return {
    medianMs: median,
    p95Ms: quantile(sorted, 0.95),
    iqrMs: q3 - q1,
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

async function main() {
  const baselineIndex = process.argv.indexOf('--baseline');
  if (baselineIndex < 0 || !process.argv[baselineIndex + 1]) throw new Error('usage: node secret-guard.bench.mjs --baseline <baseline-secret-guard.mjs> [--iterations 61]');
  const iterationIndex = process.argv.indexOf('--iterations');
  const iterations = iterationIndex < 0 ? 61 : Number(process.argv[iterationIndex + 1]);
  if (!Number.isInteger(iterations) || iterations < 20) throw new Error('--iterations must be an integer >= 20');
  const { secretGuardHookCommand: baselineHookCommand } = await import(pathToFileURL(resolve(process.argv[baselineIndex + 1])).href);
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-secret-guard-bench-'));
  try {
    const eventFor = command => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/work/repo' });
    const scenarios = [
      { name: 'missing-policy', command: 'cat ~/.codex/auth.json', policy: undefined, deny: false },
      { name: 'policy-allow', command: 'pnpm test', policy: { enabled: true, authorized: false }, deny: false },
      { name: 'policy-deny', command: 'cat ~/.codex/auth.json', policy: { enabled: true, authorized: false }, deny: true },
    ];
    const versions = [
      { name: 'baseline', hook: baselineHookCommand },
      { name: 'candidate', hook: candidateHookCommand },
    ];
    const env = { ...process.env, HOME: '/home/alice', dutydeck_session_id: 'ses_benchmark' };
    const results = [];
    for (const scenario of scenarios) {
      const policyRoot = join(root, scenario.name);
      if (scenario.policy) {
        const sessions = join(policyRoot, '.dutydeck', 'security', 'sessions');
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, 'ses_benchmark.json'), JSON.stringify(scenario.policy));
      } else mkdirSync(policyRoot);
      const commands = versions.map(version => ({
        ...version,
        command: version.hook({ nodePath: process.execPath, policyRoot }),
        samples: [],
      }));
      const run = version => {
        const started = performance.now();
        const result = spawnSync('/bin/sh', ['-c', version.command], {
          input: JSON.stringify(eventFor(scenario.command)), encoding: 'utf8', env,
        });
        version.samples.push(performance.now() - started);
        if (result.status !== 0) throw new Error(`${scenario.name}/${version.name} exited ${result.status}: ${result.stderr}`);
        const denied = Boolean(result.stdout && JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision === 'deny');
        if (denied !== scenario.deny) throw new Error(`${scenario.name}/${version.name} returned an unexpected decision`);
      };
      for (const version of commands) for (let index = 0; index < 5; index++) run(version);
      for (const version of commands) version.samples = [];
      for (let index = 0; index < iterations; index++) {
        if (index % 2 === 0) {
          run(commands[0]);
          run(commands[1]);
        } else {
          run(commands[1]);
          run(commands[0]);
        }
      }
      for (const version of commands) {
        const summary = stats(version.samples);
        results.push({ scenario: scenario.name, version: version.name, iterations, ...summary, samplesMs: version.samples });
        console.log(`${scenario.name}/${version.name}: median=${summary.medianMs.toFixed(3)}ms p95=${summary.p95Ms.toFixed(3)}ms IQR=${summary.iqrMs.toFixed(3)}ms min=${summary.minMs.toFixed(3)}ms max=${summary.maxMs.toFixed(3)}ms`);
      }
    }

    const count = join(root, 'node-count');
    const countingNode = join(root, 'counting-node');
    writeFileSync(countingNode, `#!/bin/sh\nprintf 1 >> ${JSON.stringify(count)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    const missingRoot = join(root, 'zero-node-check');
    mkdirSync(missingRoot);
    const command = candidateHookCommand({ nodePath: countingNode, policyRoot: missingRoot });
    for (let index = 0; index < iterations; index++) {
      const result = spawnSync('/bin/sh', ['-c', command], {
        input: JSON.stringify(eventFor('cat ~/.codex/auth.json')), encoding: 'utf8', env,
      });
      if (result.status !== 0) throw new Error(`zero-node check exited ${result.status}`);
    }
    const nodeStarts = existsSync(count) ? readFileSync(count, 'utf8').length : 0;
    if (nodeStarts !== 0) throw new Error('the common missing-policy path started Node');
    console.log(`common missing-policy Node starts: 0/${iterations}`);
    console.log(JSON.stringify({ node: process.version, platform: process.platform, warmupPerVersionPerScenario: 5, results, commonMissingPolicy: { runs: iterations, nodeStarts } }, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});
