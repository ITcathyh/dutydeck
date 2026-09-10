import { randomUUID } from 'node:crypto';
import { readSync } from 'node:fs';
import type { ReadStream, WriteStream } from 'node:tty';
import { z } from 'zod';
import {
  LocalFileSecretProvider,
  SecretProviderError,
  larkCredentialBundleSchema,
  localFileSecretProviderName,
  type SecretAvailability
} from '@dutydeck/secret-provider';
import { RuntimeError, type RepositoryBundle, type SecretRefMetadata } from '@dutydeck/shared';

const MAX_INPUT_BYTES = 64 * 1024;
const secretIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const revisionSchema = z.coerce.number().int().positive();
const fileDescriptorSchema = z.coerce.number().int().min(0).max(2_147_483_647).refine(value => value !== 1 && value !== 2, 'stdout/stderr cannot be used as a secret input descriptor');

export interface SecretValueInputOptions { valueFd?: string }
export interface RotateSecretOptions extends SecretValueInputOptions { expectedRevision: string }
export interface RemoveSecretOptions { expectedRevision: string }
export interface SecretCliContext {
  repositories: Pick<RepositoryBundle, 'secretRefs'>;
  provider: LocalFileSecretProvider;
}
export interface PublicSecretRef extends SecretRefMetadata { availability: SecretAvailability }

export class SecretCliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SecretCliError';
  }
}

function safeError(error: unknown): never {
  if (error instanceof SecretCliError) throw error;
  if (error instanceof SecretProviderError) throw new SecretCliError(error.code, error.message);
  if (error instanceof RuntimeError) throw new SecretCliError(error.code, error.message);
  if (error instanceof z.ZodError) throw new SecretCliError('SECRET_INPUT_INVALID', 'Secret command input is invalid');
  throw error;
}

function publicSecretRef(metadata: SecretRefMetadata, provider: LocalFileSecretProvider): PublicSecretRef {
  const availability = metadata.provider === localFileSecretProviderName
    ? provider.inspect(metadata.referenceKey).availability
    : 'unreadable';
  return { ...metadata, availability };
}

function readDescriptor(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const scratch = Buffer.allocUnsafe(Math.min(4096, MAX_INPUT_BYTES + 1 - total));
      let count: number;
      try { count = readSync(fd, scratch, 0, scratch.length, null); }
      catch (error) {
        scratch.fill(0);
        throw error;
      }
      if (count === 0) {
        scratch.fill(0);
        break;
      }
      total += count;
      const owned = Buffer.from(scratch.subarray(0, count));
      scratch.fill(0);
      chunks.push(owned);
      if (total > MAX_INPUT_BYTES) throw new SecretCliError('SECRET_VALUE_TOO_LARGE', 'Secret input may not exceed 64 KiB');
    }
    if (total === 0) throw new SecretCliError('SECRET_VALUE_EMPTY', 'Secret input cannot be empty');
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function readHiddenTty(stdin: ReadStream, stderr: WriteStream): Promise<Buffer> {
  if (!stdin.isTTY || !stderr.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new SecretCliError('SECRET_VALUE_INPUT_REQUIRED', 'Use an interactive TTY or pass --value-fd with an inherited descriptor');
  }
  stderr.write('Lark credential bundle JSON (input hidden): ');
  stdin.setRawMode(true);
  stdin.resume();
  const bytes: number[] = [];
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const cleanup = () => stdin.off('data', onData);
      const onData = (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        try {
          for (const byte of data) {
            if (byte === 3) {
              cleanup();
              reject(new SecretCliError('SECRET_VALUE_INPUT_CANCELLED', 'Secret input was cancelled'));
              return;
            }
            if (byte === 10 || byte === 13) {
              cleanup();
              if (bytes.length === 0) reject(new SecretCliError('SECRET_VALUE_EMPTY', 'Secret input cannot be empty'));
              else resolve(Buffer.from(bytes));
              return;
            }
            if (byte === 8 || byte === 127) bytes.pop();
            else if (bytes.length < MAX_INPUT_BYTES) bytes.push(byte);
            else {
              cleanup();
              reject(new SecretCliError('SECRET_VALUE_TOO_LARGE', 'Secret input may not exceed 64 KiB'));
              return;
            }
          }
        } finally { data.fill(0); }
      };
      stdin.on('data', onData);
    });
  } finally {
    bytes.fill(0);
    stdin.setRawMode(false);
    stdin.pause();
    stderr.write('\n');
  }
}

export async function readSecretValue(
  options: SecretValueInputOptions,
  streams: { stdin?: ReadStream; stderr?: WriteStream } = {}
): Promise<Buffer> {
  if (options.valueFd !== undefined) return readDescriptor(fileDescriptorSchema.parse(options.valueFd));
  return readHiddenTty(streams.stdin ?? process.stdin, streams.stderr ?? process.stderr);
}

