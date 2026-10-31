import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRepositories, restoreQuarantinePath, withOfflineDatabase } from '@dutydeck/storage';
import { createBackup, inspectBackup, restoreBackup } from './backup.js';
import { PluginBindings } from './plugins/bindings.js';
import { PluginStore, treeDigest } from './plugins/store.js';
import { AUTH_TOKEN_CONFIG_KEY, SHARE_LINK_SECRET_CONFIG_KEY, loadOrCreateAuthToken, loadOrCreateShareLinkSecret } from './auth/auth.js';
import { startLocalServer } from './service.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-backup-test-')); roots.push(root);
  const dataDir = join(root, 'source'); mkdirSync(dataDir);
  const database = join(dataDir, 'source.db'), repos = createRepositories(database);
  repos.close();
  return { root, dataDir, database, output: join(root, 'archive') };
}
function editManifest(archive: string, change: (manifest: any) => void) {
  const path = join(archive, 'manifest.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  change(manifest); writeFileSync(path, JSON.stringify(manifest));
}
function rehashDatabase(archive: string) {
  editManifest(archive, manifest => { manifest.entries.find((entry: any) => entry.path === 'dutydeck.db').sha256 = createHash('sha256').update(readFileSync(join(archive, 'dutydeck.db'))).digest('hex'); });
}

describe('offline portable backup', () => {
  it('captures committed WAL data, restores twice-openable SQLite and blocks execution while preserving unknown tasks', async () => {
    const f = fixture(), db = new Database(f.database);
    db.pragma('journal_mode=WAL');
    db.exec("CREATE TABLE backup_sample(id PRIMARY KEY, parent REFERENCES backup_sample(id)); INSERT INTO backup_sample VALUES(1,NULL)");
    // Use real persisted attempts: the external submission has no known result.
    db.exec("INSERT INTO sessions(id,agent_id,state,cwd,run_id,created_at,updated_at) VALUES('s','agent','error','/external','run','now','now'); INSERT INTO tasks(id,session_id,prompt,status,created_at,updated_at,current_attempt_id) VALUES('t','s','external write','interrupted','now','now','attempt'); INSERT INTO task_attempts(id,task_id,session_id,run_id,number,revision,state,submission_state,json) VALUES('attempt','t','s','run',1,1,'reconcile_required','intent_recorded','{}')");
    const created = await createBackup(f); db.close();
    expect(created.status).toBe('offline-backup');
    expect(lstatSync(f.output).mode & 0o777).toBe(0o700);
    const inspection = inspectBackup(f.output);
    for (const entry of inspection.manifest.entries.filter(entry => entry.kind === 'file')) expect(lstatSync(join(f.output, entry.path)).mode & 0o777).toBe(0o600);
    const result = restoreBackup({ archive: f.output, target: join(f.root, 'restored') });
    expect(result.status).toBe('quarantined'); expect(result.missing.join(' ')).toContain('External credential files only');
    expect(existsSync(restoreQuarantinePath(result.database))).toBe(true);
    for (let i = 0; i < 2; i++) {
      const repos = createRepositories(result.database);
      expect((await repos.tasks.get('t'))?.status).toBe('interrupted');
      expect(() => repos.control.attachRuntime('restore-test')).toThrow(/quarantined/);
      repos.close();
    }
    expect(() => createRepositories(result.database, { mode: 'runtime' })).toThrow(/quarantined/);
    const alias = join(result.target, 'alias.db'); symlinkSync(result.database, alias);
    await expect(startLocalServer({ env: { DUTYDECK_DATABASE_URL: alias } })).rejects.toThrow(/quarantined/);
    await expect(startLocalServer({ env: { DUTYDECK_DEFAULT_CWD: result.target, DUTYDECK_DATABASE_URL: 'dutydeck.db' } })).rejects.toThrow(/quarantined/);
    const restored = new Database(result.database, { readonly: true });
    expect(restored.prepare('SELECT state,submission_state FROM task_attempts').get()).toEqual({ state: 'reconcile_required', submission_state: 'intent_recorded' });
    expect(restored.prepare('SELECT * FROM backup_sample').all()).toEqual([{ id: 1, parent: null }]);
    expect(restored.pragma('foreign_key_check')).toEqual([]); restored.close();
  });

  it('preserves real database authentication material and reports only external credential files as excluded', async () => {
    const f = fixture(), repos = createRepositories(f.database);
    const { token } = await loadOrCreateAuthToken(repos.config);
    const signingKey = await loadOrCreateShareLinkSecret(repos.config); repos.close();
    const created = await createBackup(f), inspected = inspectBackup(f.output);
    const restored = restoreBackup({ archive: f.output, target: join(f.root, 'restored') });
    const warning = inspected.manifest.excluded.find(item => item.startsWith('External credential files only'))!;
    expect(warning).toContain('full SQLite is retained');
    expect(warning).toContain('authentication tokens, signing keys and private content');
    for (const result of [created, inspected, restored]) {
      expect(result.missing).toContain(warning);
      const output = JSON.stringify(result);
      expect(output.includes(token)).toBe(false); expect(output.includes(signingKey)).toBe(false);
    }
    for (const database of [join(f.output, 'dutydeck.db'), restored.database]) {
      const db = new Database(database, { readonly: true });
      try {
        expect(db.prepare('SELECT value FROM configs WHERE key=?').pluck().get(AUTH_TOKEN_CONFIG_KEY) === token).toBe(true);
        expect(db.prepare('SELECT value FROM configs WHERE key=?').pluck().get(SHARE_LINK_SECRET_CONFIG_KEY) === signingKey).toBe(true);
      } finally { db.close(); }
    }
  });

  it('omits an entire supported symlink plugin as a missing dependency while restoring other data in quarantine', async () => {
    const f = fixture(), source = join(f.root, 'linked-plugin');
    mkdirSync(join(source, '.dutydeck-plugin'), { recursive: true });
    writeFileSync(join(source, '.dutydeck-plugin/plugin.json'), JSON.stringify({ name: 'linked-backup', version: '1.0.0' }));
    writeFileSync(join(source, 'actual.mjs'), 'export default "WHOLE_PLUGIN_MUST_BE_OMITTED";');
    symlinkSync('actual.mjs', join(source, 'helper.mjs'));
    const store = new PluginStore(f.dataDir, undefined, f.database), entry = await store.install(source);
    expect(lstatSync(join(store.pluginDir('linked-backup'), 'helper.mjs')).isSymbolicLink()).toBe(true);
    const packagePath = `plugins/.artifacts/linked-backup/${entry.active!.id}`;
    const created = await createBackup(f), inspected = inspectBackup(f.output);
    const missing = `Immutable plugin package with symbolic links (not copied): linked-backup/${entry.active!.id}`;
    expect(created.missing).toContain(missing); expect(inspected.manifest.missing).toContain(missing);
    expect(inspected.manifest.entries.some(component => component.path.startsWith(packagePath))).toBe(false);
    expect(existsSync(join(f.output, packagePath))).toBe(false);
    expect(inspected.status).toBe('quarantined');
    const restored = restoreBackup({ archive: f.output, target: join(f.root, 'restored') });
    expect(restored.status).toBe('quarantined'); expect(restored.missing).toContain(missing);
    expect(existsSync(join(restored.target, packagePath))).toBe(false);
    const repos = createRepositories(restored.database);
    expect(() => repos.control.attachRuntime('linked-restore')).toThrow(/quarantined/); repos.close();
  });

  it('rejects live repositories and raw SQLite writers; releases locks on failure', async () => {
    const f = fixture(), repos = createRepositories(f.database);
    await expect(createBackup(f)).rejects.toThrow(/DATABASE_UPGRADE_BUSY/); repos.close();
    const raw = new Database(f.database, { timeout: 0 }); raw.exec('BEGIN IMMEDIATE');
    await expect(createBackup(f)).rejects.toThrow(/locked/); raw.close();
    await expect(createBackup(f)).resolves.toMatchObject({ status: 'offline-backup' });
  });

  it('prevents new raw writers and repository startup during the filesystem snapshot', async () => {
    const f = fixture();
    await withOfflineDatabase(f.database, async () => {
      const writer = new Database(f.database, { timeout: 0 });
      expect(() => writer.exec("INSERT INTO configs VALUES('racing','2')")).toThrow(/locked/);
      writer.close();
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import Database from ${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))}; const db=new Database(process.argv[1],{timeout:0});try { db.exec("INSERT INTO configs VALUES('child-racing','2')");process.exitCode=1; } catch(error) { process.exitCode=error.code==='SQLITE_BUSY'?0:2; } finally {db.close();}`, f.database], { env: { PATH: process.env.PATH, HOME: f.root }, encoding: 'utf8' });
      expect(child.status, child.stderr).toBe(0);
      expect(() => createRepositories(f.database)).toThrow(/locked|MAINTENANCE/);
    });
    const repos = createRepositories(f.database); expect(await repos.config.get('racing')).toBeUndefined(); repos.close();
  });

  it('uses the existing plugin writer locks and rejects competing binding changes', async () => {
    const f = fixture(); mkdirSync(join(f.dataDir, 'plugins'));
    const lock = new Database(join(f.dataDir, 'plugins/.binding-lock.sqlite')); lock.exec('BEGIN IMMEDIATE');
    await expect(createBackup(f)).rejects.toThrow(/locked/);
    const bindings = new PluginBindings(f.dataDir, () => undefined);
    expect(() => bindings.save({ plugin: 'test', botAppId: 'bot', enabled: true, config: {}, secrets: {}, skills: [], expectedRevision: 0 }, { name: 'test' } as any)).toThrow(/Another binding update/);
    lock.close();
    await expect(createBackup(f)).resolves.toMatchObject({ status: 'offline-backup' });
  });

  it('holds both real plugin locks throughout the actual database backup', async () => {
    // VACUUM INTO runs in a worker thread: probe the locks when it starts and when it exits, before createBackup resumes.
    const f = fixture(), original = Worker.prototype.emit, probes: string[] = [];
    const spy = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
      if (event === 'online' || event === 'exit') for (const name of ['.config-lock.sqlite', '.binding-lock.sqlite']) {
        const competitor = new Database(join(f.dataDir, 'plugins', name), { timeout: 0 });
        try { competitor.exec('BEGIN IMMEDIATE'); probes.push(`${String(event)} ${name} unlocked`); }
        catch (error) { probes.push(`${String(event)} ${name} ${/locked/.test(String(error)) ? 'locked' : String(error)}`); }
        finally { competitor.close(); }
      }
      if (event === 'exit') probes.push(`exit ${args[0]}`);
      return original.call(this, event, ...args);
    });
    try { await createBackup(f); } finally { spy.mockRestore(); }
    expect(probes).toEqual([
      'online .config-lock.sqlite locked', 'online .binding-lock.sqlite locked',
      'exit .config-lock.sqlite locked', 'exit .binding-lock.sqlite locked', 'exit 0'
    ]);
  });

  it('preserves immutable artifact identity and excludes secret files', async () => {
    const f = fixture(), plugin = join(f.dataDir, 'plugins'), source = join(plugin, 'package'); mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'run.mjs'), 'export {}'); chmodSync(join(source, 'run.mjs'), 0o755);
    const id = await treeDigest(source), artifacts = join(plugin, '.artifacts/test'); mkdirSync(artifacts, { recursive: true });
    const { renameSync } = await import('node:fs'); renameSync(source, join(artifacts, id));
    writeFileSync(join(plugin, 'plugins.lock.json'), JSON.stringify({ version: 1, plugins: { test: { active: { id } } } }));
    writeFileSync(join(plugin, '.trigger-tokens.json'), 'DO-NOT-COPY');
    writeFileSync(join(f.dataDir, '.env'), 'DO-NOT-COPY');
    await createBackup(f);
    expect(existsSync(join(f.output, 'plugins/.trigger-tokens.json'))).toBe(false);
    expect(readFileSync(join(f.output, 'manifest.json'), 'utf8')).not.toContain('DO-NOT-COPY');
    const result = restoreBackup({ archive: f.output, target: join(f.root, 'restored') });
    expect(await treeDigest(join(result.target, 'plugins/.artifacts/test', id))).toBe(id);
    writeFileSync(join(f.dataDir, 'plugins/.artifacts/test', id, 'run.mjs'), 'changed');
    await expect(createBackup({ ...f, output: join(f.root, 'changed') })).rejects.toThrow(/artifact hash mismatch/);
    const component = `plugins/.artifacts/test/${id}/run.mjs`;
    writeFileSync(join(f.output, component), 'altered archive');
    editManifest(f.output, manifest => { manifest.entries.find((entry: any) => entry.path === component).sha256 = createHash('sha256').update('altered archive').digest('hex'); });
    expect(() => inspectBackup(f.output)).toThrow(/artifact identity mismatch/);
  });

  it('copies only database-referenced immutable artifact bytes and refuses mismatched generations', async () => {
    const f = fixture(), id = 'a'.repeat(64), bytes = Buffer.from('immutable captured artifact');
    const directory = join(f.dataDir, 'artifact-snapshots'); mkdirSync(directory, { mode: 0o700 });
    const file = join(directory, `${id}.bin`); writeFileSync(file, bytes, { mode: 0o600 });
    writeFileSync(join(directory, `${'b'.repeat(64)}.bin`), 'orphan');
    writeFileSync(join(directory, '.tmp-pending'), 'uncommitted');
    const repos = createRepositories(f.database);
    await repos.config.set(`artifact.snapshot.${id}`, JSON.stringify({ version: 1, id, sessionId: 's', taskId: 't', attemptId: 'a', eventId: 'e', sequence: 1, partIndex: 0, revision: 1, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), capturedAt: new Date().toISOString(), mimeType: 'text/plain', name: 'captured.txt' })); repos.close();
    await createBackup(f);
    expect(readFileSync(join(f.output, 'artifact-snapshots', `${id}.bin`))).toEqual(bytes);
    expect(existsSync(join(f.output, 'artifact-snapshots', `${'b'.repeat(64)}.bin`))).toBe(false);
    expect(existsSync(join(f.output, 'artifact-snapshots/.tmp-pending'))).toBe(false);
    const result = restoreBackup({ archive: f.output, target: join(f.root, 'restored') });
    expect(readFileSync(join(result.target, 'artifact-snapshots', `${id}.bin`))).toEqual(bytes);
    writeFileSync(file, 'new generation');
    await expect(createBackup({ ...f, output: join(f.root, 'bad-generation') })).rejects.toThrow(/snapshot size or hash mismatch/);
    rmSync(file);
    await expect(createBackup({ ...f, output: join(f.root, 'missing') })).rejects.toThrow(/snapshot is missing/);
    const linkedSource = join(f.dataDir, 'linked-source'); writeFileSync(linkedSource, bytes); symlinkSync(linkedSource, file);
    await expect(createBackup({ ...f, output: join(f.root, 'linked-snapshot') })).rejects.toThrow(/Symbolic links/);
    const archiveFile = join(f.output, 'artifact-snapshots', `${id}.bin`);
    writeFileSync(archiveFile, 'changed');
    editManifest(f.output, manifest => { manifest.entries.find((entry: any) => entry.path === `artifact-snapshots/${id}.bin`).sha256 = createHash('sha256').update('changed').digest('hex'); });
    expect(() => inspectBackup(f.output)).toThrow(/snapshot size or hash mismatch/);
  });

  it.each(['hash', 'schema', 'corrupt', 'traversal', 'symlink', 'unlisted', 'foreign-key'])('rejects %s before creating a restore target', async kind => {
    const f = fixture(); await createBackup(f);
    const file = join(f.output, 'dutydeck.db');
    if (kind === 'hash') writeFileSync(file, 'tampered');
    if (kind === 'schema') editManifest(f.output, manifest => { manifest.schema++; });
    if (kind === 'corrupt') { writeFileSync(file, 'corrupt'); rehashDatabase(f.output); }
    if (kind === 'traversal') editManifest(f.output, manifest => { manifest.entries[0].path = '../escape'; });
    if (kind === 'symlink') { rmSync(file); symlinkSync(f.database, file); }
    if (kind === 'unlisted') writeFileSync(join(f.output, 'unlisted'), 'extra');
    if (kind === 'foreign-key') {
      const db = new Database(file); db.pragma('journal_mode=DELETE'); db.pragma('foreign_keys=OFF'); db.exec('CREATE TABLE backup_parent(id PRIMARY KEY); CREATE TABLE backup_child(id REFERENCES backup_parent(id)); INSERT INTO backup_child VALUES(99)'); db.close(); rehashDatabase(f.output);
    }
    const target = join(f.root, 'restore');
    expect(() => restoreBackup({ archive: f.output, target })).toThrow(); expect(existsSync(target)).toBe(false);
  });

  it('refuses existing targets and source symlinks', async () => {
    const f = fixture(); await createBackup(f);
    expect(() => restoreBackup({ archive: f.output, target: f.dataDir })).toThrow(/already exists/);
    const link = join(f.root, 'link.db'); symlinkSync(f.database, link);
    await expect(createBackup({ ...f, database: link, output: join(f.root, 'other') })).rejects.toThrow(/regular file/);
    expect(readFileSync(join(f.output, 'manifest.json'), 'utf8')).not.toContain(f.database);
  });
});
