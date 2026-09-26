import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { RuntimeError } from '@dutydeck/shared';

export const botProcessKey = 'dutydeck.bot_process';
export const botProcessMigrationKey = 'dutydeck.bot_process_migration';
export interface BotProcessBinding { version: 1; appId: string | null }

function reject(message: string): never {
  throw new RuntimeError('BOT_PROCESS_SCOPE', `BOT_PROCESS_SCOPE: ${message}`, 409);
}
function read(db: Database.Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM configs WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}
function binding(raw: string): BotProcessBinding {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { reject('Invalid persisted bot process binding'); }
  const item = value as BotProcessBinding | null;
  if (!item || item.version !== 1 || (item.appId !== null && (typeof item.appId !== 'string' || !item.appId.trim()))) reject('Invalid persisted bot process binding');
  return item;
}
function assertBots(raw: string | undefined, scope: BotProcessBinding): void {
  let bots: unknown;
  try { bots = JSON.parse(raw ?? '[]'); } catch { reject('Invalid lark.bots configuration'); }
  if (!Array.isArray(bots) || (scope.appId === null ? bots.length !== 0 : bots.length !== 1 || bots[0]?.appId !== scope.appId)) {
    reject('Database must contain exactly its assigned bot (or no bots for a Web process)');
  }
}
export function assertBotProcessApp(db: Database.Database, appId: string): void {
  const raw = read(db, botProcessKey);
  if (raw !== undefined && binding(raw).appId !== appId) reject('Cannot add or replace the bot assigned to this process');
}

/** All repository config writes, including offline import, share this boundary. */
export function assertBotProcessConfigWrite(db: Database.Database, key: string, value: string): void {
  const raw = read(db, botProcessKey);
  if (key === botProcessKey) {
    const scope = binding(value);
    if (raw !== undefined && binding(raw).appId !== scope.appId) reject('Bot process binding is immutable');
    assertBots(read(db, 'lark.bots'), scope);
  } else if (raw !== undefined && key === 'lark.bots') {
    assertBots(value, binding(raw));
  } else if (raw !== undefined && key === 'lark.credentials') {
    let legacy: { appId?: string };
    try { legacy = JSON.parse(value); } catch { reject('Invalid legacy bot configuration'); }
    if (legacy?.appId !== binding(raw).appId) reject('Legacy credentials must match the assigned bot');
  }
}

/** Read-only check before taking a runtime claim or recovering any session. */
export function assertBotProcessStartup(filename: string, expectedAppId?: string): BotProcessBinding | undefined {
  if (filename === ':memory:' || !existsSync(filename)) {
    if (expectedAppId !== undefined) reject('--bot-app-id requires a partitioned database');
    return undefined;
  }
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'configs'").get()) {
      if (expectedAppId !== undefined) reject('--bot-app-id requires a partitioned database');
      return undefined;
    }
    if (read(db, botProcessMigrationKey) !== undefined) reject('This source database has been migrated; start the generated per-bot runtimes');
    const raw = read(db, botProcessKey);
    if (raw === undefined) {
      if (expectedAppId !== undefined) reject('--bot-app-id requires a persisted bot process binding; split the database first');
      return undefined;
    }
    const scope = binding(raw);
    if (expectedAppId !== undefined && expectedAppId !== scope.appId) reject('--bot-app-id does not match the database binding');
    assertBots(read(db, 'lark.bots'), scope);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_bots'").get()) {
      const bots = db.prepare("SELECT external_app_id AS appId FROM channel_bots WHERE channel = 'lark' AND state != 'deleted'").all() as Array<{ appId: string }>;
      if (bots.some(bot => bot.appId !== scope.appId) || bots.length > 1) reject('Structured bot configuration does not match the database binding');
    }
    return scope;
  } finally { db.close(); }
}
