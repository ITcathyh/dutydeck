import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planBotmuxImport } from '../../../../packages/botmux-importer/src/index.ts';

const checkDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(checkDirectory, '../fixtures/importer');
const fingerprintKey = new Uint8Array(32).fill(0x41);
const archiveKey = new Uint8Array(32).fill(0x42);

const forbiddenFixtureValues = [
  'cli_fixture_alpha',
  'cli_fixture_hammer',
  'cli_fixture_retired',
  'SYNTHETIC_SECRET_ALPHA_NEVER_VALID',
  'SYNTHETIC_SECRET_HAMMER_NEVER_VALID',
  'SYNTHETIC_SECRET_RETIRED_NEVER_VALID',
  'owner.fixture@example.invalid',
  'oc_fixture_alpha',
  'oc_fixture_beta',
  '/synthetic/workspace/alpha',
  'SYNTHETIC_SCHEDULE_PROMPT_NEVER_SEND',
  'SYNTHETIC_WORKFLOW_GOAL_NEVER_EXECUTE',
  'SYNTHETIC_SESSION_PROMPT_NEVER_SEND',
  'ou_fixture_owner',
  'om_fixture_root',
];

function invariant(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

async function copySyntheticFixture(source: string, destination: string, dataDirectory: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === 'data-dir.template') {
      await writeFile(join(destination, '.data-dir'), `${dataDirectory}\n`, { mode: 0o600 });
      continue;
    }
    if (entry.name === 'legacy-env.template') {
      const bytes = await readFile(join(source, entry.name));
      await writeFile(join(destination, '.env'), bytes, { mode: 0o600 });
      continue;
    }
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copySyntheticFixture(sourcePath, destinationPath, dataDirectory);
      continue;
    }
    invariant(entry.isFile(), 'FIXTURE_ENTRY_TYPE_UNSAFE');
    await writeFile(destinationPath, await readFile(sourcePath), { mode: 0o600 });
  }
}

