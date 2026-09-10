import { homedir } from 'node:os';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { writePrivateArchive, type ArchiveSourceFile } from './archive.js';
import { hmacSha256, opaqueRef, stableFingerprint, stableJson } from './fingerprint.js';
import {
  canonicalDirectory,
  pathExists,
  safeDirectoryEntries,
  stableReadFile,
  type StableFileSnapshot
} from './safe-reader.js';
import type {
  ArtifactDisposition,
  BotmuxChannelBotPlan,
  BotmuxDiscoveryManifest,
  BotmuxImportArtifact,
  BotmuxImportBlocker,
  BotmuxImportSummary,
  BotmuxPrivateArchiveManifest,
  BotmuxPrivateMigrationPlan,
  BotmuxRedactedManifest,
  BotmuxRetiredBotPlan,
  BotmuxSchedulePlan,
  BotmuxSecretRequirement,
  DiscoverBotmuxOptions,
  PrivateArchiveOptions
} from './types.js';
import { BotmuxImportError } from './types.js';

const PARSER_VERSION = 'botmux-read-only-v1';
const VALID_APP_ID = /^[A-Za-z0-9_-]{1,128}$/;

const HANDLED_BOT_FIELDS = new Set([
  'larkAppId',
  'larkAppSecret',
  'cliId',
  'defaultWorkingDir',
  'allowedUsers',
  'oncallChats',
  'p2pMode',
  'regularGroupReplyMode',
  'regularGroupMentionMode',
  'hammer',
  'backendType',
  'model',
  'reasoningEffort'
]);

const KNOWN_UNSUPPORTED_BOT_FIELDS = new Set([
  'allowedChatGroups',
  'chatReplyModes',
  'chatGrants',
  'globalGrants',
  'env',
  'startupCommands',
  'sandbox',
  'sandboxReadonlyPaths',
  'sandboxHidePaths',
  'sandboxNetwork',
  'disableCliBypass',
  'cliRuntime',
  'cliPathOverride',
  'wrapperCli',
  'plugins',
  'systemPrompt',
  'roleProfile',
  'messageListeners',
  'substituteMode',
  'sessionGroup',
  'noCardChats',
  'messageQuota',
  'canTalkDaemonCommands',
  'p2pOpen',
  'allowedBots',
  'peerBotsAllowed'
]);

const HANDLED_ONCALL_FIELDS = new Set(['chatId', 'workingDir']);
const HANDLED_HAMMER_FIELDS = new Set(['enabled', 'mode', 'enforceGates', 'skillsInjection']);
const HANDLED_SCHEDULE_FIELDS = new Set([
  'chatId',
  'chatType',
  'createdAt',
  'creatorChatId',
  'creatorLarkAppId',
  'creatorRootMessageId',
  'deliver',
  'enabled',
  'executionPosition',
  'id',
  'larkAppId',
  'lastRunAt',
  'lastStatus',
  'lastError',
  'lastDeliveryError',
  'name',
  'nextRunAt',
  'parsed',
  'prompt',
  'repeat',
  'rootMessageId',
  'schedule',
  'scope',
  'silent',
  'topicTitle',
  'workingDir'
]);

const KNOWN_ENV_KEYS = new Set([
  'BOT_GATEWAY_CHAT_IDS',
  'BOT_GATEWAY_LARK_APP_IDS',
  'BOT_GATEWAY_SOCKET',
  'BOT_GATEWAY_TRANSPORT_TOKEN_FILE'
]);

const KNOWN_HOME_ENTRIES = new Set([
  '.data-dir', '.env', 'bots.json', 'bots.json.bak', 'config.json', 'bots', 'data', 'usage', 'v3-runs',
  'workflow-distillations', 'plugins', 'skills', 'claude-plugin', 'bin', 'logs', 'pm2', 'heapshots', 'fonts',
  'dsh', 'ecosystem.config.json', 'feishu-session.json', '.dashboard-port', '.dashboard-secret',
  '.dashboard-secret.report-binding', '.dashboard-token'
]);

const KNOWN_DATA_ENTRY = new RegExp([
  '^(?:',
  'sessions-[A-Za-z0-9_-]+\\.json|',
  'teams\\.json|',
  'schedules\\.json\\.bak-split-v1|',
  '(?:botmux|feisuo)-feedback\\.sqlite(?:-wal|-shm)?|',
  'bots-info\\.json|bot-union-ids\\.json|',
  'bot-openids-[A-Za-z0-9_-]+\\.json|allowed-users-cache-[A-Za-z0-9_-]+\\.json|',
  'identities-[A-Za-z0-9_-]+\\.json|chat-first-seen-[A-Za-z0-9_-]+\\.json|',
  'daemon-\\d+\\.pid|deployment-identity\\.json|last-cli-id|',
  'attachments|roles|team-roles|role-profiles|connectors|',
  'dedup|queues|turn-sends|turn-marks|frozen-cards|heartbeats|dashboard-daemons|oauth-pending|mcp-gateway|',
  'runtime-skills|skill-manifests|session-enrichment|sessions|codex-notifier|codex-rpc-app-servers|',
  'vc-meeting-daemon-auth|\\.botmux-cli-pids|\\.feisuo-cli-pids',
  ')$'
].join(''));

type JsonObject = Record<string, unknown>;

interface InternalArtifact extends BotmuxImportArtifact {
  absolute_path?: string;
  snapshot?: StableFileSnapshot;
  archive_eligible: boolean;
  excluded_secret: boolean;
}

interface InternalState {
  key: Uint8Array;
  plan: BotmuxPrivateMigrationPlan;
  artifacts: InternalArtifact[];
  archive_files: ArchiveSourceFile[];
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function parseJson(bytes: Uint8Array, artifactRef: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new BotmuxImportError('SOURCE_JSON_INVALID', 'Botmux source JSON is invalid', artifactRef);
  }
}

