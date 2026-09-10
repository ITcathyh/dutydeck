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
    await writeFile(claude, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n'); await chmod(claude, 0o755);
    const inspect = `process.stdout.write(JSON.stringify({ token: process.env.ANTHROPIC_AUTH_TOKEN, base: process.env.ANTHROPIC_BASE_URL, model: process.env.ANTHROPIC_MODEL, bedrock: process.env.CLAUDE_CODE_USE_BEDROCK, awsProfile: process.env.AWS_PROFILE, executable: process.env.CLAUDE_CODE_EXECUTABLE }))`;
    const result = spawnSync(process.execPath, [resolve(process.cwd(), 'packages/acp-client/agents/claude-acp.mjs')], {
      cwd: project,
      env: { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_AUTH_TOKEN: 'explicit-token', DUTYDECK_CLAUDE_ACP_COMMAND: process.execPath, DUTYDECK_CLAUDE_ACP_ARGS_JSON: JSON.stringify(['-e', inspect]) },
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ token: 'explicit-token', base: 'https://project.example', model: 'local-model', bedrock: '1', awsProfile: 'dutydeck-test', executable: claude });
  });
});
