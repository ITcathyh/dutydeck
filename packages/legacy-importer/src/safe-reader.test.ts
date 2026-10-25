import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LegacyImportError } from './types.js';
import { LEGACY_MAX_SINGLE_FILE_BYTES, stableReadFile } from './safe-reader.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('rejects sparse files above the single-file limit before allocating their contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-legacy-reader-')); dirs.push(dir);
  const path = join(dir, 'sparse');
  const handle = await open(path, 'w');
  await handle.truncate(LEGACY_MAX_SINGLE_FILE_BYTES + 1);
  await handle.close();
  await expect(stableReadFile(path, 'artifact')).rejects.toMatchObject<Partial<LegacyImportError>>({ code: 'SOURCE_FILE_TOO_LARGE' });
});
