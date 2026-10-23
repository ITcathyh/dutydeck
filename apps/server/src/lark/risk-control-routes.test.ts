import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from '../app.js';
import { loadConfig } from '@dutydeck/config';
import { toPublicAgent } from '@dutydeck/shared';
import { PTY_AGENT_CONTRIBUTIONS } from '../../../../packages/pty-driver/src/contributions.js';
import { runSettingsCli } from '../settings-cli.js';
import { larkBotsConfigKey, readLarkConfig } from './config.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.unstubAllEnvs(); });

it('lets Agents launched with the process guard enable enforced risk control without a workspace hook', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-risk-routes-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repos = createRepositories(join(directory, 'test.sqlite'));
  cleanups.push(() => repos.close());
  for (const [id, adapterId] of [['ccflash', 'claude-code'], ['genius-custom', 'genius']]) {
    await repos.agents.save({ id, name: id, command: 'claude', protocol: 'pty-cli', adapterId, permissionMode: 'full-trust', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false } as any);
  }
  const bot = (appId: string, defaultAgentId: string) => ({ appId, appSecret: 'fake', listening: false, permissionMode: 'full-trust', defaultAgentId, workspace: directory });
  await repos.config.set(larkBotsConfigKey, JSON.stringify([bot('cli_guarded', 'ccflash'), bot('cli_plain', 'genius-custom')]));
  const fetcher = vi.fn(async () => { throw new Error('Unexpected network'); });
  const app = await buildApp({} as any, { lark: { env: { DUTYDECK_DISABLE_LARK_LISTENER: 'true' }, config: repos.config, agents: repos.agents, fetcher } });
  cleanups.push(() => app.close());
  expect((await app.inject({ method: 'GET', url: '/api/lark/hooks/status?appId=cli_guarded' })).json()).toMatchObject({ supported: true, installed: true, trustRequired: false });
  const enforced = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_guarded', riskControlMode: 'enforced' } });
  expect(enforced.statusCode).toBe(200);
  expect(enforced.json().bots.find((item: { appId: string }) => item.appId === 'cli_guarded')).toMatchObject({ riskControlMode: 'enforced' });
  const refused = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { originalAppId: 'cli_plain', riskControlMode: 'enforced' } });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe('RISK_CONTROL_HOOK_NOT_READY');
  expect(fetcher).not.toHaveBeenCalled();
});


