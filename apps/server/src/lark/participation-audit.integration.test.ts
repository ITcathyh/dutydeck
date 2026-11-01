import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

it.each(['audit', 'timer'] as const)('survives a %s failure in the real timer and handles the next message in strict Node', failure => {
  const code = [
    "import assert from 'node:assert/strict';",
    "import { createRepositories } from './packages/storage/src/index.ts';",
    "import { LarkGroupParticipation } from './apps/server/src/lark/group-participation.ts';",
    "const repos = createRepositories(':memory:'); const scope = { appId: 'app', chatId: 'chat' }; let calls = 0, warnings = 0, broken = true;",
    "const store = { ...repos.config, get: async key => { if (broken) throw new Error('audit unavailable'); return repos.config.get(key); } };",
    "const p = new LarkGroupParticipation({ repository: repos.collaboration, inboxStore: store, debounceMs: 5, readConfig: async () => ({ listening: true }), authorize: async () => true, serviceFor: () => ({}), decider: {}, log: { warn: () => warnings++ } });",
    "p.decide = async () => { calls++; if (calls === 1 && " + JSON.stringify(failure) + " === 'audit') throw new Error('decision failed'); };",
    "const drain = p.drain.bind(p); let first = true;",
    "if (" + JSON.stringify(failure) + " === 'timer') p.drain = async (...args) => { if (first) { first = false; throw new Error('unexpected drain rejection'); } return drain(...args); };",
    "p.enqueue(scope, { event: { messageId: 'first' } });",
    "await new Promise(resolve => setTimeout(resolve, 40)); broken = false;",
    "p.enqueue(scope, { event: { messageId: 'next' } });",
    "await new Promise(resolve => setTimeout(resolve, 40)); await p.close(); repos.close();",
    "assert.equal(calls, " + (failure === 'audit' ? '2' : '1') + "); assert.ok(warnings > 0); console.log('survived-next-message', calls);"
  ].join('\n');
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--import', 'tsx', '--input-type=module', '-e', code],
    { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toContain('survived-next-message');
});
