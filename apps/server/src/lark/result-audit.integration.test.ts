import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { createLarkCardService } from './service.js';
import { isLarkFinalContentAuditRejected, larkResultKey, sendLarkResult } from './result-delivery.js';
import { performLarkCardReconcile } from './reconciler.js';

const serviceList: Array<ReturnType<typeof createLarkCardService>> = [];
afterEach(() => { for (const service of serviceList.splice(0)) service.close(); });
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const input = { state: 'completed' as const, elements: [{ tag: 'markdown', element_id: 'final_output', content: 'PRIVATE_ORIGINAL_RESULT' }], idempotencyKey: larkResultKey('om_process') };

it.each([230022, 230028, 11312, 11248, 18054])('persists %s final rejection, sends a fixed notice once, and keeps delivery failed in reconciliation', async code => {
  const repos = createRepositories(':memory:');
  try {
    const writes: Array<{ path: string; body: any }> = [];
    const service = createLarkCardService({ LARK_APP_ID: `cli_audit_${code}`, LARK_APP_SECRET: 'synthetic' }, (async (url, init) => {
      if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 });
      const body = JSON.parse(String(init?.body)); writes.push({ path: String(url), body });
      if (body.msg_type === 'interactive') return Response.json({ code, msg: 'messages do not pass the audit' }, { status: 400 });
      return Response.json({ code: 0, data: { message_id: 'om_audit_notice' } });
    }) as typeof fetch); serviceList.push(service);
    const target = { chatId: 'oc_fixture', replyMessageId: 'om_input', replyInThread: true };
    await expect(sendLarkResult(service, target, input, log, repos.config)).rejects.toSatisfy(isLarkFinalContentAuditRejected);
    await expect(sendLarkResult(service, target, input, log, repos.config)).rejects.toSatisfy(isLarkFinalContentAuditRejected);
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toMatchObject({ msg_type: 'text', reply_in_thread: true, uuid: expect.stringMatching(/^audit_.{40}$/) });
    expect(JSON.stringify(writes[1])).not.toContain('PRIVATE_ORIGINAL_RESULT');
    expect(writes.every(write => write.path.endsWith('/messages/om_input/reply'))).toBe(true);
    const mapping = { id: 'map', channel: `lark-card:cli_audit_${code}`, externalId: 'om_input', sessionId: 'ses_fixture', createdAt: new Date().toISOString(),
      extra: JSON.stringify({ app_id: `cli_audit_${code}`, chat_id: 'oc_fixture', reply_message_id: 'om_input', reply_in_thread: true,
        card_message_id: 'om_process', task_name: 'fixture', prompt: 'fixture', state: 'completed', runtime_task_id: 'task_fixture', progress_frozen: true, started_at: Date.now() }) };
    await repos.channelMappings.save(mapping);
    const reconcile = { runtime: { getTasks: async () => [{ id: 'task_fixture', sessionId: 'ses_fixture', status: 'completed' }],
      getEvents: async () => [{ id: 'final', type: 'text', data: { text: 'PRIVATE_ORIGINAL_RESULT' } }] } as any,
      service, cardMappings: repos.channelMappings, deliveryStore: repos.config, config: { appId: `cli_audit_${code}` } as any, channel: mapping.channel, log };
    await performLarkCardReconcile(reconcile); await performLarkCardReconcile(reconcile);
    expect(writes).toHaveLength(2);
    expect(JSON.parse((await repos.channelMappings.get(mapping.channel, mapping.externalId))!.extra!)).toMatchObject({ state: 'completed', final_delivery_state: 'failed' });
  } finally { repos.close(); }
});

it('keeps failed-notice diagnostics without sending the original through an attachment', async () => {
  const repos = createRepositories(':memory:');
  try {
    const types: string[] = [];
    const service = createLarkCardService({ LARK_APP_ID: 'cli_notice_failure', LARK_APP_SECRET: 'synthetic' }, (async (url, init) => {
      if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 });
      const body = JSON.parse(String(init?.body)); types.push(body.msg_type);
      return Response.json({ code: body.msg_type === 'interactive' ? 230028 : 230002, msg: 'rejected' }, { status: 400 });
    }) as typeof fetch); serviceList.push(service);
    await expect(sendLarkResult(service, { chatId: 'oc_fixture' }, input, log, repos.config)).rejects.toSatisfy(isLarkFinalContentAuditRejected);
    expect(types).toEqual(['interactive', 'text']);
    expect(await repos.config.get(`lark.delivery.${input.idempotencyKey}.audit_notice_error`)).toContain('230002');
    expect(await repos.config.get(`lark.delivery.${input.idempotencyKey}.summary`)).toBeUndefined();
  } finally { repos.close(); }
});

it.each([230002, 230001, 230025, 230099, 18054])('does not label an unrelated %s error as a confirmed audit rejection', async code => {
  const { LarkServiceError } = await import('./service.js');
  expect(isLarkFinalContentAuditRejected(new LarkServiceError('LARK_OPENAPI_ERROR', 'create message content fail', 502, { upstreamCode: code, upstreamHttpStatus: 400 }))).toBe(false);
});
