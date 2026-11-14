import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { maybePrintFirstRunGuidance } from './first-run.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function database(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-first-run-db-'));
  dirs.push(dir);
  return join(dir, 'dutydeck.db');
}

function options(databaseUrl: string, write: (text: string) => void) {
  return {
    address: 'http://127.0.0.1:4310', databaseUrl, isTTY: true, env: {}, write,
    cliOnPath: () => true
  };
}

describe('first-run guidance bot configuration reader', () => {
  it('prints for an empty temporary database', async () => {
    const write = vi.fn();
    await maybePrintFirstRunGuidance(options(await database(), write));
    expect(write).toHaveBeenCalledOnce();
  });

  it('does not print when the temporary database contains a bot', async () => {
    const databaseUrl = await database();
    const repositories = createRepositories(databaseUrl);
    try {
      await repositories.config.set('lark.bots', JSON.stringify([{ appId: 'cli_fixture', appSecret: 'secret_fixture' }]));
    } finally { repositories.close(); }
    const write = vi.fn();
    await maybePrintFirstRunGuidance(options(databaseUrl, write));
    expect(write).not.toHaveBeenCalled();
  });
});
