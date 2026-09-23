import { describe, expect, it, vi } from 'vitest';
// 该 fixture 是 console 实抓，唯一例外是标了 `_synthetic` 的四行
// （application:app_slash_command:write、im:message:urgent_app、im:pin、task:task:write
// 的真实 scope id 未知，手工补入以便权限映射与发布测试能跑，一律按已开通填）。
import draftCatalog from './fixtures/scope-catalog-draft.json';
import newAppPrivileges from './fixtures/new-app-privileges.json';
import automaticApproval from './fixtures/approval-collaborator-exemption.json';
import { larkCommandRegistry } from './commands.js';
import {
  OpenPlatformSessionExpiredError,
} from './open-platform-session.js';
import {
  configureLarkOpenPlatformApp,
  formatCommandDescription,
  larkSlashCommandDefinitions,
  LARK_COMMON_TENANT_SCOPES,
  LARK_COMMON_USER_SCOPES,
  LARK_REQUIRED_EVENTS,
  LARK_TENANT_SCOPES,
  MAX_SLASH_COMMAND_DESCRIPTION_LENGTH,
  type LarkOpenPlatformClient,
} from './open-platform-configurator.js';

interface Call { path: string; body?: Record<string, unknown> }

function catalog(scopes: readonly string[] = LARK_COMMON_TENANT_SCOPES, status = 5): unknown {
  return {
    code: 0,
    data: {
      nested: {
        appScopeList: scopes.map((name, index) => ({ scopeId: `tenant-${index + 1}`, scopeName: name, status })),
        userScopeList: [{ id: 'same-name-in-wrong-bucket', name: LARK_COMMON_TENANT_SCOPES[0] }],
      },
    },
  };
}

const visibility = {
  code: 0,
  data: {
    whiteList: {
      departments: [{ departmentId: 'od_engineering' }],
      members: [{ openId: 'ou_owner' }],
      groups: [{ groupId: 'g_team' }],
      isAll: 1,
    },
    blackList: { departments: [], members: [{ id: 'ou_blocked' }], groups: [], isAll: 0 },
  },
};

function harness(options: {
  catalog?: unknown;
  catalogs?: unknown[];
  events?: unknown[];
  callbacks?: unknown[];
  visibility?: unknown;
  versions?: unknown;
  published?: unknown;
  created?: unknown;
  failAt?: string;
  secret?: string;
  privileges?: unknown;
  ignorePrivilegeUpdate?: boolean;
  draftDetail?: unknown;
  approval?: unknown;
} = {}): { client: LarkOpenPlatformClient; calls: Call[] } {
  const calls: Call[] = [];
  let eventRead = 0;
  let callbackRead = 0;
  let scopeRead = 0;
  let versionRead = 0;
  let versionBody: Record<string, unknown> | undefined;
  let privileges = structuredClone(options.privileges ?? { data: { privileges: [] } });
  const eventStates = options.events ?? [{ data: { eventMode: 4, appEvents: [...LARK_REQUIRED_EVENTS] } }];
  const callbackStates = options.callbacks ?? [{ data: { callbackMode: 4, callbacks: ['card.action.trigger'] } }];
  const client: LarkOpenPlatformClient = {
    postJson: vi.fn(async (path: string, body?: Record<string, unknown>) => {
      calls.push({ path, ...(body === undefined ? {} : { body }) });
      if (path === options.failAt) throw new Error(`transport leaked ${options.secret ?? ''}`);
      // 与真实控制台会话客户端一致：只放行 /developers/v1/*（open-platform-session.ts 的路径白名单）。
      // 放宽这里会让「用错传输层」的缺陷继续被测试掩盖。
      if (!/^\/developers\/v1(?:\/|$)/.test(path)) throw new Error(`开放平台客户端仅允许访问 /developers/v1/*: ${path}`);
      if (path.includes('/privilege/all/')) return privileges;
      if (path.includes('/privilege/update/')) {
        if (!options.ignorePrivilegeUpdate) privileges = { data: { privileges: body?.privileges } };
        return { code: 0 };
      }
      if (path.includes('/scope/all/')) {
        const catalogs = options.catalogs ?? [options.catalog ?? catalog()];
        return catalogs[Math.min(scopeRead++, catalogs.length - 1)];
      }
      if (path.includes('/scope/update/')) return { code: 0 };
      if (path.includes('/robot/switch/') || path.includes('/event/switch/')) return { code: 0 };
      if (path.includes('/event/update/')) return { code: 0 };
      if (/\/event\/cli_test$/.test(path)) return eventStates[Math.min(eventRead++, eventStates.length - 1)];
      if (path.includes('/callback/switch/') || path.includes('/callback/update/')) return { code: 0 };
      if (/\/callback\/cli_test$/.test(path)) return callbackStates[Math.min(callbackRead++, callbackStates.length - 1)];
      if (path.includes('/visible/online/')) return options.visibility ?? visibility;
      if (path.includes('/app_version/list/')) {
        if (versionRead++ > 0) return options.published ?? { data: { versions: [{ versionId: 'version-2', versionStatus: 2 }] } };
        return options.versions ?? { data: { versions: [{ appVersion: '1.0.0' }] } };
      }
      if (path.includes('/app_version/create/')) {
        versionBody = body;
        return options.created ?? { data: { versionId: 'version-2' } };
      }
      if (path.includes('/app_version/detail/')) return options.draftDetail ?? { data: {
        versionId: 'version-2', versionStatus: 0,
        visibleRange: { whiteList: versionBody?.visibleSuggest, blackList: versionBody?.blackVisibleSuggest },
        changeAppShareConfig: { b2cShareSplitConfigSuggest: { b2cGroupChatShareEnable: false, b2cP2PChatShareEnable: false, b2cP2PChatNeedAudit: false } },
      } };
      if (path.includes('/approval_nodes/get/')) return options.approval ?? automaticApproval;
      if (path.includes('/publish/commit/')) return { code: 0 };
      throw new Error(`unexpected endpoint: ${path}`);
    }),
  };
  return { client, calls };
}

