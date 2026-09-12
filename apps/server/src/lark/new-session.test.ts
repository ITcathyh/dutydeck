import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@dutydeck/shared';
import { parseLarkNewSession, validateLarkLaunchOptions } from './new-session.js';
import { discoverAgentModels } from '../agent-models.js';

vi.mock('../agent-models.js', () => ({ discoverAgentModels: vi.fn() }));

const agent: AgentConfig = { id: 'codex', name: 'Codex', command: 'codex', args: [], protocol: 'pty-cli',
  permissionMode: 'ask', env: {}, timeout: 30, capabilities: { pause: false, resume: true }, builtin: true };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('/new first-turn options', () => {
  it('preserves legacy goals and a literal option-looking body', () => {
    expect(parseLarkNewSession('')).toEqual({ prompt: '' });
    expect(parseLarkNewSession('修复问题\n  保留缩进')).toEqual({ prompt: '修复问题\n  保留缩进' });
    expect(parseLarkNewSession('-- --model 是文档里的参数')).toEqual({ prompt: '--model 是文档里的参数' });
    expect(parseLarkNewSession('解释 --model foo')).toEqual({ prompt: '解释 --model foo' });
  });

  it('parses only the header and keeps task formatting untouched', () => {
    expect(parseLarkNewSession('--cwd "/tmp/a b" --model gateway/model[1m] --effort high -- 修复问题\n  --cwd 是正文')).toEqual({
      prompt: '修复问题\n  --cwd 是正文', launchOptions: { cwd: '/tmp/a b', model: 'gateway/model[1m]', reasoningEffort: 'high' }
    });
    expect(parseLarkNewSession("--cwd '/tmp/a b' -- 运行测试").launchOptions?.cwd).toBe('/tmp/a b');
  });

  it.each([
    '--cwd', '--cwd --model foo -- 任务', '--model "" -- 任务', '--effort high',
    '--cwd /tmp --cwd /other -- 任务', '--model foo --modle bar -- 任务',
    '--unknown foo -- 任务', '--model foo 任务', '--model foo --', '--cwd "not closed -- 任务'
  ])('rejects a malformed header before any lifecycle action: %s', input => {
    expect(() => parseLarkNewSession(input)).toThrow();
  });

  it('validates a real directory without changing the caller options', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-new-'));
    directories.push(cwd);
    const options = { cwd, model: 'gateway/custom', reasoningEffort: 'high' };
    expect(await validateLarkLaunchOptions(options, agent)).toEqual(options);
    await writeFile(join(cwd, 'file'), 'fixture');
    await expect(validateLarkLaunchOptions({ cwd: join(cwd, 'file') }, agent)).rejects.toThrow('目录');
    await expect(validateLarkLaunchOptions({ cwd: join(cwd, 'missing') }, agent)).rejects.toThrow('目录');
    await expect(validateLarkLaunchOptions({ cwd: '../relative' }, agent)).rejects.toThrow('绝对路径');
  });

  it('rejects unsupported CLI fields and malformed model/effort tokens', async () => {
    await expect(validateLarkLaunchOptions({ model: 'x' }, { ...agent, id: 'dsh-tui' })).rejects.toThrow('模型');
    await expect(validateLarkLaunchOptions({ reasoningEffort: 'high' }, { ...agent, id: 'gemini' })).rejects.toThrow('推理强度');
    await expect(validateLarkLaunchOptions({ model: '--other-flag' }, agent)).rejects.toThrow('模型');
    await expect(validateLarkLaunchOptions({ reasoningEffort: 'hihg' }, agent)).rejects.toThrow('推理强度');
    await expect(validateLarkLaunchOptions({ model: 'x' }, { ...agent, protocol: 'jsonl' })).rejects.toThrow('协议');
  });

  it('validates ACP choices against provider metadata for the effective model', async () => {
    const acpAgent = { ...agent, protocol: 'acp' as const, model: 'configured-model' };
    vi.mocked(discoverAgentModels).mockResolvedValue({ models: [{ id: 'selected-model', name: 'Selected' }], reasoningEfforts: [{ id: 'high', name: 'High' }], source: 'acp' });
    await expect(validateLarkLaunchOptions({ model: 'selected-model', reasoningEffort: 'high' }, acpAgent)).resolves.toEqual({ model: 'selected-model', reasoningEffort: 'high' });
    expect(discoverAgentModels).toHaveBeenLastCalledWith(acpAgent, 'selected-model');
    await expect(validateLarkLaunchOptions({ reasoningEffort: 'high' }, acpAgent)).resolves.toEqual({ reasoningEffort: 'high' });
    expect(discoverAgentModels).toHaveBeenLastCalledWith(acpAgent, 'configured-model');
    await expect(validateLarkLaunchOptions({ model: 'unknown' }, acpAgent)).rejects.toThrow('模型');
    await expect(validateLarkLaunchOptions({ reasoningEffort: 'xhigh' }, acpAgent)).rejects.toThrow('推理强度');
  });
});
