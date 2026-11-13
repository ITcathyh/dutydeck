import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { listAcpxBuiltinAgents } from './index.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe('Claude ACP launcher', () => {
  it('routes the built-in Claude agent through the Dutydeck launcher', () => {
    const claude = listAcpxBuiltinAgents().find(agent => agent.id === 'claude');
    expect(claude?.argv[0]).toBe(process.execPath);
    expect(claude?.argv[1]).toMatch(/claude-acp\.mjs$/);
  });

  it('uses the exact installed Claude ACP binary without runtime npx resolution', async () => {
    const packageJson = JSON.parse(await readFile(resolve(process.cwd(), 'packages/acp-client/package.json'), 'utf8'));
    const standalonePackageJson = JSON.parse(await readFile(resolve(process.cwd(), 'apps/server/package.json'), 'utf8'));
    const launcher = await readFile(resolve(process.cwd(), 'packages/acp-client/agents/claude-acp.mjs'), 'utf8');
    expect(packageJson.dependencies['@agentclientprotocol/claude-agent-acp']).toBe('0.66.0');
    expect(standalonePackageJson.dependencies['@agentclientprotocol/claude-agent-acp']).toBe('0.66.0');
    expect(launcher).toContain("import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')");
    expect(launcher).not.toMatch(/\bnpx\b/);
  });

  it('loads Claude settings env without overriding explicit process variables and reuses the installed CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-claude-launcher-')); dirs.push(root);
    const configDir = join(root, 'config'); const project = join(root, 'project');
    await mkdir(configDir, { recursive: true }); await mkdir(join(project, '.claude'), { recursive: true });
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'settings-token', ANTHROPIC_BASE_URL: 'https://user.example' } }));
    await writeFile(join(project, '.env'), 'ANTHROPIC_BASE_URL=https://dotenv.example\nCLAUDE_CODE_USE_BEDROCK=1\n');
    await writeFile(join(project, '.env.local'), 'ANTHROPIC_BASE_URL=https://dotenv-local.example\nAWS_PROFILE=dutydeck-test\n');
    await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://project.example' } }));
    await writeFile(join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'local-model' } }));
    const bin = join(root, 'bin'); await mkdir(bin); const claude = join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    // 假的 claude 只回显收到的参数和自己看到的 CLAUDE_CODE_EXECUTABLE。
    await writeFile(claude, process.platform === 'win32' ? '@echo off\r\n' : `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), executable: process.env.CLAUDE_CODE_EXECUTABLE, guard: process.env.dutydeck_secret_guard_settings }))\n`); await chmod(claude, 0o755);
    const inspect = `process.stdout.write(JSON.stringify({ token: process.env.ANTHROPIC_AUTH_TOKEN, base: process.env.ANTHROPIC_BASE_URL, model: process.env.ANTHROPIC_MODEL, bedrock: process.env.CLAUDE_CODE_USE_BEDROCK, awsProfile: process.env.AWS_PROFILE, executable: process.env.CLAUDE_CODE_EXECUTABLE, real: process.env.dutydeck_claude_executable, guard: process.env.dutydeck_secret_guard_settings }))`;
    const inheritedEnv = { ...process.env };
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_PROFILE', 'CLAUDE_CODE_EXECUTABLE']) delete inheritedEnv[key];
    const result = spawnSync(process.execPath, [resolve(process.cwd(), 'packages/acp-client/agents/claude-acp.mjs')], {
      cwd: project,
      env: { ...inheritedEnv, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_AUTH_TOKEN: 'explicit-token', DUTYDECK_CLAUDE_ACP_COMMAND: process.execPath, DUTYDECK_CLAUDE_ACP_ARGS_JSON: JSON.stringify(['-e', inspect]) },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    const { real, guard, ...launched } = JSON.parse(result.stdout);
    expect(launched).toEqual({ token: 'explicit-token', base: 'https://project.example', model: 'local-model', bedrock: undefined, awsProfile: undefined,
      executable: process.platform === 'win32' ? claude : expect.stringMatching(/\/dutydeck-claude-guard-[^/]+\/claude-[0-9a-f]{16}\.sh$/) });
    if (process.platform === 'win32') return;
    // SDK 拿到的是转发脚本：凭据保护 hook 并进 SDK 自己传的 --settings（Claude Code 只认最后一个），再启动真正的 CLI。
    expect(real).toBe(claude);
    const sdkHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'sdk-hook' }] };
    const forwarded = spawnSync(launched.executable, ['--settings', JSON.stringify({ model: 'm', hooks: { PreToolUse: [sdkHook] } }), '--print'], {
      cwd: project, env: { ...process.env, dutydeck_claude_executable: real, dutydeck_secret_guard_settings: guard }, encoding: 'utf8' });
    expect(forwarded.status).toBe(0);
    const child = JSON.parse(forwarded.stdout);
    expect(child.executable).toBe(claude);
    expect(child.guard).toBeUndefined();
    expect(child.args).toHaveLength(3);
    expect(child.args[0]).toBe('--settings');
    expect(child.args[2]).toBe('--print');
    const settings = JSON.parse(child.args[1]);
    expect(settings.model).toBe('m');
    expect(settings.hooks.PreToolUse).toEqual([...JSON.parse(guard).hooks.PreToolUse, sdkHook]);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(`DUTYDECK_POLICY_ROOT='${project}'`);
  });
  it('blocks an ACP secret-guard timeout through launcher settings only with onFailure:block', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-claude-acp-timeout-')); dirs.push(root);
    const project = join(root, 'project'); const bin = join(root, 'bin');
    const sessions = join(project, '.dutydeck', 'security', 'sessions');
    await mkdir(sessions, { recursive: true }); await mkdir(bin);
    const sessionId = 'ses_acp_secret_timeout';
    await writeFile(join(sessions, `${sessionId}.json`), JSON.stringify({ enabled: true, authorized: false, pattern: '(a+)+$' }));
    const claude = join(bin, 'claude');
    await writeFile(claude, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('2.1.295 (Claude Code)\\n');\n`, { mode: 0o755 });
    const inspect = `process.stdout.write(JSON.stringify({ guard: process.env.dutydeck_secret_guard_settings }))`;
    const launched = spawnSync(process.execPath, [resolve(process.cwd(), 'packages/acp-client/agents/claude-acp.mjs')], {
      cwd: project,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, DUTYDECK_CLAUDE_ACP_COMMAND: process.execPath, DUTYDECK_CLAUDE_ACP_ARGS_JSON: JSON.stringify(['-e', inspect]) },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(launched.status).toBe(0);
    const guard = JSON.parse(launched.stdout).guard;
    const marker = join(root, 'tool-ran');
    const outcome = spawnSync(process.execPath, [resolve(process.cwd(), 'tests/fixtures/claude-hook-runner.mjs'), '--settings', guard, '--hook', 'secret-guard.mjs'], {
      cwd: project,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, dutydeck_session_id: sessionId, CLAUDE_HOOK_TEST_TOOL_MARKER: marker, CLAUDE_HOOK_TEST_TIMEOUT_MS: '40', CLAUDE_HOOK_TEST_EVENT: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `${'a'.repeat(100_000)}!` } }) },
      encoding: 'utf8', timeout: 5_000,
    });
    expect(outcome.error).toBeUndefined();
    expect(JSON.parse(outcome.stdout)).toMatchObject({ timedOut: true, onFailure: 'block', blocked: true });
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['2.1.220', false],
    ['2.1.295', true],
  ])('probes Claude independently in the ACP launcher before writing onFailure: %s', async (version, supported) => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-claude-acp-version-')); dirs.push(root);
    const bin = join(root, 'bin'); await mkdir(bin);
    const claude = join(bin, 'claude');
    await writeFile(claude, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write(${JSON.stringify(`${version} (Claude Code)\n`)});\n`, { mode: 0o755 });
    const inspect = `process.stdout.write(JSON.stringify({ guard: process.env.dutydeck_secret_guard_settings, report: process.env.dutydeck_claude_guard_report }))`;
    const report = join(root, 'guard-report');
    const launched = spawnSync(process.execPath, [resolve(process.cwd(), 'packages/acp-client/agents/claude-acp.mjs')], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, dutydeck_claude_guard_report: report, DUTYDECK_CLAUDE_ACP_COMMAND: process.execPath, DUTYDECK_CLAUDE_ACP_ARGS_JSON: JSON.stringify(['-e', inspect]) },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(launched.status).toBe(0);
    const output = JSON.parse(launched.stdout);
    expect(output.report).toBeUndefined();
    expect(await readFile(report, 'utf8')).toBe(supported ? '1' : '0');
    expect((await stat(report)).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(output.guard);
    expect(settings.hooks.PreToolUse[0].hooks[0].onFailure === 'block').toBe(supported);
  });

  it('fails launch instead of overwriting an existing guard report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-claude-acp-report-')); dirs.push(root);
    const bin = join(root, 'bin'); await mkdir(bin);
    const claude = join(bin, 'claude');
    await writeFile(claude, `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('2.1.295 (Claude Code)\\n');\n`, { mode: 0o755 });
    const report = join(root, 'guard-report'); await writeFile(report, 'stale');
    const marker = join(root, 'launched');
    const inspect = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1')`;
    const launched = spawnSync(process.execPath, [resolve(process.cwd(), 'packages/acp-client/agents/claude-acp.mjs')], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, dutydeck_claude_guard_report: report, DUTYDECK_CLAUDE_ACP_COMMAND: process.execPath, DUTYDECK_CLAUDE_ACP_ARGS_JSON: JSON.stringify(['-e', inspect]) },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(launched.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(report, 'utf8')).toBe('stale');
  });

  it.each(['bearer', 'api-key'] as const)('keeps explicit %s credentials exclusive over user and project cloud settings', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-claude-auth-')); dirs.push(root);
    await mkdir(join(root, '.claude'));
    const file = join(root, '.claude', 'settings.json');
    const original = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'old-api-key', ANTHROPIC_AUTH_TOKEN: 'old-bearer', CLAUDE_CODE_OAUTH_TOKEN: 'old-oauth', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_BASE_URL: 'https://old.example' } });
    await writeFile(file, original);
    const inspect = `process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)|CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY))$/.test(key)))))`;
    const explicit = { ANTHROPIC_API_KEY: mode === 'api-key' ? 'new-key' : '', ANTHROPIC_AUTH_TOKEN: mode === 'bearer' ? 'new-key' : '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0', ANTHROPIC_BASE_URL: 'https://new.example' };
    const result = spawnSync(process.execPath, [resolve('packages/acp-client/agents/claude-acp.mjs')], { cwd: root, env: { ...process.env, ...explicit, CLAUDE_CONFIG_DIR: join(root, '.claude'), DUTYDECK_CLAUDE_ACP_COMMAND: process.execPath, DUTYDECK_CLAUDE_ACP_ARGS_JSON: JSON.stringify(['-e', inspect]) }, encoding: 'utf8' });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual(explicit);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it.each([
    ['marked session', { marker: 'off' }, '1'],
    ['unmarked session', {}, null],
    ['inherit marker', { marker: 'inherit' }, null],
    ['user settings value', { marker: 'off', settings: '0' }, '0'],
    ['explicit process value', { marker: 'off', explicit: '0' }, '0'],
  ] as const)('applies the Claude auto memory default only below user values: %s', async (_name, input, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-claude-auto-memory-')); dirs.push(root);
    const configDir = join(root, 'config'); await mkdir(configDir);
    if ('settings' in input) await writeFile(join(configDir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: input.settings } }));
    const inspect = `process.stdout.write(JSON.stringify(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null))`;
    const inherited = { ...process.env };
    delete inherited.CLAUDE_CODE_DISABLE_AUTO_MEMORY; delete inherited.dutydeck_claude_auto_memory;
    const result = spawnSync(process.execPath, [resolve('packages/acp-client/agents/claude-acp.mjs')], { cwd: root, env: {
      ...inherited, PATH: join(root, 'bin'), CLAUDE_CONFIG_DIR: configDir, DUTYDECK_CLAUDE_ACP_COMMAND: process.execPath, DUTYDECK_CLAUDE_ACP_ARGS_JSON: JSON.stringify(['-e', inspect]),
      ...('marker' in input ? { dutydeck_claude_auto_memory: input.marker } : {}),
      ...('explicit' in input ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: input.explicit } : {})
    }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(expected);
  });

  it('ignores the workspace .env and loader or executable keys from project settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-claude-dotenv-')); dirs.push(root);
    const bin = join(root, 'bin'); await mkdir(bin); await mkdir(join(root, '.claude'));
    const preload = join(root, 'preload.cjs'); const marker = join(root, 'preloaded');
    await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1');\n`);
    await writeFile(join(root, '.env'), `NODE_OPTIONS=--require=${preload}\nLARK_APP_SECRET=svc-secret\nANTHROPIC_BASE_URL=https://dotenv.example\n`);
    await writeFile(join(root, '.env.local'), 'AWS_PROFILE=dotenv-profile\n');
    await writeFile(join(root, '.claude', 'settings.local.json'), JSON.stringify({ env: {
      NODE_OPTIONS: `--require=${preload}`, LD_PRELOAD: join(root, 'missing.so'), CLAUDE_CODE_EXECUTABLE: join(root, 'evil'),
      DUTYDECK_DAEMON_DIR: join(root, 'elsewhere'), dutydeck_relay_token: 'other-relay', ANTHROPIC_MODEL: 'project-model'
    } }));
    const keys = ['NODE_OPTIONS', 'LD_PRELOAD', 'CLAUDE_CODE_EXECUTABLE', 'DUTYDECK_DAEMON_DIR', 'dutydeck_relay_token', 'LARK_APP_SECRET', 'ANTHROPIC_BASE_URL', 'AWS_PROFILE', 'ANTHROPIC_MODEL'];
    const inspect = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key] ?? null]))))`;
    const inherited = { ...process.env };
    for (const key of keys) delete inherited[key];
    // No Claude CLI on PATH, so the launcher does not replace CLAUDE_CODE_EXECUTABLE itself.
    const result = spawnSync(process.execPath, [resolve('packages/acp-client/agents/claude-acp.mjs')], { cwd: root, env: { ...inherited, PATH: bin, CLAUDE_CONFIG_DIR: join(root, 'config'), DUTYDECK_CLAUDE_ACP_COMMAND: process.execPath, DUTYDECK_CLAUDE_ACP_ARGS_JSON: JSON.stringify(['-e', inspect]) }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ...Object.fromEntries(keys.map(key => [key, null])), ANTHROPIC_MODEL: 'project-model' });
    expect(existsSync(marker)).toBe(false);
  });
});