describe('configureLarkOpenPlatformApp', () => {
  it('uses the real collaborator exemption flow despite canAutoApproval=false and a CC recipient', async () => {
    const { client, calls } = harness({ versions: { data: { versions: [] } } });
    await configureLarkOpenPlatformApp(client, 'cli_test', { newApp: true, creatorUserId: 'creator' });
    expect(automaticApproval.data.canAutoApproval).toBe(false);
    const prediction = calls.findIndex(call => call.path.includes('/approval_nodes/get/'));
    expect(calls[prediction]?.body).toEqual({
      visibleSuggest: { departments: [], members: ['creator'], groups: [], isAll: 0 },
      blackVisibleSuggest: { departments: [], members: [], groups: [], isAll: 0 },
      b2cShareSplitConfigSuggest: { b2cGroupChatShareEnable: false, b2cP2PChatShareEnable: false, b2cP2PChatNeedAudit: false },
      versionId: 'version-2', notCalculateFlow: false,
    });
    expect(calls[prediction + 1]?.path).toContain('/publish/commit/');
  });

  it.each([
    { nodeName: '业务方必要性确认', nodeType: '或签', nodeUser: [{ approver: { id: 'human' } }] },
    { nodeName: '业务方必要性确认', nodeType: '自动通过', nodeUser: [{ approver: { id: 'human' } }] },
    { nodeName: '权限确认', nodeType: '审批人规则为空，自动通过', nodeUser: [] },
    { nodeName: '未知节点', nodeType: '自动通过' },
    { nodeName: '结束', nodeType: '或签', nodeUser: [{ approver: { id: 'human' } }] },
    { nodeName: '未知抄送节点', nodeType: '或签', nodeUser: [], nodeCcUser: [{ approver: { id: 'cc' } }] },
  ])('never submits a new app with an unconfirmed or human approval gate: %j', async node => {
    const { client, calls } = harness({ approval: { data: { canAutoApproval: true, applyInstanceInfo: { applyNodes: [node] } } } });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test', { newApp: true })).rejects.toMatchObject({ code: 'publish_requires_review' });
    expect(calls.some(call => call.path.includes('/publish/commit/'))).toBe(false);
  });

  it.each([undefined, [], [null], [{ nodeName: '发起', nodeType: '', nodeUser: [{ approver: { id: 'creator' } }] }, { nodeName: '结束', nodeType: '', nodeUser: [] }]])('does not submit an empty or malformed approval prediction: %j', async applyNodes => {
    const { client, calls } = harness({ approval: { data: { canAutoApproval: true, applyInstanceInfo: { applyNodes } } } });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test', { newApp: true })).rejects.toMatchObject({ code: 'approval_prediction_unreadable' });
    expect(calls.some(call => call.path.includes('/publish/commit/'))).toBe(false);
  });

  it('reuses the unpublished app draft and checks its actual creator-only visibility', async () => {
    const { client, calls } = harness({
      versions: { data: { versions: [{ versionId: 'version-2', appVersion: '0.0.1', versionStatus: 0 }] } },
      draftDetail: { data: { versionId: 'version-2', versionStatus: 0,
        visibleRange: { whiteList: { departments: [], members: [{ id: 'creator' }], groups: [], isAll: 0 }, blackList: { departments: [], members: [], groups: [], isAll: 0 } },
        changeAppShareConfig: { b2cShareSplitConfigSuggest: { b2cGroupChatShareEnable: false, b2cP2PChatShareEnable: false, b2cP2PChatNeedAudit: false } },
      } },
    });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test', { newApp: true, creatorUserId: 'creator' })).resolves.toMatchObject({ versionId: 'version-2' });
    expect(calls.some(call => call.path.includes('/app_version/create/'))).toBe(false);
    expect(calls.some(call => call.path.includes('/visible/online/'))).toBe(false);
    expect(calls.some(call => call.path.includes('/publish/commit/cli_test/version-2'))).toBe(true);
  });

  it('waits for an automatic approval to finish and submits the version only once', async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = harness();
      const delegate = client.postJson.bind(client);
      let reads = 0;
      client.postJson = async (path, body) => {
        const result = await delegate(path, body);
        if (path.includes('/app_version/list/') && ++reads === 2) return { data: { versions: [{ versionId: 'version-2', versionStatus: 1 }] } };
        return result;
      };
      const pending = configureLarkOpenPlatformApp(client, 'cli_test', { newApp: true });
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ status: 'ready' });
      expect(reads).toBe(3);
      expect(calls.filter(call => call.path.includes('/publish/commit/'))).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('stops before approval prediction if a draft has stale visibility', async () => {
    const { client, calls } = harness({ versions: { data: { versions: [] } }, draftDetail: { data: {
      versionId: 'version-2', versionStatus: 0, visibleRange: visibility.data,
    } } });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test', { newApp: true, creatorUserId: 'creator' })).rejects.toMatchObject({ code: 'draft_visibility_mismatch' });
    expect(calls.some(call => call.path.includes('/approval_nodes/get/') || call.path.includes('/publish/commit/'))).toBe(false);
  });

  it.each(['/app_version/detail/cli_test/version-2', '/approval_nodes/get/cli_test'])('does not submit when preflight transport fails at %s', async path => {
    const { client, calls } = harness({ failAt: `/developers/v1${path}`, secret: 'COOKIE_CANARY' });
    const error = await configureLarkOpenPlatformApp(client, 'cli_test', { newApp: true }).catch(error => error);
    expect(String(error)).not.toContain('COOKIE_CANARY');
    expect(calls.some(call => call.path.includes('/publish/commit/'))).toBe(false);
  });

  it('publishes with the actual console draft catalog, including five pending application permissions', async () => {
    const { client, calls } = harness({ catalog: draftCatalog });
    expect(draftCatalog.data.scopes.filter(scope => scope.scopeType2ScopeStatus['2'] === 1)).toHaveLength(5);
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).resolves.toMatchObject({ status: 'ready' });
    expect(calls.find(call => call.path.includes('/scope/update/'))?.body?.appScopeIDs).toEqual(
      LARK_COMMON_TENANT_SCOPES.map(name => draftCatalog.data.scopes.find(scope => scope.name === name)!.id),
    );
    expect(calls.some(call => call.path.includes('/publish/commit/'))).toBe(true);
  });

  it('rejects a numeric user-only scope instead of treating it as unbucketed', async () => {
    const data = structuredClone(draftCatalog);
    // 必须挑一项 base 权限：feature 权限缺失只会被跳过，证明不了「user bucket 不算数」。
    data.data.scopes.find(scope => scope.name === 'im:message')!.scopeType = [1];
    const { client, calls } = harness({ catalog: data });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).rejects.toMatchObject({ code: 'scope_catalog_incomplete' });
    expect(calls.some(call => call.path.includes('/scope/update/'))).toBe(false);
  });

  it.each([0, 2, 3, 4, undefined])('rejects tenant status %s even if the user and aggregate status are enabled', async status => {
    const readback = structuredClone(draftCatalog);
    Object.assign(readback.data.scopes[0]!, {
      scopeType: [1, 2], status: 5,
      scopeType2ScopeStatus: { '1': 5, ...(status === undefined ? {} : { '2': status }) },
    });
    const { client, calls } = harness({ catalogs: [draftCatalog, readback] });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).rejects.toMatchObject({ code: 'scope_verification_failed' });
    expect(calls.some(call => call.path.includes('/app_version/create/'))).toBe(false);
  });

  it('uses the exact minimal common scope set and keeps an already-ready subscription idempotent', async () => {
    expect(LARK_COMMON_TENANT_SCOPES).toEqual([
      'application:app_slash_command:write',
      'contact:contact.base:readonly',
      'contact:user.base:readonly',
      'contact:user.email:readonly',
      'contact:user.id:readonly',
      'im:chat.members:read',
      'im:chat:read',
      'im:message',
      'im:message.group_at_msg.include_bot:readonly',
      'im:message.group_at_msg:readonly',
      'im:message.group_msg',
      'im:message.group_msg.include_bot:read',
      'im:message.p2p_msg:readonly',
      'im:message.reactions:write_only',
      'im:message:readonly',
      'im:message:update',
      'im:message:urgent_app',
      'im:pin',
      'im:resource',
      'task:task:write',
    ]);
    expect(LARK_COMMON_USER_SCOPES).toEqual([]);

    const { client, calls } = harness();
    const result = await configureLarkOpenPlatformApp(client, 'cli_test');

    expect(result).toEqual({
      status: 'ready',
      scopeCount: 20,
      skippedScopes: [],
      eventCount: 3,
      callbackCount: 1,
      versionId: 'version-2',
    });
    expect(LARK_REQUIRED_EVENTS).toEqual([
      'im.message.receive_v1',
      'im.chat.member.bot.added_v1',
      'im.message.updated_v1',
    ]);
    expect(calls.find(call => call.path.includes('/scope/update/'))?.body).toMatchObject({
      appScopeIDs: LARK_COMMON_TENANT_SCOPES.map((_, index) => `tenant-${index + 1}`),
      userScopeIDs: [],
      operation: 'add',
    });
    expect(calls.some(call => call.path.includes('/event/update/'))).toBe(false);
    expect(calls.some(call => call.path.includes('/callback/update/'))).toBe(false);
    expect(calls.some(call => call.path.includes('/callback/switch/'))).toBe(false);
  });

  it('adds only the missing bot.added event without resubscribing receive_v1, switches callback mode, and verifies by rereading', async () => {
    const { client, calls } = harness({
      events: [
        { data: { eventMode: 4, appEvents: ['existing.event', 'im.message.receive_v1', 'im.message.updated_v1'] } },
        { data: { eventMode: 4, appEvents: ['existing.event', 'im.message.receive_v1', 'im.message.updated_v1', 'im.chat.member.bot.added_v1'] } },
      ],
      callbacks: [
        { data: { callbackMode: 1, callbacks: ['existing.callback'] } },
        { data: { callbackMode: 4, callbacks: ['existing.callback'] } },
        { data: { callbackMode: 4, callbacks: ['existing.callback', 'card.action.trigger'] } },
      ],
    });

    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).resolves.toMatchObject({ status: 'ready' });
    expect(calls.find(call => call.path.includes('/event/update/'))?.body).toEqual({
      clientId: 'cli_test',
      operation: 'add',
      events: [],
      appEvents: ['im.chat.member.bot.added_v1'],
      userEvents: [],
      eventMode: 4,
    });
    expect(calls.find(call => call.path.includes('/callback/switch/'))?.body).toEqual({
      clientId: 'cli_test', callbackMode: 4,
    });
    expect(calls.find(call => call.path.includes('/callback/update/'))?.body).toEqual({
      clientId: 'cli_test', operation: 'add', callbacks: ['card.action.trigger'], callbackMode: 4,
    });
    expect(calls.filter(call => /\/event\/cli_test$/.test(call.path))).toHaveLength(2);
    expect(calls.filter(call => /\/callback\/cli_test$/.test(call.path))).toHaveLength(3);
  });

  it('adds only updated_v1 for an existing app and verifies the subscription readback', async () => {
    const { client, calls } = harness({ events: [
      { data: { eventMode: 4, appEvents: ['existing.event', 'im.message.receive_v1', 'im.chat.member.bot.added_v1'] } },
      { data: { eventMode: 4, appEvents: ['existing.event', ...LARK_REQUIRED_EVENTS] } }
    ] });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).resolves.toMatchObject({ status: 'ready', eventCount: 3 });
    const updates = calls.filter(call => call.path.includes('/event/update/'));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.body).toMatchObject({ operation: 'add', appEvents: ['im.message.updated_v1'] });
    expect(calls.filter(call => /\/event\/cli_test$/.test(call.path))).toHaveLength(2);
  });

  it('submits every missing required event exactly once when the app predates all subscriptions', async () => {
    const { client, calls } = harness({
      events: [
        { data: { eventMode: 4, appEvents: ['existing.event'] } },
        { data: { eventMode: 4, appEvents: ['existing.event', ...LARK_REQUIRED_EVENTS] } },
      ],
    });

    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).resolves.toMatchObject({ status: 'ready', eventCount: 3 });
    const updateBodies = calls.filter(call => call.path.includes('/event/update/'));
    // 只提交一次增量 add，每个必需事件各出现一次、已有事件不重提。
    expect(updateBodies).toHaveLength(1);
    expect(updateBodies[0]!.body?.appEvents).toEqual(LARK_REQUIRED_EVENTS);
  });

  it('does not touch the event subscription when all required events are already present', async () => {
    const { client, calls } = harness();
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).resolves.toMatchObject({ status: 'ready' });
    expect(calls.some(call => call.path.includes('/event/update/'))).toBe(false);
  });

  it('fails closed when any base scope is absent or only exists in the user bucket', async () => {
    const { client, calls } = harness({
      catalog: catalog(LARK_COMMON_TENANT_SCOPES.filter(name => name !== 'im:message')),
    });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).rejects.toMatchObject({
      code: 'scope_catalog_incomplete',
    });
    expect(calls.some(call => call.path.includes('/scope/update/'))).toBe(false);
    expect(calls.some(call => call.path.includes('/robot/switch/'))).toBe(false);
  });

  it('skips a feature scope missing from the tenant catalog and still publishes', async () => {
    const present = LARK_COMMON_TENANT_SCOPES.filter(name => name !== 'task:task:write');
    const { client, calls } = harness({ catalog: catalog(present) });

    const result = await configureLarkOpenPlatformApp(client, 'cli_test');

    expect(result).toMatchObject({ status: 'ready', scopeCount: 19, skippedScopes: ['task:task:write'] });
    // 申请清单里不得出现跳过项的 id，回读校验也不得因为它失败。
    expect(calls.find(call => call.path.includes('/scope/update/'))?.body?.appScopeIDs)
      .toEqual(present.map((_, index) => `tenant-${index + 1}`));
    expect(calls.some(call => call.path.includes('/publish/commit/'))).toBe(true);
  });

  it('skips every missing feature scope at once and reports them through onStep', async () => {
    const featureScopes = LARK_TENANT_SCOPES.filter(scope => scope.tier === 'feature').map(scope => scope.name);
    const present = LARK_COMMON_TENANT_SCOPES.filter(name => !featureScopes.includes(name));
    const { client } = harness({ catalog: catalog(present) });
    const steps: Array<[string, unknown]> = [];

    const result = await configureLarkOpenPlatformApp(client, 'cli_test', {
      onStep: (step, detail) => steps.push([step, detail]),
    });

    expect(featureScopes).toEqual([
      'application:app_slash_command:write',
      'im:message:urgent_app',
      'im:pin',
      'task:task:write',
    ]);
    expect(result).toMatchObject({ status: 'ready', scopeCount: 16, skippedScopes: featureScopes });
    expect(steps.find(([step]) => step === 'scope_update')?.[1]).toEqual({ skippedScopes: featureScopes });
  });

  it('does not report skipped scopes when the catalog is complete', async () => {
    const { client } = harness();
    const steps: Array<[string, unknown]> = [];
    const result = await configureLarkOpenPlatformApp(client, 'cli_test', {
      onStep: (step, detail) => steps.push([step, detail]),
    });
    expect(result.skippedScopes).toEqual([]);
    expect(steps.find(([step]) => step === 'scope_update')?.[1]).toBeUndefined();
  });

  it('accepts the real console catalog shape when entries omit identity buckets', async () => {
    const unbucketed = {
      code: 0,
      data: {
        scopes: LARK_COMMON_TENANT_SCOPES.map((name, index) => ({ id: String(index + 1), name, status: 5 })),
      },
    };
    const { client, calls } = harness({ catalog: unbucketed });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).resolves.toMatchObject({ status: 'ready' });
    expect(calls.find(call => call.path.includes('/scope/update/'))?.body?.appScopeIDs).toEqual(
      LARK_COMMON_TENANT_SCOPES.map((_, index) => String(index + 1)),
    );
  });

  it('fails closed when scope update succeeds but required permissions are absent in readback', async () => {
    const { client, calls } = harness({ catalogs: [catalog(), catalog(LARK_COMMON_TENANT_SCOPES, 0)] });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).rejects.toMatchObject({
      code: 'scope_verification_failed',
    });
    expect(calls.filter(call => call.path.includes('/scope/all/'))).toHaveLength(2);
    expect(calls.some(call => call.path.includes('/robot/switch/'))).toBe(false);
    expect(calls.some(call => call.path.includes('/app_version/create/'))).toBe(false);
  });

  it('fails when the required event is still missing after the update readback', async () => {
    const { client, calls } = harness({
      events: [
        { data: { eventMode: 4, appEvents: [] } },
        { data: { eventMode: 4, appEvents: [] } },
      ],
    });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).rejects.toMatchObject({
      code: 'event_verification_failed',
    });
    expect(calls.some(call => call.path.includes('/visible/online/'))).toBe(false);
  });

  it('fails closed when the event update readback request itself fails', async () => {
    const base = harness({ events: [{ data: { eventMode: 4, appEvents: [] } }] });
    const delegate = base.client.postJson.bind(base.client);
    let eventReads = 0;
    const client: LarkOpenPlatformClient = {
      postJson: async (path, body) => {
        if (/\/event\/cli_test$/.test(path) && ++eventReads === 2) {
          throw new Error('sensitive transport diagnostics');
        }
        return delegate(path, body);
      },
    };

    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).rejects.toMatchObject({
      code: 'event_read_failed',
    });
    expect(base.calls.some(call => call.path.includes('/app_version/create/'))).toBe(false);
  });

  it('does not create or publish a version when either online visibility block is incomplete', async () => {
    const { client, calls } = harness({
      visibility: {
        data: {
          whiteList: { departments: [], members: [], groups: [], isAll: 1 },
          blackList: { departments: [], members: [], isAll: 0 },
        },
      },
    });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).rejects.toMatchObject({
      code: 'visibility_unreadable',
    });
    expect(calls.some(call => call.path.includes('/app_version/create/'))).toBe(false);
    expect(calls.some(call => call.path.includes('/publish/commit/'))).toBe(false);
  });

  it('increments the greatest semver including an unpublished draft, requires versionId, then commits it', async () => {
    const { client, calls } = harness({
      versions: {
        data: {
          versions: [
            { appVersion: '1.9.9', status: 'published' },
            { appVersion: '2.0.4', status: 'draft' },
            { appVersion: '2.0.3', status: 'published' },
          ],
        },
      },
      created: { code: 0, data: { appVersion: { version_id: 'draft-205' } } },
      published: { data: { versions: [{ versionId: 'draft-205', versionStatus: 2 }] } },
    });
    const result = await configureLarkOpenPlatformApp(client, 'cli_test');
    expect(calls.find(call => call.path.includes('/app_version/create/'))?.body).toMatchObject({
      appVersion: '2.0.5',
      visibleSuggest: {
        departments: ['od_engineering'], members: ['ou_owner'], groups: ['g_team'], isAll: 1,
      },
      blackVisibleSuggest: {
        departments: [], members: ['ou_blocked'], groups: [], isAll: 0,
      },
    });
    expect(calls.at(-2)).toEqual({
      path: '/developers/v1/publish/commit/cli_test/draft-205',
      body: { clientId: 'cli_test' },
    });
    expect(result.versionId).toBe('draft-205');
    expect(calls.at(-1)?.path).toBe('/developers/v1/app_version/list/cli_test');
  });

  it.each([
    [0, 'publish_verification_failed'],
    [1, 'publish_pending_review'],
    [3, 'publish_verification_failed'],
    [undefined, 'publish_verification_failed'],
  ])('does not report success when commit succeeds but the new version has status %s', async (versionStatus, code) => {
    const { client } = harness({ published: { data: { versions: [
      { versionId: 'old-published-version', versionStatus: 2 },
      { versionId: 'version-2', versionStatus },
    ] } } });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).rejects.toMatchObject({ code });
  });

  it('never exposes a secret through either success results or transport errors', async () => {
    const secret = 'app-secret-must-not-leak';
    const success = harness();
    expect(JSON.stringify(await configureLarkOpenPlatformApp(success.client, 'cli_test'))).not.toContain(secret);

    const failure = harness({
      failAt: '/developers/v1/scope/all/cli_test',
      secret,
    });
    let error: unknown;
    try {
      await configureLarkOpenPlatformApp(failure.client, 'cli_test');
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'scope_catalog_read_failed' });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

it('uses only the creator for the first version without requiring an online visibility record', async () => {
  const { client, calls } = harness({ versions: { data: { versions: [] } } });
  await configureLarkOpenPlatformApp(client, 'cli_test', { creatorUserId: 'creator-private-id' });
  expect(calls.some(call => call.path.includes('/visible/online/'))).toBe(false);
  expect(calls.find(call => call.path.includes('/app_version/create/'))?.body).toMatchObject({
    visibleSuggest: { departments: [], members: ['creator-private-id'], groups: [], isAll: 0 },
    blackVisibleSuggest: { departments: [], members: [], groups: [], isAll: 0 },
  });
});

it('preserves existing published visibility even when a creator is supplied', async () => {
  const { client, calls } = harness();
  await configureLarkOpenPlatformApp(client, 'cli_test', { creatorUserId: 'new-scanned-user' });
  expect(calls.find(call => call.path.includes('/app_version/create/'))?.body).toMatchObject({
    visibleSuggest: { departments: ['od_engineering'], members: ['ou_owner'], groups: ['g_team'], isAll: 1 },
    blackVisibleSuggest: { departments: [], members: ['ou_blocked'], groups: [], isAll: 0 },
  });
});

describe('native slash commands', () => {
  it('includes application:app_slash_command:write in LARK_COMMON_TENANT_SCOPES with alphabetical sort', () => {
    expect(LARK_COMMON_TENANT_SCOPES).toContain('application:app_slash_command:write');
    const sorted = [...LARK_COMMON_TENANT_SCOPES].sort();
    expect(LARK_COMMON_TENANT_SCOPES).toEqual(sorted);
    // 分级只认 LARK_TENANT_SCOPES 这张表，不靠名字前缀猜。
    expect(LARK_TENANT_SCOPES.find(scope => scope.name === 'application:app_slash_command:write')?.tier).toBe('feature');
    expect(LARK_TENANT_SCOPES.filter(scope => scope.tier === 'base')).toHaveLength(16);
  });

  it('never routes slash command requests through the console session client', async () => {
    const { client, calls } = harness();
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).resolves.toMatchObject({ status: 'ready' });
    // 控制台会话带的是 cookie + CSRF，打的是控制台域；/open-apis/* 只认 tenant token。
    // 发版流程里出现任何一条 /open-apis 请求，都说明传输层又选错了。
    expect(calls.every(call => call.path.startsWith('/developers/v1/'))).toBe(true);
    expect(calls.some(call => call.path.includes('app_slash_commands'))).toBe(false);
  });

  it('turns the registry into命令菜单目标状态：不带前导斜杠、说明按上限截断', () => {
    const definitions = larkSlashCommandDefinitions();
    expect(definitions).toHaveLength(larkCommandRegistry.length);
    expect(definitions.some(definition => definition.command.startsWith('/'))).toBe(false);
    expect(definitions.map(definition => definition.command)).toEqual(larkCommandRegistry.map(command => command.name));
    expect(definitions.every(definition => definition.description.length <= MAX_SLASH_COMMAND_DESCRIPTION_LENGTH)).toBe(true);
  });

  it('truncates summaries exceeding MAX_SLASH_COMMAND_DESCRIPTION_LENGTH without error', () => {
    const longSummary = 'A'.repeat(150);
    const formatted = formatCommandDescription(longSummary);
    expect(formatted).toHaveLength(MAX_SLASH_COMMAND_DESCRIPTION_LENGTH);
    expect(formatted).toBe('A'.repeat(100));
  });
});


