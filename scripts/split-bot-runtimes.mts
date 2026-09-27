#!/usr/bin/env node
/** Offline partitioner. Never opens Runtime or Repository (both may recover external resources). */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { observeProcess } from '../packages/storage/src/process-identity.ts';

type Row = Record<string, any>;
type Peer = { id: string; name: string; url: string };
export type Options = { database: string; output: string; apply?: boolean; cliFile?: string; cwd?: string; basePort?: number; webHost?: string; webPort?: number; peers?: Peer[] };
const MARKER = 'dutydeck.bot_process_migration';
const sharedTables = new Set(['schema_migrations', 'agent_configs', 'machines', 'projects', 'execution_authority', 'configuration_authority']);
const sessionTables = new Set(['sessions', 'tasks', 'events', 'tool_calls', 'permission_requests', 'errors', 'channel_mappings', 'task_requests', 'task_attempts', 'task_queue_actions', 'driver_resources', 'recovery_decisions']);
const botTables = new Set(['channel_bot_policies', 'group_bindings', 'remote_chat_facts', 'remote_identity_facts', 'role_assignments', 'full_trust_confirmations', 'configuration_changes', 'configuration_versions']);
const appTables = new Set(['collaboration_scopes', 'collaboration_settings', 'collaboration_observations', 'collaboration_bootstraps', 'collaboration_decisions', 'collaboration_feedbacks', 'usage_ledger', 'usage_background_admissions']);
const entityTables: Record<string, string> = { channel_bot: 'channel_bots', secret_ref: 'secret_refs', channel_bot_policy: 'channel_bot_policies', group_binding: 'group_bindings', remote_chat_fact: 'remote_chat_facts', remote_identity_fact: 'remote_identity_facts', role_assignment: 'role_assignments' };
const sharedConfigs = new Set(['auth.accessToken', 'auth.passwordHash', 'auth.shareLinkSecret', 'lark.group_tools.signing_secret', 'relay.signing_secret']);
const q = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const parse = (value: string): any => { try { return JSON.parse(value); } catch { return undefined; } };
const rows = (db: DatabaseSync, table: string): Row[] => db.prepare(`SELECT * FROM ${q(table)}`).all();
const entity = (file: string) => { const s = statSync(file); if (!s.isFile() || s.nlink !== 1) throw new Error('UNSAFE_DATABASE_FILE'); return `${s.dev}:${s.ino}`; };
const fail = (message: string): never => { throw new Error(message); };

