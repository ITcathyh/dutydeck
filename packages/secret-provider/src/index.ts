import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const DIRECTORY_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;
const MAX_SECRET_BYTES = 64 * 1024;
const REFERENCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const runtimeBoundaryMarker = Symbol('dutydeck.lark-secret-runtime-boundary');
const runtimeReaders = new WeakMap<LocalFileSecretProvider, (referenceKey: string) => Buffer>();

export const localFileSecretProviderName = 'local-file-v1';
export const secretAvailabilityValues = ['available', 'missing', 'unreadable'] as const;
export type SecretAvailability = (typeof secretAvailabilityValues)[number];

export const larkCredentialBundleSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('lark_app_credential'),
  app_id: z.string().min(1).max(256),
  app_secret: z.string().min(1).max(4096)
}).strict();
export type LarkCredentialBundle = z.infer<typeof larkCredentialBundleSchema>;

export class SecretProviderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SecretProviderError';
  }
}

export interface SecretInspection {
  referenceKey: string;
  availability: SecretAvailability;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function assertReferenceKey(referenceKey: string): void {
  if (!REFERENCE_KEY.test(referenceKey) || referenceKey === '.' || referenceKey === '..') {
    throw new SecretProviderError('SECRET_REFERENCE_KEY_INVALID', 'Secret reference keys must be opaque path-safe identifiers');
  }
}

function assertOwner(stats: Stats, subject: 'directory' | 'file'): void {
  const getEuid = process.geteuid ?? process.getuid;
  if (process.platform !== 'win32' && getEuid && stats.uid !== getEuid.call(process)) {
    throw new SecretProviderError('SECRET_OWNER_INVALID', `Secret provider ${subject} must be owned by the current user`);
  }
}

function assertDirectory(stats: Stats): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new SecretProviderError('SECRET_DIRECTORY_INVALID', 'Secret provider directory must be a real directory');
  assertOwner(stats, 'directory');
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== DIRECTORY_MODE) {
    throw new SecretProviderError('SECRET_DIRECTORY_MODE_INVALID', 'Secret provider directory must have mode 0700');
  }
}

function assertSecretFile(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) throw new SecretProviderError('SECRET_FILE_INVALID', 'Secret value must be a regular file and may not be a symlink');
  assertOwner(stats, 'file');
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== SECRET_FILE_MODE) {
    throw new SecretProviderError('SECRET_FILE_MODE_INVALID', 'Secret value file must have mode 0600');
  }
  if (process.platform !== 'win32' && stats.nlink !== 1) {
    throw new SecretProviderError('SECRET_FILE_LINK_INVALID', 'Secret value file may not have additional hard links');
  }
  if (stats.size < 1 || stats.size > MAX_SECRET_BYTES) throw new SecretProviderError('SECRET_FILE_SIZE_INVALID', 'Secret value file has an invalid size');
}

function safeUnlink(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if (!isMissing(error)) throw error; }
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Derives the only supported local provider location without adding a public config value. */
export function secretDirectoryForDatabase(databasePath: string): string {
  if (!databasePath || databasePath === ':memory:') throw new SecretProviderError('SECRET_DATABASE_PATH_INVALID', 'A persisted SQLite database path is required for local secrets');
  return join(dirname(databasePath), 'secrets');
}

export class LocalFileSecretProvider {
  readonly directory: string;

