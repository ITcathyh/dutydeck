import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { agentConfigSchema, type AgentConfig } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import { LarkReplyPolisher, replyPolishInput } from './reply-polish.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const config = { appId: 'cli_polish', defaultAgentId: 'primary', defaultModel: 'primary-model', replyPolishEnabled: true, replyPolishAgentId: 'editor' } as StoredLarkConfig;

async function harness(edit: (material: string) => string | null = text => JSON.stringify({ text: text.replace('值得注意的是，', '') }), timeoutMs = 3000) {
  const directory = await mkdtemp(join(tmpdir(), 'reply-polish-test-'));
  const repos = createRepositories(join(directory, 'test.db'), { newDatabaseAuthority: 'ledger_v1' });
  const starts: AgentConfig[] = [];
  const prompts: string[] = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (agent, _protocol, emit) => {
      starts.push(agent);
      let stopped = false;
      return { start: async () => {}, resume: async () => {}, stop: async () => { stopped = true; }, isStopped: () => stopped,
        interrupt: async () => { emit({ type: 'completed', data: { stopReason: 'cancelled' } }); },
        send: async prompt => {
          const text = typeof prompt === 'string' ? prompt : prompt.prompt;
          prompts.push(text);
          const output = edit(JSON.parse(text.split('\n').at(-1)!).text);
          if (output === null) return;
          emit({ type: 'text', data: { text: output } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      } satisfies AgentDriver;
    }
  });
  await runtime.initialize([agentConfigSchema.parse({ id: 'editor', name: 'Editor', command: process.execPath, protocol: 'acp', model: 'editor-default' })]);
  const log = { warn: vi.fn() };
  const polisher = new LarkReplyPolisher({ runtime, repos, timeoutMs, log });
  cleanups.push(async () => { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, repos, starts, prompts, polisher, log };
}

describe('reply wording pass', () => {
  it('protects code, links and numbers and rejects deletion, duplication or newly invented details', () => {
    const text = '值得注意的是，通过 12 项测试。`pnpm test`\n```sh\necho 42\n```\n[报告](https://example.test/r/7)';
    const input = replyPolishInput(text);
    const material = JSON.parse(input.prompt.split('\n').at(-1)!).text;
    const edited = material.replace('值得注意的是，', '');
    expect(input.restore(JSON.stringify({ text: edited }))).toBe(text.replace('值得注意的是，', ''));
    const token = material.match(/__DDP_\w+?__/)![0];
    for (const invalid of [edited.replace(token, ''), edited + token, edited + '新增 99 项', edited + ' https://other.test', edited + ' `rm`', '不是 JSON']) {
      expect(input.restore(JSON.stringify({ text: invalid }))).toBeUndefined();
    }
    expect(input.restore('')).toBeUndefined();
  });

  it('defaults off without launching an Agent and uses only the editor model in an empty isolated directory', async () => {
    const h = await harness();
    const original = '值得注意的是，通过 12 项测试，线上情况尚未验证。';
    expect(await h.polisher.polish({ ...config, replyPolishEnabled: undefined }, original, 'off')).toBe(original);
    expect(h.starts).toHaveLength(0);
    expect(await h.polisher.polish(config, original, 'first', 'oc_chat')).toBe('通过 12 项测试，线上情况尚未验证。');
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]).toMatchObject({ id: 'editor', model: 'editor-default', permissionMode: 'deny-all' });
    expect(h.starts[0]!.env).not.toHaveProperty('dutydeck_group_tools_token');
    expect(h.prompts[0]).not.toContain('primary-model');
    const [session] = await h.runtime.listSessions();
    expect(session).toMatchObject({ source: 'lark-reply-polish', sourceId: 'cli_polish:oc_chat', state: 'stopped' });
    expect(session!.cwd).not.toBe(process.cwd());
    await vi.waitFor(async () => expect(await stat(session!.cwd).catch(() => undefined)).toBeUndefined());
    expect(await h.polisher.polish({ ...config, replyPolishModel: 'explicit-editor' }, original, 'second')).toBe('通过 12 项测试，线上情况尚未验证。');
    expect(h.starts[1]).toMatchObject({ model: 'explicit-editor' });
  });

  it('freezes one result across concurrent calls, configuration changes and a new polisher instance', async () => {
    const h = await harness();
    const text = '值得注意的是，本次通过。';
    expect(await Promise.all([h.polisher.polish(config, text, 'frozen'), h.polisher.polish(config, text, 'frozen')])).toEqual(['本次通过。', '本次通过。']);
    const restarted = new LarkReplyPolisher({ runtime: h.runtime, repos: h.repos });
    expect(await restarted.polish({ ...config, replyPolishEnabled: false }, text, 'frozen')).toBe('本次通过。');
    expect(await restarted.polish(config, text, 'old-attempt', undefined, true)).toBe(text);
    expect(h.starts).toHaveLength(1);
  });

  it.each(['', '{"text":""}', '{"text":"新增 9 项结果"}', 'not json'])('falls back permanently on invalid output %j', async output => {
    const h = await harness(() => output);
    const text = '值得注意的是，尚未验证。';
    expect(await h.polisher.polish(config, text, 'bad')).toBe(text);
    expect(await h.polisher.polish(config, text, 'bad')).toBe(text);
    expect(h.starts).toHaveLength(1);
  });

  it('falls back on timeout and stops the isolated session', async () => {
    const h = await harness(() => null, 30_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stop = vi.spyOn(h.runtime, 'stop');
    const text = '值得注意的是，尚未验证。';
    const pending = h.polisher.polish(config, text, 'timeout');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(text);
    vi.useRealTimers();
    expect(stop).toHaveBeenCalledOnce();
    await expect(stop.mock.results[0]!.value).resolves.toBeUndefined();
    expect(['stopped', 'interrupted']).toContain((await h.runtime.listSessions())[0]!.state);
    expect(h.log.warn).toHaveBeenCalledOnce();
    expect(await h.polisher.polish(config, text, 'timeout')).toBe(text);
    expect(h.starts).toHaveLength(1);
  });

  it('uses the configured deadline above 60 seconds and defaults an unset deadline to 60 seconds', async () => {
    const h = await harness(() => null, 30_000);
    const defaultPolisher = new LarkReplyPolisher({ runtime: h.runtime, repos: h.repos, log: h.log });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const custom = h.polisher.polish({ ...config, replyPolishTimeoutMs: 120_000 }, '自定义原文', 'custom-deadline');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.log.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await custom).toBe('自定义原文');
    expect(h.log.warn).toHaveBeenCalledOnce();
    const defaults = defaultPolisher.polish(config, '默认原文', 'default-deadline');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.log.warn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await defaults).toBe('默认原文');
    expect(h.log.warn).toHaveBeenCalledTimes(2);
  });

  it('bounds concurrent editing sessions and freezes a saturated reply as its original', async () => {
    const h = await harness(() => null, 30_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = h.polisher.polish(config, '第一份原文', 'one');
    const second = h.polisher.polish(config, '第二份原文', 'two');
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
    expect(await h.polisher.polish(config, '第三份原文', 'three')).toBe('第三份原文');
    expect(h.starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all([first, second]);
    vi.useRealTimers();
    expect(await h.polisher.polish(config, '第三份原文', 'three')).toBe('第三份原文');
    expect(h.starts).toHaveLength(2);
  });

  it('skips unsupported or missing Agents and sends long replies without truncation', async () => {
    const h = await harness();
    await h.repos.agents.save(agentConfigSchema.parse({ id: 'terminal', name: 'Terminal', command: 'mock', protocol: 'pty-cli' }));
    for (const candidate of [{ ...config, replyPolishAgentId: 'missing' }, { ...config, replyPolishAgentId: 'terminal' }]) {
      expect(await h.polisher.polish(candidate, '原文', candidate.replyPolishAgentId)).toBe('原文');
    }
    expect(h.starts).toHaveLength(0);
    const long = '长'.repeat(24_001);
    expect(await h.polisher.polish(config, long, 'long')).toBe(long);
    expect(h.starts).toHaveLength(1);
    expect(JSON.parse(h.prompts[0]!.split('\n').at(-1)!).text).toBe(long);
  });
});
