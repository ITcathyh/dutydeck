export type ArtifactAuthority = 'authoritative' | 'derived' | 'runtime' | 'historical' | 'unknown';
export type ArtifactSensitivity = 'secret' | 'personal' | 'business' | 'runtime' | 'public_metadata';
export type ArtifactDisposition =
  | 'mapped'
  | 'archive_only'
  | 'archive_deferred'
  | 'rebuild'
  | 'runtime_only'
  | 'excluded_with_reason'
  | 'blocked_unknown';

export interface BotmuxImportArtifact {
  artifact_ref: string;
  kind: string;
  authority: ArtifactAuthority;
  sensitivity: ArtifactSensitivity;
  disposition: ArtifactDisposition;
  size_bytes: number;
  source_mode: number;
  blocker_codes: string[];
}

export interface BotmuxImportBlocker {
  code: string;
  scope: 'global' | 'app' | 'artifact';
  scope_ref?: string;
  next_step: string;
}

export interface BotmuxSecretRequirement {
  secret_ref: string;
  app_ref?: string;
  kind: 'lark_app_secret' | 'agent_env' | 'connector_credential' | 'unknown_secret';
  source_present: boolean;
  persisted_value: false;
}

export interface BotmuxOwnerLocator {
  principal_ref: string;
  kind: 'email' | 'mobile' | 'open_id' | 'union_id' | 'unknown';
  app_ref: string;
  validation_state: 'not_checked';
}

export interface BotmuxOncallBinding {
  binding_ref: string;
  chat_ref: string;
  cwd_ref?: string;
  app_ref: string;
  source_talk_policy: 'whole_group';
  target_state: 'staged_only';
}

export interface BotmuxArchivedHammerIntegration {
  schema_version: 1;
  kind: 'hammer';
  source_system: 'botmux';
  source_enabled: boolean;
  mode: 'full' | 'lite' | 'unknown';
  enforce_gates: boolean;
  skills_injection: 'prompt' | 'runtime' | 'none' | 'unknown';
  state: 'archived';
  executor_state: 'unavailable';
  blocker_code: 'hammer_executor_unavailable';
}

export interface BotmuxChannelBotPlan {
  app_ref: string;
  source_state: 'current';
  cli_id: string;
  effective_backend: string;
  effective_p2p_mode: 'chat' | 'thread';
  effective_group_reply_mode: 'chat' | 'shared' | 'new-topic' | 'chat-topic';
  effective_mention_mode: 'always' | 'topic' | 'never' | 'ambient';
  default_cwd_ref?: string;
  default_cwd_kind: 'absolute' | 'home_relative' | 'relative' | 'unset';
  owner_locators: BotmuxOwnerLocator[];
  oncall_bindings: BotmuxOncallBinding[];
  hammer_archived: boolean;
  archived_integrations: BotmuxArchivedHammerIntegration[];
  target_state: 'staged_only';
  eligibility: false;
  blocker_codes: string[];
}

export interface BotmuxRetiredBotPlan {
  app_ref: string;
  source_state: 'retired_or_unknown';
  disposition: 'archive_only';
}

export interface BotmuxSchedulePlan {
  schedule_ref: string;
  app_ref?: string;
  source_enabled: boolean;
  parsed_kind: string;
  chat_ref?: string;
  root_message_ref?: string;
  payload_ref: string;
  definition_ref: string;
  ownership: 'botmux_owned';
  target_state: 'staged_disabled';
  target_enabled: false;
  intent_kind: 'task_run_snapshot';
  blocker_codes: string[];
}

export interface BotmuxImportSummary {
  current_channel_bots: number;
  retired_channel_bots: number;
  oncall_group_bindings: number;
  enabled_schedules: number;
  distinct_owner_locators: number;
  teams: number;
  team_members: number;
  legacy_session_records: number;
  active_topic_records: number;
  workflow_drafts: number;
  roles: number;
  connectors: number;
  plugins: number;
  unknown_artifacts: number;
  unknown_config_fields: number;
  activation_ready_apps: 0;
}

