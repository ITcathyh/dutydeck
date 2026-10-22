import { afterEach, describe, expect, it, vi } from 'vitest';
import { __testOnly_resetLarkGate } from './api-gate.js';
import { createLarkCardService } from './service.js';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const missing = () => response({ code: 41050, msg: 'no user authority' });
const found = () => response({ code: 0, data: { user: { open_id: 'ou_1', email: 'user@example.com' } } });
const harness = (appId = 'cli_test', appSecret = 'synthetic') => {
  const contact = vi.fn<(...args: any[]) => Promise<Response>>();
  const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes('/auth/')
    ? response({ code: 0, tenant_access_token: 'synthetic' }) : contact(url));
  const service = createLarkCardService({ LARK_APP_ID: appId, LARK_APP_SECRET: appSecret,
    LARK_API_QPS: '100000', LARK_API_BURST: '100000', LARK_API_RETRY_MAX_ATTEMPTS: '0',
    LARK_API_CIRCUIT_FAILURE_THRESHOLD: '100' }, fetcher);
  return { service, contact };
};
afterEach(() => { __testOnly_resetLarkGate(); vi.restoreAllMocks(); });

describe('identity failure cache', () => {
  it.each([41050, 41012, 40001, 99992361])('reuses a classified Contact failure %s for the same user', async code => {
    const { service, contact } = harness();
    contact.mockImplementation(async () => response({ code, msg: 'unusable identity' }));
    await expect(service.getUserEmails('ou_1')).rejects.toMatchObject({ details: { upstreamCode: code } });
    await expect(service.getUserEmails('ou_1')).rejects.toMatchObject({ details: { upstreamCode: code } });
    expect(contact).toHaveBeenCalledTimes(1);
    await expect(service.getUserEmails('ou_2')).rejects.toThrow();
    expect(contact).toHaveBeenCalledTimes(2);
  });

  it('preserves the numeric Contact error contract and separates ID namespaces', async () => {
    const { service, contact } = harness();
    contact.mockImplementation(async () => missing());
    await expect(service.getUserEmails('ou_1')).rejects.toMatchObject({ details: { upstreamCode: 41050 } });
    await expect(service.getContactUser('ou_1', 'open_id')).rejects.toMatchObject({ code: 41050 });
    expect(contact).toHaveBeenCalledTimes(1);
    await expect(service.getContactUser('ou_1', 'union_id')).rejects.toMatchObject({ code: 41050 });
    expect(contact).toHaveBeenCalledTimes(2);
  });

  it('does not let a cached failure bypass service shutdown', async () => {
    const { service, contact } = harness();
    contact.mockImplementation(async () => missing());
    await expect(service.getUserEmails('ou_1')).rejects.toThrow();
    service.close();
    await expect(service.getUserEmails('ou_1')).rejects.toMatchObject({ name: 'AbortError' });
    expect(contact).toHaveBeenCalledTimes(1);
  });

  it('expires after 60 seconds and immediately observes restored access', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { service, contact } = harness();
    contact.mockImplementationOnce(async () => missing()).mockImplementation(async () => found());
    await expect(service.getUserEmails('ou_1')).rejects.toThrow();
    now += 59_999;
    await expect(service.getUserEmails('ou_1')).rejects.toThrow();
    expect(contact).toHaveBeenCalledTimes(1);
    now += 1;
    await expect(service.getUserEmails('ou_1')).resolves.toEqual(['user@example.com']);
    expect(contact).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['HTTP 408', () => response({ code: 41050 }, 408)],
    ['HTTP 504', () => response({ code: 41050 }, 504)],
    ['HTTP 429', () => response({ code: 41050 }, 429)],
    ['HTTP 503', () => response({ code: 41050 }, 503)],
    ['rate limit', () => response({ code: 99991400 })],
    ['missing scope', () => response({ code: 99991672 })],
    ['unknown business code', () => response({ code: 40003 })],
    ['network', () => { throw new TypeError('fetch failed'); }],
    ['timeout', () => { throw new DOMException('request timed out', 'TimeoutError'); }]
  ] as const)('does not cache %s failures', async (_name, failure) => {
    const { service, contact } = harness();
    contact.mockImplementationOnce(async () => failure()).mockImplementationOnce(async () => found());
    await expect(service.getUserEmails('ou_1')).rejects.toThrow();
    await expect(service.getUserEmails('ou_1')).resolves.toEqual(['user@example.com']);
    expect(contact).toHaveBeenCalledTimes(2);
  });

  it('checks successful identities again so revocation takes effect immediately', async () => {
    const { service, contact } = harness();
    contact.mockImplementationOnce(async () => found()).mockImplementation(async () => missing());
    await expect(service.getUserEmails('ou_1')).resolves.toEqual(['user@example.com']);
    await expect(service.getUserEmails('ou_1')).rejects.toMatchObject({ details: { upstreamCode: 41050 } });
    expect(contact).toHaveBeenCalledTimes(2);
  });

  it('does not share failures across apps or freshly bound credentials', async () => {
    const first = harness(), otherApp = harness('cli_other'), newCredentials = harness('cli_test', 'new-synthetic');
    first.contact.mockImplementation(async () => missing());
    otherApp.contact.mockImplementation(async () => found());
    newCredentials.contact.mockImplementation(async () => found());
    await expect(first.service.getUserEmails('ou_1')).rejects.toThrow();
    await expect(otherApp.service.getUserEmails('ou_1')).resolves.toEqual(['user@example.com']);
    await expect(newCredentials.service.getUserEmails('ou_1')).resolves.toEqual(['user@example.com']);
    expect(otherApp.contact).toHaveBeenCalledTimes(1);
    expect(newCredentials.contact).toHaveBeenCalledTimes(1);
  });

  it('bounds negative cache entries and evicts the oldest failure', async () => {
    const { service, contact } = harness();
    contact.mockImplementation(async () => missing());
    for (let id = 0; id <= 1000; id++) await expect(service.getUserEmails(`ou_${id}`)).rejects.toThrow();
    await expect(service.getUserEmails('ou_1000')).rejects.toThrow();
    expect(contact).toHaveBeenCalledTimes(1001);
    await expect(service.getUserEmails('ou_0')).rejects.toThrow();
    expect(contact).toHaveBeenCalledTimes(1002);
  });
});