  constructor(directory: string, options: { createDirectory?: boolean } = {}) {
    this.directory = directory;
    if (options.createDirectory) {
      let created = false;
      try {
        mkdirSync(directory, { mode: DIRECTORY_MODE });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stats = lstatSync(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new SecretProviderError('SECRET_DIRECTORY_INVALID', 'Secret provider directory must be a real directory');
      assertOwner(stats, 'directory');
      if (created && process.platform !== 'win32') chmodSync(directory, DIRECTORY_MODE);
    }
    this.assertProviderDirectory();
    runtimeReaders.set(this, referenceKey => this.readOwnedBuffer(referenceKey));
  }

  inspect(referenceKey: string): SecretInspection {
    assertReferenceKey(referenceKey);
    try {
      this.assertProviderDirectory();
      const descriptor = this.openValidated(referenceKey);
      closeSync(descriptor);
      return { referenceKey, availability: 'available' };
    } catch (error) {
      if (isMissing(error)) return { referenceKey, availability: 'missing' };
      if (error instanceof SecretProviderError) return { referenceKey, availability: 'unreadable' };
      return { referenceKey, availability: 'unreadable' };
    }
  }

  fingerprint(referenceKey: string): string {
    const value = this.readOwnedBuffer(referenceKey);
    try { return createHash('sha256').update(value).digest('hex'); }
    finally { value.fill(0); }
  }

  /** Takes ownership of `value` and zeroes it before returning or throwing. */
  writeExclusive(referenceKey: string, value: Buffer): { fingerprint: string } {
    let temporary: string | undefined;
    try {
      assertReferenceKey(referenceKey);
      this.assertInputValue(value);
      const destination = this.secretPath(referenceKey);
      temporary = this.temporaryPath(referenceKey, 'tmp');
      this.assertProviderDirectory();
      const fingerprint = createHash('sha256').update(value).digest('hex');
      this.writePrivateFile(temporary, value);
      try { linkSync(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SecretProviderError('SECRET_ALREADY_EXISTS', 'Secret reference already exists');
        throw error;
      }
      safeUnlink(temporary);
      syncDirectory(this.directory);
      const descriptor = this.openValidated(referenceKey);
      closeSync(descriptor);
      return { fingerprint };
    } finally {
      value.fill(0);
      if (temporary) safeUnlink(temporary);
    }
  }

  /** Atomically replaces only the exact version identified by `expectedFingerprint`. */
  replaceConditional(referenceKey: string, value: Buffer, expectedFingerprint: string): { fingerprint: string } {
    try {
      assertReferenceKey(referenceKey);
      if (!SHA256.test(expectedFingerprint)) throw new SecretProviderError('SECRET_FINGERPRINT_INVALID', 'Expected fingerprint must be a SHA-256 digest');
      this.assertInputValue(value);
      const release = this.acquireLock(referenceKey);
      const temporary = this.temporaryPath(referenceKey, 'tmp');
      try {
        if (this.fingerprint(referenceKey) !== expectedFingerprint) throw new SecretProviderError('SECRET_CONDITION_FAILED', 'Secret value changed before conditional replacement');
        const fingerprint = createHash('sha256').update(value).digest('hex');
        this.writePrivateFile(temporary, value);
        renameSync(temporary, this.secretPath(referenceKey));
        syncDirectory(this.directory);
        const descriptor = this.openValidated(referenceKey);
        closeSync(descriptor);
        return { fingerprint };
      } finally {
        safeUnlink(temporary);
        release();
      }
    } finally {
      value.fill(0);
    }
  }

  removeConditional(referenceKey: string, expectedFingerprint?: string): void {
    assertReferenceKey(referenceKey);
    if (expectedFingerprint !== undefined && !SHA256.test(expectedFingerprint)) throw new SecretProviderError('SECRET_FINGERPRINT_INVALID', 'Expected fingerprint must be a SHA-256 digest');
    const release = this.acquireLock(referenceKey);
    try {
      if (expectedFingerprint !== undefined && this.fingerprint(referenceKey) !== expectedFingerprint) {
        throw new SecretProviderError('SECRET_CONDITION_FAILED', 'Secret value changed before conditional removal');
      }
      const descriptor = this.openValidated(referenceKey);
      closeSync(descriptor);
      unlinkSync(this.secretPath(referenceKey));
      syncDirectory(this.directory);
    } finally {
      release();
    }
  }

  private assertProviderDirectory(): void {
    let stats: Stats;
    try { stats = lstatSync(this.directory); }
    catch (error) {
      if (isMissing(error)) throw new SecretProviderError('SECRET_DIRECTORY_MISSING', 'Secret provider directory does not exist');
      throw error;
    }
    assertDirectory(stats);
  }

  private secretPath(referenceKey: string): string {
    return join(this.directory, `${referenceKey}.secret`);
  }

  private temporaryPath(referenceKey: string, suffix: string): string {
    return join(this.directory, `.${referenceKey}.${randomUUID()}.${suffix}`);
  }

  private openValidated(referenceKey: string): number {
    this.assertProviderDirectory();
    const path = this.secretPath(referenceKey);
    const before = lstatSync(path);
    assertSecretFile(before);
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const after = fstatSync(descriptor);
      assertSecretFile(after);
      if (before.dev !== after.dev || before.ino !== after.ino) throw new SecretProviderError('SECRET_FILE_CHANGED', 'Secret value changed while it was being opened');
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  private readOwnedBuffer(referenceKey: string): Buffer {
    const descriptor = this.openValidated(referenceKey);
    try {
      const value = readFileSync(descriptor);
      if (value.length < 1 || value.length > MAX_SECRET_BYTES) {
        value.fill(0);
        throw new SecretProviderError('SECRET_FILE_SIZE_INVALID', 'Secret value file has an invalid size');
      }
      return value;
    } finally { closeSync(descriptor); }
  }

  private writePrivateFile(path: string, value: Buffer): void {
    const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), SECRET_FILE_MODE);
    try {
      if (process.platform !== 'win32') fchmodSync(descriptor, SECRET_FILE_MODE);
      writeFileSync(descriptor, value);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
  }

  private acquireLock(referenceKey: string): () => void {
    this.assertProviderDirectory();
    const lockPath = join(this.directory, `.${referenceKey}.lock`);
    let descriptor: number;
    try { descriptor = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), SECRET_FILE_MODE); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SecretProviderError('SECRET_BUSY', 'Secret reference is already being changed');
      throw error;
    }
    if (process.platform !== 'win32') fchmodSync(descriptor, SECRET_FILE_MODE);
    return () => {
      closeSync(descriptor);
      safeUnlink(lockPath);
      syncDirectory(this.directory);
    };
  }

  private assertInputValue(value: Buffer): void {
    if (!Buffer.isBuffer(value) || value.length < 1 || value.length > MAX_SECRET_BYTES) {
      value.fill?.(0);
      throw new SecretProviderError('SECRET_VALUE_SIZE_INVALID', 'Secret value must be a non-empty Buffer no larger than 64 KiB');
    }
  }

}

export class LarkListenerSecretBoundary {
  readonly purpose = 'lark_listener' as const;
  private constructor(private readonly marker: symbol) {
    if (marker !== runtimeBoundaryMarker) throw new SecretProviderError('SECRET_RUNTIME_BOUNDARY_REQUIRED', 'Invalid secret runtime boundary');
  }
  static create(): LarkListenerSecretBoundary { return new LarkListenerSecretBoundary(runtimeBoundaryMarker); }
  _isAuthentic(marker: symbol): boolean { return marker === runtimeBoundaryMarker && this.marker === runtimeBoundaryMarker; }
}

/**
 * Read-only Lark identity/App×Chat verification boundary.
 *
 * This is deliberately distinct from listener startup: resolving a credential
 * for a preflight must never imply that a listener may be opened or activated.
 */
export class LarkIdentityPreflightSecretBoundary {
  readonly purpose = 'identity_preflight' as const;
  private constructor(private readonly marker: symbol) {
    if (marker !== runtimeBoundaryMarker) throw new SecretProviderError('SECRET_RUNTIME_BOUNDARY_REQUIRED', 'Invalid secret runtime boundary');
  }
  static create(): LarkIdentityPreflightSecretBoundary { return new LarkIdentityPreflightSecretBoundary(runtimeBoundaryMarker); }
  _isAuthentic(marker: symbol): boolean { return marker === runtimeBoundaryMarker && this.marker === runtimeBoundaryMarker; }
}

export type LarkCredentialRuntimeBoundary = LarkListenerSecretBoundary | LarkIdentityPreflightSecretBoundary;
export interface ResolvedLarkCredentialMetadata { fingerprint: string }

function isAuthenticCredentialBoundary(boundary: LarkCredentialRuntimeBoundary): boolean {
  return (boundary instanceof LarkListenerSecretBoundary || boundary instanceof LarkIdentityPreflightSecretBoundary)
    && boundary._isAuthentic(runtimeBoundaryMarker)
    && (boundary.purpose === 'lark_listener' || boundary.purpose === 'identity_preflight');
}

/** This class is intentionally absent from management/API/Web wiring. */
export class LocalFileLarkCredentialResolver {
  constructor(private readonly provider: LocalFileSecretProvider, private readonly boundary: LarkCredentialRuntimeBoundary) {
    if (!isAuthenticCredentialBoundary(boundary)) {
      throw new SecretProviderError('SECRET_RUNTIME_BOUNDARY_REQUIRED', 'Lark credential resolution requires an explicit listener or identity-preflight runtime boundary');
    }
  }

