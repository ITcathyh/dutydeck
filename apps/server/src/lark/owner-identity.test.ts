import { describe, expect, it, vi } from 'vitest';
import {
  assertOwnersUsableForApp,
  detectUnusableOwnerEntries,
  larkErrorCode,
  normalizeOwnerEntries,
  type ContactIdType,
  type ContactLookup,
  type ContactUser
} from './owner-identity.js';

const userKey = (id: string, idType: ContactIdType) => `${idType}:${id}`;

interface FakeLookupState {
  /** key 为 `${idType}:${id}`；值为 undefined 模拟 code:0 无 user（definitive miss）。 */
  users: Map<string, ContactUser | undefined>;
  /** key 同上；值为要 throw 的错误（模拟 SDK 非零码 / 网络错误）。 */
  userThrows: Map<string, unknown>;
  emailIds: Map<string, string | undefined>;
  emailThrows: Map<string, unknown>;
  mobileIds: Map<string, string | undefined>;
  mobileThrows: Map<string, unknown>;
}

type FakeLookup = ContactLookup & {
  getUser: ReturnType<typeof vi.fn>;
  batchGetIdByEmail: ReturnType<typeof vi.fn>;
  batchGetIdByMobile: ReturnType<typeof vi.fn>;
};

const makeLookup = (state: Partial<FakeLookupState> = {}): FakeLookup => {
  const users = state.users ?? new Map<string, ContactUser | undefined>();
  const userThrows = state.userThrows ?? new Map<string, unknown>();
  const emailIds = state.emailIds ?? new Map<string, string | undefined>();
  const emailThrows = state.emailThrows ?? new Map<string, unknown>();
  const mobileIds = state.mobileIds ?? new Map<string, string | undefined>();
  const mobileThrows = state.mobileThrows ?? new Map<string, unknown>();
  return {
    getUser: vi.fn(async (id: string, idType: ContactIdType) => {
      const thrown = userThrows.get(userKey(id, idType));
      if (thrown !== undefined) throw thrown;
      return users.get(userKey(id, idType));
    }),
    batchGetIdByEmail: vi.fn(async (email: string) => {
      const thrown = emailThrows.get(email);
      if (thrown !== undefined) throw thrown;
      return emailIds.get(email);
    }),
    batchGetIdByMobile: vi.fn(async (mobile: string) => {
      const thrown = mobileThrows.get(mobile);
      if (thrown !== undefined) throw thrown;
      return mobileIds.get(mobile);
    })
  };
};

describe('larkErrorCode', () => {
  it('从三种 SDK 错误形态里挖出数字码', () => {
    expect(larkErrorCode({ response: { data: { code: 99992361 } } })).toBe(99992361);
    expect(larkErrorCode({ data: { code: '41012' } })).toBe(41012);
    expect(larkErrorCode({ code: 40001 })).toBe(40001);
  });
  it('纯网络错误 / 空值返回 undefined（inconclusive）', () => {
    expect(larkErrorCode(new Error('ECONNRESET'))).toBeUndefined();
    expect(larkErrorCode({ code: 'not-a-number' })).toBeUndefined();
    expect(larkErrorCode(null)).toBeUndefined();
    expect(larkErrorCode(undefined)).toBeUndefined();
  });
});

