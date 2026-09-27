import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '../packages/storage/src/index.js';
import { currentProcessIdentity } from '../packages/storage/src/process-identity.js';
import { DutydeckRuntime } from '../packages/agent-runtime/src/index.js';
import { deliverLarkCompletionReaction, larkResultKey, sendLarkFile } from '../apps/server/src/lark/result-delivery.js';
import { split } from '../scripts/split-bot-runtimes.mts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const use = <T>(file: string, f: (db: DatabaseSync) => T) => { const db = new DatabaseSync(file); try { return f(db); } finally { db.close(); } };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-split-')); dirs.push(dir);
  const database = join(dir, 'source.db'), output = join(dir, 'split');
  const repos = createRepositories(database);
  await repos.config.set('lark.bots', JSON.stringify([{ appId: 'cli_aaa', name: 'A', appSecret: 'a', webBaseUrl: 'https://dock.example/' }, { appId: 'cli_bbb', name: 'B', appSecret: 'b' }]));
  await repos.config.set('auth.shareLinkSecret', 'share-secret');
  for (const name of ['aaa', 'bbb']) {
    await repos.secretRefs.create({ id: `secret_${name}`, kind: 'lark_app_secret', provider: 'live_lark_config', referenceKey: `cli_${name}`, status: 'configured' });
    await repos.channelBots.create({ id: `bot_${name}`, channel: 'lark', externalAppId: `cli_${name}`, displayName: name, brand: 'feishu', credentialRef: `secret_${name}`, state: 'staged' });
  }
  const time = '2026-01-01T00:00:00.000Z';
  for (const [id, source, sourceId] of [['a', 'lark', 'cli_aaa:chat:thread'], ['b', 'lark-memory', 'cli_bbb:chat:memory'], ['w', undefined, undefined]] as const) {
    await repos.sessions.save({ id, agentId: 'agent', state: 'idle', cwd: '/tmp', source, sourceId, runId: `run_${id}`, createdAt: time, updatedAt: time });
    await repos.tasks.save({ id: `t_${id}`, sessionId: id, prompt: `history ${id}`, status: id === 'b' ? 'queued' : 'completed', createdAt: time, updatedAt: time });

  }
  repos.execution.upgradeLegacy(); repos.close();
  use(database, db => {
    for (const id of ['a', 'b', 'w']) db.prepare('INSERT INTO configs VALUES (?,?)').run(`runtime_native_context:${id}`, JSON.stringify({ sessionId: id, native: `native_${id}` }));
    // Native selection above is legacy fixture data, retained byte-for-byte by the partitioner.
    db.prepare('INSERT INTO events(id,session_id,sequence,type,timestamp,data) VALUES (?,?,?,?,?,?)').run('ev_a', 'a', 1, 'text', time, '{"text":"history"}');
    db.prepare('INSERT INTO channel_mappings(id,channel,external_id,session_id,extra,created_at) VALUES (?,?,?,?,?,?)').run('map_a', 'lark-card:cli_aaa', 'om_a', 'a', '{}', time);
  });
  return { database, output, cliFile: process.execPath, peers: [] };
}

