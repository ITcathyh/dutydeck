import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLarkCardService } from './service.js';

// contact SDK 调用（user.get / batchGetId）独立于 api-gate，瞬时错误就地重试。
// 这里直接替换懒构造的 contactSdk()，避免触达真实飞书接口。

const fakeAxiosError = (status: number | undefined, code?: number) => {
  const err = new Error(status === undefined ? 'Network Error' : `Request failed with status ${status}`) as Error & {
    isAxiosError: boolean;
    response?: { status: number; data: { code: number } };
  };
  err.isAxiosError = true;
  if (status !== undefined) err.response = { status, data: { code: code ?? status } };
  return err;
};

const harness = () => {
  const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' });
  const get = vi.fn();
  const batchGetId = vi.fn();
  vi.spyOn(service as any, 'contactSdk').mockReturnValue({
    contact: { v3: { user: { get, batchGetId } } }
  } as any);
  return { service, get, batchGetId };
};

afterEach(() => vi.restoreAllMocks());

describe('contact SDK 瞬时错误就地重试', () => {
  it('user.get 首次 5xx、二次成功：重试后返回用户', async () => {
    const { service, get } = harness();
    get.mockRejectedValueOnce(fakeAxiosError(500))
      .mockResolvedValueOnce({ code: 0, data: { user: { open_id: 'ou_1', union_id: 'on_1' } } });
    await expect(service.getContactUser('ou_1', 'open_id')).resolves.toEqual({ openId: 'ou_1', unionId: 'on_1' });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('user.get 网络错误（无 HTTP 状态）也重试', async () => {
    const { service, get } = harness();
    get.mockRejectedValueOnce(fakeAxiosError(undefined))
      .mockResolvedValueOnce({ code: 0, data: { user: { open_id: 'ou_1' } } });
    await expect(service.getContactUser('ou_1', 'open_id')).resolves.toEqual({ openId: 'ou_1' });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('user.get 确定性 4xx 不重试，直接归一化抛出业务码', async () => {
    const { service, get } = harness();
    get.mockRejectedValue(fakeAxiosError(403, 99992361));
    await expect(service.getContactUser('ou_foreign', 'open_id')).rejects.toMatchObject({ code: 99992361 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('batchGetId 首次只回瞬态业务码（不 throw）、二次成功：仍然重试', async () => {
    const { service, batchGetId } = harness();
    batchGetId.mockResolvedValueOnce({ code: 99991400, msg: 'gateway busy' })
      .mockResolvedValueOnce({ code: 0, data: { user_list: [{ user_id: 'ou_2' }] } });
    await expect(service.batchGetIdByEmail('a@example.com')).resolves.toBe('ou_2');
    expect(batchGetId).toHaveBeenCalledTimes(2);
  });

  it('batchGetId 持续 5xx：重试耗尽后归一化抛出', async () => {
    const { service, batchGetId } = harness();
    batchGetId.mockRejectedValue(fakeAxiosError(503));
    await expect(service.batchGetIdByMobile('13800000000')).rejects.toThrow();
    expect(batchGetId).toHaveBeenCalledTimes(2);
  });
});