function canonicalizeLarkBundle(value: Buffer): Buffer {
  let text = '';
  try {
    text = value.toString('utf8').trim();
    let json: unknown;
    try { json = JSON.parse(text); }
    catch { throw new SecretCliError('SECRET_BUNDLE_INVALID', 'Value must be a strict Lark credential bundle JSON object'); }
    const bundle = larkCredentialBundleSchema.parse(json);
    return Buffer.from(JSON.stringify(bundle), 'utf8');
  } catch (error) {
    safeError(error);
  } finally {
    value.fill(0);
    text = '';
  }
}

function nextReferenceKey(id: string): string {
  return `${id}.${randomUUID().replaceAll('-', '')}`;
}

export async function runSecretList(context: SecretCliContext): Promise<{ secretRefs: PublicSecretRef[] }> {
  const refs = await context.repositories.secretRefs.list();
  return { secretRefs: refs.map(ref => publicSecretRef(ref, context.provider)) };
}

export async function runSecretSet(idInput: string, options: SecretValueInputOptions, context: SecretCliContext): Promise<{ secretRef: PublicSecretRef }> {
  try {
    const id = secretIdSchema.parse(idInput);
    if (await context.repositories.secretRefs.get(id)) throw new SecretCliError('SECRET_REF_ALREADY_EXISTS', 'SecretRef already exists; use rotate with an expected revision');
    const canonical = canonicalizeLarkBundle(await readSecretValue(options));
    const referenceKey = nextReferenceKey(id);
    const written = context.provider.writeExclusive(referenceKey, canonical);
    try {
      const metadata = await context.repositories.secretRefs.create({ id, kind: 'lark_app_secret', provider: localFileSecretProviderName, referenceKey, status: 'configured' });
      return { secretRef: publicSecretRef(metadata, context.provider) };
    } catch (error) {
      context.provider.removeConditional(referenceKey, written.fingerprint);
      throw error;
    }
  } catch (error) { safeError(error); }
}

export async function runSecretRotate(idInput: string, options: RotateSecretOptions, context: SecretCliContext): Promise<{ secretRef: PublicSecretRef }> {
  try {
    const id = secretIdSchema.parse(idInput);
    const expectedRevision = revisionSchema.parse(options.expectedRevision);
    const current = await context.repositories.secretRefs.get(id);
    if (!current) throw new SecretCliError('SECRET_REF_NOT_FOUND', 'SecretRef was not found');
    if (current.provider !== localFileSecretProviderName || current.kind !== 'lark_app_secret') throw new SecretCliError('SECRET_PROVIDER_UNSUPPORTED', 'Only local Lark credential SecretRefs can be rotated by this command');
    if (current.revision !== expectedRevision) throw new SecretCliError('FOUNDATION_REVISION_CONFLICT', 'SecretRef revision changed; list metadata and retry');
    const canonical = canonicalizeLarkBundle(await readSecretValue(options));
    const referenceKey = nextReferenceKey(id);
    const written = context.provider.writeExclusive(referenceKey, canonical);
    let next: SecretRefMetadata;
    try {
      next = await context.repositories.secretRefs.update(id, { expectedRevision, referenceKey, status: 'configured' });
    } catch (error) {
      context.provider.removeConditional(referenceKey, written.fingerprint);
      throw error;
    }
    try { context.provider.removeConditional(current.referenceKey); }
    catch {
      // Rotation is already committed and the old, unreferenced value remains
      // owner-only. Do not roll metadata back to stale credentials.
    }
    return { secretRef: publicSecretRef(next, context.provider) };
  } catch (error) { safeError(error); }
}

export async function runSecretRemove(idInput: string, options: RemoveSecretOptions, context: SecretCliContext): Promise<{ secretRef: PublicSecretRef }> {
  try {
    const id = secretIdSchema.parse(idInput);
    const expectedRevision = revisionSchema.parse(options.expectedRevision);
    const current = await context.repositories.secretRefs.get(id);
    if (!current) throw new SecretCliError('SECRET_REF_NOT_FOUND', 'SecretRef was not found');
    if (current.provider !== localFileSecretProviderName) throw new SecretCliError('SECRET_PROVIDER_UNSUPPORTED', 'Only local file SecretRefs can be removed by this command');
    const removed = await context.repositories.secretRefs.remove(id, expectedRevision);
    context.provider.removeConditional(removed.referenceKey);
    return { secretRef: { ...removed, availability: 'missing' } };
  } catch (error) { safeError(error); }
}
