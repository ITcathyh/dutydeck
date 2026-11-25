// Focused guarantees for JobStore.mutate:
//  - a transaction is invisible in memory until fsync + rename commit;
//  - a failed write rolls memory back, leaves no raw-text temp file, and the
//    same message can be applied and persisted on the next attempt;
//  - every on-disk artifact carrying raw chat text is owner-only (0600).
//
// Runs against the real filesystem in mkdtemp directories; write failures are
// real syscall failures (a directory sitting on the destination path makes
// rename(2) fail after the temp file was written and fsynced).

import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JobStore,
  STATE_FILE_NAME,
  freshState,
  writeJsonAtomic,
} from '../service/store.mjs';

const SECRET = '秘密聊天原文-persist-probe-7f3a9c21';
const APP_ID = 'cli_testapp';
const EVENT_ID = 'ev_persist_1';
const MESSAGE_ID = 'om_persist_1';
const SOURCE_KEY = `lark/${APP_ID}/${MESSAGE_ID}`;

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rvj-store-persist-'));
  dirs.push(dir);
  return dir;
}

/** Recursively list every file under `dir`. */
async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/**
 * Handler-style idempotent transaction for one Lark message. Re-running it
 * against the last committed state must behave like the first delivery.
 */
function recordMessage(state: any) {
  if (state.events[EVENT_ID]) return { mode: 'event-duplicate' as const };
  if (state.messageIndex[MESSAGE_ID]) return { mode: 'message-duplicate' as const };
  state.jobs[SOURCE_KEY] = {
    sourceKey: SOURCE_KEY,
    appId: APP_ID,
    eventId: EVENT_ID,
    messageId: MESSAGE_ID,
    rawText: SECRET,
    stage: 'queued',
    replies: {},
  };
  state.messageIndex[MESSAGE_ID] = SOURCE_KEY;
  state.events[EVENT_ID] = { eventId: EVENT_ID, decision: 'stop', sourceKey: SOURCE_KEY };
  return { mode: 'created' as const };
}

describe('JobStore.mutate atomic commit', () => {
  it('hides an uncommitted transaction from memory, removes raw temp files, and commits the same message on retry', async () => {
    const dir = await makeDir();
    const file = join(dir, STATE_FILE_NAME);
    const store = new JobStore(file, freshState());

    // A directory at the destination makes rename(2) fail (EISDIR on Linux)
    // only AFTER the temp file holding the full raw payload was written/fsynced.
    await mkdir(file);

    await expect(store.mutate(recordMessage)).rejects.toThrow();

    // Nothing is visible in memory: readers keep seeing the last durable state.
    expect(store.getEvent(EVENT_ID)).toBeUndefined();
    expect(store.getJob(SOURCE_KEY)).toBeUndefined();
    expect(store.getJobByMessage(MESSAGE_ID)).toBeUndefined();
    expect(Object.keys(store.state.events)).toHaveLength(0);
    expect(Object.keys(store.state.messageIndex)).toHaveLength(0);
    expect(Object.keys(store.state.jobs)).toHaveLength(0);

    // The failed commit must not leave its temp file (which contains the raw
    // chat text) behind, and no file in the directory may carry the payload.
    const names = await readdir(dir);
    expect(names.some((name) => name.includes('.tmp-'))).toBe(false);
    for (const path of await listFiles(dir)) {
      await expect(readFile(path, 'utf8')).resolves.not.toContain(SECRET);
    }

    // Transient failure cleared: the same message applies as a fresh create
    // and truly reaches the disk on this attempt.
    await rm(file, { recursive: true, force: true });
    await expect(store.mutate(recordMessage)).resolves.toEqual({ mode: 'created' });

    expect(store.getEvent(EVENT_ID)).toMatchObject({ sourceKey: SOURCE_KEY });
    expect(store.getJob(SOURCE_KEY)).toMatchObject({ rawText: SECRET, stage: 'queued' });
    expect(store.getJobByMessage(MESSAGE_ID)).toBe(store.getJob(SOURCE_KEY));

    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    expect(onDisk.events[EVENT_ID].sourceKey).toBe(SOURCE_KEY);
    expect(onDisk.messageIndex[MESSAGE_ID]).toBe(SOURCE_KEY);
    expect(onDisk.jobs[SOURCE_KEY].rawText).toBe(SECRET);

    // The serial chain survived the rejection and keeps committing.
    await store.mutate((state: any) => { state.jobs[SOURCE_KEY].stage = 'live'; });
    expect(store.getJob(SOURCE_KEY).stage).toBe('live');

    // Reopening from disk yields exactly the committed state.
    const reopened = await JobStore.open(dir);
    expect(reopened.getJob(SOURCE_KEY)).toMatchObject({ rawText: SECRET, stage: 'live' });
    await reopened.close();
    await store.close();
  });

  it('rolls memory back when the transaction function throws and keeps the chain usable', async () => {
    const dir = await makeDir();
    const store = await JobStore.open(dir);

    await expect(store.mutate((state: any) => {
      state.events[EVENT_ID] = { eventId: EVENT_ID };
      throw new Error('boom in transaction');
    })).rejects.toThrow('boom in transaction');

    expect(store.getEvent(EVENT_ID)).toBeUndefined();

    await expect(store.mutate(recordMessage)).resolves.toEqual({ mode: 'created' });
    expect(store.getEvent(EVENT_ID)).toBeDefined();
    await store.close();
  });

  it('runs queued transactions after one rejects, without handing them rolled-back state', async () => {
    const dir = await makeDir();
    const store = await JobStore.open(dir);

    // Queue both calls before either settles; the first fails inside fn.
    const boom = store.mutate((state: any) => {
      state.events[EVENT_ID] = { eventId: EVENT_ID };
      throw new Error('queue-boom');
    });
    const ok = store.mutate(recordMessage);

    await expect(boom).rejects.toThrow('queue-boom');
    // The queued transaction runs against the unchanged committed state, so
    // the rolled-back event is absent and the message is created exactly once.
    await expect(ok).resolves.toEqual({ mode: 'created' });
    expect(store.getEvent(EVENT_ID)).toMatchObject({ sourceKey: SOURCE_KEY });
    expect(Object.keys(store.state.events)).toHaveLength(1);
    await store.close();
  });
});

describe('private file permissions (0600)', () => {
  it('writeJsonAtomic creates the destination with exactly 0600', async () => {
    const dir = await makeDir();
    const file = join(dir, 'artifact.json');
    await writeJsonAtomic(file, { rawText: SECRET });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8')).rawText).toBe(SECRET);
  });

  it('state files written by mutate are 0600 and a pre-existing loose state file is tightened on open', async () => {
    const dir = await makeDir();
    const file = join(dir, STATE_FILE_NAME);
    const store = await JobStore.open(dir);
    await store.mutate(recordMessage);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await store.close();

    // State files written by older builds may be 0644; they already hold chat
    // text, so opening the store must tighten them immediately.
    const dir2 = await makeDir();
    const looseFile = join(dir2, STATE_FILE_NAME);
    await writeFile(looseFile, JSON.stringify(freshState()));
    await chmod(looseFile, 0o644);
    expect((await stat(looseFile)).mode & 0o777).toBe(0o644);

    const reopened = await JobStore.open(dir2);
    expect((await stat(looseFile)).mode & 0o777).toBe(0o600);

    // A later atomic replace keeps the owner-only mode.
    await reopened.mutate(recordMessage);
    expect((await stat(looseFile)).mode & 0o777).toBe(0o600);
    await reopened.close();
  });
});
