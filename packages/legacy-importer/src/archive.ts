import { createCipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, stableFingerprint, stableJson } from './fingerprint.js';
import type {
  LegacyPrivateArchiveManifest,
  LegacyPrivateMigrationPlan,
  PrivateArchiveOptions
} from './types.js';
import { LegacyImportError } from './types.js';

export interface ArchiveSourceFile {
  artifact_ref: string;
  kind: string;
  bytes: Uint8Array;
}

function encrypt(bytes: Uint8Array, key: Uint8Array): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  // V2 而不是继续叫 V1：品牌名从 DOCKMUX 换成 DUTYDECK 让这段头部长了一个字节，
  // 按固定偏移取 iv/tag 的解码器会整体错位。版本号必须跟着变，否则外部无从分辨两种布局。
  return Buffer.concat([Buffer.from('DUTYDECK-BOTMUX-ARCHIVE-V2\0'), iv, tag, ciphertext]);
}

async function privateWrite(path: string, bytes: string | Uint8Array): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    if (process.platform !== 'win32') await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

export async function writePrivateArchive(
  plan: LegacyPrivateMigrationPlan,
  sourceFiles: readonly ArchiveSourceFile[],
  excludedSecretArtifacts: number,
  options: PrivateArchiveOptions
): Promise<LegacyPrivateArchiveManifest> {
  if (options.encryption_key.byteLength !== 32) {
    throw new LegacyImportError('ARCHIVE_KEY_INVALID', 'Private archive encryption key must be exactly 32 bytes');
  }
  try {
    await mkdir(options.destination, { recursive: false, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(options.destination, 0o700);
  } catch {
    throw new LegacyImportError('ARCHIVE_DESTINATION_UNAVAILABLE', 'Private archive destination must be a new writable directory');
  }

  try {
    const files: LegacyPrivateArchiveManifest['files'] = [];
    for (const source of [...sourceFiles].sort((left, right) => left.artifact_ref.localeCompare(right.artifact_ref))) {
      const encrypted = encrypt(source.bytes, options.encryption_key);
      const filename = `${source.artifact_ref}.enc`;
      await privateWrite(join(options.destination, filename), encrypted);
      files.push({
        artifact_ref: source.artifact_ref,
        kind: source.kind,
        ciphertext_sha256: sha256(encrypted),
        plaintext_size_bytes: source.bytes.byteLength
      });
    }

    const archiveSnapshotId = `archive_${stableFingerprint(files).slice(0, 24)}`;
    const manifest: LegacyPrivateArchiveManifest = {
      schema_version: 1,
      archive_snapshot_id: archiveSnapshotId,
      created_at: new Date().toISOString(),
      source_instance_ref: plan.source.source_instance_ref,
      encryption: 'aes-256-gcm',
      ...(options.key_derivation ? { key_derivation: options.key_derivation } : {}),
      files,
      excluded_secret_artifacts: excludedSecretArtifacts,
      source_mutated: false,
      live_config_written: false
    };
    await privateWrite(join(options.destination, 'archive-manifest.json'), `${stableJson(manifest)}\n`);

    await privateWrite(join(options.destination, 'migration-plan.json'), `${stableJson(plan)}\n`);
    return manifest;
  } catch (error) {
    if (error instanceof LegacyImportError) throw error;
    throw new LegacyImportError('ARCHIVE_WRITE_FAILED', 'Private archive could not be written completely');
  }
}