export function inspect(db: DatabaseSync, database: string) {
  const schema = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as Row[];
  const tables = schema.filter(r => r.type === 'table').map(r => r.name as string);
  for (const table of ['sessions', 'configs', 'channel_bots', 'dutydeck_control', 'dutydeck_access']) if (!tables.includes(table)) fail(`REQUIRED_TABLE_MISSING:${table}`);
  const config = new Map(rows(db, 'configs').map(r => [r.key, r.value as string]));
  const blockers: string[] = [];
  const warnings: string[] = ['Stop and disable the original unit before apply; old binaries do not enforce the migration marker.'];
  const block = (s: string) => { if (!blockers.includes(s)) blockers.push(s); };
  if (config.has(MARKER) || config.has('dutydeck.bot_process')) block('SOURCE_ALREADY_MIGRATED_OR_PARTITIONED');
  const control = rows(db, 'dutydeck_control')[0];
  if (!control || control.protocol !== 1 || control.entity !== entity(database)) block('SOURCE_CONTROL_IDENTITY_MISMATCH');
  if (control?.phase !== 'idle') block('SOURCE_NOT_IDLE');
  const accesses = rows(db, 'dutydeck_access');
  for (const access of accesses) if (observeProcess(parse(access.identity)) !== 'dead') block(`SOURCE_OWNER_NOT_PROVEN_DEAD:${access.id}`);
  for (const ref of [control?.runtime, control?.maintenance]) if (ref && !accesses.some(a => a.id === ref)) block('SOURCE_OWNER_IDENTITY_MISSING');
  const structured = rows(db, 'channel_bots');
  const legacy = parse(config.get('lark.bots') ?? '[]');
  if (!Array.isArray(legacy)) fail('INVALID_LEGACY_BOTS');
  const authority = tables.includes('configuration_authority') ? rows(db, 'configuration_authority')[0]?.authority : 'legacy';
  const apps: string[] = authority === 'legacy' ? legacy.map(b => b.appId) : structured.map(b => b.external_app_id);
  if (!apps.length || new Set(apps).size !== apps.length || apps.some(a => typeof a !== 'string' || !/^cli_[a-z0-9]+$/.test(a))) fail('INVALID_BOT_APP_IDS');
  // The server's startup guard requires one matching legacy bot even when structured configuration is authoritative.
  for (const appId of apps) {
    if (legacy.filter(bot => bot?.appId === appId).length !== 1 || structured.filter(bot => bot.external_app_id === appId && bot.channel === 'lark' && bot.state !== 'deleted').length > 1) block(`BOT_STARTUP_CONFIG_UNSUPPORTED:${appId}`);
  }
  const shards = ['web', ...apps];
  const sessions = rows(db, 'sessions');
  const owners = new Map<string, string>();
  for (const s of sessions) {
    const owner = s.source == null && s.source_id == null ? 'web' : ['lark', 'lark-memory'].includes(s.source) ? s.source_id?.split(':')[0] : undefined;
    if (!owner || !shards.includes(owner)) block(`SESSION_OWNERSHIP_UNKNOWN:${s.id}`); else owners.set(s.id, owner);
    if (['starting', 'running', 'stopping'].includes(s.state)) block(`SESSION_ACTIVE:${s.id}`);
  }
  const botOwner = new Map(structured.map(b => [b.id, apps.includes(b.external_app_id) ? b.external_app_id : 'retained_source']));
  const secretOwner = new Map<string, string[]>();
  for (const b of structured) if (b.credential_ref) secretOwner.set(b.credential_ref, [...(secretOwner.get(b.credential_ref) ?? []), botOwner.get(b.id)!]);
  const deliveryOwners = new Map<string, Set<string>>();
  const addDeliveryOwner = (id: string, owner: string) => { const owners = deliveryOwners.get(id) ?? new Set<string>(); owners.add(owner); deliveryOwners.set(id, owners); };
  const messageOwners = new Map<string, Set<string>>();
  if (tables.includes('channel_mappings')) for (const m of rows(db, 'channel_mappings')) {
    const owner = owners.get(m.session_id); if (!owner) continue;
    const extra = parse(m.extra ?? '{}');
    if (m.channel === `lark-card:${owner}` && extra) {
      // external_id is the incoming task/root message, shared across bots. Delivery uses the process card or silent-task anchor.
      const anchor = extra.card_message_id ?? `silent:${m.external_id}:${extra.turn ?? 0}`;
      addDeliveryOwner(`result_${createHash('sha256').update(anchor).digest('hex').slice(0, 40)}`, owner);
      for (const id of extra.earlier_message_ids ?? []) addDeliveryOwner(`result_${createHash('sha256').update(id).digest('hex').slice(0, 40)}`, owner);
    }
    for (const id of [extra?.final_message_id, extra?.final_attachment_message_id, ...extra?.earlier_message_ids ?? []]) if (id) { const set = messageOwners.get(id) ?? new Set(); set.add(owner); messageOwners.set(id, set); }
    const set = messageOwners.get(m.external_id) ?? new Set(); set.add(owner); messageOwners.set(m.external_id, set);
  }
  const ownerForSession = (id: string) => owners.get(id) ?? (block(`ORPHAN_SESSION_REFERENCE:${id}`), 'unknown');
  const appOwner = (id: string) => apps.includes(id) ? id : structured.some(b => b.external_app_id === id) ? 'retained_source' : (block(`UNKNOWN_APP_REFERENCE:${id}`), 'unknown');
  for (const [key, value] of config) if (key.startsWith('lark.explicit_final.')) {
    const record = parse(value); if (record?.provider_uuid && record?.scope?.app_id) addDeliveryOwner(record.provider_uuid, appOwner(record.scope.app_id));
  }
  for (const [key, value] of config) {
    const summary = key.match(/^lark\.delivery\.((?:result|final)_[a-f0-9]+)\.summary$/);
    const receipt = parse(value), owners = summary && receipt?.messageId && messageOwners.get(receipt.messageId);
    if (summary && owners?.size === 1) for (const owner of owners) addDeliveryOwner(summary[1]!, owner);
  }
  // prepareLarkResult derives both attachment legs from the result/final provider UUID.
  for (const [id, owners] of [...deliveryOwners]) {
    const fileId = `result_file_${createHash('sha256').update(id).digest('hex').slice(0, 36)}`;
    for (const owner of owners) addDeliveryOwner(fileId, owner);
  }
  const resolveConfig = (r: Row): string[] => {
    const k = r.key as string, value = parse(r.value);
    if (sharedConfigs.has(k)) return shards;
    if (k === 'lark.bots') return shards;
    const sessionMatch = k.match(/^(?:runtime_(?:workspace|native_context|driver_stop_block|driver_configuration|pty_retirement|verification):|legacy_retirement:|lark\.(?:run-context|memory\.turns)\.)([^:.]+)/);
    if (sessionMatch) {
      const owner = ownerForSession(sessionMatch[1]!);
      if (value?.sessionId && value.sessionId !== sessionMatch[1] || value?.appId && appOwner(value.appId) !== owner) block(`CONFIG_CROSS_SHARD_REFERENCE:${k}`);
      return [owner];
    }
    const appMatch = k.match(/^lark\.(?:inbox|context|interaction|reaction|live-owner|memory(?:\.state)?|verification_suggestion|welcomed)\.(cli_[a-z0-9]+)(?:\.|$)/);
    if (appMatch) {
      const owner = appOwner(appMatch[1]!);
      if (value?.sessionId && ownerForSession(value.sessionId) !== owner) block(`CONFIG_CROSS_SHARD_REFERENCE:${k}`);
      return [owner];
    }
    if (k.startsWith('relay.ask.') && value?.sessionId) return [ownerForSession(value.sessionId)];
    if (k.startsWith('lark.principal.') && value?.appId) return [appOwner(value.appId)];
    if (k.startsWith('lark.explicit_final.') && value?.scope?.app_id) {
      const owner = appOwner(value.scope.app_id);
      if (ownerForSession(value.scope.session_id) !== owner) block(`CONFIG_CROSS_SHARD_REFERENCE:${k}`);
      return [owner];
    }
    const delivery = k.match(/^lark\.delivery\.((?:result_file|result|final)_[a-f0-9]+)\./);
    if (delivery && deliveryOwners.has(delivery[1]!)) {
      const owners = deliveryOwners.get(delivery[1]!)!;
      if (owners.size === 1) return [...owners];
      block(`DELIVERY_OWNERSHIP_AMBIGUOUS:${delivery[1]}`); return ['unknown'];
    }
    if (k.startsWith('lark.app_creation.') || k.startsWith('lark.app_creation_owner.')) {
      const record = parse(config.get(k.replace('lark.app_creation_owner.', 'lark.app_creation.')) ?? '{}');
      if (record.status === 'completed' && record.botSaved && record.appId) return [appOwner(record.appId)];
    }
    if (k.startsWith('lark.delivery.trace_')) { block(`TRACE_EXPORT_OWNERSHIP_UNSUPPORTED:${k}`); return ['unknown']; }
    if (k.startsWith('lark.delivery.') && value?.messageId && messageOwners.get(value.messageId)?.size === 1) return [...messageOwners.get(value.messageId)!];
    // App-creation records may still drive polling; unknown/delivery state must never be duplicated.
    block(`CONFIG_OWNERSHIP_UNKNOWN:${k}`); return ['unknown'];
  };
  const entityOwner = new Map<string, string[]>();
  for (const [kind, table] of Object.entries(entityTables)) if (tables.includes(table)) for (const r of rows(db, table)) {
    const target = table === 'channel_bots' ? [botOwner.get(r.id)!] : table === 'secret_refs' ? secretOwner.get(r.id) : [botOwner.get(r.channel_bot_id)!];
    if (target?.every(Boolean)) entityOwner.set(`${kind}:${r.id}`, target);
  }
  function destinations(table: string, r: Row): string[] {
    if (sharedTables.has(table)) return shards;
    if (table === 'dutydeck_control' || table === 'dutydeck_access') return [];
    if (table === 'configs') return resolveConfig(r);
    if (sessionTables.has(table)) return [ownerForSession(table === 'sessions' ? r.id : r.session_id)];
    if (table === 'channel_bots') return [botOwner.get(r.id)!];
    if (table === 'secret_refs') return secretOwner.get(r.id) ?? (block(`SECRET_OWNERSHIP_UNKNOWN:${r.id}`), ['unknown']);
    if (botTables.has(table)) return [botOwner.get(r.channel_bot_id ?? r.bot_id) ?? (block(`BOT_OWNERSHIP_UNKNOWN:${table}`), 'unknown')];
    if (appTables.has(table)) {
      const owner = r.app_id == null && r.session_id ? ownerForSession(r.session_id) : appOwner(r.app_id);
      if (r.session_id && ownerForSession(r.session_id) !== owner) block(`CROSS_SHARD_REFERENCE:${table}`);
      return [owner];
    }
    if (table === 'foundation_entity_versions' || table === 'wp1a_entity_versions') return entityOwner.get(`${r.entity_kind}:${r.entity_id}`) ?? (block(`ENTITY_HISTORY_UNKNOWN:${table}:${r.entity_kind}:${r.entity_id}`), ['unknown']);
    if (table === 'task_execution_commands') {
      const p = parse(r.payload); if (p?.sessionId) return [ownerForSession(p.sessionId)];
    }
    block(`UNSUPPORTED_NONEMPTY_TABLE:${table}`); return ['unknown'];
  }
  const references = new Map<string, Map<string, string>>();
  for (const table of ['tasks', 'task_attempts', 'driver_resources']) if (tables.includes(table)) references.set(table, new Map(rows(db, table).map(r => [r.id, r.session_id])));
  if (db.prepare('PRAGMA foreign_key_check').all().length) block('SOURCE_FOREIGN_KEY_FAILURE');
  const counts: Record<string, Record<string, number>> = {};
  for (const table of tables) {
    counts[table] = { source: 0 };
    for (const r of db.prepare(`SELECT * FROM ${q(table)}`).iterate() as Iterable<Row>) {
      counts[table]!.source!++;
      if (r.session_id) for (const [column, refTable] of [['task_id', 'tasks'], ['attempt_id', 'task_attempts'], ['parent_id', 'driver_resources']]) {
        if (r[column!] && references.get(refTable!)?.get(r[column!]) !== r.session_id) block(`CROSS_SESSION_REFERENCE:${table}:${column}:${r.id ?? r.task_id}`);
      }
      if (table === 'secret_refs' && r.provider !== 'live_lark_config') block(`SECRET_PROVIDER_UNSUPPORTED:${r.provider}:${r.id}`);
      for (const target of destinations(table, r)) counts[table]![target] = (counts[table]![target] ?? 0) + 1;
      if (table === 'tasks' && ['running', 'preparing'].includes(r.status)) block(`TASK_ACTIVE:${r.id}`);
      if (table === 'task_attempts' && ['preparing', 'active'].includes(r.state)) block(`ATTEMPT_ACTIVE:${r.id}`);
      if (table === 'permission_requests' && r.status === 'pending') block(`PERMISSION_PENDING:${r.id}`);
      if (table === 'driver_resources') {
        const resource = parse(r.json), s = sessions.find(s => s.id === r.session_id);
        if (!resource || resource.sessionId !== r.session_id) { block(`RESOURCE_INVALID:${r.id}`); continue; }
        if (s?.archived_at) continue; // initializeOnce never recovers archived sessions; retain original evidence unchanged.
        const last = resource.observations?.at(-1);
        const closed = resource.kind === 'operation' && (['created', 'not_created'].includes(resource.stage) || resource.creationClosure);
        const native = resource.purpose === 'acp_native_context' && (resource.nativeReplacement || resource.stage === 'created' && resource.identity);
        const gone = last?.state === 'gone' || resource.stage === 'not_created';
        if (!closed && !native && !gone) {
          const stopBlock = parse(config.get(`runtime_driver_stop_block:${r.session_id}`) ?? '');
          if (resource.kind === 'legacy' || resource.kind === 'local_only' && stopBlock?.sessionId === r.session_id && stopBlock?.runId === s?.run_id) warnings.push(`RESOURCE_REMAINS_BLOCKED:${r.id}`);
          else block(`RESOURCE_NOT_CLOSED:${r.id}`);
        }
        if (resource.kind === 'process' && resource.identity && observeProcess(resource.identity.locator) !== 'dead') block(`RESOURCE_PROCESS_NOT_PROVEN_DEAD:${r.id}`);
      }
    }
  }
  return { version: 1, database, apps, shards, blockers, warnings, counts, schema, tables, destinations, legacy };
}

