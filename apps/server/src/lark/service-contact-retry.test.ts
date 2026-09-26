import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testOnly_resetLarkGate } from './api-gate.js';
import { createLarkCardService } from './service.js';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const harness = () => {
  const contact = vi.fn();
  const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes('/auth/')
    ? response({ code: 0, tenant_access_token: 'synthetic' }) : contact(url));
  const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'synthetic',
    LARK_API_QPS: '1000', LARK_API_RETRY_MAX_ATTEMPTS: '1', LARK_API_RETRY_BASE_MS: '1' }, fetcher);
  return { service, contact, fetcher };
};
afterEach(() => { __testOnly_resetLarkGate(); vi.restoreAllMocks(); });

describe('contact lookups use the shared HTTP retry budget', () => {
  it('retries a 5xx and returns both user identifiers', async () => {
    const { service, contact } = harness();
    contact.mockResolvedValueOnce(response({ code: 500 }, 500))
      .mockResolvedValueOnce(response({ code: 0, data: { user: { open_id: 'ou_1', union_id: 'on_1' } } }));
    await expect(service.getContactUser('ou_1', 'open_id')).resolves.toEqual({ openId: 'ou_1', unionId: 'on_1' });
    expect(contact).toHaveBeenCalledTimes(2);
    expect(String(contact.mock.calls[0]![0])).toContain('/contact/v3/users/ou_1?user_id_type=open_id');
  });

  it('retries a network failure', async () => {
    const { service, contact } = harness();
    contact.mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(response({ code: 0, data: { user: { open_id: 'ou_1' } } }));
    await expect(service.getContactUser('ou_1', 'open_id')).resolves.toEqual({ openId: 'ou_1' });
    expect(contact).toHaveBeenCalledTimes(2);
  });

  it('preserves definitive numeric business codes without retrying', async () => {
    const { service, contact } = harness();
    contact.mockResolvedValue(response({ code: 99992361, data: { reason: 'foreign' } }, 403));
    await expect(service.getContactUser('ou_foreign', 'open_id')).rejects.toMatchObject({ code: 99992361, data: { reason: 'foreign' } });
    expect(contact).toHaveBeenCalledTimes(1);
  });

  it('retries a transient business code and preserves batch request semantics', async () => {
    const { service, contact, fetcher } = harness();
    contact.mockResolvedValueOnce(response({ code: 99991400 }))
      .mockResolvedValueOnce(response({ code: 0, data: { user_list: [{ user_id: 'ou_2' }] } }));
    await expect(service.batchGetIdByEmail('a@example.com')).resolves.toBe('ou_2');
    expect(contact).toHaveBeenCalledTimes(2);
    expect(String(contact.mock.calls[0]![0])).toContain('/contact/v3/users/batch_get_id?user_id_type=open_id');
    expect(fetcher).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ emails: ['a@example.com'], include_resigned: false }), signal: expect.any(AbortSignal) }));
  });

  it('stops after the configured budget on persistent 5xx', async () => {
    const { service, contact } = harness();
    contact.mockImplementation(async () => response({ code: 503 }, 503));
    await expect(service.batchGetIdByMobile('13800000000')).rejects.toMatchObject({ code: 503 });
    expect(contact).toHaveBeenCalledTimes(2);
  });

  it('returns undefined for a clean missing user or empty batch', async () => {
    const { service, contact } = harness();
    contact.mockImplementation(async () => response({ code: 0, data: {} }));
    await expect(service.getContactUser('ou_missing', 'union_id')).resolves.toBeUndefined();
    await expect(service.batchGetIdByEmail('missing@example.com')).resolves.toBeUndefined();
  });
});
