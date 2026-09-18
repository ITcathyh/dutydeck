import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { readSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import {
  LegacyImportError,
  LegacyPlanHandle,
  discoverLegacySource,
  type LegacyArchiveKeyDerivation,
  type LegacyRedactedManifest
} from '@dutydeck/legacy-importer';
import type { LegacyArchiveCliOptions, LegacySourceCliOptions } from './cli-program.js';

const PASSPHRASE_MIN_BYTES = 16;
const PASSPHRASE_MAX_BYTES = 1024;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export class LegacyImportCliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LegacyImportCliError';
  }
}

interface LegacyCliIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

const processIo: LegacyCliIo = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
};

function render(value: unknown, compact: boolean): string {
  return `${JSON.stringify(value, null, compact ? undefined : 2)}\n`;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  try {
    const existing = await lstat(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) throw new Error('target exists');
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(render(value, true), 'utf8');
      await handle.sync();
      if (process.platform !== 'win32') await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  } catch {
    throw new LegacyImportCliError(
      'OUTPUT_FILE_UNAVAILABLE',
      'Output must be a new regular file in a writable directory'
    );
  }
}

function sourceOptions(options: LegacySourceCliOptions, fingerprintKey: Uint8Array) {
  return {
    ...(options.sourceHome ? { source_home: options.sourceHome } : {}),
    ...(options.botsConfig ? { bots_config: options.botsConfig } : {}),
    ...(options.dataDir ? { data_dir: options.dataDir } : {}),
    env: process.env,
    fingerprint_key: fingerprintKey
  };
}

async function withPlan<T>(options: LegacySourceCliOptions, operation: (manifest: LegacyRedactedManifest, handle: LegacyPlanHandle) => Promise<T>): Promise<T> {
  const fingerprintKey = randomBytes(32);
  try {
    const discovery = await discoverLegacySource(sourceOptions(options, fingerprintKey));
    const handle = discovery.createPlan();
    return await operation(handle.createRedactedManifest(), handle);
  } finally {
    fingerprintKey.fill(0);
  }
}

/** JSON 输出里的 command 字段：canonical `migrate` 用 migrate.*，兼容别名 `botmux` 保持历史值 botmux.*。 */
function commandName(action: 'discover' | 'plan' | 'archive', invokedAs: 'migrate' | 'botmux' | undefined): string {
  return `${invokedAs === 'migrate' ? 'migrate' : 'botmux'}.${action}`;
}

export async function runLegacyDiscover(options: LegacySourceCliOptions, io: LegacyCliIo = processIo): Promise<void> {
  const fingerprintKey = randomBytes(32);
  try {
    const discovery = await discoverLegacySource(sourceOptions(options, fingerprintKey));
    const plan = discovery.createPlan().createRedactedManifest();
    const report = {
      schema_version: 1,
      command: commandName('discover', options.invokedAs),
      allowed_mode: 'read_only_plan',
      production_cutover: 'NO_GO',
      discovery: discovery.manifest,
      blockers: plan.blockers,
      forbidden_capabilities: plan.forbidden_capabilities,
      eligibility: plan.eligibility
    } as const;
    if (options.output) {
      await writePrivateJson(options.output, report);
      io.stdout.write(render({ ok: true, command: report.command, production_cutover: 'NO_GO', output_written: true }, options.json === true));
    } else {
      io.stdout.write(render(report, options.json === true));
    }
  } finally {
    fingerprintKey.fill(0);
  }
}

export async function runLegacyPlan(options: LegacySourceCliOptions, io: LegacyCliIo = processIo): Promise<void> {
  await withPlan(options, async (manifest, handle) => {
    if (options.output) {
      await handle.writeRedactedManifest(options.output);
      io.stdout.write(render({ ok: true, command: commandName('plan', options.invokedAs), production_cutover: 'NO_GO', output_written: true }, options.json === true));
      return;
    }
    io.stdout.write(render(manifest, options.json === true));
  });
}

function trimSingleLineEnding(bytes: Buffer): Buffer {
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0x0a) end -= 1;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  return Buffer.from(bytes.subarray(0, end));
}

function validatePassphrase(bytes: Buffer): Buffer {
  if (bytes.includes(0)) {
    bytes.fill(0);
    throw new LegacyImportCliError('ARCHIVE_PASSPHRASE_INVALID', 'Archive passphrase must be a single text value without NUL bytes');
  }
  if (bytes.byteLength < PASSPHRASE_MIN_BYTES || bytes.byteLength > PASSPHRASE_MAX_BYTES) {
    bytes.fill(0);
    throw new LegacyImportCliError(
      'ARCHIVE_PASSPHRASE_INVALID',
      `Archive passphrase must contain ${PASSPHRASE_MIN_BYTES}-${PASSPHRASE_MAX_BYTES} UTF-8 bytes`
    );
  }
  return bytes;
}

