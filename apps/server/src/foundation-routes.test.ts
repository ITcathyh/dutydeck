import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { createRepositories } from '@dutydeck/storage';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const repositories: Array<ReturnType<typeof createRepositories>> = [];
const runtime = { listAgents: vi.fn(async () => []) } as any;

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const repository of repositories.splice(0)) repository.close();
});

describe('WP1a foundation management API', () => {
  it('reports machine-readable unwired readiness and fails closed without service wiring', async () => {
    const app = await buildApp(runtime); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/foundation/capabilities' })).json()).toEqual({
      schemaVersion: 1,
      repositoriesWired: false,
      permissionEvaluatorWired: false,
      secretInspectorWired: false,
      runtimeWired: false,
      writesEnabled: false,
      readiness: 'repository_unwired',
      blockers: [
        { code: 'foundation_repository_unwired', message: '群策略仓储尚未接入运行时', action: '由 WP1b 注入 RepositoryBundle' },
        { code: 'permission_evaluator_unwired', message: '管理权限解析尚未接入运行时', action: '由 WP1b 注入 owner/admin principal resolver' },
        { code: 'secret_inspector_unwired', message: 'SecretRef 文件可用性检查尚未接入', action: '注入 metadata-only SecretRef inspector' },
        { code: 'production_execution_unwired', message: '生产消息与执行入口尚未接入', action: '等待 WP1b 执行入口接线' }
      ]
    });
    const matrix = await app.inject({ method: 'GET', url: '/api/foundation/group-matrix' });
    expect(matrix.statusCode).toBe(503);
    expect(matrix.json().error.code).toBe('FOUNDATION_REPOSITORY_UNWIRED');
  });

  it('allows safe reads but denies all writes when the permission adapter is unwired', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const app = await buildApp(runtime, { foundation: { repositories: repos } }); apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/api/foundation/capabilities' })).json()).toMatchObject({ repositoriesWired: true, permissionEvaluatorWired: false, readiness: 'permission_unwired', writesEnabled: false, runtimeWired: false });
    expect((await app.inject({ method: 'GET', url: '/api/foundation/group-matrix' })).json()).toEqual({ capabilities: expect.any(Object), bots: [] });
    const write = await app.inject({ method: 'POST', url: '/api/foundation/channel-bots', payload: { id: 'bot-denied', externalAppId: 'cli_denied', displayName: 'Denied', brand: 'feishu' } });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('FOUNDATION_PERMISSION_EVALUATOR_UNWIRED');
  });

  it('provides allowlisted disabled-state matrix data and CAS conflict recovery', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const authorize = vi.fn(async () => true);
    const inspectSecretRef = vi.fn(async () => 'available' as const);
    const app = await buildApp(runtime, { foundation: { repositories: repos, authorize, inspectSecretRef } }); apps.push(app);

    const bot = await app.inject({ method: 'POST', url: '/api/foundation/channel-bots', payload: { id: 'bot-api', externalAppId: 'cli_api', displayName: 'API Bot', brand: 'feishu' } });
    expect(bot.statusCode).toBe(201);
    expect(bot.json()).toMatchObject({ id: 'bot-api', revision: 1, state: 'staged', desiredListenerState: 'disabled', fullTrustConfirmed: false, credentialStatus: 'missing' });
    expect(bot.body).not.toMatch(/credentialRef|appSecret|secret-ref/i);

    await app.inject({ method: 'POST', url: '/api/foundation/channel-bot-policies', payload: {
      id: 'policy-api', channelBotId: 'bot-api', defaults: { agentDefinitionId: 'codex' },
      routingDefaults: { groupReplyMode: 'chat', mentionPolicy: 'always' }, accessPolicy: { mode: 'owner_only', principalIds: [] },
      groupToolsPolicy: { readCeiling: true, discoverCeiling: true, sendCeiling: false, readDefault: true, discoverDefault: true, sendDefault: false }
    } });
    await app.inject({ method: 'POST', url: '/api/foundation/group-bindings', payload: {
      id: 'binding-api', channelBotId: 'bot-api', externalChatId: 'chat-api', oncall: true,
      routingOverride: { groupReplyMode: { mode: 'set', value: 'chat-topic' }, mentionPolicy: { mode: 'set', value: 'topic' } },
      groupToolsOverride: { read: 'inherit', discover: 'deny', send: 'allow' }
    } });
    await app.inject({ method: 'POST', url: '/api/foundation/remote-chat-facts', payload: {
      id: 'fact-api', channelBotId: 'bot-api', externalChatId: 'chat-api', membershipState: 'member', chatType: 'topic_group', displayName: 'Synthetic chat', observedAt: '2026-08-30T00:00:00.000Z', lastSuccessAt: '2026-08-30T00:00:00.000Z'
    } });
    await app.inject({ method: 'POST', url: '/api/foundation/role-assignments', payload: {
      id: 'role-operate', channelBotId: 'bot-api', groupBindingId: 'binding-api', principalId: 'principal_operator', role: 'can_operate', operateScope: 'group_runs', actionGates: { terminalWrite: false, highRisk: false, groupToolsSend: false }
    } });

    const matrix = await app.inject({ method: 'GET', url: '/api/foundation/group-matrix' });
    expect(matrix.statusCode).toBe(200);
    expect(matrix.json()).toMatchObject({
      capabilities: { repositoriesWired: true, permissionEvaluatorWired: true, secretInspectorWired: true, runtimeWired: false, readiness: 'offline_management_ready' },
      bots: [{
        bot: { id: 'bot-api', state: 'staged', credentialStatus: 'missing' },
        cells: [{
          externalChatId: 'chat-api', remoteFact: { displayName: 'Synthetic chat', membershipState: 'member' },
          desiredPolicy: { id: 'binding-api', revision: 1, state: 'staged', oncall: true },
          effectiveSummary: { routing: { groupReplyMode: { value: 'chat-topic', source: 'group_override' }, mentionPolicy: { value: 'topic', source: 'group_override' } }, talkGrant: 'oncall_chat_members', groupTools: { send: { allowed: false, source: 'bot_ceiling' } } },
          permissionSummary: { canOperateAssignments: 1, adminAssignments: 0, independentGates: { terminalWrite: false, highRisk: false, groupToolsSend: false } },
          severity: 'blocked'
        }]
      }]
    });
    for (const privateCanary of ['fake-app-secret', 'fake-vendor-token', 'fake-cookie', 'alice@example.com', 'ou_raw_open_id', 'inline-secret-command', 'private-system-prompt', 'private-schedule-prompt', 'group-tools-capability-token']) expect(matrix.body).not.toContain(privateCanary);
    expect(matrix.body).not.toContain('principal_operator');

    const updated = await app.inject({ method: 'PATCH', url: '/api/foundation/group-bindings/binding-api', payload: { expectedRevision: 1, state: 'disabled' } });
    expect(updated.json()).toMatchObject({ revision: 2, state: 'disabled' });
    const stale = await app.inject({ method: 'PATCH', url: '/api/foundation/group-bindings/binding-api', payload: { expectedRevision: 1, oncall: false } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'FOUNDATION_REVISION_CONFLICT' }, current: { revision: 2, state: 'disabled', oncall: true } });
    expect(authorize).toHaveBeenCalledWith(expect.any(Object), 'group_binding.update');
  });

  it('returns only SecretRef metadata and blocks a Bot when the provider value is unreadable', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.secretRefs.create({ id: 'lark-local', kind: 'lark_app_secret', provider: 'local-file-v1', referenceKey: 'opaque.reference', status: 'configured' });
    const app = await buildApp(runtime, { foundation: { repositories: repos, authorize: async () => true, inspectSecretRef: async () => 'unreadable' } }); apps.push(app);
    const listed = await app.inject({ method: 'GET', url: '/api/foundation/secret-refs' });
    expect(listed.json()).toEqual({ secretRefs: [expect.objectContaining({ id: 'lark-local', provider: 'local-file-v1', referenceKey: 'opaque.reference', availability: 'unreadable' })] });
    const bot = await app.inject({ method: 'POST', url: '/api/foundation/channel-bots', payload: { id: 'bot-unreadable', externalAppId: 'cli_unreadable', displayName: 'Unreadable Bot', brand: 'feishu', credentialRef: 'lark-local' } });
    expect(bot.json()).toMatchObject({ selectedSecretRefId: 'lark-local', credentialStatus: 'unreadable', blockerCodes: ['channel_bot_credential_unreadable', 'channel_bot_activation_unavailable'] });
    for (const canary of ['SECRET_VALUE_CANARY', '"value":', '"appSecret":', '"token":', '/private/provider/locator']) expect(`${listed.body}${bot.body}`).not.toContain(canary);
    expect(Object.keys(listed.json().secretRefs[0]).sort()).toEqual(['availability', 'createdAt', 'id', 'kind', 'provider', 'referenceKey', 'revision', 'schemaVersion', 'status', 'updatedAt'].sort());
  });

  it('rejects activation, raw principal PII and plaintext-like request fields without echoing values', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const app = await buildApp(runtime, { foundation: { repositories: repos, authorize: async () => true } }); apps.push(app);
    const secret = await app.inject({ method: 'POST', url: '/api/foundation/channel-bots', payload: { id: 'bot-secret', externalAppId: 'cli_secret', displayName: 'Secret Bot', brand: 'feishu', appSecret: 'fake-app-secret-canary' } });
    expect(secret.statusCode).toBe(400);
    expect(secret.body).not.toContain('fake-app-secret-canary');
    const active = await app.inject({ method: 'POST', url: '/api/foundation/channel-bots', payload: { id: 'bot-active', externalAppId: 'cli_active', displayName: 'Active Bot', brand: 'feishu', state: 'active' } });
    expect(active.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/api/foundation/channel-bots', payload: { id: 'bot-role', externalAppId: 'cli_role', displayName: 'Role Bot', brand: 'feishu' } });
    const pii = await app.inject({ method: 'POST', url: '/api/foundation/role-assignments', payload: { id: 'role-pii', channelBotId: 'bot-role', principalId: 'alice@example.com', role: 'can_talk', operateScope: 'none' } });
    expect(pii.statusCode).toBe(400);
    expect(pii.body).not.toContain('alice@example.com');
  });
});
