import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

afterEach(() => vi.unstubAllEnvs());

describe('default runtime child environment', () => {
  it.each(['jsonl', 'pipe'] as const)('%s filters ambient credentials and preserves explicit configuration', async protocol => {
    for (const key of ['DUTYDECK_AUTH_TOKEN', 'LARK_APP_SECRET', 'BOTMUX_SESSION_ID', 'dutydeck_group_tools_token', 'dutydeck_session_id', 'dutydeck_relay_token', 'BYTEDCLI_USER_CODE_JWT']) vi.stubEnv(key, 'fake-ambient');
    vi.stubEnv('OCR_ORDINARY', 'ordinary');
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repos, {
      sessionEnvironment: () => ({ dutydeck_session_id: 'current-session', dutydeck_relay_token: 'fake-current-capability' })
    });
    const agent: AgentConfig = {
      id: 'env-check', name: 'Environment check', command: process.execPath,
      args: [fileURLToPath(new URL('../tests/fixtures/child-environment-agent.mjs', import.meta.url))],
      protocol, cwd: process.cwd(), env: { OCR_CONFIGURED: 'configured', BYTEDCLI_USER_CODE_JWT: 'fake-configured-account' },
      permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false
    };
    try {
      await runtime.initialize([agent]);
      const session = await runtime.start({ agentId: agent.id });
      expect((await runtime.send(session.id, 'check environment')).status).toBe('completed');
      const events = await runtime.getEvents(session.id);
      const response = events.find(event => event.type === 'text' && event.data.role !== 'user');
      expect(JSON.parse(response!.data.text as string)).toEqual({
        daemonSecret: true, larkSecret: true, staleIdentity: true, staleCapability: true,
        ordinary: true, configured: true, configuredAccount: true, sessionIdentity: true, sessionCapability: true
      });
    } finally {
      await runtime.shutdown();
      repos.close();
    }
  });
});
