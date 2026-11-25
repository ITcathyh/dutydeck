// Durable inbox/job store for rovetap-jobs.
//
// The plugin is dependency-free and runs as a single service process, so a
// serialized, atomically-renamed JSON file gives us real read-modify-write
// transactions: every mutation runs synchronously inside one ordered chain and
// the whole state is fsynced + renamed before the caller proceeds. That makes
// duplicate/concurrent Lark deliveries collapse on `event_id`/`message_id` and
// lets a restart recover every in-flight job. RoveTap additionally enforces the
// stable source key uniquely.
//
// The JSON file is an internal implementation detail, not an external API.

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const STATE_VERSION = 1;
export const STATE_FILE_NAME = 'rovetap-jobs-state.json';

/** Stable upstream idempotency key: `lark/<app_id>/<command message_id>`. */
export function sourceKeyFor(appId, messageId) {
  return `lark/${appId}/${messageId}`;
}

export function freshState() {
  return { version: STATE_VERSION, events: {}, messageIndex: {}, jobs: {} };
}

export function newJobRecord({ sourceKey, appId, eventId, messageId }) {
  const now = new Date().toISOString();
  return {
    sourceKey,
    appId,
    eventId,
    messageId,
    chatId: null,
    chatType: null,
    threadId: null,
    rootId: null,
    parentId: null,
    // Trusted command message create_time (ms string) from the inbound event;
    // temporal anchor for no-quote material discovery.
    commandCreateTime: null,
    commanderOpenId: null,
    rawText: '',
    instruction: '',
    alias: null,
    explicitTarget: false,
    // denied | needs_input | queued | resolving | submitting | unknown | live | done | failed
    stage: 'queued',
    reasonCode: null,
    reasonDetail: null,
    // SHA-256 of the canonical submit payload, used to detect same-key/different-body conflict.
    fingerprint: null,
    material: null, // { messageId, kind, text, truncated, verifiedAt }
    pairfob: null, // { project, taskId, leaderId, phase, checkedAt }
    submit: { state: 'idle', attempts: 0, code: null, message: null, at: null },
    // kind -> outbound record (uuid is durable before the first send and reused).
    replies: {},
    // Distinct upstream phases for which a thread update was sent.
    sentPhases: [],
    createdAt: now,
    updatedAt: now,
  };
}

let tmpCounter = 0;

async function fsyncDirectory(dir) {
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync?.();
  } catch {
    // Some filesystems do not allow fsync on directories; rename atomicity remains.
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeJsonAtomic(file, value) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${file.split('/').pop()}.tmp-${process.pid}-${++tmpCounter}`);
  let handle;
  try {
    // The payload can contain raw chat text, so the temp file is owner-only.
    // open's mode is an upper bound; fchmod pins exact 0600 against any umask.
    handle = await open(tmp, 'wx', 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
    await handle.close();
    handle = undefined;
    // rename keeps the temp inode and its 0600 mode, replacing any old file.
    await rename(tmp, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    // Never leave a temp file containing raw chat text behind on failure.
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  await fsyncDirectory(dir);
}

export class JobStore {
  constructor(file, state) {
    this.file = file;
    this.state = state;
    this.chain = Promise.resolve();
    this.closed = false;
  }

  static async open(dataDir, options = {}) {
    const file = options.file ?? join(dataDir, options.fileName ?? STATE_FILE_NAME);
    let state;
    try {
      const raw = await readFile(file, 'utf8');
      state = JSON.parse(raw);
      if (!state || typeof state !== 'object' || state.version !== STATE_VERSION
        || !state.events || !state.messageIndex || !state.jobs) {
        throw new Error(`unrecognized state file shape/version: ${file}`);
      }
      // Files written by older builds may be world-readable; they already hold
      // raw chat text, so tighten them as soon as the store opens.
      await chmod(file, 0o600);
    } catch (error) {
      if (error && error.code === 'ENOENT') state = freshState();
      else throw error; // fail loud rather than restart "empty" and risk duplicate orders
    }
    return new JobStore(file, state);
  }

  /**
   * Run a synchronous, serial read-modify-write transaction and durably persist
   * it. `fn(state)` must not await; return value is resolved to the caller.
   *
   * `fn` runs against a detached copy: until its result is fsynced and renamed
   * into place, readers keep seeing the last durable state. A failed write (or a
   * throwing `fn`) discards the copy, so retrying the same message re-applies
   * the whole transaction instead of observing a half-committed memory state.
   */
  mutate(fn) {
    if (this.closed) return Promise.reject(new Error('store closed'));
    const run = this.chain.then(async () => {
      const draft = structuredClone(this.state);
      const result = fn(draft);
      await writeJsonAtomic(this.file, draft);
      // Make the transaction visible in memory only after fsync + rename.
      this.state = draft;
      return result;
    });
    // Keep the chain alive even if one transaction fails.
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  getEvent(eventId) {
    return eventId ? this.state.events[eventId] : undefined;
  }

  getJob(sourceKey) {
    return sourceKey ? this.state.jobs[sourceKey] : undefined;
  }

  getJobByMessage(messageId) {
    const key = messageId ? this.state.messageIndex[messageId] : undefined;
    return key ? this.state.jobs[key] : undefined;
  }

  listJobs() {
    return Object.values(this.state.jobs);
  }

  /** Jobs that may still need an async step after a restart. */
  pendingJobs() {
    return this.listJobs().filter((job) => ['queued', 'resolving', 'submitting', 'unknown', 'live'].includes(job.stage));
  }

  /**
   * Get or create the durable outbound record for `kind`. The UUID is generated
   * and persisted on creation so retries present the same Feishu idempotency key.
   * Must be called inside `store.mutate`.
   */
  outbound(state, sourceKey, kind) {
    const job = state.jobs[sourceKey];
    if (!job) throw new Error(`no job ${sourceKey}`);
    let reply = job.replies[kind];
    if (!reply) {
      reply = { uuid: randomUUID(), status: 'pending', providerMessageId: null, error: null, attempts: 0, updatedAt: new Date().toISOString() };
      job.replies[kind] = reply;
    }
    return reply;
  }

  async close() {
    this.closed = true;
    await this.chain;
  }

  /** Test helper: remove the state file. */
  async _remove() {
    await rm(this.file, { force: true });
  }
}
