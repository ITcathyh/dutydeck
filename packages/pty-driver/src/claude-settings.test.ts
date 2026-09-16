import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import type { SessionBackend } from '@dutydeck/session-backends';
import { ClaudeSettings } from './claude-settings.js';
import { PtyCliDriver } from './driver.js';

const directories: string[] = [];
const settings: ClaudeSettings[] = [];
afterEach(() => {
  for (const item of settings.splice(0)) item.cleanup();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const fixture = (adapterId = 'claude-code') => {
  const cwd = mkdtempSync(join(tmpdir(), 'claude-settings-test-'));
  directories.push(cwd);
  const sessionId = randomUUID();
  const helper = new ClaudeSettings(adapterId, sessionId);
  settings.push(helper);
  const generated = createCliAdapter(adapterId).buildArgs({ sessionId, permissionMode: 'full-trust' });
  return { cwd, helper, generated, sessionId };
};

describe('Claude settings composition', () => {
  it.each(['ask', 'full-trust'] as const)('adds only the native question hook and preserves existing hooks in %s mode', permissionMode => {
    const { cwd, helper, sessionId } = fixture();
    const generated = createCliAdapter('claude-code').buildArgs({ sessionId, permissionMode, env: {
      dutydeck_relay_url: 'http://localhost/api/relay', dutydeck_relay_token: 'fixture-secret',
      dutydeck_relay_command: "'/usr/bin/node' '/opt/dutydeck/cli.js'",
    } });
    const original = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check-shell' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'start' }] }] }, permissions: { deny: ['Bash(rm *)'] } };
    const argv = helper.args(['--settings', JSON.stringify(original)], generated, cwd);
    expect(argv.join(' ')).not.toContain('fixture-secret');
    const composed = JSON.parse(readFileSync(argv.at(-1)!, 'utf8'));
    expect(composed.hooks.PreToolUse[0]).toEqual(original.hooks.PreToolUse[0]);
    expect(composed.hooks.PreToolUse[1]).toEqual({ matcher: '^AskUserQuestion$', hooks: [{
      type: 'command', command: "'/usr/bin/node' '/opt/dutydeck/cli.js' session native-ask", timeout: 1230,
    }] });
    expect(composed.hooks.SessionStart).toEqual(original.hooks.SessionStart);
    expect(composed.permissions.deny).toEqual(['Bash(rm *)']);
    expect(composed.permissions.defaultMode).toBe(permissionMode === 'full-trust' ? 'bypassPermissions' : undefined);
  });

  it('installs the native question hook during driver startup using agent.env', async () => {
    const { cwd, sessionId } = fixture();
    let spawnedArgs: string[] = [];
    const backend: SessionBackend = {
      kind: 'pty', spawn(_command, args) { spawnedArgs = args; }, write() {}, resize() {},
      kill() {}, onData() {}, onExit() {},
    };
    const driver = new PtyCliDriver({
      agent: {
        id: 'claude-code', name: 'Claude', command: 'claude', args: ['--settings', JSON.stringify({ theme: 'dark' })],
        protocol: 'pty-cli', cwd, permissionMode: 'full-trust', timeout: 60,
        env: {
          dutydeck_relay_url: 'http://localhost/api/relay',
          dutydeck_relay_token: 'fixture-secret',
          dutydeck_relay_command: "'/usr/bin/node' '/opt/dutydeck/cli.js'",
        },
        capabilities: { pause: false, resume: true }, builtin: false,
      },
      adapter: createCliAdapter('claude-code'),
      backend, sessionId, onEvent: () => {}, onExit: () => {},
    });
    try {
      await driver.start();
      expect(spawnedArgs.join(' ')).not.toContain('fixture-secret');
      const settingsIndex = spawnedArgs.indexOf('--settings');
      expect(settingsIndex).toBeGreaterThanOrEqual(0);
      const settingsPath = spawnedArgs[settingsIndex + 1]!;
      expect(existsSync(settingsPath)).toBe(true);
      const composed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(composed.theme).toBe('dark');
      expect(composed.hooks.PreToolUse).toEqual([{
        matcher: '^AskUserQuestion$',
        hooks: [{
          type: 'command', command: "'/usr/bin/node' '/opt/dutydeck/cli.js' session native-ask", timeout: 1230,
        }],
      }]);
    } finally {
      await driver.stop();
    }
  });

  it.each(['claude-code', 'seed', 'relay', 'genius'])('preserves user settings and permissions for %s without credentials in argv', adapterId => {
    const { cwd, helper, generated } = fixture(adapterId);
    const original = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fixture-secret', ANTHROPIC_BASE_URL: 'http://fixture.invalid' },
      permissions: { allow: ['Read'], deny: ['Bash(rm *)'], defaultMode: 'default' }, theme: 'dark' });
    writeFileSync(join(cwd, 'gateway.json'), original);
    const argv = helper.args(['--wrapper', 'profile', '--settings', 'gateway.json'], generated, cwd);
    expect(argv.filter(arg => arg === '--settings')).toHaveLength(1);
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv.slice(0, 2)).toEqual(['--wrapper', 'profile']);
    expect(argv.join(' ')).not.toContain('fixture-secret');
    const path = argv.at(-1)!;
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      ...JSON.parse(original), skipDangerousModePermissionPrompt: true,
      permissions: { allow: ['Read'], deny: ['Bash(rm *)'], defaultMode: 'bypassPermissions' },
    });
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(cwd, 'gateway.json'), 'utf8')).toBe(original);
    helper.cleanup();
    expect(existsSync(dirname(path))).toBe(false);
  });

  it.each([
    ['--settings', '{"env":{"TOKEN":"inline-secret"}}'],
    ['--settings={"env":{"TOKEN":"inline-secret"}}'],
    ['--settings=missing.json', '--settings', '{"env":{"TOKEN":"inline-secret"}}'],
    ['--settings', 'missing.json', '--settings={"env":{"TOKEN":"inline-secret"}}'],
  ])('uses the last user settings value with split or equals syntax: %j', (...userArgs) => {
    const { cwd, helper, generated } = fixture();
    const argv = helper.args(userArgs, generated, cwd);
    expect(argv.join(' ')).not.toContain('inline-secret');
    expect(argv).not.toContain('missing.json');
    expect(JSON.parse(readFileSync(argv.at(-1)!, 'utf8')).env).toEqual({ TOKEN: 'inline-secret' });
  });

  it('accepts equals syntax for a relative file and rereads it for each launch', () => {
    const { cwd, helper, generated } = fixture();
    const source = join(cwd, 'settings.json');
    writeFileSync(source, '{"env":{"VERSION":"first"}}');
    const first = helper.args(['--settings=settings.json'], generated, cwd).at(-1)!;
    writeFileSync(source, '{"env":{"VERSION":"second"}}');
    const second = helper.args(['--settings=settings.json'], generated, cwd).at(-1)!;
    expect(second).not.toBe(first);
    expect(JSON.parse(readFileSync(first, 'utf8')).env.VERSION).toBe('first');
    expect(JSON.parse(readFileSync(second, 'utf8')).env.VERSION).toBe('second');
  });

  it.each(['missing.json', '{"TOKEN":"private-value",bad}', '[]', '{"permissions":[]}'])('rejects bad settings without echoing contents: %s', value => {
    const { cwd, helper, generated } = fixture();
    expect(() => helper.args(['--settings', value], generated, cwd)).toThrow('Invalid Claude --settings');
    try { helper.args(['--settings', value], generated, cwd); }
    catch (error) { expect(String(error)).not.toContain('private-value'); }
  });

  it('keeps ask, no-user-settings, and non-Claude arguments unchanged', () => {
    const { cwd, helper, generated, sessionId } = fixture();
    const user = ['--settings', 'not-read-in-ask.json'];
    const ask = createCliAdapter('claude-code').buildArgs({ sessionId, permissionMode: 'ask' });
    expect(helper.args(user, ask, cwd)).toEqual([...user, ...ask]);
    expect(helper.args([], generated, cwd)).toEqual(generated);
    const unrelated = new ClaudeSettings('codex', sessionId);
    expect(unrelated.args(user, generated, cwd)).toEqual([...user, ...generated]);
  });

  it('does not remove replacement settings when an old process exits late', () => {
    const { cwd, helper, generated, sessionId } = fixture();
    const user = ['--settings', '{"env":{"TOKEN":"fixture-secret"}}'];
    const oldPath = helper.args(user, generated, cwd).at(-1)!;
    const replacement = new ClaudeSettings('claude-code', sessionId);
    settings.push(replacement);
    const newPath = replacement.args(user, generated, cwd).at(-1)!;
    helper.cleanup();
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    replacement.cleanup();
    expect(existsSync(dirname(newPath))).toBe(false);
  });
});