describe('offline bot partitions', () => {
  it('preserves automatic task admissions in only the owning bot partition', async () => {
    const f = await fixture();
    use(f.database, db => {
      const insert = db.prepare('INSERT INTO usage_background_admissions VALUES (?, ?, ?, ?)');
      insert.run('cli_aaa', '2026-09', 'root-a', '2026-09-26T00:00:00Z');
      insert.run('cli_bbb', '2026-09', 'root-b', '2026-09-26T00:01:00Z');
    });
    const original = use(f.database, db => db.prepare('SELECT * FROM usage_background_admissions ORDER BY app_id').all());
    expect(split(f).blockers).toEqual([]);
    split({ ...f, apply: true });
    for (const [shard, expected] of [['cli_aaa', [original[0]]], ['cli_bbb', [original[1]]], ['web', []]] as const) {
      expect(use(join(f.output, shard, 'dutydeck.db'), db => db.prepare('SELECT * FROM usage_background_admissions').all())).toEqual(expected);
    }
    const repos = createRepositories(join(f.output, 'cli_aaa/dutydeck.db'));
    try {
      expect(await repos.usage.backgroundTaskCounts('2026-09')).toEqual([{ appId: 'cli_aaa', tasks: 1 }]);
      expect(await repos.usage.claimBackgroundTask('cli_aaa', '2026-09', 'root-a', 1)).toBe(true);
      expect(await repos.usage.claimBackgroundTask('cli_aaa', '2026-09', 'new-root', 1)).toBe(false);
    } finally { repos.close(); }
  });

  it('preserves exact history and native context in one shard; web contains no bot sessions', async () => {
    const f = await fixture();
    const before = use(f.database, db => db.prepare('SELECT * FROM sessions').all());
    const plan = split(f); expect(plan.blockers).toEqual([]); expect(existsSync(f.output)).toBe(false);
    const result = split({ ...f, apply: true, peers: [{ id: 'tag', name: 'Tag', url: 'http://127.0.0.1:4311' }] });
    expect(result.blockers).toEqual([]);
    expect(use(f.database, db => db.prepare('SELECT * FROM sessions').all())).toEqual(before);
    expect(use(f.database, db => db.prepare("SELECT value FROM configs WHERE key='dutydeck.bot_process_migration'").get())).toBeTruthy();
    for (const [shard, session] of [['cli_aaa', 'a'], ['cli_bbb', 'b'], ['web', 'w']]) {
      const file = join(f.output, shard!, 'dutydeck.db');
      use(file, db => {
        expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: session }]);
        expect(db.prepare('SELECT external_app_id FROM channel_bots').all()).toEqual(shard === 'web' ? [] : [{ external_app_id: shard }]);
        expect(db.prepare('SELECT reference_key FROM secret_refs').all()).toEqual(shard === 'web' ? [] : [{ reference_key: shard }]);
        expect(db.prepare('SELECT COUNT(*) AS n FROM foundation_entity_versions').get()?.n).toBe(shard === 'web' ? 0 : 2);
        expect(db.prepare('SELECT session_id FROM tasks').all()).toEqual([{ session_id: session }]);
        expect(db.prepare('SELECT status FROM tasks').get()?.status).toBe(session === 'b' ? 'queued' : 'completed');
        expect(db.prepare("SELECT key FROM configs WHERE key LIKE 'runtime_native_context:%'").all()).toEqual([{ key: `runtime_native_context:${session}` }]);
        expect(db.prepare('SELECT COUNT(*) AS n FROM dutydeck_access').get()?.n).toBe(0);
        const s = statSync(file); expect(db.prepare('SELECT entity FROM dutydeck_control').get()?.entity).toBe(`${s.dev}:${s.ino}`);
      });
      const repos = createRepositories(file); repos.close(); // Real inode fencing accepts each new database.
    }
    const peers = JSON.parse(readFileSync(join(f.output, 'peers.json'), 'utf8'));
    expect(peers.map((p: any) => p.id)).toEqual(['bot-cli-aaa', 'bot-cli-bbb', 'tag']);
    expect(use(join(f.output, 'web/dutydeck.db'), db => JSON.parse(db.prepare("SELECT value FROM configs WHERE key='dutydeck.bot_session_routes'").get()!.value as string))).toEqual({ version: 1, routes: { a: 'bot-cli-aaa', b: 'bot-cli-bbb' } });
    const bot = use(join(f.output, 'cli_aaa/dutydeck.db'), db => JSON.parse(db.prepare("SELECT value FROM configs WHERE key='lark.bots'").get()!.value as string));
    expect(bot).toHaveLength(1); expect(bot[0].webBaseUrl).toBe('https://dock.example/instances/bot-cli-aaa');
    expect(readFileSync(join(f.output, 'cli_aaa/dutydeck-cli-aaa.service'), 'utf8')).toContain('DUTYDECK_DAEMON_DIR=');
    expect(() => split({ ...f, apply: true })).toThrow('OUTPUT_ALREADY_EXISTS');
    expect(split({ ...f, output: f.output + '-again' }).blockers).toContain('SOURCE_ALREADY_MIGRATED_OR_PARTITIONED');
  });

  it('resolves actual delivery records from process cards while bots share an incoming root', async () => {
    const f = await fixture();
    const resultKey = (id: string) => `lark.delivery.result_${createHash('sha256').update(id).digest('hex').slice(0, 40)}.summary`;
    use(f.database, db => {
      const mapping = db.prepare('INSERT INTO channel_mappings(id,channel,external_id,session_id,extra,created_at) VALUES (?,?,?,?,?,?)');
      for (const [app, session] of [['cli_aaa', 'a'], ['cli_bbb', 'b']]) {
        mapping.run(`root_${session}`, `lark-card:${app}`, 'om_shared_root', session!, JSON.stringify({ card_message_id: `om_process_${session}`, turn: 1 }), '2026-01-01T00:00:00.000Z');
        mapping.run(`silent_${session}`, `lark-card:${app}`, 'om_shared_silent_root', session!, JSON.stringify({ turn: 1 }), '2026-01-01T00:00:00.000Z');
        db.prepare('INSERT INTO configs VALUES (?,?)').run(resultKey(`om_process_${session}`), JSON.stringify({ messageId: `om_final_${session}`, elements: [] }));
      }
    });
    expect(split(f).blockers).toEqual([]);
    split({ ...f, apply: true });
    for (const [app, session] of [['cli_aaa', 'a'], ['cli_bbb', 'b']]) expect(use(join(f.output, app!, 'dutydeck.db'), db => db.prepare("SELECT key FROM configs WHERE key LIKE 'lark.delivery.%'").all())).toEqual([{ key: resultKey(`om_process_${session}`) }]);
    // A shared silent anchor with an actual receipt cannot be assigned safely.
    const g = await fixture();
    use(g.database, db => {
      const mapping = db.prepare('INSERT INTO channel_mappings(id,channel,external_id,session_id,extra,created_at) VALUES (?,?,?,?,?,?)');
      for (const [app, session] of [['cli_aaa', 'a'], ['cli_bbb', 'b']]) mapping.run(`root_${session}`, `lark-card:${app}`, 'om_shared', session!, '{"turn":1}', '2026-01-01T00:00:00.000Z');
      db.prepare('INSERT INTO configs VALUES (?,?)').run(resultKey('silent:om_shared:1'), '{}');
    });
    expect(split(g).blockers).toContain(`DELIVERY_OWNERSHIP_AMBIGUOUS:${resultKey('silent:om_shared:1').split('.')[2]}`);
  });

  it('partitions previous-turn summaries, result attachments and reactions produced by Lark delivery', async () => {
    const f = await fixture(), repos = createRepositories(f.database);
    const keys = new Map<string, string[]>();
    try {
      for (const [appId, session] of [['cli_aaa', 'a'], ['cli_bbb', 'b']]) {
        await repos.channelMappings.save({ id: `history_${session}`, channel: `lark-card:${appId}`, externalId: 'om_shared_history_root', sessionId: session!, createdAt: '2026-01-01T00:00:00.000Z', extra: JSON.stringify({ app_id: appId, card_message_id: `om_current_${session}`, turn: 2, earlier_message_ids: [`om_old_process_${session}`, `om_old_result_${session}`] }) });
        const result = larkResultKey(`om_old_process_${session}`), final = `final_${createHash('sha256').update(session!).digest('hex').slice(0, 40)}`;
        await repos.config.set(`lark.delivery.${result}.summary`, JSON.stringify({ messageId: `om_old_result_${session}`, elements: [] }));
        // Even when its process-card hash is no longer reconstructible, the receipt's earlier result ID identifies the owner.
        const earlierResultKey = `result_${'f'.repeat(39)}${session === 'a' ? 'a' : 'b'}`;
        await repos.config.set(`lark.delivery.${earlierResultKey}.summary`, JSON.stringify({ messageId: `om_old_result_${session}`, elements: [] }));
        await repos.config.set(`lark.explicit_final.${session}`, JSON.stringify({ provider_uuid: final, scope: { app_id: appId, session_id: session } }));
        const service = { uploadFile: async () => `file_${session}`, sendFile: async () => ({ messageId: `om_attachment_${session}` }), addReaction: async (messageId: string) => ({ messageId, reactionId: `reaction_${session}` }) };
        for (const providerId of [result, final, earlierResultKey]) await sendLarkFile(service as any, { chatId: 'oc_shared' }, { data: Buffer.from('history'), filename: 'result.md', idempotencyKey: `result_file_${createHash('sha256').update(providerId).digest('hex').slice(0, 36)}` }, { warn: vi.fn() }, repos.config);
        expect(await deliverLarkCompletionReaction(service, { appId: appId!, messageId: 'om_shared_history_root' }, { warn: vi.fn() }, repos.config)).toBe(true);
        keys.set(appId!, (await repos.config.list!('lark.')).map(r => r.key).filter(key => key !== 'lark.bots' && ![...keys.values()].flat().includes(key)));
      }
    } finally { repos.close(); }
    expect(split(f).blockers).toEqual([]); split({ ...f, apply: true });
    for (const [appId, expected] of keys) expect(use(join(f.output, appId, 'dutydeck.db'), db => db.prepare("SELECT key FROM configs WHERE key LIKE 'lark.%' AND key!='lark.bots' ORDER BY key").all().map(r => r.key))).toEqual(expected.sort());
    expect(use(join(f.output, 'web/dutydeck.db'), db => db.prepare("SELECT COUNT(*) AS n FROM configs WHERE key LIKE 'lark.delivery.%' OR key LIKE 'lark.reaction.%'").get()?.n)).toBe(0);
  });

  it('rejects trace exports and ambiguous previous-turn attachment ownership', async () => {
    const f = await fixture(), shared = larkResultKey('om_shared_old_process');
    const fileKey = `lark.delivery.result_file_${createHash('sha256').update(shared).digest('hex').slice(0, 36)}.upload`;
    use(f.database, db => {
      const insert = db.prepare('INSERT INTO channel_mappings(id,channel,external_id,session_id,extra,created_at) VALUES (?,?,?,?,?,?)');
      for (const [app, session] of [['cli_aaa', 'a'], ['cli_bbb', 'b']]) insert.run(`earlier_${session}`, `lark-card:${app}`, `om_root_${session}`, session!, JSON.stringify({ card_message_id: `om_now_${session}`, earlier_message_ids: ['om_shared_old_process'] }), '2026-01-01T00:00:00.000Z');
      db.prepare('INSERT INTO configs VALUES (?,?)').run(fileKey, JSON.stringify('file_unattributed'));
      db.prepare('INSERT INTO configs VALUES (?,?)').run('lark.delivery.trace_abc.upload', JSON.stringify('file_trace'));
      db.prepare('INSERT INTO configs VALUES (?,?)').run('lark.delivery.trace_abc.message', JSON.stringify({ messageId: 'om_trace' }));
    });
    expect(split(f).blockers).toEqual(expect.arrayContaining([`DELIVERY_OWNERSHIP_AMBIGUOUS:${fileKey.split('.')[2]}`, 'TRACE_EXPORT_OWNERSHIP_UNSUPPORTED:lark.delivery.trace_abc.upload', 'TRACE_EXPORT_OWNERSHIP_UNSUPPORTED:lark.delivery.trace_abc.message']));
    expect(() => split({ ...f, apply: true })).toThrow('MIGRATION_BLOCKED');
    expect(use(f.database, db => db.prepare("SELECT value FROM configs WHERE key='dutydeck.bot_process_migration'").get())).toBeUndefined();
  });

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/systemd-analyze'))('emits units accepted by systemd, including paths containing spaces and percent signs', async () => {
    const f = await fixture(); f.output += ' space % path';
    split({ ...f, apply: true });
    const files = ['web', 'cli_aaa', 'cli_bbb'].map(shard => join(f.output, shard, `dutydeck-${shard.replaceAll('_', '-')}.service`));
    const result = spawnSync('/usr/bin/systemd-analyze', ['--user', 'verify', ...files], { encoding: 'utf8' });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  });

  it('persists startup defaults in each local .env and Node loads them after daemon state is absent', async () => {
    const f = await fixture(); f.output += ' env space # percent%';
    const cwd = join(f.output, 'workspace with spaces');
    split({ ...f, apply: true, cwd, webHost: '0.0.0.0', webPort: 4310 });
    for (const [shard, port] of [['web', '4310'], ['cli_aaa', '4401'], ['cli_bbb', '4402']]) {
      const dir = join(f.output, shard!), envFile = join(dir, '.env'), parsed = parseEnv(readFileSync(envFile, 'utf8'));
      expect(parsed).toMatchObject({ DUTYDECK_DATABASE_URL: join(dir, 'dutydeck.db'), DUTYDECK_DAEMON_DIR: join(dir, '.dutydeck/daemon'), DUTYDECK_SYSTEMD_UNIT: `dutydeck-${shard!.replaceAll('_', '-')}.service`, DUTYDECK_HOST: shard === 'web' ? '0.0.0.0' : '127.0.0.1', DUTYDECK_PORT: port, DUTYDECK_DEFAULT_CWD: cwd });
      if (shard === 'web') { expect(parsed).not.toHaveProperty('DUTYDECK_BOT_APP_ID'); expect(JSON.parse(parsed.DUTYDECK_INSTANCES_JSON!)).toHaveLength(2); }
      else expect(parsed).toMatchObject({ DUTYDECK_BOT_APP_ID: shard, DUTYDECK_LOCAL_ONLY: 'true' });
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      expect(existsSync(parsed.DUTYDECK_DAEMON_DIR!)).toBe(false);
      const env = { ...process.env }; for (const key of Object.keys(parsed)) delete env[key];
      const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', "import { loadEnvFile } from 'node:process'; loadEnvFile(); console.log(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(key => [key, process.env[key]]))))", JSON.stringify(Object.keys(parsed))], { cwd: dir, env, encoding: 'utf8' });
      expect({ status: loaded.status, stderr: loaded.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(loaded.stdout)).toEqual(parsed);
    }
  });

  it('preserves real native selection, operation provenance and ledger graph across new inode identity', async () => {
    const f = await fixture(), repos = createRepositories(f.database), claim = repos.control.attachRuntime('native-source');
    const x = repos.execution.bind(claim), fence = { sessionId: 'native', runId: 'run_native' };
    x.createSession({ id: fence.sessionId, runId: fence.runId, agentId: 'agent', state: 'idle', cwd: '/tmp', source: 'lark', sourceId: 'cli_bbb:chat:native', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const expected = { nativeCreationId: 'creation', sessionKey: 'native', agent: 'agent', command: ['unused'], cwd: '/tmp', executionDomain: 'local' };
    const root = x.beforeControlledOperation(fence, { resourceId: 'factory', driverInstanceId: 'driver' });
    const native = x.reserveNativeContext(fence, { resourceId: 'native_resource', parentResourceId: root.resourceId, expected });
    x.confirmNativeContext(fence, native.resourceId, native.revision, { ...expected, acpxRecordId: 'native', backendSessionId: 'backend', defaults: { model: 'model' } });
    x.creationFinished(fence, root.resourceId, root.revision, 'created');
    const selection = repos.execution.getNativeContext('native'), resources = repos.execution.getResources('native');
    claim.release(); repos.close();
    split({ ...f, apply: true });
    const target = createRepositories(join(f.output, 'cli_bbb/dutydeck.db'));
    try {
      expect(target.execution.getNativeContext('native')).toEqual(selection);
      expect(target.execution.getResources('native')).toEqual(resources);
      const other = createRepositories(join(f.output, 'cli_aaa/dutydeck.db'));
      try { expect(other.execution.getResources('native')).toEqual([]); } finally { other.close(); }
    } finally { target.close(); }
  });

  it('keeps an unverified local driver blocked after partition and real runtime initialization', async () => {
    const f = await fixture();
    const source = createRepositories(f.database), claim = source.control.attachRuntime('source');
    const x = source.execution.bind(claim), fence = { sessionId: 'blocked', runId: 'run_blocked' };
    x.createSession({ id: fence.sessionId, runId: fence.runId, agentId: 'agent', state: 'idle', cwd: '/tmp', source: 'lark', sourceId: 'cli_aaa:chat:blocked', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    let r = x.beforeCreate(fence, { resourceId: 'local_blocked', kind: 'local_only' });
    r = x.spawned(fence, r.resourceId, r.revision, { identityId: 'identity_blocked', kind: 'local_only', locator: { owner: 'runtime-adapter' } });
    r = x.creationFinished(fence, r.resourceId, r.revision, 'created');
    const block = JSON.stringify({ ...fence, reason: 'stop unverified' });
    await source.config.set(`runtime_driver_stop_block:${fence.sessionId}`, block);
    claim.release(); source.close();
    const original = use(f.database, db => db.prepare('SELECT json FROM driver_resources WHERE id=?').get('local_blocked')!.json);
    split({ ...f, apply: true });
    const repos = createRepositories(join(f.output, 'cli_aaa/dutydeck.db'));
    const factory = vi.fn(() => { throw new Error('must not start any driver'); });
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, driverFactory: factory });
    try {
      await runtime.initialize([{ id: 'agent', name: 'Agent', command: 'unused', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }]);
      await expect(runtime.restart('blocked')).rejects.toMatchObject({ code: 'SESSION_RESOURCE_BLOCKED' });
      expect(factory).not.toHaveBeenCalled();
      expect(await repos.config.get('runtime_driver_stop_block:blocked')).toBe(block);
      expect(use(join(f.output, 'cli_aaa/dutydeck.db'), db => db.prepare('SELECT json FROM driver_resources WHERE id=?').get('local_blocked')!.json)).toBe(original);
    } finally { await runtime.shutdown(); repos.close(); }
  });

  it.each(['missing', 'incomplete'])('rejects v2 with %s legacy startup configuration before retiring the source', async mode => {
    const f = await fixture();
    use(f.database, db => {
      db.exec("UPDATE configuration_authority SET authority='v2'");
      if (mode === 'missing') db.exec("DELETE FROM configs WHERE key='lark.bots'");
      else db.prepare("UPDATE configs SET value=? WHERE key='lark.bots'").run(JSON.stringify([{ appId: 'cli_aaa', name: 'A', appSecret: 'a' }]));
    });
    expect(split(f).blockers).toContain('BOT_STARTUP_CONFIG_UNSUPPORTED:cli_bbb');
    expect(() => split({ ...f, apply: true })).toThrow('BOT_STARTUP_CONFIG_UNSUPPORTED');
    expect(existsSync(f.output)).toBe(false);
    expect(use(f.database, db => db.prepare("SELECT value FROM configs WHERE key='dutydeck.bot_process_migration'").get())).toBeUndefined();
  });

  it('refuses live and unknown process identities without modifying source or writing outputs', async () => {
    const f = await fixture();
    for (const identity of [currentProcessIdentity(), { ...currentProcessIdentity(), host: 'different-host' }]) {
      use(f.database, db => { db.exec('DELETE FROM dutydeck_access'); db.prepare('INSERT INTO dutydeck_access VALUES (?,?)').run('owner', JSON.stringify(identity)); });
      expect(() => split({ ...f, apply: true })).toThrow('SOURCE_OWNER_NOT_PROVEN_DEAD');
      expect(existsSync(f.output)).toBe(false);
      expect(use(f.database, db => db.prepare("SELECT value FROM configs WHERE key='dutydeck.bot_process_migration'").get())).toBeUndefined();
    }
  });

  it('cleans failed staging and leaves the source unretired', async () => {
    const f = await fixture(), original = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (/^CREATE TABLE [\"]?sessions/.test(sql)) throw new Error('injected destination failure');
      return original.call(this, sql);
    });
    try { expect(() => split({ ...f, apply: true })).toThrow('injected destination failure'); } finally { spy.mockRestore(); }
    expect(existsSync(f.output)).toBe(false);
    expect(readdirSync(join(f.database, '..')).some(name => name.includes('.staging-'))).toBe(false);
    expect(use(f.database, db => db.prepare("SELECT value FROM configs WHERE key='dutydeck.bot_process_migration'").get())).toBeUndefined();
  });

  it('rejects database-relative secret files and conflicting existing peer ports', async () => {
    const f = await fixture();
    expect(() => split({ ...f, apply: true, peers: [{ id: 'tag', name: 'Tag', url: 'http://127.0.0.1:4401' }] })).toThrow('INVALID_OR_CONFLICTING_PEER');
    use(f.database, db => db.exec("UPDATE secret_refs SET provider='local-file-v1' WHERE id='secret_aaa'"));
    expect(split(f).blockers).toContain('SECRET_PROVIDER_UNSUPPORTED:local-file-v1:secret_aaa');
  });

  it('refuses ambiguous state, live attempts, unknown populated tables and orphan references', async () => {
    const f = await fixture();
    use(f.database, db => { db.exec("INSERT INTO configs VALUES ('future_runtime:unknown','{}'); CREATE TABLE unknown_state(id TEXT); INSERT INTO unknown_state VALUES ('x'); UPDATE sessions SET source='other' WHERE id='a'; UPDATE tasks SET status='running' WHERE id='t_b'"); });
    const p = split(f); expect(p.blockers).toEqual(expect.arrayContaining(['CONFIG_OWNERSHIP_UNKNOWN:future_runtime:unknown', 'UNSUPPORTED_NONEMPTY_TABLE:unknown_state', 'SESSION_OWNERSHIP_UNKNOWN:a', 'TASK_ACTIVE:t_b']));
    expect(() => split({ ...f, apply: true })).toThrow('MIGRATION_BLOCKED'); expect(existsSync(f.output)).toBe(false);
  });
});