function parsePassphraseFd(value: string): number {
  if (!/^(?:0|[3-9]|[1-9][0-9]+)$/.test(value)) {
    throw new LegacyImportCliError('ARCHIVE_PASSPHRASE_FD_INVALID', 'Passphrase file descriptor must be 0 or an integer greater than 2');
  }
  const fd = Number(value);
  if (!Number.isSafeInteger(fd) || fd > 65_535) {
    throw new LegacyImportCliError('ARCHIVE_PASSPHRASE_FD_INVALID', 'Passphrase file descriptor is outside the supported range');
  }
  return fd;
}

function readPassphraseFd(value: string): Buffer {
  const fd = parsePassphraseFd(value);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(256);
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > PASSPHRASE_MAX_BYTES + 2) {
        chunk.fill(0);
        for (const prior of chunks) prior.fill(0);
        throw new LegacyImportCliError('ARCHIVE_PASSPHRASE_INVALID', 'Archive passphrase input is too large');
      }
      chunks.push(Buffer.from(chunk.subarray(0, count)));
      chunk.fill(0);
    }
  } catch (error) {
    if (error instanceof LegacyImportCliError) throw error;
    for (const chunk of chunks) chunk.fill(0);
    throw new LegacyImportCliError('ARCHIVE_PASSPHRASE_READ_FAILED', 'Archive passphrase could not be read from the requested file descriptor');
  }
  const joined = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  const trimmed = trimSingleLineEnding(joined);
  joined.fill(0);
  return validatePassphrase(trimmed);
}

async function hiddenQuestion(prompt: string, io: LegacyCliIo): Promise<Buffer> {
  io.stderr.write(prompt);
  const mutedOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const readline = createInterface({ input: io.stdin, output: mutedOutput, terminal: true });
  try {
    return Buffer.from(await readline.question(''), 'utf8');
  } finally {
    readline.close();
    io.stderr.write('\n');
  }
}

async function readInteractivePassphrase(io: LegacyCliIo): Promise<Buffer> {
  const first = validatePassphrase(await hiddenQuestion('Archive passphrase: ', io));
  let second: Buffer | undefined;
  try {
    second = validatePassphrase(await hiddenQuestion('Confirm archive passphrase: ', io));
    if (first.byteLength !== second.byteLength || !timingSafeEqual(first, second)) {
      throw new LegacyImportCliError('ARCHIVE_PASSPHRASE_MISMATCH', 'Archive passphrase confirmation did not match');
    }
    return first;
  } catch (error) {
    first.fill(0);
    throw error;
  } finally {
    second?.fill(0);
  }
}

async function archivePassphrase(options: LegacyArchiveCliOptions, io: LegacyCliIo): Promise<Buffer> {
  if (options.passphraseFd !== undefined) return readPassphraseFd(options.passphraseFd);
  if (io.stdin.isTTY === true && io.stderr.isTTY === true) return readInteractivePassphrase(io);
  throw new LegacyImportCliError(
    'ARCHIVE_PASSPHRASE_INPUT_REQUIRED',
    'Non-interactive archive requires explicit --passphrase-fd; passphrase values are never accepted in arguments or environment variables'
  );
}

function deriveArchiveKey(passphrase: Buffer): Promise<{ key: Buffer; metadata: LegacyArchiveKeyDerivation }> {
  const salt = randomBytes(16);
  const metadata: LegacyArchiveKeyDerivation = {
    algorithm: 'scrypt',
    salt_base64: salt.toString('base64'),
    key_length_bytes: 32,
    cost: SCRYPT_COST,
    block_size: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION
  };
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
      maxmem: 64 * 1024 * 1024
    }, (error, key) => {
      salt.fill(0);
      if (error) reject(new LegacyImportCliError('ARCHIVE_KEY_DERIVATION_FAILED', 'Archive encryption key derivation failed'));
      else resolve({ key: Buffer.from(key), metadata });
    });
  });
}

export async function runLegacyArchive(options: LegacyArchiveCliOptions, io: LegacyCliIo = processIo): Promise<void> {
  const passphrase = await archivePassphrase(options, io);
  let archiveKey: Buffer | undefined;
  try {
    const derived = await deriveArchiveKey(passphrase);
    archiveKey = derived.key;
    await withPlan(options, async (redactedPlan, handle) => {
      const archive = await handle.createPrivateArchive({
        destination: options.output,
        encryption_key: archiveKey!,
        key_derivation: derived.metadata
      });
      io.stdout.write(render({
        schema_version: 1,
        command: commandName('archive', options.invokedAs),
        allowed_mode: 'private_archive_only',
        production_cutover: 'NO_GO',
        archive,
        blockers: redactedPlan.blockers,
        forbidden_capabilities: redactedPlan.forbidden_capabilities,
        eligibility: redactedPlan.eligibility
      }, options.json === true));
    });
  } catch (error) {
    if (error instanceof LegacyImportError || error instanceof LegacyImportCliError) throw error;
    throw new LegacyImportCliError('ARCHIVE_FAILED', 'Private archive could not be created');
  } finally {
    passphrase.fill(0);
    archiveKey?.fill(0);
  }
}
