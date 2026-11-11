import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRepositories } from '@dutydeck/storage';
import { expect, it, vi } from 'vitest';
import { LarkCardService } from './service.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './agent-tools.js';
import { larkBotsConfigKey } from './config.js';

it.each([
  ['send', 'disconnect'], ['reply', 'disconnect'], ['send', '503'], ['reply', '503']
] as const)('ordinary %s attempts one platform write after %s, even on a later retry', async (mode, failure) => {
  const writes: unknown[] = [];
  const server = createServer(async (req, res) => {
    if (req.url?.includes('/tenant_access_token/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, tenant_access_token: 'fixture', expire: 7200 })); return; }
    const target = mode === 'send' ? '/open-apis/im/v1/messages?receive_id_type=chat_id' : '/open-apis/im/v1/messages/om_origin/reply';
    if (req.url !== target || req.method !== 'POST') { res.statusCode = 404; res.end(); return; }
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    let payload;
    try { payload = JSON.parse(Buffer.concat(parts).toString()); } catch { req.destroy(); return; }
    writes.push(payload); // The platform received the full message before the response was lost.
    if (failure === 'disconnect') { req.socket.destroy(); return; }
    res.statusCode = 503; res.end(JSON.stringify({ code: 999, msg: 'temporarily unavailable' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const repos = createRepositories(':memory:');
  const session = { id: 'session', agentId: 'fixture', cwd: '/tmp', source: 'lark', sourceId: 'cli_fixture:oc_chat:group', state: 'idle', runId: 'run', createdAt: '', updatedAt: '' } as const;
  await repos.sessions.save(session);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_fixture', appSecret: 'synthetic', defaultAgentId: 'fixture', groupToolsEnabled: true, groupToolsAllowSend: true }]));
  const service = new LarkCardService({ appId: `cli_transport_${mode}_${failure}`, appSecret: 'synthetic', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, defaultReceiveIdType: 'chat_id', defaultAgentName: 'fixture', env: { LARK_API_QPS: '10000', LARK_API_RETRY_BASE_MS: '1', LARK_API_RETRY_MAX_MS: '1' } });
  // The read-only reply target is fixed; the platform write uses the real HTTP service and retry gate.
  vi.spyOn(service, 'getMessage').mockResolvedValue({ messageId: 'om_origin', chatId: 'oc_chat', messageType: 'text', createTime: '0', deleted: false, updated: false, rawContent: '{"text":"original"}', mentions: [], sender: { id: 'ou_author', type: 'user' } });
  const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://localhost');
  const tools = new LarkAgentToolsService(capabilities, repos.config, { clientFactory: () => service });
  const token = capabilities.environmentFor(session).dutydeck_group_tools_token!;
  const input = { content: 'hello', idempotencyKey: 'same-intent', ...(mode === 'reply' ? { replyTo: 'om_origin' } : {}) };
  try {
    await expect(tools.send(token, input)).rejects.toMatchObject({ code: 'GROUP_SEND_RESULT_UNKNOWN' });
    expect(writes).toHaveLength(1);
    const records = await repos.config.list!('lark.send.');
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!.value)).toMatchObject({ status: 'unknown', firstAttemptAt: expect.any(Number) });
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 30 * 86_400_000);
    await expect(tools.send(token, input)).rejects.toMatchObject({ code: 'GROUP_SEND_RESULT_UNKNOWN' });
    expect(writes).toHaveLength(1);
  } finally { vi.restoreAllMocks(); capabilities.close(); service.close(); repos.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
