import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeStore } from 'acpx/runtime';
import { AcpxAdapter, buildAcpxSessionOptions, normalizeAcpxEvent, renderAgentCommand } from './index.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe('acpx ACP boundary', () => {
  it('initializes a custom Mock ACP agent and streams normalized events', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-acp-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock ACP', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: e => events.push(e) });
    await adapter.start();
    await adapter.send('hello');
    expect(events.some(e => e.type === 'thinking')).toBe(true);
    expect(events.some(e => e.type === 'tool_call' && e.data.id === 'mock-tool-1')).toBe(true);
    expect(events.some(e => e.type === 'tool_result' && e.data.id === 'mock-tool-1')).toBe(true);
    expect(events.some(e => e.type === 'text' && e.data.text.includes('Mock reply'))).toBe(true);
    await adapter.stop();
  });

  it('treats timeout as inactivity and lets an active turn exceed its configured duration', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-acp-active-timeout-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock ACP', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'deny-all', timeout: 2, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: event => events.push(event) });
    await adapter.start();
    await expect(adapter.send('active longer than timeout')).resolves.toBeUndefined();
    expect(events.filter(event => event.type === 'thinking')).toHaveLength(3);
    expect(events.some(event => event.type === 'text' && event.data.text === 'long task completed')).toBe(true);
    await adapter.stop();
  });

  it('persists a Lark-style ask session with snake_case capability env and resolves its live request once', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-lark-ask-acp-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'); const events: any[] = [];
    const sessionKey = 'lark-ask-persistent-session';
    const adapter = new AcpxAdapter({
      id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd,
      env: {
        dockmux_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dockmux_group_tools_token: 'group-token',
        dockmux_relay_url: 'http://127.0.0.1:4310/api/relay', dockmux_relay_token: 'relay-token'
      }, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false
    }, { sessionKey, onEvent: event => events.push(event) });
    await adapter.start();
    const sending = adapter.send('request permission');
    await expect.poll(() => events.find(event => event.type === 'permission_request')?.data.id).toBe('permission-tool');
    await expect(adapter.resolvePermission('permission-tool', true)).resolves.toBe(true);
    await sending;
    expect(events.filter(event => event.type === 'permission_request' && event.data.status === 'pending')).toHaveLength(1);
    await adapter.stop();
    const persisted = await createRuntimeStore({ stateDir: join(cwd, '.dockmux', 'acpx') }).load(sessionKey);
    const env = persisted?.acpx?.session_options?.env ?? {};
    expect(env).toMatchObject({ dockmux_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dockmux_group_tools_token: 'group-token', dockmux_relay_url: 'http://127.0.0.1:4310/api/relay', dockmux_relay_token: 'relay-token' });
    expect(Object.keys(env).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
  });

  it('maps ACP cancel to acpx cancel and retains the session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-cancel-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent() {} });
    await adapter.start(); await adapter.interrupt(); await adapter.resume(); await adapter.stop();
  });

  it('resolves a live ACP permission request from an external Web decision', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-permission-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'); const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: e => events.push(e) });
    await adapter.start(); const sending = adapter.send('request permission');
    await expect.poll(() => events.find(e => e.type === 'permission_request')?.data.id).toBe('permission-tool');
    expect(await adapter.resolvePermission('permission-tool', true)).toBe(true); await sending;
    expect(events.some(e => e.type === 'text' && e.data.text.includes('selected'))).toBe(true); await adapter.stop();
  });

  it.each([
    ['ask', 'deny-all'],
    ['deny-all', 'deny-all'],
    ['approve-reads', 'approve-reads'],
    ['full-trust', 'approve-all']
  ] as const)('maps Dockmux %s to ACPX %s at construction time', (permissionMode, expected) => {
    const adapter = new AcpxAdapter({ ...agentConfig(), permissionMode }, { onEvent() {} });
    expect((adapter as any).runtime.options.permissionMode).toBe(expected);
  });

  it('does not advertise a fake live permission-mode switch on an ACPX adapter', () => {
    const adapter = new AcpxAdapter(agentConfig(), { onEvent() {} });
    expect((adapter as any).setPermissionMode).toBeUndefined();
  });

  it('auto-approves ACP permission requests in full-trust mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-full-trust-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'); const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: event => events.push(event) });
    await adapter.start(); await adapter.send('request permission');
    expect(events.some(event => event.type === 'text' && event.data.text.includes('selected'))).toBe(true);
    expect(events.some(event => event.type === 'permission_request')).toBe(false);
    await adapter.stop();
  });

  it('rejects a matching ACP permission before it reaches the Web approval UI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-risk-gate-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'); const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: event => events.push(event) });
    adapter.setRiskPolicy({ enabled: true, authorized: false, pattern: 'Edit\\s+a\\s+file', actorEmail: 'user@example.com' });
    await adapter.start();
    await adapter.send('request permission');
    expect(events).toContainEqual(expect.objectContaining({ type: 'permission_request', data: expect.objectContaining({ id: 'permission-tool', status: 'rejected', title: expect.stringContaining('Dockmux') }) }));
    expect(events.some(event => event.type === 'permission_request' && event.data.status === 'pending')).toBe(false);
    expect(await adapter.resolvePermission('permission-tool', true)).toBe(false);
    await adapter.stop();
  });

  it('rechecks current group policy for real ACP requests with a persisted session key', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-live-risk-')); dirs.push(cwd);
    const events: any[] = [];
    let authorized = true;
    let unavailable = false;
    const adapter = new AcpxAdapter({ ...agentConfig(), cwd, command: process.execPath, args: [resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')], permissionMode: 'full-trust', env: { dockmux_group_tools_token: 'synthetic-token' } }, {
      sessionKey: 'live-policy-session', onEvent: event => events.push(event),
      resolveRiskPolicy: async () => { if (unavailable) throw new Error('Policy unavailable'); return { enabled: true, authorized, pattern: 'Edit' }; }
    });
    try {
      await adapter.start();
      await adapter.send('request permission');
      expect(events.some(event => event.type === 'text' && event.data.text.includes('"optionId":"allow"'))).toBe(true);
      events.length = 0; authorized = false;
      await adapter.send('request permission');
      expect(events.some(event => event.type === 'text' && event.data.text.includes('"optionId":"deny"'))).toBe(true);
      expect(events).toContainEqual(expect.objectContaining({ type: 'permission_request', data: expect.objectContaining({ status: 'rejected' }) }));
      events.length = 0; authorized = true; unavailable = true;
      await adapter.send('request permission');
      expect(events.some(event => event.type === 'text' && event.data.text.includes('"optionId":"deny"'))).toBe(true);
    } finally { await adapter.stop(); }
    const persisted = await createRuntimeStore({ stateDir: join(cwd, '.dockmux', 'acpx') }).load('live-policy-session');
    expect(persisted?.acpx?.session_options?.env?.dockmux_group_tools_token).toBe('synthetic-token');
    expect(JSON.stringify(persisted)).not.toContain('resolveRiskPolicy');
  });

  it('hard-stops an active turn even while permission is pending', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-hard-stop-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs'); const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { onEvent: event => events.push(event) });
    await adapter.start(); const sending = adapter.send('request permission');
    await expect.poll(() => events.some(event => event.type === 'permission_request')).toBe(true);
    await expect(adapter.stop()).resolves.toBeUndefined();
    await expect(sending).resolves.toBeUndefined();
  });

  it('recreates a persistent ACP session when the agent no longer recognizes its id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-stale-session-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const config = { id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp' as const, cwd, env: { mock_acp_reject_unknown_load: '1' }, permissionMode: 'deny-all' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
    const first = new AcpxAdapter(config, { sessionKey: 'same-dockmux-session', onEvent() {} });
    await first.start(); await first.stop();
    const second = new AcpxAdapter(config, { sessionKey: 'same-dockmux-session', onEvent() {} });
    await expect(second.start()).resolves.toBeUndefined();
    await expect(second.send('after stale session')).resolves.toBeUndefined();
    await second.stop();
  });

  it('safely renders configurable custom agent argv', () => {
    const command = renderAgentCommand({ id: 'traex', name: 'TraeX', command: '/path/with space/traex', args: ['--acp', "it's-safe"], protocol: 'acp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false });
    expect(command).toContain("'/path/with space/traex'");
    expect(command).toContain("'it'\\''s-safe'");
  });

  it('passes the selected model into ACP session creation options', () => {
    expect(buildAcpxSessionOptions({ ...agentConfig(), model: 'model-selected-in-web' })).toMatchObject({ model: 'model-selected-in-web' });
  });

  it('persists the system prompt with ACPX keys and reuses it for the same session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-system-prompt-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const sessionKey = 'system-prompt-session';
    const base = { ...agentConfig(), cwd, command: process.execPath, args: [fixture] };
    const first = new AcpxAdapter({ ...base, systemPrompt: 'original session prompt' }, { sessionKey, onEvent() {} });
    await first.start(); await first.stop();

    const store = createRuntimeStore({ stateDir: join(cwd, '.dockmux', 'acpx') });
    expect((await store.load(sessionKey))?.acpx?.session_options?.system_prompt).toBe('original session prompt');

    const restored = new AcpxAdapter({ ...base, systemPrompt: 'new global prompt' }, { sessionKey, onEvent() {} });
    await restored.start(); await restored.stop();
    expect((await store.load(sessionKey))?.acpx?.session_options?.system_prompt).toBe('original session prompt');
  });

  it('persists Dockmux group capability environment with snake_case keys', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-group-env-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const adapter = new AcpxAdapter({
      ...agentConfig(), cwd, command: process.execPath, args: [fixture],
      env: { dockmux_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dockmux_group_tools_token: 'scoped-token' }
    }, { sessionKey: 'group-capability-session', onEvent() {} });
    await expect(adapter.start()).resolves.toBeUndefined();
    await adapter.stop();
  });

  it('bridges uppercase Agent env without persisting an uppercase session key', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-agent-env-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const events: any[] = [];
    const sessionKey = 'uppercase-agent-env-session';
    const adapter = new AcpxAdapter({
      ...agentConfig(), cwd, command: process.execPath, args: [fixture],
      env: { MOCK_VENDOR_TOKEN: 'vendor-secret', dockmux_group_tools_url: 'http://127.0.0.1:4310/tools' }
    }, { sessionKey, onEvent: event => events.push(event) });
    await expect(adapter.start()).resolves.toBeUndefined();
    await adapter.send('report bridged environment');
    expect(events.some(event => event.type === 'text' && event.data.text === 'Bridged: vendor-secret')).toBe(true);
    await adapter.stop();

    const store = createRuntimeStore({ stateDir: join(cwd, '.dockmux', 'acpx') });
    const persisted = (await store.load(sessionKey))?.acpx?.session_options?.env ?? {};
    expect(persisted).not.toHaveProperty('MOCK_VENDOR_TOKEN');
    expect(Object.keys(persisted).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain('vendor-secret');
    expect(persisted.dockmux_group_tools_url).toBe('http://127.0.0.1:4310/tools');
  });

  it('recreates a persisted ACP session once when its scoped group capability changes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dockmux-group-env-refresh-')); dirs.push(cwd);
    const fixture = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs');
    const sessionKey = 'group-capability-refresh-session';
    const base = { ...agentConfig(), cwd, command: process.execPath, args: [fixture] };
    const first = new AcpxAdapter({
      ...base,
      env: { dockmux_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dockmux_group_tools_token: 'legacy-random-token', dockmux_relay_url: 'http://127.0.0.1:4310/api/relay', dockmux_relay_token: 'relay-v1', dockmux_relay_command: '/old/dockmux' }
    }, { sessionKey, onEvent() {} });
    await first.start(); await first.stop();
    const store = createRuntimeStore({ stateDir: join(cwd, '.dockmux', 'acpx') });
    expect((await store.load(sessionKey))?.acpx?.session_options?.env?.dockmux_group_tools_token).toBe('legacy-random-token');

    const second = new AcpxAdapter({
      ...base,
      env: { dockmux_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dockmux_group_tools_token: 'v1.stable-token', dockmux_relay_url: 'http://127.0.0.1:9321/api/relay', dockmux_relay_token: 'relay-v2', dockmux_relay_command: '/new/dockmux' }
    }, { sessionKey, onEvent() {} });
    await second.start(); await second.stop();
    expect((await store.load(sessionKey))?.acpx?.session_options?.env?.dockmux_group_tools_token).toBe('v1.stable-token');
    expect((await store.load(sessionKey))?.acpx?.session_options?.env?.dockmux_relay_url).toBe('http://127.0.0.1:9321/api/relay');

    const third = new AcpxAdapter({ ...base, env: {} }, { sessionKey, onEvent() {} });
    await third.start(); await third.stop();
    expect((await store.load(sessionKey))?.acpx?.session_options?.env ?? {}).not.toHaveProperty('dockmux_relay_url');
  });

  it('normalizes raw ACP session/update envelopes', () => {
    expect(normalizeAcpxEvent({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'TraeX says hi' } } } })).toMatchObject({ type: 'text', data: { text: 'TraeX says hi' } });
    expect(normalizeAcpxEvent({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'pwd' } } })).toMatchObject({ type: 'tool_call', data: { id: 'tool-1', status: 'running' } });
    expect(normalizeAcpxEvent({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' } } })).toMatchObject({ type: 'tool_result', data: { id: 'tool-1', status: 'completed' } });
    expect(normalizeAcpxEvent({ type: 'status', tag: 'usage_update', used: 1200, size: 200000, breakdown: { totalTokens: 1300 } })).toEqual({ type: 'status', data: { state: 'usage', used: 1200, size: 200000, breakdown: { totalTokens: 1300 }, cost: undefined } });
    expect(normalizeAcpxEvent({ type: 'status', tag: 'available_commands_update', availableCommands: [{ name: 'compact' }] })).toEqual({ type: 'status', data: { state: 'commands', availableCommands: [{ name: 'compact' }] } });
  });

  it('maps context-compaction banners to status events instead of agent messages', () => {
    const chunk = (text: string) => ({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    expect(normalizeAcpxEvent(chunk('Compacting...'))).toEqual({ type: 'status', data: { state: 'compaction', phase: 'start' } });
    expect(normalizeAcpxEvent(chunk('\n\nCompacting completed.'))).toEqual({ type: 'status', data: { state: 'compaction', phase: 'completed' } });
    expect(normalizeAcpxEvent(chunk('\n\nCompacting failed: context window exceeded'))).toEqual({ type: 'status', data: { state: 'compaction', phase: 'failed', detail: 'context window exceeded' } });
    // 普通回复文本不应被误判为压缩横幅。
    expect(normalizeAcpxEvent(chunk('Compacting the workspace is done.'))).toMatchObject({ type: 'text', data: { text: 'Compacting the workspace is done.' } });
  });
});

function agentConfig() {
  return { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp' as const, env: {}, permissionMode: 'ask' as const, timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
}