export interface BotmuxPrivateMigrationPlan {
  schema_version: 1;
  parser_version: string;
  plan_id: string;
  generated_at: string;
  allowed_mode: 'read_only_plan';
  production_cutover: 'NO_GO';
  source: {
    source_instance_ref: string;
    config_path_ref: string;
    data_path_ref: string;
    apply_fingerprint: string;
    private_integrity_fingerprint: string;
    archive_candidate_fingerprint: string;
    archive_snapshot_id: null;
    cutover_watermark: null;
  };
  summary: BotmuxImportSummary;
  channel_bots: BotmuxChannelBotPlan[];
  retired_bots: BotmuxRetiredBotPlan[];
  schedules: BotmuxSchedulePlan[];
  artifacts: BotmuxImportArtifact[];
  secret_requirements: BotmuxSecretRequirement[];
  blockers: BotmuxImportBlocker[];
  forbidden_capabilities: readonly [
    'write_dockmux_db',
    'modify_botmux_source',
    'enable_listener',
    'enable_schedule',
    'confirm_full_trust',
    'resume_legacy_session'
  ];
  eligibility: {
    activation_ready: false;
    reason: 'read_only_importer_and_unresolved_blockers';
  };
}

export interface BotmuxRedactedManifest {
  schema_version: 1;
  parser_version: string;
  plan_id: string;
  generated_at: string;
  allowed_mode: 'read_only_plan';
  production_cutover: 'NO_GO';
  source: {
    source_instance_ref: string;
    apply_fingerprint: string;
    archive_candidate_fingerprint: string;
    archive_snapshot_id: null;
    cutover_watermark: null;
  };
  summary: BotmuxImportSummary;
  channel_bots: Array<{
    app_ref: string;
    cli_id: string;
    effective_backend: string;
    oncall_bindings: number;
    owner_locators: number;
    hammer_archived: boolean;
    archived_integrations: BotmuxArchivedHammerIntegration[];
    target_state: 'staged_only';
    eligibility: false;
    blocker_codes: string[];
  }>;
  retired_bots: BotmuxRetiredBotPlan[];
  schedules: Array<{
    schedule_ref: string;
    app_ref?: string;
    source_enabled: boolean;
    parsed_kind: string;
    ownership: 'botmux_owned';
    target_state: 'staged_disabled';
    target_enabled: false;
    intent_kind: 'task_run_snapshot';
    blocker_codes: string[];
  }>;
  artifact_counts: Record<ArtifactDisposition, number>;
  secret_requirement_counts: Record<BotmuxSecretRequirement['kind'], number>;
  blockers: BotmuxImportBlocker[];
  forbidden_capabilities: BotmuxPrivateMigrationPlan['forbidden_capabilities'];
  eligibility: BotmuxPrivateMigrationPlan['eligibility'];
}

export interface BotmuxDiscoveryManifest {
  schema_version: 1;
  source_instance_ref: string;
  config_path_ref: string;
  data_path_ref: string;
  artifact_counts: Record<ArtifactDisposition, number>;
  unknown_artifacts: number;
  blocker_codes: string[];
}

export interface DiscoverBotmuxOptions {
  source_home?: string;
  bots_config?: string;
  data_dir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  fingerprint_key: Uint8Array;
  now?: () => Date;
}

export interface PrivateArchiveOptions {
  destination: string;
  encryption_key: Uint8Array;
  key_derivation?: BotmuxArchiveKeyDerivation;
}

export interface BotmuxArchiveKeyDerivation {
  algorithm: 'scrypt';
  salt_base64: string;
  key_length_bytes: 32;
  cost: number;
  block_size: number;
  parallelization: number;
}

export interface BotmuxPrivateArchiveManifest {
  schema_version: 1;
  archive_snapshot_id: string;
  created_at: string;
  source_instance_ref: string;
  encryption: 'aes-256-gcm';
  key_derivation?: BotmuxArchiveKeyDerivation;
  files: Array<{
    artifact_ref: string;
    kind: string;
    ciphertext_sha256: string;
    plaintext_size_bytes: number;
  }>;
  excluded_secret_artifacts: number;
  source_mutated: false;
  live_config_written: false;
}

export class BotmuxImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly artifact_ref?: string
  ) {
    super(message);
    this.name = 'BotmuxImportError';
  }
}
