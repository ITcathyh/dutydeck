import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as publicApi from './index.js';
import { BotmuxImportError, discoverBotmuxSource, planBotmuxImport } from './index.js';

const FIXTURE = {
  appA: 'cli_fixture_alpha',
  appB: 'cli_fixture_hammer',
  retiredApp: 'cli_fixture_retired',
  appSecretA: 'FIXTURE_APP_SECRET_ALPHA_DO_NOT_LEAK',
  appSecretB: 'FIXTURE_APP_SECRET_BETA_DO_NOT_LEAK',
  owner: 'owner.fixture@example.invalid',
  chatA: 'oc_fixture_private_alpha',
  chatB: 'oc_fixture_private_beta',
  cwd: '/private/fixture/workspace',
  prompt: 'FIXTURE_SCHEDULE_PROMPT_DO_NOT_LEAK',
  workflowGoal: 'FIXTURE_WORKFLOW_GOAL_DO_NOT_LEAK',
  rootMessage: 'om_fixture_root_private',
  gatewayToken: 'FIXTURE_GATEWAY_TOKEN_DO_NOT_LEAK'
} as const;

const dirs: string[] = [];
const fingerprintKey = new Uint8Array(32).fill(0x41);
const archiveKey = new Uint8Array(32).fill(0x42);

async function privateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

async function privateText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

interface FixtureTree {
  root: string;
  sourceHome: string;
  dataDir: string;
  sessionPath: string;
  schedulePath: string;
}

