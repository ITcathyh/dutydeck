import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    expect(launched).toEqual({ token: 'explicit-token', base: 'https://project.example', model: 'local-model', bedrock: '1', awsProfile: 'dutydeck-test',
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
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(`'${project}'/.dutydeck/security/sessions/`);
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

});
