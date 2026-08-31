import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dockmux/storage';
import {
  createFoundationExecutionAuthorizer,
  createFoundationManagementAuthorizer,
  createInstallationPrincipalResolver,
  foundationGroupBindingSessionSource,
} from './foundation-policy.js';

const repositories: Array<ReturnType<typeof createRepositories>> = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });

const request = (headers: Record<string, string> = {}) => ({ headers });

describe('WP1b foundation production policy wiring', () => {
  it('uses a marked installation owner in explicit no-auth mode and has no token-mode anonymous fallback', async () => {
    const trusted = createInstallationPrincipalResolver({ authEnabled: false, mode: 'open', getToken: async () => null });
    await expect(trusted(request())).resolves.toMatchObject({
      id: 'principal_installation_owner', kind: 'installation_owner', role: 'admin', authentication: 'trusted_devhost_no_auth'
    });

    const token = createInstallationPrincipalResolver({ authEnabled: true, mode: 'token', getToken: async () => 'verified-token' });
    await expect(token(request())).resolves.toBeUndefined();
    await expect(token(request({ authorization: 'Bearer wrong-token' }))).resolves.toBeUndefined();
    await expect(token(request({ authorization: 'Bearer verified-token' }))).resolves.toMatchObject({ authentication: 'verified_access_token' });

    const authorize = createFoundationManagementAuthorizer(token);
    await expect(authorize(request() as any, 'channel_bot.update')).resolves.toMatchObject({ allowed: false, code: 'principal_unresolved' });
    await expect(authorize(request({ authorization: 'Bearer verified-token' }) as any, 'channel_bot.update')).resolves.toMatchObject({ allowed: true, code: 'allowed_admin', source: 'owner' });
  });

  it('isolates legacy execution and blocks every managed staged execution edge', async () => {
    const repos = createRepositories(':memory:'); repositories.push(repos);
    await repos.channelBots.create({
      id: 'bot-wp1b', channel: 'lark', externalAppId: 'cli_wp1b', displayName: 'WP1b Bot', brand: 'feishu', state: 'staged'
    });
    await repos.channelBotPolicies.create({
      id: 'policy-wp1b', channelBotId: 'bot-wp1b', defaults: { agentDefinitionId: 'codex' },
      routingDefaults: { groupReplyMode: 'chat-topic', mentionPolicy: 'topic' },
      accessPolicy: { mode: 'owner_only', principalIds: [] },
      groupToolsPolicy: { readCeiling: true, discoverCeiling: true, sendCeiling: true, readDefault: true, discoverDefault: true, sendDefault: true }
    });
    await repos.groupBindings.create({ id: 'binding-wp1b', channelBotId: 'bot-wp1b', externalChatId: 'oc_wp1b', oncall: true });
    const resolvePrincipal = createInstallationPrincipalResolver({ authEnabled: false, mode: 'open', getToken: async () => null });
    const execution = createFoundationExecutionAuthorizer(repos, resolvePrincipal);

    for (const boundary of ['listener', 'session', 'terminal', 'high_risk', 'group_tools'] as const) {
      await expect(execution.authorize({ integration: 'legacy_lark', boundary, action: boundary === 'terminal' ? 'terminal.read' : boundary === 'group_tools' ? 'group_tools.read' : boundary === 'high_risk' ? 'high_risk.execute' : 'task.create' })).resolves.toMatchObject({
        allowed: true, code: 'legacy_unmanaged', integrationMode: 'legacy_unmanaged', boundary
      });
    }

    await expect(execution.authorize({
      integration: 'managed_group_binding', boundary: 'listener', action: 'listener.enable', groupBindingId: 'binding-wp1b', request: request()
    })).resolves.toMatchObject({
      allowed: false, code: 'channel_bot_activation_blocked', integrationMode: 'managed_group_binding'
    });
    const listener = await execution.authorize({
      integration: 'managed_group_binding', boundary: 'listener', action: 'listener.enable', groupBindingId: 'binding-wp1b', request: request()
    });
    expect(listener.reason).toContain('secret_ref');
    expect(listener.reason).toContain('identity_preflight');
    expect(listener.reason).toContain('listener_lease');

    for (const [boundary, action] of [
      ['session', 'task.create'], ['terminal', 'terminal.read'], ['high_risk', 'high_risk.execute'], ['group_tools', 'group_tools.send']
    ] as const) {
      await expect(execution.authorize({
        integration: 'managed_group_binding', boundary, action, groupBindingId: 'binding-wp1b', request: request(),
        sessionGroupTools: { read: true, discover: true, send: true }
      })).resolves.toMatchObject({ allowed: false, code: 'channel_bot_disabled', integrationMode: 'managed_group_binding', boundary });
    }

    await expect(execution.authorizeSession({ source: foundationGroupBindingSessionSource, sourceId: 'binding-wp1b' }, {
      boundary: 'terminal', action: 'terminal.write', request: request()
    })).resolves.toMatchObject({ allowed: false, code: 'channel_bot_disabled' });
    await expect(execution.authorizeSession({ source: 'lark', sourceId: 'cli_legacy:oc_legacy:group:user:ou_legacy' }, {
      boundary: 'terminal', action: 'terminal.write', request: request()
    })).resolves.toMatchObject({ allowed: true, code: 'legacy_unmanaged' });
  });
});

