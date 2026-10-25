import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginHookSpec } from '@dutydeck/shared';
import { HOOK_STDOUT_LIMIT, PluginHookBus, runCommandHook, type HookRegistration } from './hooks.js';

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-hooks-')); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const command = (plugin: string, script: string, extra: Partial<PluginHookSpec> & { scope?: string; matcher?: RegExp } = {}): HookRegistration => {
  const { scope = 'global', matcher, ...spec } = extra;
  return { kind: 'command', plugin, scope, event: 'task.received', cwd, env: { MARK: plugin }, spec: { command: script, timeout: 2_000, onFailure: 'ignore', ...spec }, ...(matcher ? { matcher } : {}) };
};
const input = { botAppId: 'cli_a', cwd: '/repo', payload: { prompt: 'hi' } };

describe('runCommandHook', () => {
  it('passes JSON on stdin and plugin env, and truncates stdout at the cap', async () => {
    const echoed = await runCommandHook('cat; printf " $MARK"', { a: 1 }, { cwd, env: { ...process.env, MARK: 'x' }, timeout: 2_000 });
    expect(echoed).toMatchObject({ exitCode: 0, stdout: '{"a":1} x', timedOut: false });
    const big = await runCommandHook(['node', '-e', `process.stdout.write('y'.repeat(${HOOK_STDOUT_LIMIT * 2}))`], {}, { cwd, env: process.env, timeout: 5_000 });
    expect(big.stdout).toHaveLength(HOOK_STDOUT_LIMIT);
    expect(big.stdoutTruncated).toBe(true);
  });

  it('kills the process group on timeout', async () => {
    const started = Date.now();
    const result = await runCommandHook('sleep 5 & sleep 5; wait', {}, { cwd, env: process.env, timeout: 200 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('returns on timeout even when a descendant left the group and still holds stdout', async () => {
    const started = Date.now();
    const result = await runCommandHook(['node', '-e', `require('node:child_process').spawn('sleep', ['5'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); setInterval(() => {}, 1000)`], {}, { cwd, env: process.env, timeout: 300 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('PluginHookBus protocol', () => {
  it('does not expose daemon secret environment to command hooks', async () => {
    const previous = process.env.DUTYDECK_HOOK_SECRET; process.env.DUTYDECK_HOOK_SECRET = 'synthetic-secret';
    try {
      const output = join(cwd, 'env.txt');
      const bus = new PluginHookBus([command('secret', `printf '%s' \"$DUTYDECK_HOOK_SECRET\" > ${output}`)]);
      await bus.run('task.received', input);
      expect(await readFile(output, 'utf8')).toBe('');
    } finally { if (previous === undefined) delete process.env.DUTYDECK_HOOK_SECRET; else process.env.DUTYDECK_HOOK_SECRET = previous; }
  });

  it('exit 0 allows and stdout JSON carries decision, context and prompt rewrite', async () => {
    const bus = new PluginHookBus([
      command('a', `cat > ${join(cwd, 'stdin.json')}; echo '{"additionalContext":"ctx-a","updatedPrompt":"rewritten"}'`),
      command('b', 'echo \'{"decision":"allow","additionalContext":"ctx-b"}\'')
    ]);
    const result = await bus.run('task.received', input);
    expect(result).toMatchObject({ decision: 'allow', additionalContext: ['ctx-a', 'ctx-b'], updatedPrompt: 'rewritten' });
    expect(JSON.parse(await readFile(join(cwd, 'stdin.json'), 'utf8'))).toEqual({ ...input, event: 'task.received', plugin: 'a' });
  });

  it('exit 2 blocks with stderr as the reason and stops later hooks', async () => {
    const marker = join(cwd, 'later');
    const bus = new PluginHookBus([command('a', 'echo "no deploys on friday" >&2; exit 2'), command('b', `touch ${marker}`)]);
    expect(await bus.run('task.received', input)).toMatchObject({ decision: 'deny', reason: 'no deploys on friday' });
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('other exit codes and timeouts are non-blocking unless onFailure is block', async () => {
    const log = { warn: vi.fn() };
    const ignore = new PluginHookBus([command('a', 'exit 1'), command('b', 'sleep 3', { timeout: 150 })], log);
    const ignored = await ignore.run('task.received', input);
    expect(ignored.decision).toBeUndefined();
    expect(ignored.outcomes.map(outcome => outcome.result)).toEqual(['error', 'error']);
    expect(ignored.outcomes[1]).toMatchObject({ timedOut: true });
    expect(log.warn).toHaveBeenCalledTimes(2);

    expect(await new PluginHookBus([command('a', 'exit 1', { onFailure: 'block' })]).run('task.received', input)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('onFailure=block') });
    expect(await new PluginHookBus([command('a', 'sleep 3', { timeout: 150, onFailure: 'block' })]).run('task.received', input)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('150ms') });
  });

  it('deny wins over earlier allow and ask', async () => {
    const bus = new PluginHookBus([
      command('a', 'echo \'{"decision":"allow"}\''),
      command('b', 'echo \'{"decision":"ask","reason":"check"}\''),
      command('c', 'echo \'{"decision":"deny","reason":"nope"}\'')
    ]);
    expect(await bus.run('task.received', input)).toMatchObject({ decision: 'deny', reason: 'nope' });
    expect(await new PluginHookBus([command('a', 'echo \'{"decision":"allow"}\''), command('b', 'echo \'{"decision":"ask"}\'')]).run('task.received', input)).toMatchObject({ decision: 'ask' });
  });

  it('ignores truncated or non-JSON stdout', async () => {
    const huge = `node -e "process.stdout.write(JSON.stringify({decision:'deny',reason:'x'.repeat(${HOOK_STDOUT_LIMIT})}))"`;
    const bus = new PluginHookBus([command('a', huge), command('b', 'echo hello')]);
    const result = await bus.run('task.received', input);
    expect(result.decision).toBeUndefined();
    expect(result.outcomes[0]).toMatchObject({ result: 'allow', stdoutTruncated: true });
  });

  it('filters by scope and matcher, and runs in-process handlers with a timeout', async () => {
    const handler = vi.fn(async () => ({ additionalContext: 'from-handler' }));
    const bus = new PluginHookBus([
      command('other-bot', 'exit 2', { scope: 'bot:cli_other' }),
      command('other-repo', 'exit 2', { scope: 'workspace:/elsewhere' }),
      command('no-match', 'exit 2', { matcher: /^schedule$/ }),
      { kind: 'handler', plugin: 'h', scope: 'workspace:/repo', event: 'task.received', handler, timeout: 1_000 },
      { kind: 'handler', plugin: 'slow', scope: 'global', event: 'task.received', handler: () => new Promise(() => {}), timeout: 100 }
    ]);
    const result = await bus.run('task.received', input, 'lark');
    expect(result.decision).toBeUndefined();
    expect(result.additionalContext).toEqual(['from-handler']);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ event: 'task.received', plugin: 'h' }));
    expect(result.outcomes.map(outcome => [outcome.plugin, outcome.result])).toEqual([['h', 'allow'], ['slow', 'error']]);
    expect(bus.has('task.received')).toBe(true);
    expect(bus.has('notify')).toBe(false);
  });
});