function ownerKind(value: string): 'email' | 'mobile' | 'open_id' | 'union_id' | 'unknown' {
  if (value.startsWith('ou_')) return 'open_id';
  if (value.startsWith('on_')) return 'union_id';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'email';
  if (/^(?:\+\d{6,15}|1\d{10})$/.test(value.replace(/[\s-]/g, ''))) return 'mobile';
  return 'unknown';
}

function cwdKind(value: unknown): BotmuxChannelBotPlan['default_cwd_kind'] {
  if (typeof value !== 'string' || !value.trim()) return 'unset';
  if (value === '~' || value.startsWith('~/')) return 'home_relative';
  return isAbsolute(value) ? 'absolute' : 'relative';
}

function artifactCounts(artifacts: readonly BotmuxImportArtifact[]): Record<ArtifactDisposition, number> {
  const counts: Record<ArtifactDisposition, number> = {
    mapped: 0,
    archive_only: 0,
    archive_deferred: 0,
    rebuild: 0,
    runtime_only: 0,
    excluded_with_reason: 0,
    blocked_unknown: 0
  };
  for (const artifact of artifacts) counts[artifact.disposition] += 1;
  return counts;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function addBlocker(
  blockers: BotmuxImportBlocker[],
  code: string,
  scope: BotmuxImportBlocker['scope'],
  nextStep: string,
  scopeRef?: string
): void {
  if (blockers.some(item => item.code === code && item.scope === scope && item.scope_ref === scopeRef)) return;
  blockers.push({ code, scope, ...(scopeRef ? { scope_ref: scopeRef } : {}), next_step: nextStep });
}

function envKeys(bytes: Uint8Array): string[] {
  const output: string[] = [];
  for (const line of Buffer.from(bytes).toString('utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (match?.[1]) output.push(match[1]);
  }
  return uniqueSorted(output);
}

async function pathMetadata(path: string, artifactRef: string): Promise<{ size: number; mode: number; kind: 'file' | 'directory' | 'other' }> {
  try {
    const info = await lstat(path);
    return {
      size: info.isFile() ? info.size : 0,
      mode: info.mode & 0o777,
      kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
    };
  } catch {
    throw new BotmuxImportError('SOURCE_ARTIFACT_UNREADABLE', 'Botmux source artifact metadata is unavailable', artifactRef);
  }
}

async function recursiveFiles(root: string, key: Uint8Array, kind: string): Promise<Array<{ path: string; ref: string }>> {
  const output: Array<{ path: string; ref: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    const directoryRef = opaqueRef('artifact', key, directory);
    for (const entry of await safeDirectoryEntries(directory, directoryRef)) {
      const child = join(directory, entry.name);
      if (entry.kind === 'file') output.push({ path: child, ref: opaqueRef(kind, key, child) });
      else if (entry.kind === 'directory') await visit(child);
      else throw new BotmuxImportError('SOURCE_ARTIFACT_INVALID', 'Botmux archive source contains an unsupported file type', opaqueRef('artifact', key, child));
    }
  };
  await visit(root);
  return output;
}

export class BotmuxPlanHandle {
  readonly private_plan: BotmuxPrivateMigrationPlan;
  #state: InternalState;

  constructor(state: InternalState) {
    this.#state = state;
    this.private_plan = state.plan;
  }

  createRedactedManifest(): BotmuxRedactedManifest {
    const plan = this.private_plan;
    const secretRequirementCounts: BotmuxRedactedManifest['secret_requirement_counts'] = {
      lark_app_secret: 0,
      agent_env: 0,
      connector_credential: 0,
      unknown_secret: 0
    };
    for (const requirement of plan.secret_requirements) secretRequirementCounts[requirement.kind] += 1;
    return {
      schema_version: 1,
      parser_version: plan.parser_version,
      plan_id: plan.plan_id,
      generated_at: plan.generated_at,
      allowed_mode: 'read_only_plan',
      production_cutover: 'NO_GO',
      source: {
        source_instance_ref: plan.source.source_instance_ref,
        apply_fingerprint: plan.source.apply_fingerprint,
        archive_candidate_fingerprint: plan.source.archive_candidate_fingerprint,
        archive_snapshot_id: null,
        cutover_watermark: null
      },
      summary: plan.summary,
      channel_bots: plan.channel_bots.map(bot => ({
        app_ref: bot.app_ref,
        cli_id: bot.cli_id,
        effective_backend: bot.effective_backend,
        oncall_bindings: bot.oncall_bindings.length,
        owner_locators: bot.owner_locators.length,
        hammer_archived: bot.hammer_archived,
        archived_integrations: bot.archived_integrations,
        target_state: 'staged_only',
        eligibility: false,
        blocker_codes: bot.blocker_codes
      })),
      retired_bots: plan.retired_bots,
      schedules: plan.schedules.map(schedule => ({
        schedule_ref: schedule.schedule_ref,
        ...(schedule.app_ref ? { app_ref: schedule.app_ref } : {}),
        source_enabled: schedule.source_enabled,
        parsed_kind: schedule.parsed_kind,
        ownership: 'botmux_owned',
        target_state: 'staged_disabled',
        target_enabled: false,
        intent_kind: 'task_run_snapshot',
        blocker_codes: schedule.blocker_codes
      })),
      artifact_counts: artifactCounts(plan.artifacts),
      secret_requirement_counts: secretRequirementCounts,
      blockers: plan.blockers,
      forbidden_capabilities: plan.forbidden_capabilities,
      eligibility: plan.eligibility
    };
  }

  async writeRedactedManifest(path: string): Promise<void> {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${stableJson(this.createRedactedManifest())}\n`, 'utf8');
        await handle.sync();
        if (process.platform !== 'win32') await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    } catch {
      throw new BotmuxImportError('REDACTED_MANIFEST_WRITE_FAILED', 'Redacted manifest could not be written to a new private file');
    }
  }

  async createPrivateArchive(options: PrivateArchiveOptions): Promise<BotmuxPrivateArchiveManifest> {
    return writePrivateArchive(
      this.private_plan,
      this.#state.archive_files,
      this.#state.artifacts.filter(item => item.excluded_secret).length,
      options
    );
  }
}

export class BotmuxDiscovery {
  readonly manifest: BotmuxDiscoveryManifest;
  #state: InternalState;

  constructor(state: InternalState) {
    this.#state = state;
    this.manifest = {
      schema_version: 1,
      source_instance_ref: state.plan.source.source_instance_ref,
      config_path_ref: state.plan.source.config_path_ref,
      data_path_ref: state.plan.source.data_path_ref,
      artifact_counts: artifactCounts(state.plan.artifacts),
      unknown_artifacts: state.plan.summary.unknown_artifacts,
      blocker_codes: uniqueSorted(state.plan.blockers.map(item => item.code))
    };
  }

  createPlan(): BotmuxPlanHandle {
    return new BotmuxPlanHandle(this.#state);
  }
}

export async function discoverBotmuxSource(options: DiscoverBotmuxOptions): Promise<BotmuxDiscovery> {
  if (options.fingerprint_key.byteLength < 32) {
    throw new BotmuxImportError('FINGERPRINT_KEY_INVALID', 'Fingerprint key must contain at least 32 bytes');
  }
  const key = new Uint8Array(options.fingerprint_key);
  const env = options.env ?? {};
  const sourceHomeInput = options.source_home ?? join(homedir(), '.botmux');
  const sourceHomeRef = opaqueRef('path', key, resolve(sourceHomeInput));
  const sourceHome = await canonicalDirectory(resolve(sourceHomeInput), sourceHomeRef);

  const configPathInput = options.bots_config ?? env.BOTS_CONFIG ?? join(sourceHome, 'bots.json');
  const configPath = resolve(configPathInput);
  const configPathRef = opaqueRef('path', key, configPath);

  let dataPathInput = options.data_dir ?? env.SESSION_DATA_DIR;
  const breadcrumbPath = join(sourceHome, '.data-dir');
  if (!dataPathInput && await pathExists(breadcrumbPath)) {
    const breadcrumbRef = opaqueRef('artifact', key, breadcrumbPath);
    const breadcrumb = await stableReadFile(breadcrumbPath, breadcrumbRef, { secret: true });
    const value = Buffer.from(breadcrumb.bytes).toString('utf8').trim();
    if (!value) throw new BotmuxImportError('DATA_BREADCRUMB_INVALID', 'Botmux data breadcrumb is empty', breadcrumbRef);
    dataPathInput = isAbsolute(value) ? value : resolve(sourceHome, value);
  }
  dataPathInput ??= join(sourceHome, 'data');
  const dataPathRef = opaqueRef('path', key, resolve(dataPathInput));
  const dataPath = await canonicalDirectory(resolve(dataPathInput), dataPathRef);
  const botmuxHome = dirname(dataPath);

  const sourceInstanceRef = opaqueRef('source', key, `${configPath}\0${dataPath}`);
  const artifacts: InternalArtifact[] = [];
  const archiveFiles: ArchiveSourceFile[] = [];
  const blockers: BotmuxImportBlocker[] = [];
  const integrityParts: Array<{ artifact_ref: string; digest: string }> = [];
  const archiveParts: Array<{ artifact_ref: string; digest: string }> = [];
  let unknownConfigFields = 0;

  const readArtifact = async (
    path: string,
    descriptor: Omit<InternalArtifact, 'artifact_ref' | 'absolute_path' | 'snapshot' | 'size_bytes' | 'source_mode'>,
    options: { secret?: boolean } = {}
  ): Promise<InternalArtifact> => {
    const artifactRef = opaqueRef('artifact', key, path);
    const snapshot = await stableReadFile(path, artifactRef, options);
    const artifact: InternalArtifact = {
      artifact_ref: artifactRef,
      absolute_path: path,
      snapshot,
      size_bytes: snapshot.size,
      source_mode: snapshot.mode,
      ...descriptor
    };
    artifacts.push(artifact);
    if (descriptor.authority === 'authoritative') {
      integrityParts.push({ artifact_ref: artifactRef, digest: hmacSha256(key, snapshot.bytes) });
    }
    if (descriptor.archive_eligible) {
      archiveFiles.push({ artifact_ref: artifactRef, kind: descriptor.kind, bytes: snapshot.bytes });
      archiveParts.push({ artifact_ref: artifactRef, digest: hmacSha256(key, snapshot.bytes) });
    }
    return artifact;
  };

  const recordOpaqueArtifact = async (
    path: string,
    descriptor: Omit<InternalArtifact, 'artifact_ref' | 'absolute_path' | 'snapshot' | 'size_bytes' | 'source_mode'>
  ): Promise<void> => {
    const artifactRef = opaqueRef('artifact', key, path);
    const metadata = await pathMetadata(path, artifactRef);
    artifacts.push({
      artifact_ref: artifactRef,
      absolute_path: path,
      size_bytes: metadata.size,
      source_mode: metadata.mode,
      ...descriptor
    });
  };

  const registryArtifact = await readArtifact(configPath, {
    kind: 'bot_registry',
    authority: 'authoritative',
    sensitivity: 'secret',
    disposition: 'mapped',
    blocker_codes: [],
    archive_eligible: false,
    excluded_secret: true
  }, { secret: true });
  const registry = parseJson(registryArtifact.snapshot!.bytes, registryArtifact.artifact_ref);
  if (!Array.isArray(registry)) throw new BotmuxImportError('BOT_REGISTRY_INVALID', 'Botmux bot registry must be an array', registryArtifact.artifact_ref);

  let backupBots: JsonObject[] = [];
  const backupPath = join(sourceHome, 'bots.json.bak');
  if (await pathExists(backupPath)) {
    const artifact = await readArtifact(backupPath, {
      kind: 'bot_registry_backup',
      authority: 'historical',
      sensitivity: 'secret',
      disposition: 'archive_only',
      blocker_codes: [],
      archive_eligible: true,
      excluded_secret: false
    }, { secret: true });
    const value = parseJson(artifact.snapshot!.bytes, artifact.artifact_ref);
    backupBots = Array.isArray(value) ? value.map(asObject).filter((item): item is JsonObject => Boolean(item)) : [];
  }

  const channelBots: BotmuxChannelBotPlan[] = [];
  const secretRequirements: BotmuxSecretRequirement[] = [];
  const appRefByRaw = new Map<string, string>();
  const botCanonical: unknown[] = [];
  const distinctOwnerRefs = new Set<string>();

  for (const [index, rawValue] of registry.entries()) {
    const raw = asObject(rawValue);
    if (!raw) {
      unknownConfigFields += 1;
      addBlocker(blockers, 'unknown_config_field', 'global', 'Remove or explicitly classify every unknown Botmux bot field before any future staging.');
      continue;
    }
    const rawAppId = typeof raw.larkAppId === 'string' ? raw.larkAppId.trim() : '';
    const appIdentity = rawAppId || `invalid-index-${index}`;
    const appRef = opaqueRef('app', key, appIdentity);
    if (!rawAppId || !VALID_APP_ID.test(rawAppId)) {
      addBlocker(blockers, 'invalid_app_identity', 'app', 'Repair the Botmux App identity before migration planning.', appRef);
    } else {
      appRefByRaw.set(rawAppId, appRef);
    }

    const appBlockers = new Set<string>(['read_only_importer_no_activation']);
    addBlocker(blockers, 'read_only_importer_no_activation', 'app', 'WP3 can only produce a read-only plan and private archive.', appRef);
    const unsupportedFields: string[] = [];
    const unknownFieldRefs: string[] = [];
    for (const field of Object.keys(raw)) {
      if (HANDLED_BOT_FIELDS.has(field)) continue;
      if (KNOWN_UNSUPPORTED_BOT_FIELDS.has(field)) {
        unsupportedFields.push(field);
        appBlockers.add('known_config_field_unsupported');
        addBlocker(blockers, 'known_config_field_unsupported', 'app', 'Implement and behavior-test this known Botmux capability before future staging.', appRef);
      } else {
        unknownConfigFields += 1;
        unknownFieldRefs.push(opaqueRef('field', key, field));
        appBlockers.add('unknown_config_field');
        addBlocker(blockers, 'unknown_config_field', 'app', 'Remove or explicitly classify every unknown Botmux bot field before any future staging.', appRef);
      }
    }

    const cliId = typeof raw.cliId === 'string' && raw.cliId.trim() ? raw.cliId.trim() : 'unknown';
    if (cliId === 'unknown') appBlockers.add('missing_cli_id');
    const defaultCwd = typeof raw.defaultWorkingDir === 'string' ? raw.defaultWorkingDir.trim() : undefined;
    const defaultCwdRef = defaultCwd ? opaqueRef('cwd', key, defaultCwd) : undefined;
    const owners = Array.isArray(raw.allowedUsers)
      ? raw.allowedUsers.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : [];
    const ownerLocators = owners.map(owner => {
      const principalRef = opaqueRef('principal', key, `${rawAppId}\0${owner.trim()}`);
      distinctOwnerRefs.add(opaqueRef('owner_locator', key, owner.trim()));
      return {
        principal_ref: principalRef,
        kind: ownerKind(owner.trim()),
        app_ref: appRef,
        validation_state: 'not_checked' as const
      };
    }).sort((left, right) => left.principal_ref.localeCompare(right.principal_ref));

    const oncallBindings = (Array.isArray(raw.oncallChats) ? raw.oncallChats : [])
      .map(asObject)
      .filter((item): item is JsonObject => Boolean(item))
      .map((oncall, oncallIndex) => {
        for (const field of Object.keys(oncall)) {
          if (!HANDLED_ONCALL_FIELDS.has(field)) {
            unknownConfigFields += 1;
            appBlockers.add('unknown_config_field');
            addBlocker(blockers, 'unknown_config_field', 'app', 'Classify the unknown oncall field before future staging.', appRef);
          }
        }
        const chatId = typeof oncall.chatId === 'string' ? oncall.chatId : `invalid-chat-${oncallIndex}`;
        const workingDir = typeof oncall.workingDir === 'string' ? oncall.workingDir : undefined;
        return {
          binding_ref: opaqueRef('binding', key, `${rawAppId}\0${chatId}`),
          chat_ref: opaqueRef('chat', key, `${rawAppId}\0${chatId}`),
          ...(workingDir ? { cwd_ref: opaqueRef('cwd', key, workingDir) } : {}),
          app_ref: appRef,
          source_talk_policy: 'whole_group' as const,
          target_state: 'staged_only' as const
        };
      }).sort((left, right) => left.binding_ref.localeCompare(right.binding_ref));

    if (oncallBindings.length > 0) {
      appBlockers.add('oncall_group_policy_unsupported');
      addBlocker(blockers, 'oncall_group_policy_unsupported', 'app', 'Implement App+Chat policy and request/operate separation before future staging.', appRef);
    }

    const hammer = asObject(raw.hammer);
    let hammerArchived = false;
    const archivedIntegrations: BotmuxChannelBotPlan['archived_integrations'] = [];
    if (hammer) {
      for (const field of Object.keys(hammer)) {
        if (!HANDLED_HAMMER_FIELDS.has(field)) {
          unknownConfigFields += 1;
          appBlockers.add('unknown_config_field');
          addBlocker(blockers, 'unknown_config_field', 'app', 'Classify the unknown Hammer field before future staging.', appRef);
        }
      }
      hammerArchived = true;
      archivedIntegrations.push({
        schema_version: 1,
        kind: 'hammer',
        source_system: 'botmux',
        source_enabled: hammer.enabled === true,
        mode: hammer.mode === 'full' || hammer.mode === 'lite' ? hammer.mode : 'unknown',
        enforce_gates: hammer.enforceGates === true,
        skills_injection: hammer.skillsInjection === 'prompt' || hammer.skillsInjection === 'runtime' || hammer.skillsInjection === 'none'
          ? hammer.skillsInjection
          : 'unknown',
        state: 'archived',
        executor_state: 'unavailable',
        blocker_code: 'hammer_executor_unavailable'
      });
      appBlockers.add('hammer_executor_unavailable');
      addBlocker(blockers, 'hammer_executor_unavailable', 'app', 'Preserve typed Hammer metadata as archived; no executor is available.', appRef);
    }

    const p2pMode = raw.p2pMode === 'thread' ? 'thread' : 'chat';
    const groupReplyMode = raw.regularGroupReplyMode === 'chat'
      || raw.regularGroupReplyMode === 'shared'
      || raw.regularGroupReplyMode === 'new-topic'
      || raw.regularGroupReplyMode === 'chat-topic'
      ? raw.regularGroupReplyMode
      : 'chat-topic';
    const mentionMode = raw.regularGroupMentionMode === 'topic'
      || raw.regularGroupMentionMode === 'never'
      || raw.regularGroupMentionMode === 'ambient'
      ? raw.regularGroupMentionMode
      : 'always';
    if (mentionMode !== 'always') {
      appBlockers.add('mention_policy_unsupported');
      addBlocker(blockers, 'mention_policy_unsupported', 'app', 'Implement and behavior-test the source mention policy before future staging.', appRef);
    }
    const backend = typeof raw.backendType === 'string' && raw.backendType.trim() ? raw.backendType.trim() : 'tmux';
    if (backend !== 'pty') {
      appBlockers.add('persistent_backend_readiness_required');
      addBlocker(blockers, 'persistent_backend_readiness_required', 'app', 'Prove backend ownership and daemon restart reattach before future staging.', appRef);
    }

    const secretPresent = typeof raw.larkAppSecret === 'string' && raw.larkAppSecret.length > 0;
    secretRequirements.push({
      secret_ref: opaqueRef('secret', key, `${rawAppId}\0lark_app_secret`),
      app_ref: appRef,
      kind: 'lark_app_secret',
      source_present: secretPresent,
      persisted_value: false
    });

    const channelBot: BotmuxChannelBotPlan = {
      app_ref: appRef,
      source_state: 'current',
      cli_id: cliId,
      effective_backend: backend,
      effective_p2p_mode: p2pMode,
      effective_group_reply_mode: groupReplyMode,
      effective_mention_mode: mentionMode,
      ...(defaultCwdRef ? { default_cwd_ref: defaultCwdRef } : {}),
      default_cwd_kind: cwdKind(defaultCwd),
      owner_locators: ownerLocators,
      oncall_bindings: oncallBindings,
      hammer_archived: hammerArchived,
      archived_integrations: archivedIntegrations,
      target_state: 'staged_only',
      eligibility: false,
      blocker_codes: uniqueSorted(appBlockers)
    };
    channelBots.push(channelBot);
    botCanonical.push({
      app_ref: appRef,
      cli_id: cliId,
      backend,
      p2p_mode: p2pMode,
      group_reply_mode: groupReplyMode,
      mention_mode: mentionMode,
      cwd_ref: defaultCwdRef,
      owner_refs: ownerLocators.map(item => item.principal_ref),
      oncall_refs: oncallBindings.map(item => item.binding_ref),
      archived_integrations: archivedIntegrations,
      model_ref: typeof raw.model === 'string' ? opaqueRef('model', key, raw.model) : undefined,
      reasoning_ref: typeof raw.reasoningEffort === 'string' ? opaqueRef('reasoning', key, raw.reasoningEffort) : undefined,
      secret_present: secretPresent,
      unsupported_fields: unsupportedFields.sort(),
      unknown_field_refs: unknownFieldRefs.sort()
    });
  }

  channelBots.sort((left, right) => left.app_ref.localeCompare(right.app_ref));

  const currentRawAppIds = new Set(appRefByRaw.keys());
  const retiredBots: BotmuxRetiredBotPlan[] = [];
  for (const raw of backupBots) {
    const rawAppId = typeof raw.larkAppId === 'string' ? raw.larkAppId.trim() : '';
    if (!rawAppId || currentRawAppIds.has(rawAppId)) continue;
    retiredBots.push({
      app_ref: opaqueRef('app', key, rawAppId),
      source_state: 'retired_or_unknown',
      disposition: 'archive_only'
    });
  }
  retiredBots.sort((left, right) => left.app_ref.localeCompare(right.app_ref));

  const envPath = join(sourceHome, '.env');
  if (await pathExists(envPath)) {
    const artifact = await readArtifact(envPath, {
      kind: 'legacy_environment',
      authority: 'authoritative',
      sensitivity: 'secret',
      disposition: 'excluded_with_reason',
      blocker_codes: ['legacy_gateway_requires_review'],
      archive_eligible: false,
      excluded_secret: true
    }, { secret: true });
    const keys = envKeys(artifact.snapshot!.bytes);
    if (keys.some(item => KNOWN_ENV_KEYS.has(item))) {
      addBlocker(blockers, 'legacy_gateway_requires_review', 'artifact', 'Locate and review the external gateway consumer; keep all target group tools disabled.', artifact.artifact_ref);
      for (const bot of channelBots) bot.blocker_codes = uniqueSorted([...bot.blocker_codes, 'legacy_gateway_requires_review']);
    }
    if (keys.some(item => !KNOWN_ENV_KEYS.has(item))) {
      unknownConfigFields += keys.filter(item => !KNOWN_ENV_KEYS.has(item)).length;
      addBlocker(blockers, 'unknown_config_field', 'artifact', 'Classify every unknown environment key without exposing its value.', artifact.artifact_ref);
    }
  }

  const globalConfigPath = join(sourceHome, 'config.json');
  if (await pathExists(globalConfigPath)) {
    const artifact = await readArtifact(globalConfigPath, {
      kind: 'global_config',
      authority: 'authoritative',
      sensitivity: 'secret',
      disposition: 'blocked_unknown',
      blocker_codes: ['global_config_requires_review'],
      archive_eligible: false,
      excluded_secret: true
    }, { secret: true });
    parseJson(artifact.snapshot!.bytes, artifact.artifact_ref);
    addBlocker(blockers, 'global_config_requires_review', 'artifact', 'Add explicit typed handling for every global Botmux setting before future staging.', artifact.artifact_ref);
  }

  const schedules: BotmuxSchedulePlan[] = [];
  const scheduleCanonical: unknown[] = [];
  const scheduleAppIds = uniqueSorted([...currentRawAppIds, ...backupBots.map(raw => typeof raw.larkAppId === 'string' ? raw.larkAppId : '').filter(Boolean)]);
  for (const rawAppId of scheduleAppIds) {
    if (!VALID_APP_ID.test(rawAppId)) continue;
    const schedulePath = join(botmuxHome, 'bots', rawAppId, 'schedules.json');
    if (!await pathExists(schedulePath)) continue;
    const artifact = await readArtifact(schedulePath, {
      kind: 'schedule_store',
      authority: 'authoritative',
      sensitivity: 'business',
      disposition: 'mapped',
      blocker_codes: [],
      archive_eligible: false,
      excluded_secret: false
    }, { secret: true });
    const parsed = parseJson(artifact.snapshot!.bytes, artifact.artifact_ref);
    const values = Array.isArray(parsed) ? parsed : asObject(parsed) ? Object.values(parsed as JsonObject) : [];
    for (const [index, rawTask] of values.entries()) {
      const task = asObject(rawTask);
      if (!task) {
        unknownConfigFields += 1;
        addBlocker(blockers, 'unknown_config_field', 'artifact', 'Classify the invalid schedule entry before future staging.', artifact.artifact_ref);
        continue;
      }
      for (const field of Object.keys(task)) {
        if (!HANDLED_SCHEDULE_FIELDS.has(field)) {
          unknownConfigFields += 1;
          addBlocker(blockers, 'unknown_config_field', 'artifact', 'Classify the unknown schedule field before future staging.', artifact.artifact_ref);
        }
      }
      const sourceScheduleId = typeof task.id === 'string' ? task.id : `index-${index}`;
      const taskAppId = typeof task.larkAppId === 'string' ? task.larkAppId : rawAppId;
      const appRef = appRefByRaw.get(taskAppId);
      const enabled = task.enabled === true;
      const parsedKindValue = asObject(task.parsed)?.kind;
      const parsedKind = parsedKindValue === 'at' || parsedKindValue === 'cron' || parsedKindValue === 'interval'
        ? parsedKindValue
        : 'unknown';
      const prompt = typeof task.prompt === 'string' ? task.prompt : '';
      const definitionRef = opaqueRef('schedule_definition', key, stableJson(task));
      const scheduleBlockerCodes = uniqueSorted([
        'schedule_staged_disabled',
        'schedule_lease_required',
        'schedule_identity_required',
        'schedule_secret_ref_required',
        'schedule_executor_unavailable',
        ...(enabled ? ['enabled_schedule_requires_single_writer'] : [])
      ]);
      const schedule: BotmuxSchedulePlan = {
        schedule_ref: opaqueRef('schedule', key, `${taskAppId}\0${sourceScheduleId}`),
        ...(appRef ? { app_ref: appRef } : {}),
        source_enabled: enabled,
        parsed_kind: parsedKind,
        ...(typeof task.chatId === 'string' ? { chat_ref: opaqueRef('chat', key, `${taskAppId}\0${task.chatId}`) } : {}),
        ...(typeof task.rootMessageId === 'string' ? { root_message_ref: opaqueRef('message', key, `${taskAppId}\0${task.rootMessageId}`) } : {}),
        payload_ref: opaqueRef('payload', key, prompt),
        definition_ref: definitionRef,
        ownership: 'botmux_owned',
        target_state: 'staged_disabled',
        target_enabled: false,
        intent_kind: 'task_run_snapshot',
        blocker_codes: scheduleBlockerCodes
      };
      schedules.push(schedule);
      scheduleCanonical.push({ ...schedule });
      for (const code of ['schedule_staged_disabled', 'schedule_lease_required', 'schedule_identity_required', 'schedule_secret_ref_required', 'schedule_executor_unavailable']) {
        addBlocker(blockers, code, appRef ? 'app' : 'global', 'Keep the schedule staged and disabled until the typed prerequisite and offline executor are implemented.', appRef);
      }
      const bot = channelBots.find(item => item.app_ref === appRef);
      if (bot) bot.blocker_codes = uniqueSorted([...bot.blocker_codes, ...scheduleBlockerCodes]);
      if (enabled) {
        addBlocker(blockers, 'enabled_schedule_requires_single_writer', appRef ? 'app' : 'global', 'Keep this schedule Botmux-owned until occurrence fencing and a single writer exist.', appRef);
      }
    }
  }
  schedules.sort((left, right) => left.schedule_ref.localeCompare(right.schedule_ref));

  let teams = 0;
  let teamMembers = 0;
  const teamsPath = join(dataPath, 'teams.json');
  if (await pathExists(teamsPath)) {
    const artifact = await readArtifact(teamsPath, {
      kind: 'teams',
      authority: 'authoritative',
      sensitivity: 'business',
      disposition: 'mapped',
      blocker_codes: [],
      archive_eligible: false,
      excluded_secret: false
    });
    const value = parseJson(artifact.snapshot!.bytes, artifact.artifact_ref);
    const teamValues = Array.isArray(value) ? value : Array.isArray(asObject(value)?.teams) ? asObject(value)!.teams as unknown[] : [];
    teams = teamValues.length;
    teamMembers = teamValues.reduce((total, team) => total + (Array.isArray(asObject(team)?.members) ? (asObject(team)!.members as unknown[]).length : 0), 0);
  }

  let sessionRecords = 0;
  let activeTopics = 0;
  const dataEntries = await safeDirectoryEntries(dataPath, dataPathRef);
  for (const entry of dataEntries) {
    const path = join(dataPath, entry.name);
    if (entry.kind === 'file' && /^sessions-[A-Za-z0-9_-]+\.json$/.test(entry.name)) {
      const artifact = await readArtifact(path, {
        kind: 'legacy_sessions',
        authority: 'historical',
        sensitivity: 'business',
        disposition: 'archive_only',
        blocker_codes: [],
        archive_eligible: true,
        excluded_secret: false
      });
      const value = parseJson(artifact.snapshot!.bytes, artifact.artifact_ref);
      const records = Array.isArray(value) ? value : asObject(value) ? Object.values(value as JsonObject) : [];
      sessionRecords += records.length;
      for (const rawRecord of records) {
        const record = asObject(rawRecord);
        if (!record || record.status !== 'active' || record.scope !== 'thread') continue;
        activeTopics += 1;
        const rawAppId = typeof record.larkAppId === 'string' ? record.larkAppId : '';
        const appRef = appRefByRaw.get(rawAppId);
        addBlocker(blockers, 'active_topics_require_disposition', appRef ? 'app' : 'global', 'Choose verified adopt, summary restart, cold archive, or keep Botmux active.', appRef);
        const bot = channelBots.find(item => item.app_ref === appRef);
        if (bot) bot.blocker_codes = uniqueSorted([...bot.blocker_codes, 'active_topics_require_disposition']);
      }
      continue;
    }
    if (!KNOWN_DATA_ENTRY.test(entry.name)) {
      const artifactRef = opaqueRef('artifact', key, path);
      const metadata = await pathMetadata(path, artifactRef);
      artifacts.push({
        artifact_ref: artifactRef,
        absolute_path: path,
        kind: 'unknown_data_artifact',
        authority: 'unknown',
        sensitivity: 'business',
        disposition: 'blocked_unknown',
        size_bytes: metadata.size,
        source_mode: metadata.mode,
        blocker_codes: ['unknown_artifact'],
        archive_eligible: false,
        excluded_secret: false
      });
      addBlocker(blockers, 'unknown_artifact', 'artifact', 'Classify the unknown data artifact before future staging.', artifactRef);
    }
  }

  let workflowDrafts = 0;
  const workflowRoot = join(botmuxHome, 'v3-runs');
  if (await pathExists(workflowRoot)) {
    for (const run of await safeDirectoryEntries(workflowRoot, opaqueRef('path', key, workflowRoot))) {
      const runPath = join(workflowRoot, run.name);
      if (run.kind !== 'directory') {
        const artifactRef = opaqueRef('artifact', key, runPath);
        addBlocker(blockers, 'unknown_artifact', 'artifact', 'Classify the unexpected workflow artifact.', artifactRef);
        continue;
      }
      const statePath = join(runPath, 'grill.state.json');
      if (!await pathExists(statePath)) continue;
      const artifact = await readArtifact(statePath, {
        kind: 'legacy_workflow_draft',
        authority: 'historical',
        sensitivity: 'business',
        disposition: 'archive_only',
        blocker_codes: [],
        archive_eligible: true,
        excluded_secret: false
      });
      const value = asObject(parseJson(artifact.snapshot!.bytes, artifact.artifact_ref));
      if (value?.status === 'grilling') workflowDrafts += 1;
      else workflowDrafts += 1;
    }
  }

  const usageRoot = join(botmuxHome, 'usage');
  if (await pathExists(usageRoot)) {
    for (const file of await recursiveFiles(usageRoot, key, 'usage')) {
      await readArtifact(file.path, {
        kind: 'usage_history',
        authority: 'historical',
        sensitivity: 'business',
        disposition: 'archive_only',
        blocker_codes: [],
        archive_eligible: true,
        excluded_secret: false
      });
    }
  }

  const attachmentsRoot = join(dataPath, 'attachments');
  if (await pathExists(attachmentsRoot)) {
    for (const file of await recursiveFiles(attachmentsRoot, key, 'attachment')) {
      await readArtifact(file.path, {
        kind: 'attachment_history',
        authority: 'historical',
        sensitivity: 'business',
        disposition: 'archive_only',
        blocker_codes: [],
        archive_eligible: true,
        excluded_secret: false
      });
    }
  }

  for (const sqliteName of ['botmux-feedback.sqlite', 'feisuo-feedback.sqlite']) {
    const sqlitePath = join(dataPath, sqliteName);
    if (!await pathExists(sqlitePath)) continue;
    await recordOpaqueArtifact(sqlitePath, {
      kind: 'feedback_sqlite',
      authority: 'historical',
      sensitivity: 'business',
      disposition: 'archive_deferred',
      blocker_codes: ['sqlite_online_backup_required'],
      archive_eligible: false,
      excluded_secret: false
    });
    addBlocker(blockers, 'sqlite_online_backup_required', 'artifact', 'Use SQLite online backup before including feedback history in a private archive.', opaqueRef('artifact', key, sqlitePath));
  }

  for (const directoryName of ['roles', 'team-roles', 'role-profiles', 'connectors']) {
    const path = join(dataPath, directoryName);
    if (!await pathExists(path)) continue;
    const entries = await safeDirectoryEntries(path, opaqueRef('path', key, path));
    if (entries.length > 0) addBlocker(blockers, `${directoryName.replaceAll('-', '_')}_unsupported`, 'artifact', 'Archive and explicitly model this capability before future staging.', opaqueRef('artifact', key, path));
  }

  let plugins = 0;
  const pluginPath = join(botmuxHome, 'plugins');
  if (await pathExists(pluginPath)) {
    const entries = await safeDirectoryEntries(pluginPath, opaqueRef('path', key, pluginPath));
    plugins = entries.length;
    if (plugins > 0) addBlocker(blockers, 'plugins_unsupported', 'artifact', 'Archive and explicitly model installed plugins before future staging.', opaqueRef('artifact', key, pluginPath));
  }

  const homeEntries = await safeDirectoryEntries(sourceHome, sourceHomeRef);
  for (const entry of homeEntries) {
    if (KNOWN_HOME_ENTRIES.has(entry.name) || resolve(sourceHome, entry.name) === resolve(dataPath)) continue;
    const path = join(sourceHome, entry.name);
    const artifactRef = opaqueRef('artifact', key, path);
    const metadata = await pathMetadata(path, artifactRef);
    artifacts.push({
      artifact_ref: artifactRef,
      absolute_path: path,
      kind: 'unknown_home_artifact',
      authority: 'unknown',
      sensitivity: 'business',
      disposition: 'blocked_unknown',
      size_bytes: metadata.size,
      source_mode: metadata.mode,
      blocker_codes: ['unknown_artifact'],
      archive_eligible: false,
      excluded_secret: false
    });
    addBlocker(blockers, 'unknown_artifact', 'artifact', 'Classify the unknown Botmux home artifact before future staging.', artifactRef);
  }

  for (const secretPath of [
    join(sourceHome, 'feishu-session.json'),
    join(sourceHome, '.dashboard-secret'),
    join(sourceHome, '.dashboard-token')
  ]) {
    if (!await pathExists(secretPath)) continue;
    if (artifacts.some(item => item.absolute_path === secretPath)) continue;
    await recordOpaqueArtifact(secretPath, {
      kind: 'forbidden_runtime_credential',
      authority: 'runtime',
      sensitivity: 'secret',
      disposition: 'excluded_with_reason',
      blocker_codes: [],
      archive_eligible: false,
      excluded_secret: true
    });
  }

  const roles = artifacts.filter(item => ['roles', 'team_roles', 'role_profiles'].includes(item.kind)).length;
  const unknownArtifacts = artifacts.filter(item => item.disposition === 'blocked_unknown').length;
  const enabledSchedules = schedules.filter(item => item.source_enabled).length;
  const summary: BotmuxImportSummary = {
    current_channel_bots: channelBots.length,
    retired_channel_bots: retiredBots.length,
    oncall_group_bindings: channelBots.reduce((total, bot) => total + bot.oncall_bindings.length, 0),
    enabled_schedules: enabledSchedules,
    distinct_owner_locators: distinctOwnerRefs.size,
    teams,
    team_members: teamMembers,
    legacy_session_records: sessionRecords,
    active_topic_records: activeTopics,
    workflow_drafts: workflowDrafts,
    roles,
    connectors: 0,
    plugins,
    unknown_artifacts: unknownArtifacts,
    unknown_config_fields: unknownConfigFields,
    activation_ready_apps: 0
  };

  const applyFingerprint = stableFingerprint({
    parser_version: PARSER_VERSION,
    bots: botCanonical.sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    schedules: scheduleCanonical.sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    teams,
    team_members: teamMembers,
    blocker_codes: uniqueSorted(blockers.filter(item => item.code !== 'active_topics_require_disposition').map(item => item.code))
  });
  const privateIntegrityFingerprint = stableFingerprint(integrityParts.sort((left, right) => left.artifact_ref.localeCompare(right.artifact_ref)));
  const archiveCandidateFingerprint = stableFingerprint(archiveParts.sort((left, right) => left.artifact_ref.localeCompare(right.artifact_ref)));
  const planId = `plan_${stableFingerprint({ source_instance_ref: sourceInstanceRef, apply_fingerprint: applyFingerprint }).slice(0, 24)}`;
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();

  const plan: BotmuxPrivateMigrationPlan = {
    schema_version: 1,
    parser_version: PARSER_VERSION,
    plan_id: planId,
    generated_at: generatedAt,
    allowed_mode: 'read_only_plan',
    production_cutover: 'NO_GO',
    source: {
      source_instance_ref: sourceInstanceRef,
      config_path_ref: configPathRef,
      data_path_ref: dataPathRef,
      apply_fingerprint: applyFingerprint,
      private_integrity_fingerprint: privateIntegrityFingerprint,
      archive_candidate_fingerprint: archiveCandidateFingerprint,
      archive_snapshot_id: null,
      cutover_watermark: null
    },
    summary,
    channel_bots: channelBots,
    retired_bots: retiredBots,
    schedules,
    artifacts: artifacts.map(({ absolute_path: _path, snapshot: _snapshot, archive_eligible: _eligible, excluded_secret: _excluded, ...artifact }) => artifact),
    secret_requirements: secretRequirements.sort((left, right) => left.secret_ref.localeCompare(right.secret_ref)),
    blockers: blockers.sort((left, right) => `${left.code}:${left.scope_ref ?? ''}`.localeCompare(`${right.code}:${right.scope_ref ?? ''}`)),
    forbidden_capabilities: [
      'write_dutydeck_db',
      'modify_botmux_source',
      'enable_listener',
      'enable_schedule',
      'confirm_full_trust',
      'resume_legacy_session'
    ],
    eligibility: {
      activation_ready: false,
      reason: 'read_only_importer_and_unresolved_blockers'
    }
  };

  return new BotmuxDiscovery({ key, plan, artifacts, archive_files: archiveFiles });
}

export async function planBotmuxImport(options: DiscoverBotmuxOptions): Promise<BotmuxPlanHandle> {
  return (await discoverBotmuxSource(options)).createPlan();
}
