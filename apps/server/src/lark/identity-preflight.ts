import { createHash, createHmac } from 'node:crypto';
import type { ChannelBotFoundation, GroupBinding, SecretRefMetadata } from '@dutydeck/shared';
import {
  LarkIdentityPreflightSecretBoundary,
  LocalFileLarkCredentialResolver,
  LocalFileSecretProvider,
  SecretProviderError,
  localFileSecretProviderName,
  type LarkCredentialBundle,
} from '@dutydeck/secret-provider';
import {
  LarkServiceError,
  createLarkCardService,
  type LarkApplicationIdentityCheck,
  type LarkBotInfo,
  type LarkChatPreflightInfo,
} from './service.js';

const MAX_EVIDENCE_TTL_MS = 4 * 60 * 60 * 1_000;

export const identityPreflightErrorCodes = [
  'IDENTITY_PREFLIGHT_CHANNEL_BOT_INVALID',
  'IDENTITY_PREFLIGHT_GROUP_BINDING_INVALID',
  'IDENTITY_PREFLIGHT_SECRET_REF_MISSING',
  'IDENTITY_PREFLIGHT_SECRET_REF_INVALID',
  'IDENTITY_PREFLIGHT_SECRET_MISSING',
  'IDENTITY_PREFLIGHT_SECRET_UNREADABLE',
  'IDENTITY_PREFLIGHT_APP_MISMATCH',
  'IDENTITY_PREFLIGHT_APP_IDENTITY_INACCESSIBLE',
  'IDENTITY_PREFLIGHT_REMOTE_AUTH_FAILED',
  'IDENTITY_PREFLIGHT_CHAT_INACCESSIBLE',
  'IDENTITY_PREFLIGHT_CHAT_NOT_MEMBER',
  'IDENTITY_PREFLIGHT_CHAT_TYPE_UNSUPPORTED',
] as const;
export type IdentityPreflightErrorCode = (typeof identityPreflightErrorCodes)[number];

const publicMessages: Record<IdentityPreflightErrorCode, string> = {
  IDENTITY_PREFLIGHT_CHANNEL_BOT_INVALID: 'The selected ChannelBot is not eligible for a Lark identity preflight',
  IDENTITY_PREFLIGHT_GROUP_BINDING_INVALID: 'A selected GroupBinding does not belong to the ChannelBot',
  IDENTITY_PREFLIGHT_SECRET_REF_MISSING: 'The ChannelBot does not have a selected SecretRef',
  IDENTITY_PREFLIGHT_SECRET_REF_INVALID: 'The selected SecretRef is not a configured local Lark credential bundle',
  IDENTITY_PREFLIGHT_SECRET_MISSING: 'The selected SecretRef value is missing',
  IDENTITY_PREFLIGHT_SECRET_UNREADABLE: 'The selected SecretRef value is unreadable or invalid',
  IDENTITY_PREFLIGHT_APP_MISMATCH: 'The selected credential does not match the configured ChannelBot App identity',
  IDENTITY_PREFLIGHT_APP_IDENTITY_INACCESSIBLE: 'Lark did not allow a read-only verification of the configured App identity',
  IDENTITY_PREFLIGHT_REMOTE_AUTH_FAILED: 'Lark did not accept the selected credential for read-only bot identity verification',
  IDENTITY_PREFLIGHT_CHAT_INACCESSIBLE: 'The selected bot cannot read the configured chat',
  IDENTITY_PREFLIGHT_CHAT_NOT_MEMBER: 'The selected bot is not a member of the configured chat',
  IDENTITY_PREFLIGHT_CHAT_TYPE_UNSUPPORTED: 'The configured chat type could not be verified as a supported group',
};

export class IdentityPreflightError extends Error {
  readonly safe = true;
  constructor(public readonly code: IdentityPreflightErrorCode, public readonly statusCode = 409) {
    super(publicMessages[code]);
    this.name = 'IdentityPreflightError';
  }
}

export interface LarkIdentityPreflightClient {
  getBotInfo(): Promise<LarkBotInfo>;
  checkApplicationIdentity(expectedAppId: string): Promise<LarkApplicationIdentityCheck>;
  checkBotInChat(chatId: string): Promise<boolean>;
  getChatPreflightInfo(chatId: string): Promise<LarkChatPreflightInfo>;
}

export interface LarkIdentityPreflightClientFactoryInput {
  brand: 'feishu' | 'lark';
  appId: string;
  appSecret: string;
}
export type LarkIdentityPreflightClientFactory = (input: LarkIdentityPreflightClientFactoryInput) => LarkIdentityPreflightClient;

export type ChatPreflightEvidence = {
  groupBindingId: string;
  chatAccessible: boolean;
  membershipState: 'member' | 'not_member' | 'inaccessible';
  chatType: 'group' | 'topic_group' | 'unknown';
  blockerCode?: Extract<IdentityPreflightErrorCode, 'IDENTITY_PREFLIGHT_CHAT_INACCESSIBLE' | 'IDENTITY_PREFLIGHT_CHAT_NOT_MEMBER' | 'IDENTITY_PREFLIGHT_CHAT_TYPE_UNSUPPORTED'>;
};

