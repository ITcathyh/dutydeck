import { describe, expect, it, vi } from 'vitest';
import draftCatalog from './fixtures/scope-catalog-draft.json';
import {
  configureLarkOpenPlatformApp,
  LARK_COMMON_TENANT_SCOPES,
  LARK_COMMON_USER_SCOPES,
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
} = {}): { client: LarkOpenPlatformClient; calls: Call[] } {
  const calls: Call[] = [];
  let eventRead = 0;
  let callbackRead = 0;
  let scopeRead = 0;
  let versionRead = 0;
  const eventStates = options.events ?? [{ data: { eventMode: 4, appEvents: ['im.message.receive_v1'] } }];
  const callbackStates = options.callbacks ?? [{ data: { callbackMode: 4, callbacks: ['card.action.trigger'] } }];
  const client: LarkOpenPlatformClient = {
    postJson: vi.fn(async (path: string, body?: Record<string, unknown>) => {
      calls.push({ path, ...(body === undefined ? {} : { body }) });
      if (path === options.failAt) throw new Error(`transport leaked ${options.secret ?? ''}`);
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
      if (path.includes('/app_version/create/')) return options.created ?? { data: { versionId: 'version-2' } };
      if (path.includes('/publish/commit/')) return { code: 0 };
      throw new Error(`unexpected endpoint: ${path}`);
    }),
  };
  return { client, calls };
}

describe('configureLarkOpenPlatformApp', () => {
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
    data.data.scopes[0]!.scopeType = [1];
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
      'im:resource',
    ]);
    expect(LARK_COMMON_USER_SCOPES).toEqual([]);

    const { client, calls } = harness();
    const result = await configureLarkOpenPlatformApp(client, 'cli_test');

    expect(result).toEqual({
      status: 'ready',
      scopeCount: 16,
      eventCount: 1,
      callbackCount: 1,
      versionId: 'version-2',
    });
    expect(calls.find(call => call.path.includes('/scope/update/'))?.body).toMatchObject({
      appScopeIDs: LARK_COMMON_TENANT_SCOPES.map((_, index) => `tenant-${index + 1}`),
      userScopeIDs: [],
      operation: 'add',
    });
    expect(calls.some(call => call.path.includes('/event/update/'))).toBe(false);
    expect(calls.some(call => call.path.includes('/callback/update/'))).toBe(false);
    expect(calls.some(call => call.path.includes('/callback/switch/'))).toBe(false);
  });

  it('adds only missing message event/card callback, switches callback mode, and verifies both by rereading', async () => {
    const { client, calls } = harness({
      events: [
        { data: { eventMode: 4, appEvents: ['existing.event'] } },
        { data: { eventMode: 4, appEvents: ['existing.event', 'im.message.receive_v1'] } },
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
      appEvents: ['im.message.receive_v1'],
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

  it('fails closed when any required scope is absent or only exists in the user bucket', async () => {
    const { client, calls } = harness({ catalog: catalog(LARK_COMMON_TENANT_SCOPES.slice(1)) });
    await expect(configureLarkOpenPlatformApp(client, 'cli_test')).rejects.toMatchObject({
      code: 'scope_catalog_incomplete',
    });
    expect(calls.some(call => call.path.includes('/scope/update/'))).toBe(false);
    expect(calls.some(call => call.path.includes('/robot/switch/'))).toBe(false);
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
