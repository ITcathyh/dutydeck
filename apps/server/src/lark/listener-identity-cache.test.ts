import { afterEach, expect, it, vi } from 'vitest';
import { __testOnly_resetLarkGate } from './api-gate.js';
import { LarkLongConnectionListener } from './listener.js';
import { LarkCardService } from './service.js';
import type { StoredLarkConfig } from './config.js';

vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  EventDispatcher: class { register() { return this; } },
  WSClient: class {
    constructor(private readonly options: { onReady: () => void }) {}
    async start() { this.options.onReady(); }
    close() {}
  }
}));
const config: StoredLarkConfig = {
  appId: 'cli_test', appSecret: 'synthetic', workspace: '/tmp', fullTrustConfirmed: true, listening: true,
  preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000,
  hideTraceOnComplete: false, allowedUsers: [], allowedEmails: ['user@example.com'],
  highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: '', riskControlMode: 'off'
};
const response = (body: unknown) => new Response(JSON.stringify(body));
const missing = () => response({ code: 41050, msg: 'no user authority' });
const found = () => response({ code: 0, data: { user: { email: 'user@example.com' } } });
const harness = () => {
  const clients: LarkCardService[] = [];
  const original = LarkCardService.prototype.getBotOpenId;
  vi.spyOn(LarkCardService.prototype, 'getBotOpenId').mockImplementation(function (this: LarkCardService) {
    clients.push(this);
    return original.call(this);
  });
  const contact = vi.fn<() => Promise<Response>>();
  const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes('/auth/')
    ? response({ code: 0, tenant_access_token: 'synthetic' }) : String(url).includes('/bot/v3/info')
      ? response({ code: 0, bot: { open_id: 'ou_bot' } }) : contact());
  const listener = new LarkLongConnectionListener({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }, {
    fetcher, env: { LARK_API_QPS: '1000', LARK_API_RETRY_MAX_ATTEMPTS: '0' }
  });
  return { listener, clients, contact };
};
afterEach(() => { __testOnly_resetLarkGate(); vi.restoreAllMocks(); });

it('invalidates cached failures through the existing same-credentials config update', async () => {
  const { listener, clients, contact } = harness();
  contact.mockImplementationOnce(async () => missing()).mockImplementation(async () => found());
  try {
    await listener.start(config);
    await expect(clients[0]!.getUserEmails('ou_1')).rejects.toThrow();
    await expect(clients[0]!.getUserEmails('ou_1')).rejects.toThrow();
    expect(contact).toHaveBeenCalledTimes(1);
    await listener.start({ ...config, allowedEmails: ['staff@example.com'] });
    expect(clients).toHaveLength(1);
    await expect(clients[0]!.getUserEmails('ou_1')).resolves.toEqual(['user@example.com']);
    expect(contact).toHaveBeenCalledTimes(2);
  } finally { listener.stop(); }
});

it('does not let an old in-flight response refill the cache after a config update', async () => {
  const { listener, clients, contact } = harness();
  let finish!: (response: Response) => void;
  contact.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockImplementation(async () => found());
  try {
    await listener.start(config);
    const old = clients[0]!.getUserEmails('ou_1');
    const rejected = expect(old).rejects.toThrow();
    await vi.waitFor(() => expect(contact).toHaveBeenCalledTimes(1));
    await listener.start({ ...config, allowedEmails: ['staff@example.com'] });
    finish(missing());
    await rejected;
    await expect(clients[0]!.getUserEmails('ou_1')).resolves.toEqual(['user@example.com']);
    expect(contact).toHaveBeenCalledTimes(2);
  } finally { listener.stop(); }
});

it.each([{ appSecret: 'new-synthetic' }, { appId: 'cli_other' }])('rebinds identity failures when credentials change: %o', async change => {
  const { listener, clients, contact } = harness();
  contact.mockImplementationOnce(async () => missing()).mockImplementation(async () => found());
  try {
    await listener.start(config);
    await expect(clients[0]!.getUserEmails('ou_1')).rejects.toThrow();
    await listener.start({ ...config, ...change });
    expect(clients).toHaveLength(2);
    await expect(clients[1]!.getUserEmails('ou_1')).resolves.toEqual(['user@example.com']);
    expect(contact).toHaveBeenCalledTimes(2);
  } finally { listener.stop(); }
});

it('keeps a late old-credential failure outside the replacement client', async () => {
  const { listener, clients, contact } = harness();
  let finish!: (response: Response) => void;
  contact.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockImplementation(async () => found());
  try {
    await listener.start(config);
    const old = clients[0]!.getUserEmails('ou_1');
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(contact).toHaveBeenCalledTimes(1));
    await listener.start({ ...config, appSecret: 'new-synthetic' });
    finish(missing());
    await rejected;
    await expect(clients[1]!.getUserEmails('ou_1')).resolves.toEqual(['user@example.com']);
    expect(contact).toHaveBeenCalledTimes(2);
  } finally { listener.stop(); }
});