async function treeDigest(root: string): Promise<string> {
  const rows: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      if (entry.isDirectory()) {
        rows.push(`d:${relativePath}`);
        await visit(path);
      } else if (entry.isFile()) {
        rows.push(`f:${relativePath}:${createHash('sha256').update(await readFile(path)).digest('hex')}`);
      } else {
        rows.push(`o:${relativePath}`);
      }
    }
  };
  await visit(root);
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex');
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'dutydeck-botmux-parity-'));
  try {
    const sourceHome = join(tempRoot, 'source-home');
    const dataDirectory = join(sourceHome, 'data');
    await copySyntheticFixture(fixtureDirectory, sourceHome, dataDirectory);
    if (process.platform !== 'win32') {
      await chmod(sourceHome, 0o700);
      await chmod(dataDirectory, 0o700);
    }

    const before = await treeDigest(sourceHome);
    const handle = await planBotmuxImport({
      source_home: sourceHome,
      fingerprint_key: fingerprintKey,
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });
    const plan = handle.private_plan;
    const report = handle.createRedactedManifest();

    invariant(plan.allowed_mode === 'read_only_plan', 'IMPORTER_MODE_NOT_READ_ONLY');
    invariant(plan.production_cutover === 'NO_GO', 'IMPORTER_NOT_NO_GO');
    invariant(plan.eligibility.activation_ready === false, 'IMPORTER_ELIGIBILITY_NOT_FALSE');
    invariant(plan.summary.current_channel_bots === 2, 'IMPORTER_BOT_COUNT_MISMATCH');
    invariant(plan.summary.retired_channel_bots === 1, 'IMPORTER_RETIRED_COUNT_MISMATCH');
    invariant(plan.summary.oncall_group_bindings === 2, 'IMPORTER_BINDING_COUNT_MISMATCH');
    invariant(plan.summary.enabled_schedules === 1, 'IMPORTER_SCHEDULE_COUNT_MISMATCH');
    invariant(plan.summary.active_topic_records === 2, 'IMPORTER_ACTIVE_TOPIC_COUNT_MISMATCH');

    const blockerCodes = new Set(plan.blockers.map(blocker => blocker.code));
    for (const code of [
      'read_only_importer_no_activation',
      'hammer_executor_unavailable',
      'enabled_schedule_requires_single_writer',
      'schedule_lease_required',
      'schedule_identity_required',
      'schedule_secret_ref_required',
      'schedule_executor_unavailable',
      'active_topics_require_disposition',
      'unknown_config_field',
      'unknown_artifact',
    ]) invariant(blockerCodes.has(code), `MISSING_BLOCKER_${code.toUpperCase()}`);
    invariant(plan.schedules.every(schedule => schedule.target_state === 'staged_disabled' && schedule.target_enabled === false && schedule.intent_kind === 'task_run_snapshot'), 'SCHEDULE_TARGET_NOT_STAGED_DISABLED');
    invariant(plan.channel_bots.flatMap(bot => bot.archived_integrations).every(integration => integration.kind === 'hammer' && integration.state === 'archived' && integration.executor_state === 'unavailable'), 'HAMMER_ARCHIVE_NOT_TYPED_OR_BLOCKED');

    const serialized = JSON.stringify({ plan, report });
    invariant(!serialized.includes(sourceHome), 'SOURCE_PATH_LEAKED');
    invariant(!serialized.includes(dataDirectory), 'DATA_PATH_LEAKED');
    for (const value of forbiddenFixtureValues) {
      invariant(!serialized.includes(value), 'PRIVATE_FIXTURE_VALUE_LEAKED');
    }
    invariant(plan.secret_requirements.every(requirement => requirement.persisted_value === false), 'SECRET_PERSISTENCE_FLAG_INVALID');
    invariant(await treeDigest(sourceHome) === before, 'SOURCE_MUTATED_BY_PLAN');

    const archiveDirectory = join(tempRoot, 'private-archive');
    const archive = await handle.createPrivateArchive({ destination: archiveDirectory, encryption_key: archiveKey });
    invariant(archive.source_mutated === false, 'ARCHIVE_REPORTED_SOURCE_MUTATION');
    invariant(archive.live_config_written === false, 'ARCHIVE_REPORTED_LIVE_WRITE');
    invariant(archive.files.length > 0, 'ARCHIVE_EMPTY');
    invariant(await treeDigest(sourceHome) === before, 'SOURCE_MUTATED_BY_ARCHIVE');

    for (const name of await readdir(archiveDirectory)) {
      const path = join(archiveDirectory, name);
      const bytes = await readFile(path);
      if (process.platform !== 'win32') invariant(((await lstat(path)).mode & 0o777) === 0o600, 'ARCHIVE_FILE_MODE_UNSAFE');
      if (name.endsWith('.enc')) {
        invariant(bytes.subarray(0, 32).toString('utf8').includes('DUTYDECK-BOTMUX-ARCHIVE'), 'ARCHIVE_HEADER_INVALID');
      } else {
        const text = bytes.toString('utf8');
        invariant(!text.includes(sourceHome), 'ARCHIVE_PLAN_PATH_LEAKED');
        for (const value of forbiddenFixtureValues) invariant(!text.includes(value), 'ARCHIVE_PLAN_PRIVATE_VALUE_LEAKED');
      }
    }

    process.stdout.write(`${JSON.stringify({
      case_id: 'importer-redaction-no-go-source-immutable',
      status: 'pass',
      source_unchanged: true,
      production_cutover: 'NO_GO',
      activation_ready: false,
      blocker_count: plan.blockers.length,
      archived_file_count: archive.files.length,
    })}\n`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({
    case_id: 'importer-redaction-no-go-source-immutable',
    status: 'fail',
    error_code: 'IMPORTER_PARITY_CHECK_FAILED',
  })}\n`);
  process.exitCode = 1;
});