describe('detectUnusableOwnerEntries', () => {
  it('A 应用的 ou_ 不能用于 B 应用：目标 app 返回 99992361（Axios throw 形态）→ 不可用', async () => {
    const lookup = makeLookup({
      userThrows: new Map([[userKey('ou_source', 'open_id'), { response: { data: { code: 99992361, msg: 'cross app' } } }]])
    });
    await expect(detectUnusableOwnerEntries(['ou_source'], lookup)).resolves.toEqual(['ou_source']);
    expect(lookup.getUser).toHaveBeenCalledWith('ou_source', 'open_id');
  });

  it('同一个 99992361 以 service 归一化后的 err.code 形态到达 → 同样不可用', async () => {
    // LarkCardService.normalizeContactError 抛出 Object.assign(new Error(...), { code, data })
    const normalized = Object.assign(new Error('Lark contact API failed (code: 99992361)'), { code: 99992361, data: {} });
    const lookup = makeLookup({ userThrows: new Map([[userKey('ou_norm', 'open_id'), normalized]]) });
    await expect(detectUnusableOwnerEntries(['ou_norm'], lookup)).resolves.toEqual(['ou_norm']);
  });

  it('code:0 但响应里没有 user → 明确不可用', async () => {
    const lookup = makeLookup({ users: new Map([[userKey('ou_no_user', 'open_id'), undefined]]) });
    await expect(detectUnusableOwnerEntries(['ou_no_user'], lookup)).resolves.toEqual(['ou_no_user']);
  });

  it('目标 app 判定 id 无效（41012 / 40001，throw 形态）→ 不可用', async () => {
    const lookup = makeLookup({
      userThrows: new Map([
        [userKey('ou_41012', 'open_id'), { data: { code: 41012 } }],
        [userKey('ou_40001', 'open_id'), { code: 40001 }]
      ])
    });
    await expect(detectUnusableOwnerEntries(['ou_41012', 'ou_40001'], lookup)).resolves.toEqual(['ou_41012', 'ou_40001']);
  });

  it('网络错误 / 未知错误码 → inconclusive，不拒绝', async () => {
    const lookup = makeLookup({
      userThrows: new Map([
        [userKey('ou_net', 'open_id'), new Error('ECONNRESET')],
        [userKey('ou_unknown', 'open_id'), { code: 40003 }]
      ])
    });
    await expect(detectUnusableOwnerEntries(['ou_net', 'ou_unknown'], lookup)).resolves.toEqual([]);
  });

  it('ou_ 能解析到目标 app 用户 → 不误拒', async () => {
    const lookup = makeLookup({
      users: new Map([[userKey('ou_same_app', 'open_id'), { openId: 'ou_same_app', unionId: 'on_owner' }]])
    });
    await expect(detectUnusableOwnerEntries(['ou_same_app'], lookup)).resolves.toEqual([]);
  });

  it('on_ 走 union_id 查询：目标 app 无法解析 → 不可用', async () => {
    const lookup = makeLookup({ users: new Map([[userKey('on_other_tenant', 'union_id'), undefined]]) });
    await expect(detectUnusableOwnerEntries(['on_other_tenant'], lookup)).resolves.toEqual(['on_other_tenant']);
    expect(lookup.getUser).toHaveBeenCalledWith('on_other_tenant', 'union_id');
  });

  it('on_ 能解析到目标 app 的 open_id → 不误拒', async () => {
    const lookup = makeLookup({
      users: new Map([[userKey('on_owner', 'union_id'), { openId: 'ou_target' }]])
    });
    await expect(detectUnusableOwnerEntries(['on_owner'], lookup)).resolves.toEqual([]);
  });

  it('邮箱 / 手机号走 batchGetId：干净空响应 → 不可用', async () => {
    const lookup = makeLookup({
      emailIds: new Map([['owner@example.com', undefined]]),
      mobileIds: new Map([['+14155550123', undefined]])
    });
    await expect(detectUnusableOwnerEntries(['owner@example.com', '+14155550123'], lookup)).resolves.toEqual(['owner@example.com', '+14155550123']);
  });

  it('邮箱 / 手机号能解析到 user_id → 不误拒', async () => {
    const lookup = makeLookup({
      emailIds: new Map([['owner@example.com', 'ou_resolved']]),
      mobileIds: new Map([['13011112222', 'ou_resolved']])
    });
    await expect(detectUnusableOwnerEntries(['owner@example.com', '13011112222'], lookup)).resolves.toEqual([]);
  });

  it('邮箱 / 手机号 lookup 抛错 → inconclusive，不拒绝', async () => {
    const lookup = makeLookup({
      emailThrows: new Map([['owner@example.com', new Error('ECONNRESET')]])
    });
    await expect(detectUnusableOwnerEntries(['owner@example.com'], lookup)).resolves.toEqual([]);
  });

  it('未知形态（邮箱前缀等）不在此拒绝，留给下游校验', async () => {
    const lookup = makeLookup();
    await expect(detectUnusableOwnerEntries(['owner_prefix'], lookup)).resolves.toEqual([]);
    expect(lookup.getUser).not.toHaveBeenCalled();
    expect(lookup.batchGetIdByEmail).not.toHaveBeenCalled();
  });

  it('ou_ 与 on_ 共用同一套 definitive-miss 判定，不漂移', async () => {
    // 同一组 definitive 码对 ou_ 和 on_ 都生效
    const lookup = makeLookup({
      userThrows: new Map([
        [userKey('ou_cross', 'open_id'), { code: 99992361 }],
        [userKey('on_cross', 'union_id'), { code: 99992361 }]
      ])
    });
    await expect(detectUnusableOwnerEntries(['ou_cross', 'on_cross'], lookup)).resolves.toEqual(['ou_cross', 'on_cross']);
  });
});

