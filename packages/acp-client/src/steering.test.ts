import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeStore } from 'acpx/runtime';
import { AcpxAdapter } from './index.js';

// 插话走真实 AcpxAdapter + 打过补丁的 acpx 运行时 + Mock ACP 子进程：
// 只 mock ACP 客户端证明不了扩展请求真的透传到了 Agent，也覆盖不到持久化键名校验。
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))));

const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
async function adapterFor(env: Record<string, string>, sessionKey: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-acp-steering-')); dirs.push(cwd);
  const events: any[] = [];
  const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { sessionKey, onEvent: event => events.push(event) });
  const waiting = () => expect.poll(() => events.some(event => event.type === 'text' && event.data.text === 'waiting for steering')).toBe(true);
  return { cwd, events, adapter, waiting };
}
// Steering goes only to agents known to honour promptRequired; the mock passes as claude-agent-acp unless a test says otherwise.
const steerable = { mock_acp_steering: '1', mock_acp_agent_name: '@agentclientprotocol/claude-agent-acp' };
const snakeCaseKeys = (value: unknown): boolean => !value || typeof value !== 'object' || Object.entries(value).every(([key, nested]) => (Array.isArray(value) || /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key)) && snakeCaseKeys(nested));

describe('ACP _session/steering', () => {
  it('injects into the running turn and keeps persisted session keys snake_case', async () => {
    const sessionKey = 'steering-persistent-session';
    const h = await adapterFor({ ...steerable, dutydeck_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dutydeck_group_tools_token: 'group-token' }, sessionKey);
    try {
      await h.adapter.start();
      const sending = h.adapter.send('wait for steering');
      await h.waiting();
      await expect(h.adapter.steer('change direction')).resolves.toBe('injected');
      await sending;
      expect(h.events.some(event => event.type === 'text' && event.data.text === 'Steered: change direction')).toBe(true);
      expect(h.events.filter(event => event.type === 'completed')).toHaveLength(1);
    } finally { await h.adapter.stop(); }
    const persisted = await createRuntimeStore({ stateDir: join(h.cwd, '.dutydeck', 'acpx') }).load(sessionKey);
    expect(persisted?.acpx?.session_options?.env).toMatchObject({ mock_acp_steering: '1', dutydeck_group_tools_token: 'group-token' });
    expect(snakeCaseKeys(persisted?.acpx)).toBe(true);
  });

  it('does not send the request when the agent does not advertise steering', async () => {
    const h = await adapterFor({}, 'steering-unsupported');
    try {
      await h.adapter.start();
      const sending = h.adapter.send('wait for steering');
      await h.waiting();
      await expect(h.adapter.steer('change direction')).resolves.toBe('unsupported');
      await h.adapter.interrupt();
      await sending;
      expect(h.events.some(event => event.type === 'text' && String(event.data.text).startsWith('Steered:'))).toBe(false);
    } finally { await h.adapter.stop(); }
  });

  it('does not send the request to an agent that advertises steering but is not known to honour promptRequired', async () => {
    // codex-acp advertises steering yet starts its own turn when none is running.
    const h = await adapterFor({ mock_acp_steering: '1', mock_acp_agent_name: '@agentclientprotocol/codex-acp' }, 'steering-not-prompt-required');
    try {
      await h.adapter.start();
      const sending = h.adapter.send('wait for steering');
      await h.waiting();
      await expect(h.adapter.steer('change direction')).resolves.toBe('unsupported');
      await h.adapter.interrupt();
      await sending;
      expect(h.events.some(event => event.type === 'text' && String(event.data.text).startsWith('Steered:'))).toBe(false);
    } finally { await h.adapter.stop(); }
  });

  it('reports promptRequired without a running turn or when the agent hands the content back', async () => {
    const h = await adapterFor(steerable, 'steering-prompt-required');
    try {
      await h.adapter.start();
      await expect(h.adapter.steer('too early')).resolves.toBe('promptRequired');
      const sending = h.adapter.send('wait for steering, then decline');
      await h.waiting();
      await expect(h.adapter.steer('handed back')).resolves.toBe('promptRequired');
      await h.adapter.interrupt();
      await sending;
      expect(h.events.some(event => event.type === 'text' && String(event.data.text).startsWith('Steered:'))).toBe(false);
    } finally { await h.adapter.stop(); }
  });
});