describe('new application data ranges', () => {
  it('narrows the real template task-member range before first publication and verifies the saved filters', async () => {
    const { client, calls } = harness({ versions: { data: { versions: [] } }, privileges: newAppPrivileges });
    await configureLarkOpenPlatformApp(client, 'cli_test', { newApp: true, creatorUserId: 'creator' });
    const update = calls.find(call => call.path.includes('/privilege/update/'))!;
    expect(update.body?.clientId).toBe('cli_test');
    const privileges = update.body?.privileges as typeof newAppPrivileges.data.privileges;
    expect(privileges).toHaveLength(1);
    expect(privileges[0]).toMatchObject({ bizId: 'task', resource: 'manage_task_and_tasklist_members', schemaType: 1, organizationType: 1 });
    const content = JSON.parse(privileges[0]!.content);
    expect(content).toMatchObject({ mode: 'part', expression: '1', filters: [{ field: 'member', operator: 'in' }] });
    expect(JSON.parse(content.filters[0].value)).toEqual([{ mode: 'availability_of_app', members: [], departments: [], groups: [] }]);
    expect(calls.filter(call => call.path.includes('/privilege/all/'))).toHaveLength(2);
    expect(calls.indexOf(update)).toBeLessThan(calls.findIndex(call => call.path.includes('/app_version/create/')));
  });

  it.each([{}, { creatorUserId: 'creator' }, { newApp: true, creatorUserId: 'creator' }])('preserves existing app ranges: %j', async options => {
    const { client, calls } = harness({ versions: { data: { versions: [{ appVersion: '1.0.0', versionStatus: 2 }] } }, privileges: newAppPrivileges });
    await configureLarkOpenPlatformApp(client, 'cli_test', options);
    expect(calls.some(call => call.path.includes('/privilege/'))).toBe(false);
  });

  it('preserves custom, unreadable and unsupported ranges and ignores optional privileges', async () => {
    const original = newAppPrivileges.data.privileges[0]!;
    const privileges = [
      { ...original, resource: 'custom', content: JSON.stringify({ mode: 'part', filters: [{ field: 'member', operator: 'in', value: 'owner-only' }] }) },
      ...['not-json', 'null', '[]', '42', '{"mode":false}', '{"mode":"part","filters":"unknown"}', '{"mode":"part"}'].map((content, index) => ({ ...original, resource: `unreadable-${index}`, content })),
      { ...original, resource: 'optional', isRequired: false },
      { ...original, resource: 'external', organizationType: 2 },
      { ...original, resource: 'mixed', schemaContent: { selectionExpressionSchemaContent: { fields: [{ id: 'place', data_source: { type: 'url' }, operators: ['in'] }] } } },
    ];
    const { client, calls } = harness({ versions: { data: { versions: [] } }, privileges: { data: { privileges } } });
    await configureLarkOpenPlatformApp(client, 'cli_test', { newApp: true, creatorUserId: 'creator' });
    expect(calls.some(call => call.path.includes('/privilege/update/'))).toBe(false);
  });

  it.each([
    { failAt: '/developers/v1/privilege/all/cli_test', code: 'privilege_read_failed' },
    { failAt: '/developers/v1/privilege/update/cli_test', code: 'privilege_update_failed' },
    { ignorePrivilegeUpdate: true, code: 'privilege_verification_failed' },
  ])('does not publish when narrowing cannot be verified: $code', async options => {
    const { client, calls } = harness({ versions: { data: { versions: [] } }, privileges: newAppPrivileges, ...options, secret: 'COOKIE_CANARY' });
    const error = await configureLarkOpenPlatformApp(client, 'cli_test', { newApp: true, creatorUserId: 'creator' }).catch(error => error);
    expect(error).toMatchObject({ code: options.code });
    expect(String(error)).not.toContain('COOKIE_CANARY');
    expect(calls.some(call => call.path.includes('/app_version/create/') || call.path.includes('/publish/commit/'))).toBe(false);
  });
});