describe('normalizeOwnerEntries', () => {
  it('ou_ 能解析成 union_id → 替换为 on_', async () => {
    const lookup = makeLookup({
      users: new Map([[userKey('ou_owner', 'open_id'), { openId: 'ou_owner', unionId: 'on_owner' }]])
    });
    await expect(normalizeOwnerEntries(['ou_owner'], lookup)).resolves.toEqual(['on_owner']);
    expect(lookup.getUser).toHaveBeenCalledWith('ou_owner', 'open_id');
  });

  it('解析失败（inconclusive）→ 保留原 ou_', async () => {
    const lookup = makeLookup({
      userThrows: new Map([[userKey('ou_maybe', 'open_id'), new Error('ECONNRESET')]])
    });
    await expect(normalizeOwnerEntries(['ou_maybe'], lookup)).resolves.toEqual(['ou_maybe']);
  });

  it('解析到 user 但没有 union_id → 保留原 ou_', async () => {
    const lookup = makeLookup({
      users: new Map([[userKey('ou_no_union', 'open_id'), { openId: 'ou_no_union' }]])
    });
    await expect(normalizeOwnerEntries(['ou_no_union'], lookup)).resolves.toEqual(['ou_no_union']);
  });

  it('on_ / 邮箱 / 手机号等稳定形态保持原样，不触发 lookup', async () => {
    const lookup = makeLookup();
    await expect(normalizeOwnerEntries(['on_owner', 'owner@example.com', '+14155550123'], lookup))
      .resolves.toEqual(['on_owner', 'owner@example.com', '+14155550123']);
    expect(lookup.getUser).not.toHaveBeenCalled();
  });

  it('多个 ou_ 解析到同一 union_id → 去重', async () => {
    const lookup = makeLookup({
      users: new Map([
        [userKey('ou_a', 'open_id'), { unionId: 'on_same' }],
        [userKey('ou_b', 'open_id'), { unionId: 'on_same' }]
      ])
    });
    await expect(normalizeOwnerEntries(['ou_a', 'ou_b'], lookup)).resolves.toEqual(['on_same']);
  });

  it('preferUnionId: false 时即使能解析也保留 ou_（dutydeck 落库场景）', async () => {
    const lookup = makeLookup({
      users: new Map([[userKey('ou_owner', 'open_id'), { unionId: 'on_owner' }]])
    });
    await expect(normalizeOwnerEntries(['ou_owner'], lookup, { preferUnionId: false })).resolves.toEqual(['ou_owner']);
  });
});

describe('assertOwnersUsableForApp', () => {
  it('新建 app 场景：ou_ 一律拒绝，不触发 lookup', async () => {
    const lookup = makeLookup();
    await expect(assertOwnersUsableForApp(['ou_foreign', 'owner@example.com'], lookup, { creatingApp: true }))
      .rejects.toThrow(/保存新机器人时不能使用 app-scoped open_id.*ou_foreign/);
    expect(lookup.getUser).not.toHaveBeenCalled();
  });

  it('新建 app 场景：只有稳定形态（邮箱/on_）时不抛错', async () => {
    const lookup = makeLookup({
      emailIds: new Map([['owner@example.com', 'ou_resolved']]),
      users: new Map([[userKey('on_owner', 'union_id'), { openId: 'ou_target' }]])
    });
    await expect(assertOwnersUsableForApp(['owner@example.com', 'on_owner'], lookup, { creatingApp: true }))
      .resolves.toBeUndefined();
  });

  it('跨 app 场景：ou_ 无法通过目标 app 校验 → 抛错并指引改用邮箱/手机号/on_', async () => {
    const lookup = makeLookup({
      userThrows: new Map([[userKey('ou_cross', 'open_id'), { code: 99992361 }]])
    });
    await expect(assertOwnersUsableForApp(['ou_cross'], lookup))
      .rejects.toThrow(/无法通过目标应用校验.*ou_cross.*邮箱.*手机号.*on_/s);
  });

  it('全部条目通过校验 → 不抛错', async () => {
    const lookup = makeLookup({
      users: new Map([[userKey('ou_ok', 'open_id'), { openId: 'ou_ok' }]])
    });
    await expect(assertOwnersUsableForApp(['ou_ok'], lookup)).resolves.toBeUndefined();
  });
});