async function createFixture(options: { unknownField?: boolean; unknownArtifact?: boolean } = {}): Promise<FixtureTree> {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-botmux-importer-'));
  dirs.push(root);
  const sourceHome = join(root, 'source-home');
  const dataDir = join(sourceHome, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await privateText(join(sourceHome, '.data-dir'), `${dataDir}\n`);

  const currentBots = [
    {
      larkAppId: FIXTURE.appA,
      larkAppSecret: FIXTURE.appSecretA,
      cliId: 'claude-code',
      defaultWorkingDir: FIXTURE.cwd,
      allowedUsers: [FIXTURE.owner],
      oncallChats: [
        { chatId: FIXTURE.chatA, workingDir: FIXTURE.cwd },
        { chatId: FIXTURE.chatB, workingDir: FIXTURE.cwd }
      ],
      p2pMode: 'thread',
      regularGroupMentionMode: 'topic',
      ...(options.unknownField ? { mysteryPolicy: { unsafe: true } } : {})
    },
    {
      larkAppId: FIXTURE.appB,
      larkAppSecret: FIXTURE.appSecretB,
      cliId: 'claude-code',
      defaultWorkingDir: '/private/fixture/hammer',
      allowedUsers: [FIXTURE.owner],
      hammer: { enabled: true, mode: 'full', enforceGates: true, skillsInjection: 'prompt' }
    }
  ];
  await privateJson(join(sourceHome, 'bots.json'), currentBots);
  await privateJson(join(sourceHome, 'bots.json.bak'), [
    currentBots[0],
    {
      larkAppId: FIXTURE.retiredApp,
      larkAppSecret: 'FIXTURE_RETIRED_SECRET_DO_NOT_LEAK',
      cliId: 'traex'
    }
  ]);
  await privateText(join(sourceHome, '.env'), [
    `BOT_GATEWAY_CHAT_IDS=${FIXTURE.chatA}`,
    `BOT_GATEWAY_LARK_APP_IDS=${FIXTURE.appA}`,
    'BOT_GATEWAY_SOCKET=/private/fixture/gateway.sock',
    `BOT_GATEWAY_TRANSPORT_TOKEN_FILE=${FIXTURE.gatewayToken}`,
    ''
  ].join('\n'));

  const schedulePath = join(sourceHome, 'bots', FIXTURE.appA, 'schedules.json');
  await privateJson(schedulePath, {
    fixture_task: {
      id: 'fixture_task',
      larkAppId: FIXTURE.appA,
      chatId: FIXTURE.chatA,
      chatType: 'group',
      rootMessageId: FIXTURE.rootMessage,
      enabled: true,
      parsed: { kind: 'interval', minutes: 60, display: 'fixture' },
      schedule: 'every fixture hour',
      prompt: FIXTURE.prompt,
      scope: 'thread',
      executionPosition: 'topic',
      workingDir: FIXTURE.cwd,
      lastStatus: 'ok'
    }
  });
  await privateJson(join(sourceHome, 'bots', FIXTURE.appB, 'schedules.json'), {});
  await privateJson(join(sourceHome, 'bots', FIXTURE.retiredApp, 'schedules.json'), {});

  await privateJson(join(dataDir, 'teams.json'), {
    version: 1,
    teams: [{ id: 'default', name: 'Fixture Team', members: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' }]
  });
  const sessionPath = join(dataDir, `sessions-${FIXTURE.appA}.json`);
  await privateJson(sessionPath, {
    fixture_active: {
      sessionId: 'fixture_active',
      larkAppId: FIXTURE.appA,
      status: 'active',
      scope: 'thread',
      backendType: 'tmux',
      rootMessageId: FIXTURE.rootMessage,
      ownerOpenId: 'ou_fixture_private',
      lastUserPrompt: 'FIXTURE_SESSION_PROMPT_DO_NOT_LEAK'
    },
    fixture_closed: {
      sessionId: 'fixture_closed',
      larkAppId: FIXTURE.appA,
      status: 'closed',
      scope: 'thread',
      backendType: 'tmux'
    }
  });
  await privateJson(join(dataDir, `sessions-${FIXTURE.appB}.json`), {
    fixture_hammer_active: {
      sessionId: 'fixture_hammer_active',
      larkAppId: FIXTURE.appB,
      status: 'active',
      scope: 'thread',
      backendType: 'tmux'
    }
  });
  await privateJson(join(sourceHome, 'v3-runs', 'fixture-run', 'grill.state.json'), {
    schemaVersion: 1,
    runId: 'fixture-run',
    status: 'grilling',
    goal: FIXTURE.workflowGoal,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  await privateText(join(sourceHome, 'usage', 'usage-2026-01-01.jsonl'), '{"fixture":true}\n');
  await mkdir(join(sourceHome, 'plugins'), { recursive: true, mode: 0o700 });
  if (options.unknownArtifact) await privateJson(join(sourceHome, 'mystery-config.json'), { hidden: 'FIXTURE_UNKNOWN_VALUE' });
  return { root, sourceHome, dataDir, sessionPath, schedulePath };
}

async function treeDigest(root: string): Promise<string> {
  const rows: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        rows.push(`d:${rel}`);
        await walk(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        rows.push(`f:${rel}:${createHash('sha256').update(bytes).digest('hex')}`);
      } else {
        rows.push(`o:${rel}`);
      }
    }
  };
  await walk(root);
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Botmux read-only importer', () => {
  it('discovers a synthetic host, emits blockers, and never exposes paths, identities, prompts, or secrets', async () => {
    const fixture = await createFixture({ unknownField: true, unknownArtifact: true });
    const discovery = await discoverBotmuxSource({
      source_home: fixture.sourceHome,
      fingerprint_key: fingerprintKey,
      now: () => new Date('2026-08-30T00:00:00.000Z')
    });
    const handle = discovery.createPlan();
    const plan = handle.private_plan;
    const report = handle.createRedactedManifest();

    expect(plan.summary).toMatchObject({
      current_channel_bots: 2,
      retired_channel_bots: 1,
      oncall_group_bindings: 2,
      enabled_schedules: 1,
      distinct_owner_locators: 1,
      teams: 1,
      team_members: 0,
      legacy_session_records: 3,
      active_topic_records: 2,
      workflow_drafts: 1,
      activation_ready_apps: 0
    });
    expect(plan.eligibility.activation_ready).toBe(false);
    expect(plan.production_cutover).toBe('NO_GO');
    expect(plan.allowed_mode).toBe('read_only_plan');
    expect(plan.channel_bots.every(bot => bot.eligibility === false && bot.target_state === 'staged_only')).toBe(true);
    expect(plan.schedules[0]).toMatchObject({
      source_enabled: true,
      ownership: 'botmux_owned',
      target_state: 'staged_disabled',
      target_enabled: false,
      intent_kind: 'task_run_snapshot'
    });
    expect(plan.schedules[0]?.blocker_codes).toEqual(expect.arrayContaining([
      'schedule_staged_disabled',
      'schedule_lease_required',
      'schedule_identity_required',
      'schedule_secret_ref_required',
      'schedule_executor_unavailable',
      'enabled_schedule_requires_single_writer'
    ]));
    const hammerPlan = plan.channel_bots.find(bot => bot.cli_id === 'claude-code' && bot.archived_integrations.length > 0);
    expect(hammerPlan?.archived_integrations).toEqual([{
      schema_version: 1,
      kind: 'hammer',
      source_system: 'botmux',
      source_enabled: true,
      mode: 'full',
      enforce_gates: true,
      skills_injection: 'prompt',
      state: 'archived',
      executor_state: 'unavailable',
      blocker_code: 'hammer_executor_unavailable'
    }]);

    const blockerCodes = new Set(plan.blockers.map(item => item.code));
    for (const requiredBlocker of [
      'hammer_executor_unavailable',
      'enabled_schedule_requires_single_writer',
      'schedule_lease_required',
      'schedule_identity_required',
      'schedule_secret_ref_required',
      'schedule_executor_unavailable',
      'active_topics_require_disposition',
      'unknown_config_field',
      'unknown_artifact',
      'legacy_gateway_requires_review'
    ]) expect(blockerCodes).toContain(requiredBlocker);

    const serialized = JSON.stringify({ discovery: discovery.manifest, plan, report });
    for (const forbidden of [
      fixture.sourceHome,
      fixture.dataDir,
      FIXTURE.appA,
      FIXTURE.appB,
      FIXTURE.retiredApp,
      FIXTURE.appSecretA,
      FIXTURE.appSecretB,
      FIXTURE.owner,
      FIXTURE.chatA,
      FIXTURE.chatB,
      FIXTURE.cwd,
      FIXTURE.prompt,
      FIXTURE.workflowGoal,
      FIXTURE.rootMessage,
      FIXTURE.gatewayToken,
      'ou_fixture_private',
      'FIXTURE_SESSION_PROMPT_DO_NOT_LEAK'
    ]) expect(serialized).not.toContain(forbidden);
    expect(plan.secret_requirements.every(item => item.persisted_value === false)).toBe(true);
  });

  it('keeps the static fingerprint stable across history changes and changes it for schedule definitions', async () => {
    const fixture = await createFixture();
    const options = {
      source_home: fixture.sourceHome,
      fingerprint_key: fingerprintKey,
      now: () => new Date('2026-08-30T00:00:00.000Z')
    };
    const first = await planBotmuxImport(options);
    const second = await planBotmuxImport(options);
    expect(second.private_plan.source.apply_fingerprint).toBe(first.private_plan.source.apply_fingerprint);
    expect(second.private_plan.plan_id).toBe(first.private_plan.plan_id);

    const sessions = JSON.parse(await readFile(fixture.sessionPath, 'utf8')) as Record<string, unknown>;
    sessions.fixture_history_only = { sessionId: 'fixture_history_only', larkAppId: FIXTURE.appA, status: 'closed', scope: 'thread' };
    await privateJson(fixture.sessionPath, sessions);
    const historyChanged = await planBotmuxImport(options);
    expect(historyChanged.private_plan.source.apply_fingerprint).toBe(first.private_plan.source.apply_fingerprint);
    expect(historyChanged.private_plan.source.archive_candidate_fingerprint).not.toBe(first.private_plan.source.archive_candidate_fingerprint);

    const schedule = JSON.parse(await readFile(fixture.schedulePath, 'utf8')) as Record<string, any>;
    schedule.fixture_task.prompt = 'FIXTURE_CHANGED_SCHEDULE_PROMPT';
    await privateJson(fixture.schedulePath, schedule);
    const scheduleChanged = await planBotmuxImport(options);
    expect(scheduleChanged.private_plan.source.apply_fingerprint).not.toBe(first.private_plan.source.apply_fingerprint);
  });

  it('does not mutate the source and writes only encrypted private archive artifacts', async () => {
    const fixture = await createFixture();
    const before = await treeDigest(fixture.sourceHome);
    const handle = await planBotmuxImport({
      source_home: fixture.sourceHome,
      fingerprint_key: fingerprintKey,
      now: () => new Date('2026-08-30T00:00:00.000Z')
    });
    expect(await treeDigest(fixture.sourceHome)).toBe(before);

    const archiveDir = join(fixture.root, 'private-archive');
    const manifest = await handle.createPrivateArchive({ destination: archiveDir, encryption_key: archiveKey });
    expect(manifest.source_mutated).toBe(false);
    expect(manifest.live_config_written).toBe(false);
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(await treeDigest(fixture.sourceHome)).toBe(before);

    if (process.platform !== 'win32') {
      expect((await lstat(archiveDir)).mode & 0o777).toBe(0o700);
    }
    const archiveEntries = await readdir(archiveDir);
    for (const name of archiveEntries) {
      const path = join(archiveDir, name);
      const bytes = await readFile(path);
      if (process.platform !== 'win32') expect((await lstat(path)).mode & 0o777).toBe(0o600);
      const serialized = bytes.toString('utf8');
      for (const forbidden of [
        FIXTURE.appSecretA,
        FIXTURE.appSecretB,
        FIXTURE.owner,
        FIXTURE.chatA,
        FIXTURE.cwd,
        FIXTURE.prompt,
        FIXTURE.workflowGoal,
        'FIXTURE_SESSION_PROMPT_DO_NOT_LEAK',
        fixture.sourceHome
      ]) expect(serialized).not.toContain(forbidden);
      if (name.endsWith('.enc')) expect(bytes.subarray(0, 32).toString('utf8')).toContain('DUTYDECK-BOTMUX-ARCHIVE');
    }

    const redactedPath = join(fixture.root, 'redacted-plan.json');
    await handle.writeRedactedManifest(redactedPath);
    if (process.platform !== 'win32') expect((await lstat(redactedPath)).mode & 0o777).toBe(0o600);
    const redacted = await readFile(redactedPath, 'utf8');
    expect(redacted).not.toContain(FIXTURE.owner);
    expect(redacted).not.toContain(fixture.sourceHome);
    expect(redacted).not.toContain(FIXTURE.appSecretA);
  });

  it('fails closed for a symlinked registry and exposes no mutation capabilities', async () => {
    const fixture = await createFixture();
    const realRegistry = join(fixture.sourceHome, 'real-bots.json');
    await privateJson(realRegistry, []);
    await rm(join(fixture.sourceHome, 'bots.json'));
    await symlink(realRegistry, join(fixture.sourceHome, 'bots.json'));

    await expect(discoverBotmuxSource({
      source_home: fixture.sourceHome,
      fingerprint_key: fingerprintKey
    })).rejects.toMatchObject<Partial<BotmuxImportError>>({ code: 'SOURCE_FILE_INVALID' });

    const exportedNames = Object.keys(publicApi);
    expect(exportedNames.some(name => /apply|activate|cutover|resume/i.test(name))).toBe(false);
  });
});