it('saves an ask/enforced bot with the discovered Codex ACP fallback while terminal Codex stays the default', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dutydeck-codex-acp-fallback-'));
  cleanups.push(() => rm(workspace, { recursive: true, force: true }));
  const codexPath = join(workspace, 'user-codex');
  await writeFile(codexPath, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('Codex fixture 1.0'); else await import(${JSON.stringify(resolve('tests/fixtures/mock-codex-hooks.mjs'))});\n`, { mode: 0o755 });
  const codexHome = join(workspace, 'codex-home');
  await mkdir(codexHome);
  await writeFile(join(codexHome, 'hooks-probe-state.json'), JSON.stringify({}));
  vi.stubEnv('CODEX_HOME', codexHome);
  vi.stubEnv('PATH', dirname(process.execPath));
  vi.stubEnv('CODEX_PATH', codexPath);
  const config = loadConfig({ DUTYDECK_DEFAULT_CWD: workspace, CODEX_PATH: codexPath, DUTYDECK_AGENTS_JSON: JSON.stringify([
    { id: 'ccflash', name: 'Primary', protocol: 'pty-cli', adapterId: 'claude-code', command: process.execPath, permissionMode: 'ask' }
  ]) }, PTY_AGENT_CONTRIBUTIONS);
  expect(config.agents.find(agent => agent.id === 'codex')).toMatchObject({ protocol: 'pty-cli' });
  const acp = config.agents.find(agent => agent.id === 'codex-acp')!;
  expect(toPublicAgent(acp)).toMatchObject({ name: 'Codex (ACP)', protocol: 'acp', remoteApproval: true });
  const repos = createRepositories(':memory:');
  cleanups.push(() => repos.close());
  for (const agent of config.agents) await repos.agents.save(agent);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_guarded', appSecret: 'fixture', listening: false, permissionMode: 'ask', fullTrustConfirmed: false, defaultAgentId: 'ccflash', defaultModel: 'gemini-3.8-flash-high', riskControlMode: 'enforced', workspace, revision: 7 }]));
  const app = await buildApp({} as any, { lark: { env: { DUTYDECK_DISABLE_LARK_LISTENER: 'true' }, config: repos.config, agents: repos.agents, fetcher: vi.fn(async () => { throw new Error('Unexpected network'); }) } });
  cleanups.push(() => app.close());
  const fetcher = async (url: URL | string | Request, init?: RequestInit) => {
    const response = await app.inject({ method: init?.method as 'GET', url: new URL(String(url)).pathname, payload: init?.body as string | undefined, headers: init?.headers as Record<string, string> });
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  };
  const input = { appId: 'cli_guarded', url: 'http://127.0.0.1:4310', database: '/tmp/fixture.db' };
  const dependencies = { fetcher, readToken: () => undefined };
  await expect(runSettingsCli('bot-set', { ...input, pairs: ['fallbackAgentId=codex-acp', 'fallbackModel=gpt-6.1-sol'] }, dependencies)).rejects.toMatchObject({ code: 'RISK_CONTROL_HOOK_NOT_READY' });
  await runSettingsCli('bot-install-hook', { ...input, prepare: true, pairs: ['fallbackAgentId=codex-acp'] }, dependencies);
  expect(await readLarkConfig(repos.config, input.appId)).toMatchObject({ revision: 7, permissionMode: 'ask', fullTrustConfirmed: false, riskControlMode: 'enforced', defaultAgentId: 'ccflash', defaultModel: 'gemini-3.8-flash-high' });
  expect(await readFile(join(workspace, '.codex/hooks.json'), 'utf8')).toContain('dutydeck-lark-high-risk-guard-codex.mjs');
  await expect(runSettingsCli('bot-set', { ...input, pairs: ['fallbackAgentId=codex-acp', 'fallbackModel=gpt-6.1-sol'] }, dependencies)).rejects.toMatchObject({ code: 'RISK_CONTROL_HOOK_NOT_READY', message: expect.stringContaining('项目信任') });
  await writeFile(join(codexHome, 'hooks-probe-state.json'), JSON.stringify({ projectTrusted: true }));
  await expect(runSettingsCli('bot-set', { ...input, pairs: ['fallbackAgentId=codex-acp', 'fallbackModel=gpt-6.1-sol'] }, dependencies)).rejects.toMatchObject({ code: 'RISK_CONTROL_HOOK_NOT_READY', message: expect.stringContaining('尚未受信任') });
  await writeFile(join(codexHome, 'hooks-probe-state.json'), JSON.stringify({ projectTrusted: true, hookTrustStatus: 'trusted' }));
  expect((await app.inject({ method: 'GET', url: '/api/lark/hooks/status?appId=cli_guarded&agentId=codex-acp' })).json()).toMatchObject({ agentId: 'codex-acp', installed: true, nativeReady: true });
  await expect(runSettingsCli('bot-set', { ...input, pairs: ['fallbackAgentId=codex', 'fallbackModel=gpt-6.1-sol'] }, dependencies)).rejects.toMatchObject({ code: 'LARK_APPROVAL_UNSUPPORTED' });
  expect((await runSettingsCli('bot-set', { ...input, pairs: ['fallbackAgentId=codex-acp', 'fallbackModel=gpt-6.1-sol'] }, dependencies)).bot).toMatchObject({ revision: 8, fallbackAgentId: 'codex-acp', fallbackModel: 'gpt-6.1-sol', permissionMode: 'ask', fullTrustConfirmed: false, riskControlMode: 'enforced', defaultAgentId: 'ccflash', defaultModel: 'gemini-3.8-flash-high' });
});
