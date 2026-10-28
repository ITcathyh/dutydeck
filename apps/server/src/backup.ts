import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { BACKUP_SCHEMA_VERSION, backupSqlite, restoreQuarantinePath, withOfflineDatabase } from '@dutydeck/storage';
import { treeDigest } from './plugins/store.js';

const exclusions = [
  'External credential files only (.env, local secret-provider files and private-key files); full SQLite is retained and may contain authentication tokens, signing keys and private content',
  'Agent executables, native CLI sessions, external worktrees and working directories',
  'External services, machine-specific environment and systemd configuration',
  'Plugin runtime data, trigger tokens, legacy mutable packages and staging directories',
  'Derived memory/decision views, terminal state and deployment history',
  'Unreferenced artifact snapshots and temporary snapshot files'
];
const entrySchema = z.object({ path: z.string(), kind: z.enum(['file', 'directory']), mode: z.number().int().min(0).max(0o777), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const manifestSchema = z.object({
  format: z.literal('dutydeck-offline-backup'), version: z.literal(1), createdAt: z.string(),
  schema: z.number().int(), database: z.literal('dutydeck.db'),
  consistency: z.literal('offline-database-and-plugin-locks'),
  entries: z.array(entrySchema), missing: z.array(z.string()), excluded: z.array(z.string())
}).strict();
export type BackupManifest = z.infer<typeof manifestSchema>;
function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Invalid backup JSON document'); }
}
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function safePath(root: string, path: string): string {
  if (!path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(path)) throw new Error('Unsafe backup component path');
  const absolute = resolve(root, path);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) throw new Error('Backup component escapes its root');
  let cursor = resolve(root);
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Symbolic links are not accepted in backups');
  }
  return absolute;
}
function regularRoot(path: string): string {
  const absolute = resolve(path);
  if (lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isDirectory()) throw new Error('Expected a real directory');
  return realpathSync(absolute);
}
function newDestination(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute) || (() => { try { lstatSync(absolute); return true; } catch { return false; } })()) throw new Error('Destination already exists; overwriting is not supported');
  // Resolve the parent once; staging and publication stay on the same filesystem.
  return join(regularRoot(dirname(absolute)), basename(absolute));
}
function publish(stage: string, target: string): void {
  // mkdir is the atomic no-replace reservation; rename only replaces our empty directory.
  mkdirSync(target, { mode: 0o700 });
  try { renameSync(stage, target); } catch (error) { try { rmdirSync(target); } catch { /* Preserve anything another process placed here. */ } throw error; }
}
function validateSqlite(file: string, expectedSchema: number): void {
  const db = new Database(readFileSync(file), { readonly: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('SQLite integrity or foreign key check failed');
    const version = (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version;
    if (version !== expectedSchema || version !== BACKUP_SCHEMA_VERSION) throw new Error('Unsupported or mismatched database schema');
  } finally { db.close(); }
}
const snapshotSchema = z.object({ version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
function referencedSnapshots(database: string): Array<{ path: string; size: number; sha256: string }> {
  const db = new Database(readFileSync(database), { readonly: true });
  try {
    return (db.prepare("SELECT key,value FROM configs WHERE key LIKE 'artifact.snapshot.%'").all() as Array<{ key: string; value: string }>).map(row => {
      let value: z.infer<typeof snapshotSchema>;
      try { value = snapshotSchema.parse(JSON.parse(row.value)); } catch { throw new Error('Invalid artifact snapshot metadata'); }
      if (row.key !== `artifact.snapshot.${value.id}`) throw new Error('Artifact snapshot identity mismatch');
      return { path: `artifact-snapshots/${value.id}.bin`, size: value.size, sha256: value.sha256 };
    });
  } finally { db.close(); }
}
function validateSnapshots(root: string, manifest: BackupManifest): void {
  const snapshots = referencedSnapshots(join(root, manifest.database));
  const referenced = new Set(snapshots.map(snapshot => snapshot.path));
  if (manifest.entries.some(entry => entry.path.startsWith('artifact-snapshots/') && !referenced.has(entry.path))) throw new Error('Unreferenced artifact snapshot component');
  for (const snapshot of snapshots) {
    const file = safePath(root, snapshot.path), entry = manifest.entries.find(entry => entry.path === snapshot.path);
    if (!entry || entry.kind !== 'file' || !existsSync(file)) throw new Error('Referenced artifact snapshot is missing');
    if (statSync(file).size !== snapshot.size || digest(file) !== snapshot.sha256) throw new Error('Artifact snapshot size or hash mismatch');
  }
}
function copyComponent(source: string, target: string, path: string, entries: BackupManifest['entries']): void {
  const from = safePath(source, path), to = safePath(target, path), info = lstatSync(from);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) throw new Error('Backup components must be regular files or directories without links');
  if (info.isDirectory()) {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    entries.push({ path, kind: 'directory', mode: info.mode & 0o777 });
    for (const name of readdirSync(from).sort()) copyComponent(source, target, `${path}/${name}`, entries);
  } else {
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(from, to); chmodSync(to, 0o600);
    entries.push({ path, kind: 'file', mode: info.mode & 0o777, sha256: digest(to) });
  }
}
function containsSymbolicLinks(directory: string): boolean {
  return readdirSync(directory).some(name => {
    const path = join(directory, name), info = lstatSync(path);
    return info.isSymbolicLink() || info.isDirectory() && containsSymbolicLinks(path);
  });
}
async function withPluginLocks<T>(dataDir: string, action: () => Promise<T>): Promise<T> {
  const directory = safePath(dataDir, 'plugins');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const locks: Database.Database[] = [];
  try {
    for (const name of ['.config-lock.sqlite', '.binding-lock.sqlite']) {
      const path = safePath(dataDir, `plugins/${name}`);
      const lock = new Database(path, { timeout: 0 }); locks.push(lock);
      lock.exec('BEGIN IMMEDIATE'); chmodSync(path, 0o600);
    }
    return await action();
  } finally { for (const lock of locks.reverse()) lock.close(); }
}

export async function createBackup(options: { database: string; dataDir: string; output: string }): Promise<{ status: 'offline-backup'; archive: string; missing: string[]; excluded: string[] }> {
  const dataDir = regularRoot(options.dataDir), database = realpathSync(options.database), output = newDestination(options.output);
  if (dirname(database) !== dataDir || lstatSync(resolve(options.database)).isSymbolicLink()) throw new Error('Explicit database must be a regular file directly inside the explicit data directory');
  if (output === dataDir || output.startsWith(`${dataDir}${sep}`)) throw new Error('Backup output must be outside the source data directory');
  const stage = mkdtempSync(join(dirname(output), '.dutydeck-backup-')); chmodSync(stage, 0o700);
  const manifest: BackupManifest = { format: 'dutydeck-offline-backup', version: 1, createdAt: new Date().toISOString(), schema: BACKUP_SCHEMA_VERSION, database: 'dutydeck.db', consistency: 'offline-database-and-plugin-locks', entries: [], missing: [], excluded: exclusions };
  try {
    await withPluginLocks(dataDir, () => withOfflineDatabase(database, async () => {
      await backupSqlite(database, join(stage, manifest.database));
      const snapshot = new Database(join(stage, manifest.database));
      try { snapshot.pragma('journal_mode=DELETE'); } finally { snapshot.close(); }
      validateSqlite(join(stage, manifest.database), manifest.schema);
      manifest.entries.push({ path: manifest.database, kind: 'file', mode: 0o600, sha256: digest(join(stage, manifest.database)) });
      for (const snapshot of referencedSnapshots(join(stage, manifest.database))) {
        if (!existsSync(safePath(dataDir, snapshot.path))) throw new Error('Referenced artifact snapshot is missing');
        copyComponent(dataDir, stage, snapshot.path, manifest.entries);
      }
      validateSnapshots(stage, manifest);
      for (const name of ['plugins.lock.json', 'bindings.json', '.config.json']) {
        const path = `plugins/${name}`;
        if (existsSync(safePath(dataDir, path))) copyComponent(dataDir, stage, path, manifest.entries);
      }
      const lockPath = safePath(dataDir, 'plugins/plugins.lock.json');
      if (existsSync(lockPath)) {
        const lock = readJson(lockPath) as { version: number; plugins: Record<string, { active?: { id: string }; candidate?: { id: string }; previous?: { id: string } }> };
        if (lock.version !== 1 || !lock.plugins || typeof lock.plugins !== 'object') throw new Error('Unsupported plugin lock format');
        const copied = new Set<string>();
        for (const [name, entry] of Object.entries(lock.plugins)) {
          if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Unsafe plugin name');
          if (!entry.active || entry.active.id === 'legacy') manifest.missing.push(`Mutable legacy plugin package: ${name}`);
          for (const artifact of [entry.active, entry.candidate, entry.previous]) {
            if (!artifact || artifact.id === 'legacy') continue;
            if (!/^[a-f0-9]{64}$/.test(artifact.id)) throw new Error('Invalid immutable plugin identity');
            const path = `plugins/.artifacts/${name}/${artifact.id}`, source = safePath(dataDir, path);
            if (copied.has(path)) continue;
            if (!existsSync(source)) { manifest.missing.push(`Missing immutable plugin artifact: ${name}/${artifact.id}`); continue; }
            if (await treeDigest(source) !== artifact.id) throw new Error('Immutable plugin artifact hash mismatch');
            if (containsSymbolicLinks(source)) {
              manifest.missing.push(`Immutable plugin package with symbolic links (not copied): ${name}/${artifact.id}`);
              copied.add(path); continue;
            }
            copyComponent(dataDir, stage, path, manifest.entries); copied.add(path);
            if (await treeDigest(source) !== artifact.id) throw new Error('Immutable plugin artifact changed during backup');
          }
        }
      }
    }));
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    inspectBackup(stage);
    publish(stage, output);
    return { status: 'offline-backup', archive: output, missing: [...manifest.missing, ...manifest.excluded], excluded: manifest.excluded };
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}

function validateArtifacts(root: string, manifest: BackupManifest): void {
  const entries = new Map(manifest.entries.map(entry => [entry.path, entry]));
  for (const entry of manifest.entries) {
    const match = /^plugins\/\.artifacts\/([a-zA-Z0-9_-]+)\/([a-f0-9]{64})$/.exec(entry.path);
    if (!match) continue;
    const hash = createHash('sha256');
    const visit = (suffix: string) => {
      const path = suffix ? `${entry.path}/${suffix}` : entry.path;
      const component = entries.get(path);
      if (!component) throw new Error('Missing immutable artifact component');
      hash.update(JSON.stringify([suffix, component.mode, component.kind]));
      const file = safePath(root, path);
      if (component.kind === 'directory') for (const name of readdirSync(file).sort()) visit(suffix ? `${suffix}/${name}` : name);
      else hash.update(readFileSync(file));
    };
    visit('');
    if (hash.digest('hex') !== match[2]) throw new Error('Immutable plugin artifact identity mismatch');
  }
}

/** Read-only preflight: this never opens a repository, migrates, or starts a runtime. */
export function inspectBackup(archive: string): { status: 'quarantined'; manifest: BackupManifest; missing: string[] } {
  const root = regularRoot(archive);
  const manifest = manifestSchema.parse(readJson(safePath(root, 'manifest.json')));
  if (manifest.schema !== BACKUP_SCHEMA_VERSION) throw new Error('Unsupported backup schema');
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    if (paths.has(entry.path) || entry.path === 'manifest.json') throw new Error('Duplicate or reserved backup component');
    paths.add(entry.path);
    if (entry.path !== 'dutydeck.db' && !entry.path.startsWith('plugins/') && !/^artifact-snapshots\/[a-f0-9]{64}\.bin$/.test(entry.path)) throw new Error('Unexpected backup component');
    const file = safePath(root, entry.path), info = lstatSync(file);
    if (entry.kind === 'directory' ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || !entry.sha256 || digest(file) !== entry.sha256) throw new Error('Backup component type or hash mismatch');
  }
  if (!paths.has(manifest.database)) throw new Error('Missing database component');
  const visit = (path: string) => {
    for (const name of readdirSync(path)) {
      const file = join(path, name), rel = relative(root, file).split(sep).join('/'), info = lstatSync(file);
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not accepted in backups');
      if (rel !== 'manifest.json' && !paths.has(rel) && ![...paths].some(candidate => candidate.startsWith(`${rel}/`))) throw new Error('Unlisted backup component');
      if (info.isDirectory()) visit(file);
    }
  };
  visit(root);
  validateSqlite(join(root, manifest.database), manifest.schema);
  validateArtifacts(root, manifest);
  validateSnapshots(root, manifest);
  return { status: 'quarantined', manifest, missing: [...manifest.missing, ...exclusions] };
}

export function restoreBackup(options: { archive: string; target: string }): { status: 'quarantined'; target: string; database: string; missing: string[] } {
  const target = newDestination(options.target), archive = regularRoot(options.archive);
  const { manifest, missing } = inspectBackup(archive);
  const stage = mkdtempSync(join(dirname(target), '.dutydeck-restore-')); chmodSync(stage, 0o700);
  try {
    for (const entry of manifest.entries) {
      const source = safePath(archive, entry.path), destination = safePath(stage, entry.path);
      if (entry.kind === 'directory') mkdirSync(destination, { recursive: true, mode: 0o700 });
      else { mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); copyFileSync(source, destination); chmodSync(destination, 0o600); }
    }
    // Revalidate the copied bytes before any database changes or publication.
    copyFileSync(join(archive, 'manifest.json'), join(stage, 'manifest.json')); chmodSync(join(stage, 'manifest.json'), 0o600);
    inspectBackup(stage);
    const database = join(stage, manifest.database), db = new Database(database);
    try {
      const info = statSync(database);
      db.transaction(() => {
        db.prepare('DELETE FROM dutydeck_access').run();
        db.prepare("UPDATE dutydeck_control SET version=version+1,phase='idle',maintenance=NULL,runtime=NULL,instance=NULL,entity=? WHERE id=1").run(`${info.dev}:${info.ino}`);
      }).immediate();
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
    for (const entry of [...manifest.entries].reverse()) if (entry.path.startsWith('plugins/.artifacts/')) chmodSync(safePath(stage, entry.path), entry.mode);
    writeFileSync(restoreQuarantinePath(database), JSON.stringify({ version: 1, status: 'quarantined', missing, execution: 'disabled; unknown outcomes are preserved and never automatically replayed' }, null, 2), { mode: 0o600 });
    validateSqlite(database, manifest.schema);
    rmSync(join(stage, 'manifest.json'));
    publish(stage, target);
    return { status: 'quarantined', target, database: join(target, manifest.database), missing };
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}