/** Exact allowlisted probe output. It contains no raw App/chat/open IDs or PII. */
export interface LarkIdentityPreflightEvidence {
  schemaVersion: 1;
  channelBotId: string;
  credentialFingerprint: string;
  appFingerprint: string;
  botIdentityOpaqueRef: string;
  tenantOpaqueRef?: string;
  appMatch: true;
  tenantAppMatch: true;
  checkedAt: string;
  expiresAt: string;
  status: 'passed' | 'blocked';
  chatFacts: ChatPreflightEvidence[];
  blockerCodes: IdentityPreflightErrorCode[];
  activationChanged: false;
  listenerReadiness: 'blocked';
}

function larkOpenApiBaseUrl(brand: 'feishu' | 'lark'): string {
  return brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

function opaqueRef(prefix: string, value: string, credentialFingerprint: string): string {
  return `${prefix}_${createHmac('sha256', credentialFingerprint).update(value).digest('hex').slice(0, 24)}`;
}

function chatType(info: LarkChatPreflightInfo): ChatPreflightEvidence['chatType'] {
  if (info.chatMode === 'topic_group') return 'topic_group';
  if (info.chatMode === 'group') return 'group';
  return 'unknown';
}

function upstreamHttpStatus(error: unknown): number | undefined {
  return error instanceof LarkServiceError && Number.isInteger(error.details?.upstreamHttpStatus)
    ? Number(error.details?.upstreamHttpStatus)
    : undefined;
}

/**
 * The only server-side boundary that resolves a selected SecretRef for WP4.
 * It does not expose a generic read and the owned credential object is wiped by
 * LocalFileLarkCredentialResolver immediately after the callback settles.
 */
export class LocalLarkIdentityPreflightSecretResolver {
  private readonly resolver: LocalFileLarkCredentialResolver;

  constructor(private readonly provider: LocalFileSecretProvider) {
    this.resolver = new LocalFileLarkCredentialResolver(provider, LarkIdentityPreflightSecretBoundary.create());
  }

  async withSelectedCredentials<T>(
    channelBot: Pick<ChannelBotFoundation, 'credentialRef' | 'externalAppId'>,
    secretRef: SecretRefMetadata | undefined,
    use: (credentials: Readonly<LarkCredentialBundle>, credentialFingerprint: string) => Promise<T>,
  ): Promise<T> {
    if (!channelBot.credentialRef) throw new IdentityPreflightError('IDENTITY_PREFLIGHT_SECRET_REF_MISSING');
    if (!secretRef || secretRef.id !== channelBot.credentialRef || secretRef.status !== 'configured'
      || secretRef.kind !== 'lark_app_secret' || secretRef.provider !== localFileSecretProviderName) {
      throw new IdentityPreflightError('IDENTITY_PREFLIGHT_SECRET_REF_INVALID');
    }
    const availability = this.provider.inspect(secretRef.referenceKey).availability;
    if (availability === 'missing') throw new IdentityPreflightError('IDENTITY_PREFLIGHT_SECRET_MISSING');
    if (availability !== 'available') throw new IdentityPreflightError('IDENTITY_PREFLIGHT_SECRET_UNREADABLE');
    try {
      return await this.resolver.withCredentials(secretRef.referenceKey, async (credentials, metadata) => {
        if (credentials.app_id !== channelBot.externalAppId) throw new IdentityPreflightError('IDENTITY_PREFLIGHT_APP_MISMATCH');
        return use(credentials, metadata.fingerprint);
      });
    } catch (error) {
      if (error instanceof IdentityPreflightError) throw error;
      if (error instanceof SecretProviderError) {
        if (error.code === 'SECRET_DIRECTORY_MISSING' || error.code === 'ENOENT') throw new IdentityPreflightError('IDENTITY_PREFLIGHT_SECRET_MISSING');
        throw new IdentityPreflightError('IDENTITY_PREFLIGHT_SECRET_UNREADABLE');
      }
      throw error;
    }
  }
}

export interface LarkIdentityPreflightProbeOptions {
  secretProvider: LocalFileSecretProvider;
  fetcher?: typeof globalThis.fetch;
  baseUrlForBrand?: (brand: 'feishu' | 'lark') => string;
  clientFactory?: LarkIdentityPreflightClientFactory;
  now?: () => Date;
  evidenceTtlMs?: number;
}

export class LarkIdentityPreflightProbe {
  private readonly resolveSecret: LocalLarkIdentityPreflightSecretResolver;
  private readonly clientFactory: LarkIdentityPreflightClientFactory;
  private readonly now: () => Date;
  private readonly evidenceTtlMs: number;

  constructor(options: LarkIdentityPreflightProbeOptions) {
    this.resolveSecret = new LocalLarkIdentityPreflightSecretResolver(options.secretProvider);
    const baseUrlForBrand = options.baseUrlForBrand ?? larkOpenApiBaseUrl;
    this.clientFactory = options.clientFactory ?? (input => createLarkCardService({}, options.fetcher ?? globalThis.fetch, {
      appId: input.appId,
      appSecret: input.appSecret,
      baseUrl: baseUrlForBrand(input.brand),
    }));
    this.now = options.now ?? (() => new Date());
    this.evidenceTtlMs = options.evidenceTtlMs ?? MAX_EVIDENCE_TTL_MS;
    if (!Number.isFinite(this.evidenceTtlMs) || this.evidenceTtlMs <= 0 || this.evidenceTtlMs > MAX_EVIDENCE_TTL_MS) {
      throw new Error('identity preflight evidence TTL must be within four hours');
    }
  }

  async probe(input: {
    channelBot: ChannelBotFoundation;
    secretRef?: SecretRefMetadata;
    groupBindings: GroupBinding[];
  }): Promise<LarkIdentityPreflightEvidence> {
    const { channelBot, secretRef, groupBindings } = input;
    if (channelBot.channel !== 'lark' || (channelBot.state !== 'staged' && channelBot.state !== 'disabled')) {
      throw new IdentityPreflightError('IDENTITY_PREFLIGHT_CHANNEL_BOT_INVALID');
    }
    if (groupBindings.some(binding => binding.channelBotId !== channelBot.id || (binding.state !== 'staged' && binding.state !== 'disabled'))) {
      throw new IdentityPreflightError('IDENTITY_PREFLIGHT_GROUP_BINDING_INVALID');
    }

    return this.resolveSecret.withSelectedCredentials(channelBot, secretRef, async (credentials, credentialFingerprint) => {
      const client = this.clientFactory({ brand: channelBot.brand, appId: credentials.app_id, appSecret: credentials.app_secret });
      let botInfo: LarkBotInfo;
      try { botInfo = await client.getBotInfo(); }
      catch { throw new IdentityPreflightError('IDENTITY_PREFLIGHT_REMOTE_AUTH_FAILED', 502); }

      let application: LarkApplicationIdentityCheck;
      try { application = await client.checkApplicationIdentity(channelBot.externalAppId); }
      catch { throw new IdentityPreflightError('IDENTITY_PREFLIGHT_APP_IDENTITY_INACCESSIBLE', 502); }
      if (application.reportedAppId && application.reportedAppId !== channelBot.externalAppId) {
        throw new IdentityPreflightError('IDENTITY_PREFLIGHT_APP_MISMATCH');
      }

      const facts: ChatPreflightEvidence[] = [];
      for (const binding of groupBindings) {
        let member: boolean;
        try { member = await client.checkBotInChat(binding.externalChatId); }
        catch (error) {
          facts.push({
            groupBindingId: binding.id,
            chatAccessible: false,
            membershipState: 'inaccessible',
            chatType: 'unknown',
            blockerCode: 'IDENTITY_PREFLIGHT_CHAT_INACCESSIBLE',
          });
          // HTTP 403 and other inconclusive read failures are both blockers;
          // inspect the status only to ensure it is never echoed to the DTO.
          void upstreamHttpStatus(error);
          continue;
        }
        if (!member) {
          facts.push({
            groupBindingId: binding.id,
            chatAccessible: false,
            membershipState: 'not_member',
            chatType: 'unknown',
            blockerCode: 'IDENTITY_PREFLIGHT_CHAT_NOT_MEMBER',
          });
          continue;
        }
        try {
          const info = await client.getChatPreflightInfo(binding.externalChatId);
          const resolvedChatType = chatType(info);
          facts.push({
            groupBindingId: binding.id,
            chatAccessible: true,
            membershipState: 'member',
            chatType: resolvedChatType,
            ...(resolvedChatType === 'unknown' ? { blockerCode: 'IDENTITY_PREFLIGHT_CHAT_TYPE_UNSUPPORTED' as const } : {}),
          });
        } catch {
          facts.push({
            groupBindingId: binding.id,
            chatAccessible: false,
            membershipState: 'inaccessible',
            chatType: 'unknown',
            blockerCode: 'IDENTITY_PREFLIGHT_CHAT_INACCESSIBLE',
          });
        }
      }

      const checkedAt = this.now();
      const blockerCodes = [...new Set(facts.flatMap(fact => fact.blockerCode ? [fact.blockerCode] : []))];
      return {
        schemaVersion: 1,
        channelBotId: channelBot.id,
        credentialFingerprint,
        appFingerprint: createHash('sha256').update(channelBot.externalAppId).digest('hex'),
        botIdentityOpaqueRef: opaqueRef('remote_bot', botInfo.openId, credentialFingerprint),
        ...(application.tenantKey ? { tenantOpaqueRef: opaqueRef('remote_tenant', application.tenantKey, credentialFingerprint) } : {}),
        appMatch: true,
        tenantAppMatch: true,
        checkedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + this.evidenceTtlMs).toISOString(),
        status: blockerCodes.length ? 'blocked' : 'passed',
        chatFacts: facts,
        blockerCodes,
        activationChanged: false,
        listenerReadiness: 'blocked',
      };
    });
  }
}
