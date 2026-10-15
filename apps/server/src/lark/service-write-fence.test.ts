import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { createLarkCardService, LarkServiceError } from './service.js';
import { executeWithLarkGate } from './api-gate.js';
import { sendLarkFile, sendLarkResult } from './result-delivery.js';

const services: Array<ReturnType<typeof createLarkCardService>> = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
const env = (id: string) => ({ LARK_APP_ID: `cli_fence_${id}`, LARK_APP_SECRET: 'synthetic', LARK_API_QPS: '10000', LARK_API_BURST: '10000', LARK_API_RETRY_MAX_ATTEMPTS: '1', LARK_API_RETRY_BASE_MS: '1', LARK_API_RETRY_MAX_MS: '1' });
const local = () => new LarkServiceError('LARK_WRITE_OBSOLETE', 'expired local authority', 409);
const log = { warn: vi.fn() };
const input = { state: 'completed' as const, elements: [{ tag: 'markdown', element_id: 'final_output', content: 'synthetic answer' }], idempotencyKey: 'result_fence' };

it('checks after tenant-token acquisition and does not misclassify local invalidation as transport failure', async () => {
  let current = true, writes = 0;
  const service = createLarkCardService(env('token'), (async url => {
    if (String(url).includes('tenant_access_token')) { current = false; return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 }); }
    writes++; return Response.json({ code: 0, data: { message_id: 'om_sent' } });
  }) as typeof fetch); services.push(service);
  await expect(service.send({ ...input, chatId: 'oc_fixture', beforeSend: () => { if (!current) throw local(); } })).rejects.toMatchObject({ code: 'LARK_WRITE_OBSOLETE' });
  expect(writes).toBe(0);
});

it('waits for quota before checking and leaves the circuit and failure budget untouched on local rejection', async () => {
  const config = { ...env('quota'), LARK_API_QPS: '100', LARK_API_BURST: '1', LARK_API_CIRCUIT_FAILURE_THRESHOLD: '1' };
  await executeWithLarkGate(config.LARK_APP_ID, 'consume', async () => {}, { env: config });
  const failed = vi.fn(), network = vi.fn(async () => {});
  let current = true; setTimeout(() => { current = false; }, 1);
  await expect(executeWithLarkGate(config.LARK_APP_ID, 'obsolete', network, { env: config, onFailure: failed,
    beforeAttempt: () => { if (!current) throw local(); } })).rejects.toMatchObject({ code: 'LARK_WRITE_OBSOLETE' });
  expect(network).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
  await executeWithLarkGate(config.LARK_APP_ID, 'healthy', network, { env: config });
  expect(network).toHaveBeenCalledOnce();
});

it.each(['send', 'reply', 'update', 'uploadFile', 'sendFile', 'replyFile'] as const)('rechecks before every %s 429 attempt and preserves valid retries', async method => {
  for (const invalidate of [true, false]) {
    let writes = 0, current = true;
    const uuids: string[] = [];
    const service = createLarkCardService(env(`${method}_${invalidate}`), (async (url, init) => {
      if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 });
      writes++;
      if (typeof init?.body === 'string') uuids.push(JSON.parse(init.body).uuid);
      if (writes === 1) { current = !invalidate; return Response.json({ code: 230020 }, { status: 429 }); }
      return Response.json({ code: 0, data: { message_id: 'om_sent', file_key: 'file_fake' } });
    }) as typeof fetch); services.push(service);
    const call = service[method]({ ...input, chatId: 'oc_fixture', messageId: 'om_fixture', data: new Uint8Array([1]), filename: 'fixture.md', fileKey: 'file_fake', beforeSend: () => { if (!current) throw local(); } });
    if (invalidate) await expect(call).rejects.toMatchObject({ code: 'LARK_WRITE_OBSOLETE' }); else await call;
    expect(writes).toBe(invalidate ? 1 : 2);
    if (!invalidate && method !== 'uploadFile') expect(uuids[1]).toBe(uuids[0]);
  }
});

it('keeps the upload receipt but fences attachment-send after ownership changes', async () => {
  const repos = createRepositories(':memory:');
  try {
    let current = true; const paths: string[] = [];
    const service = createLarkCardService(env('attachment'), (async url => {
      if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 });
      paths.push(String(url)); current = false;
      return Response.json({ code: 0, data: { file_key: 'file_fake' } });
    }) as typeof fetch); services.push(service);
    await expect(sendLarkFile(service, { chatId: 'oc_fixture', replyMessageId: 'om_fixture' },
      { data: new Uint8Array([1]), filename: 'fixture.md', idempotencyKey: 'attachment_fence' }, log, repos.config,
      async () => { if (!current) throw local(); })).rejects.toMatchObject({ code: 'LARK_WRITE_OBSOLETE' });
    expect(paths).toHaveLength(1); expect(await repos.config.get('lark.delivery.attachment_fence.upload')).toBe('"file_fake"');
  } finally { repos.close(); }
});

it('rechecks fallback authority after a reply-target rejection', async () => {
  let current = true, writes = 0;
  const service = createLarkCardService(env('fallback'), (async url => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'fake', expire: 7200 });
    writes++; current = false; return Response.json({ code: 230011 }, { status: 400 });
  }) as typeof fetch); services.push(service);
  await expect(sendLarkResult(service, { chatId: 'oc_fixture', replyMessageId: 'om_fixture' }, input, log, undefined,
    async () => { if (!current) throw local(); })).rejects.toMatchObject({ code: 'LARK_WRITE_OBSOLETE' });
  expect(writes).toBe(1);
});