  async withCredentials<T>(referenceKey: string, use: (credentials: Readonly<LarkCredentialBundle>, metadata: Readonly<ResolvedLarkCredentialMetadata>) => T | Promise<T>): Promise<T> {
    const read = runtimeReaders.get(this.provider);
    if (!read || !isAuthenticCredentialBoundary(this.boundary)) throw new SecretProviderError('SECRET_RUNTIME_BOUNDARY_REQUIRED', 'Lark credential resolution requires an explicit listener or identity-preflight runtime boundary');
    const value = read(referenceKey);
    const fingerprint = createHash('sha256').update(value).digest('hex');
    let text = '';
    let parsed: LarkCredentialBundle | undefined;
    try {
      text = value.toString('utf8');
      let json: unknown;
      try { json = JSON.parse(text); }
      catch { throw new SecretProviderError('SECRET_BUNDLE_INVALID', 'Stored Lark credential bundle is invalid'); }
      const result = larkCredentialBundleSchema.safeParse(json);
      if (!result.success) throw new SecretProviderError('SECRET_BUNDLE_INVALID', 'Stored Lark credential bundle is invalid');
      parsed = result.data;
      return await use(parsed, { fingerprint });
    } finally {
      value.fill(0);
      text = '';
      if (parsed) {
        parsed.app_id = '';
        parsed.app_secret = '';
      }
    }
  }
}
