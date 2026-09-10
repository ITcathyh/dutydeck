import { describe, expect, it } from 'vitest';
import {
  channelBotFoundationSchema,
  createChannelBotInputSchema,
  getChannelBotFoundationReadiness,
  secretRefMetadataSchema,
  toPublicAgent,
  toPublicChannelBotFoundation,
  type AgentConfig,
  type ChannelBotFoundation
} from './index.js';

const timestamp = '2026-08-30T00:00:00.000Z';

describe('WP0 public and disabled-state contracts', () => {
  it('projects AgentConfig through an exact allowlist and drops secret and PII canaries', () => {
    const agent: AgentConfig = {
      id: 'codex',
      name: 'Codex',
      command: 'private-command-canary',
      args: ['private-arg-canary'],
      protocol: 'acp',
      model: 'model-a',
      reasoningEffort: 'private-reasoning-canary',
      version: '1.0.0',
      cwd: '/private/alice@example.com',
      env: { PRIVATE_TOKEN: 'private-env-canary' },
      systemPrompt: 'contact alice@example.com with private-system-canary',
      permissionMode: 'ask',
      timeout: 600,
      capabilities: { pause: false, resume: true },
      builtin: true
    };

    const publicAgent = toPublicAgent(agent);

    expect(publicAgent).toEqual({ id: 'codex', name: 'Codex', version: '1.0.0', model: 'model-a', protocol: 'acp', permissionMode: 'ask' });
    const serialized = JSON.stringify(publicAgent);
    for (const canary of ['private-command-canary', 'private-arg-canary', 'private-reasoning-canary', '/private/', 'alice@example.com', 'PRIVATE_TOKEN', 'private-env-canary', 'private-system-canary']) {
      expect(serialized).not.toContain(canary);
    }
  });

  it('rejects plaintext-like unknown fields from strict SecretRef metadata', () => {
    const base = {
      schemaVersion: 1,
      id: 'secret-ref-1',
      revision: 1,
      kind: 'lark_app_secret',
      provider: 'keychain',
      referenceKey: 'dutydeck/lark/app-1',
      status: 'configured',
      createdAt: timestamp,
      updatedAt: timestamp
    } as const;
    expect(secretRefMetadataSchema.safeParse(base).success).toBe(true);
    for (const privateField of ['value', 'secret', 'env', 'token', 'appSecret']) {
      expect(secretRefMetadataSchema.safeParse({ ...base, [privateField]: `plaintext-${privateField}` }).success, privateField).toBe(false);
    }
  });

  it('cannot represent activation and hard-blocks a ChannelBot without SecretRef', () => {
    const bot: ChannelBotFoundation = {
      schemaVersion: 1,
      id: 'bot-1',
      revision: 1,
      channel: 'lark',
      externalAppId: 'cli_bot_1',
      displayName: 'Bot 1',
      brand: 'feishu',
      state: 'disabled',
      desiredListenerState: 'disabled',
      fullTrustConfirmed: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const readiness = getChannelBotFoundationReadiness(bot);
    expect(readiness).toMatchObject({ credentialStatus: 'missing', listenerEligible: false });
    expect(readiness.blockers.map(blocker => blocker.code)).toEqual(['channel_bot_credential_required', 'channel_bot_activation_unavailable']);
    expect(channelBotFoundationSchema.safeParse({ ...bot, state: 'active' }).success).toBe(false);
    expect(channelBotFoundationSchema.safeParse({ ...bot, desiredListenerState: 'enabled' }).success).toBe(false);
    expect(channelBotFoundationSchema.safeParse({ ...bot, fullTrustConfirmed: true }).success).toBe(false);
    const validCreateInput = { id: bot.id, channel: bot.channel, externalAppId: bot.externalAppId, displayName: bot.displayName, brand: bot.brand, state: bot.state };
    expect(createChannelBotInputSchema.safeParse(validCreateInput).success).toBe(true);
    expect(createChannelBotInputSchema.safeParse({ ...validCreateInput, appSecret: 'plaintext-canary' }).success).toBe(false);

    const publicBot = toPublicChannelBotFoundation(bot);
    expect(publicBot).not.toHaveProperty('credentialRef');
    expect(publicBot).toMatchObject({ state: 'disabled', desiredListenerState: 'disabled', fullTrustConfirmed: false, credentialStatus: 'missing' });

    const configured = { schemaVersion: 1, id: 'secret-ref-1', revision: 1, kind: 'lark_app_secret', provider: 'local-file-v1', referenceKey: 'opaque.key', status: 'configured', createdAt: timestamp, updatedAt: timestamp } as const;
    const unreadable = toPublicChannelBotFoundation({ ...bot, credentialRef: configured.id }, configured, 'unreadable');
    expect(unreadable).toMatchObject({ selectedSecretRefId: configured.id, credentialStatus: 'unreadable', blockerCodes: ['channel_bot_credential_unreadable', 'channel_bot_activation_unavailable'] });
    expect(unreadable).not.toHaveProperty('credentialRef');
  });
});