describe('session expiration propagation', () => {
  it('transparently passes through session_expired code and message instead of masking with step error', async () => {
    const expiredError = new OpenPlatformSessionExpiredError(
      '飞书开放平台登录已失效，请重新扫码。',
      400,
      99991641,
    );
    const client: LarkOpenPlatformClient = {
      postJson: vi.fn(async () => {
        throw expiredError;
      }),
    };

    let caught: unknown;
    try {
      await configureLarkOpenPlatformApp(client, 'cli_test');
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      code: 'session_expired',
      message: '飞书开放平台登录已失效，请重新扫码。',
    });
  });

  it('transparently passes through mid-chain session expiration wrapped in cause chain', async () => {
    const inner = new OpenPlatformSessionExpiredError();
    const wrapper = new Error('transport failure', { cause: inner });
    const { client } = harness();
    const orig = client.postJson;
    client.postJson = async (path: string, body?: Record<string, unknown>) => {
      if (path.includes('/robot/switch/')) throw wrapper;
      return orig(path, body);
    };

    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).rejects.toMatchObject({
      code: 'session_expired',
      message: '飞书开放平台登录已失效，请重新扫码。',
    });
  });

  it('keeps cause non-enumerable so JSON.stringify only outputs code and never serializes cause or response payload', async () => {
    const rawSecretCanary = 'raw-secret-canary-payload-12345';
    const inner = new OpenPlatformSessionExpiredError();
    // 模拟内部带有包含敏感字段的 cause
    (inner as unknown as { rawPayload: Record<string, unknown> }).rawPayload = { secret: rawSecretCanary };
    const client: LarkOpenPlatformClient = {
      postJson: vi.fn(async () => {
        throw inner;
      }),
    };

    let caught: unknown;
    try {
      await configureLarkOpenPlatformApp(client, 'cli_test');
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      code: 'session_expired',
      message: '飞书开放平台登录已失效，请重新扫码。',
    });
    // cause 属性可通过属性访问（供内部排障）
    expect((caught as Error).cause).toBe(inner);
    // 但 cause 必须是不可枚举属性，JSON.stringify 绝不输出
    const serialized = JSON.stringify(caught);
    expect(JSON.parse(serialized)).toEqual({
      code: 'session_expired',
      name: 'LarkOpenPlatformConfigurationError',
    });
    expect(serialized).not.toContain(rawSecretCanary);
    expect(serialized).not.toContain('cause');
    expect(Object.keys(caught as object)).toEqual(['code', 'name']);
  });
});