function unitQuote(value: string, command = false) { if (/[\r\n\0]/.test(value)) fail('INVALID_UNIT_VALUE'); const quoted = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%'); return '"' + (command ? quoted.replaceAll('$', '$$') : quoted) + '"'; }
function unitPath(value: string) {
  if (!value.startsWith('/') || /[\r\n\0\\]/.test(value) || /\s$/.test(value)) fail('INVALID_UNIT_PATH');
  return value.replaceAll('%', '%%');
}
function shardEnvironment(root: string, appId: string | null, options: Options, peers: Peer[]): Record<string, string> {
  const shard = join(root, appId ?? 'web');
  const port = appId ? (options.basePort ?? 4400) + peers.findIndex(p => p.id === `bot-${appId.replaceAll('_', '-')}`) + 1 : options.webPort ?? 4400;
  return {
    DUTYDECK_DATABASE_URL: join(shard, 'dutydeck.db'), DUTYDECK_DAEMON_DIR: join(shard, '.dutydeck/daemon'),
    DUTYDECK_SYSTEMD_UNIT: `dutydeck-${(appId ?? 'web').replaceAll('_', '-')}.service`, DUTYDECK_SUPERVISOR: 'systemd',
    DUTYDECK_HOST: appId ? '127.0.0.1' : options.webHost ?? '127.0.0.1', DUTYDECK_PORT: String(port),
    DUTYDECK_DEFAULT_CWD: resolve(options.cwd ?? process.cwd()), PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(appId ? { DUTYDECK_BOT_APP_ID: appId, DUTYDECK_LOCAL_ONLY: 'true' } : { DUTYDECK_LOCAL_ONLY: 'false', DUTYDECK_INSTANCES_JSON: JSON.stringify(peers) })
  };
}
export function renderBotProcessEnv(root: string, appId: string | null, options: Options, peers: Peer[]): string {
  const environment = shardEnvironment(root, appId, options, peers);
  // Node loadEnvFile reads .env in the CLI's current directory. Its quoted values are not shell strings.
  return Object.entries(environment).map(([key, value]) => {
    const quote = ["'", '"', '`'].find(candidate => !value.includes(candidate));
    if (!quote || /[\r\n\0]/.test(value)) fail(`ENV_VALUE_UNSUPPORTED:${key}`);
    const line = `${key}=${quote}${value}${quote}\n`;
    if (parseEnv(line)[key] !== value) fail(`ENV_VALUE_NOT_ROUNDTRIPPABLE:${key}`);
    return line;
  }).join('');
}
export function renderUnit(root: string, appId: string | null, options: Options, peers: Peer[]): string {
  const shard = join(root, appId ?? 'web'), env = shardEnvironment(root, appId, options, peers);
  const args = [process.execPath, resolve(options.cliFile ?? 'apps/server/dist/cli.js'), 'start', '--foreground', '--database', env.DUTYDECK_DATABASE_URL!, '--cwd', env.DUTYDECK_DEFAULT_CWD!, '--port', env.DUTYDECK_PORT!, ...(appId ? ['--local-only', '--bot-app-id', appId] : ['--host', env.DUTYDECK_HOST!])];
  return `[Unit]\nDescription=Dutydeck ${appId ?? 'web'}\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nWorkingDirectory=${unitPath(shard)}\n${Object.entries(env).map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`)}\n`).join('')}ExecStart=${args.map(arg => unitQuote(arg, true)).join(' ')}\nRestart=always\nRestartSec=3\nKillMode=process\n\n[Install]\nWantedBy=default.target\n`;
}

