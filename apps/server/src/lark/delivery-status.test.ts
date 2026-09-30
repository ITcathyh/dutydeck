import { describe, expect, it, vi } from 'vitest';
import type { ChannelMapping, Session } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import { LarkMessageCoordinator } from './coordinator.js';

const config: StoredLarkConfig = {
  appId: 'cli_status', appSecret: 'secret', workspace: '/workspace', defaultAgentId: 'codex', fullTrustConfirmed: true, listening: true,
  preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1_000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'rm\\b', riskControlMode: 'off'
};
const session: Session = { id: 'ses_1', agentId: 'codex', state: 'idle', cwd: '/workspace', permissionMode: 'full-trust', runId: 'run_1', createdAt: '', updatedAt: '' };
const mapping = (externalId: string, sessionId: string, extra: Record<string, unknown>): ChannelMapping => ({
  id: `lark-card:cli_status:${externalId}`, channel: 'lark-card:cli_status', externalId, sessionId, createdAt: '',
  extra: JSON.stringify({ app_id: 'cli_status', chat_id: 'oc_group', task_name: `任务 ${externalId}`, prompt: 'p', state: 'completed', started_at: 1, ...extra })
});

describe('/status 显示结果投递失败', () => {
  it('lists the failed and retrying result deliveries of this session with their reasons', async () => {
    const mappings = [
      mapping('om_failed', 'ses_1', { final_delivery_state: 'failed', final_delivery_error: '飞书拒收（230002）：The bot can not be outside the group.' }),
      mapping('om_retrying', 'ses_1', { final_delivery_attempts: 3, final_delivery_retry_at: Date.now() + 60_000, final_delivery_error: '503 Service Unavailable' }),
      mapping('om_delivered', 'ses_1', { final_delivery_state: 'delivered', final_message_id: 'om_result' }),
      mapping('om_other', 'ses_other', { final_delivery_state: 'failed', final_delivery_error: '别的会话' })
    ];
    const cardMappings = { list: vi.fn(async () => mappings), get: vi.fn(), save: vi.fn(), compareAndSetExtra: vi.fn() };
    const runtime = { getSession: vi.fn(async () => session) };
    const coordinator = new LarkMessageCoordinator(runtime as any, {} as any, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, Math.random, 'ou_bot',
      undefined, cardMappings as any);
    const status: string = await (coordinator as any).describeChatStatus(config, 'ses_1');
    expect(status).toContain('结果未送达');
    expect(status).toContain('任务 om_failed');
    expect(status).toContain('230002');
    expect(status).toContain('任务 om_retrying');
    expect(status).toContain('第 3 次');
    expect(status).not.toContain('任务 om_delivered');
    expect(status).not.toContain('别的会话');
  });
});