export function split(options: Options) {
  const database = realpathSync(options.database), output = resolve(options.output);
  if (existsSync(output)) fail('OUTPUT_ALREADY_EXISTS');
  if (output === dirname(database) || database.startsWith(output + '/')) fail('OUTPUT_CONTAINS_SOURCE');
  const db = new DatabaseSync(database, { readOnly: !options.apply });
  let staging: string | undefined, retired = false;
  try {
    db.exec(options.apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
    const plan = inspect(db, database);
    const report = { version: plan.version, database, outputDirectory: output, apps: plan.apps, blockers: plan.blockers, warnings: plan.warnings, counts: plan.counts, status: options.apply ? 'applied' : 'plan' };
    if (!options.apply) { db.exec('ROLLBACK'); return report; }
    if (plan.blockers.length) fail(`MIGRATION_BLOCKED\n${plan.blockers.join('\n')}`);
    if (!options.cliFile || !statSync(options.cliFile).isFile()) fail('APPLY_REQUIRES_EXISTING_CLI_FILE');
    const basePort = options.basePort ?? 4400, webPort = options.webPort ?? 4400;
    if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535 || webPort > basePort && webPort <= basePort + plan.apps.length) fail('INVALID_OR_CONFLICTING_WEB_PORT');
    if (!Array.isArray(options.peers)) fail('APPLY_REQUIRES_EXPLICIT_EXISTING_PEERS');
    if (!Number.isInteger(basePort) || basePort < 1024 || basePort + plan.apps.length > 65535) fail('INVALID_PORT_RANGE');
    const peers: Peer[] = plan.apps.map((appId, i) => ({ id: `bot-${appId.replaceAll('_', '-')}`, name: plan.legacy.find(b => b.appId === appId)?.name ?? appId, url: `http://127.0.0.1:${basePort + i + 1}` }));
    for (const peer of options.peers ?? []) {
      if (!/^[a-z0-9-]+$/.test(peer.id) || !peer.name || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(peer.url) || peers.some(p => p.id === peer.id || new URL(p.url).port === new URL(peer.url).port) || Number(new URL(peer.url).port) === webPort) fail('INVALID_OR_CONFLICTING_PEER');
      peers.push(peer);
    }
    mkdirSync(dirname(output), { recursive: true });
    staging = `${output}.staging-${randomUUID()}`; mkdirSync(staging, { mode: 0o700 });
    const marker = JSON.stringify({ version: 1, outputDirectory: output, migratedAt: new Date().toISOString() });
    for (const shard of plan.shards) {
      const dir = join(staging, shard); mkdirSync(dir, { mode: 0o700 });
      const file = join(dir, 'dutydeck.db'), target = new DatabaseSync(file);
      try {
        target.exec('PRAGMA foreign_keys=OFF; BEGIN');
        for (const s of plan.schema.filter(s => s.type === 'table')) target.exec(s.sql);
        for (const table of plan.tables) {
          const columns = db.prepare(`PRAGMA table_info(${q(table)})`).all().map(r => r.name as string);
          const insert = target.prepare(`INSERT INTO ${q(table)} (${columns.map(q).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
          for (const r of db.prepare(`SELECT * FROM ${q(table)}`).iterate() as Iterable<Row>) if (plan.destinations(table, r).includes(shard)) {
            if (table === 'configs' && r.key === 'lark.bots') r.value = JSON.stringify(plan.legacy.filter(b => b.appId === shard).map(b => {
              const prefix = `/instances/bot-${shard.replaceAll('_', '-')}`;
              const url = b.webBaseUrl?.replace(/\/+$/, '');
              return url ? { ...b, webBaseUrl: url.endsWith(prefix) ? url : url + prefix } : b;
            }));
            insert.run(...columns.map(c => r[c]));
          }
        }
        for (const table of plan.tables) {
          const count = target.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).get()!.n;
          if (count !== (plan.counts[table]![shard] ?? 0)) fail(`TARGET_COUNT_MISMATCH:${shard}:${table}`);
        }
        for (const s of plan.schema.filter(s => s.type !== 'table')) target.exec(s.sql);
        target.prepare('INSERT INTO dutydeck_control VALUES (1,0,1,\'idle\',NULL,NULL,NULL,0,?)').run(entity(file));
        target.prepare('INSERT OR REPLACE INTO configs VALUES (?,?)').run('dutydeck.bot_process', JSON.stringify({ version: 1, appId: shard === 'web' ? null : shard }));
        if (shard === 'web') target.prepare('INSERT INTO configs VALUES (?,?)').run('dutydeck.bot_session_routes', JSON.stringify({ version: 1, routes: Object.fromEntries(rows(db, 'sessions').filter(s => plan.destinations('sessions', s)[0] !== 'web').map(s => [s.id, `bot-${plan.destinations('sessions', s)[0]!.replaceAll('_', '-')}`])) }));
        target.prepare('INSERT INTO configs VALUES (?,?)').run(MARKER, marker); // staging cannot be started before source retirement
        if (target.prepare('PRAGMA foreign_key_check').all().length) fail(`TARGET_FOREIGN_KEY_FAILURE:${shard}`);
        if (target.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') fail(`TARGET_INTEGRITY_FAILURE:${shard}`);
        target.exec('COMMIT');
      } finally { target.close(); }
      writeFileSync(join(dir, '.env'), renderBotProcessEnv(output, shard === 'web' ? null : shard, options, peers), { mode: 0o600 });
      writeFileSync(join(dir, `dutydeck-${shard.replaceAll('_', '-')}.service`), renderUnit(output, shard === 'web' ? null : shard, options, peers), { mode: 0o600 });
    }
    writeFileSync(join(staging, 'peers.json'), JSON.stringify(peers, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify({ ...report, sourceEntity: entity(database), migratedAt: JSON.parse(marker).migratedAt, retainedSourceOnly: 'Counts marked retained_source are inactive legacy bot metadata; source database is retained in full.' }, null, 2) + '\n', { mode: 0o600 });
    // The write lock spans offline proof, partitioning, validation and source retirement.
    db.prepare('INSERT INTO configs VALUES (?,?)').run(MARKER, marker); db.exec('COMMIT'); retired = true;
    for (const shard of plan.shards) { const target = new DatabaseSync(join(staging, shard, 'dutydeck.db')); try { target.prepare('DELETE FROM configs WHERE key=?').run(MARKER); } finally { target.close(); } }
    renameSync(staging, output); staging = undefined;
    return report;
  } finally {
    try { db.exec('ROLLBACK'); } catch { /* already committed */ }
    db.close();
    if (staging && !retired) rmSync(staging, { recursive: true, force: true });
    if (staging && retired) process.stderr.write(`SOURCE_RETIRED_RECOVERY_REQUIRED: preserve ${staging}; do not restart the source.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { database: { type: 'string' }, output: { type: 'string' }, apply: { type: 'boolean' }, 'cli-file': { type: 'string' }, 'web-host': { type: 'string' }, 'web-port': { type: 'string' }, cwd: { type: 'string' }, 'base-port': { type: 'string' }, 'existing-peers': { type: 'string' } }, strict: true });
    if (!values.database || !values.output) fail('Usage: node --import tsx scripts/split-bot-runtimes.mts --database FILE --output NEW_DIRECTORY [--apply --cli-file /absolute/apps/server/dist/cli.js --web-host HOST --web-port PORT --cwd WORKSPACE --base-port 4400 --existing-peers FILE]');
    if (values.apply && !values['existing-peers']) fail('APPLY_REQUIRES_EXISTING_PEERS_FILE: use [] only after checking the current DUTYDECK_INSTANCES_JSON');
    const report = split({ database: values.database, output: values.output, apply: values.apply, cliFile: values['cli-file'], webHost: values['web-host'], webPort: values['web-port'] ? Number(values['web-port']) : undefined, cwd: values.cwd, basePort: values['base-port'] ? Number(values['base-port']) : undefined, peers: values['existing-peers'] ? JSON.parse(readFileSync(values['existing-peers'], 'utf8')) : undefined });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); if (report.blockers.length) process.exitCode = 2;
  } catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; }
}
