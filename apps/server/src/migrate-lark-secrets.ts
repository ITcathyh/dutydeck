import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createRepositories } from '@dutydeck/storage';
import { LocalFileSecretProvider, liveLarkSecretKey, readLiveLarkSecret, secretDirectoryForDatabase, SecretProviderError } from '@dutydeck/secret-provider';
import { SecretCliError } from './secret-cli.js';

interface BotCredentials { appId: string; appSecret?: string; appSecretRef?: string }
const configKey = 'lark.bots';

function entries(raw?: string): BotCredentials[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? '[]'); } catch { /* The parse error may quote secret values. */ }
  if (!Array.isArray(parsed)) throw new SecretCliError('INVALID_LARK_CONFIG', 'Invalid bot configuration');
  return parsed;
}

function selected(bot: BotCredentials, revert?: boolean) {
  return typeof bot?.appId === 'string' && !!bot.appId.trim() && (revert ? !!bot.appSecretRef : typeof bot.appSecret === 'string' && !!bot.appSecret);
}

export function migrateLarkSecrets(path: string, options: { dryRun?: boolean; revert?: boolean }) {
  const database = realpathSync(path);
  const db = new Database(database, { readonly: true, fileMustExist: true });
  let ids: string[];
  try {
    const bots = entries(db.prepare('SELECT value FROM configs WHERE key = ?').pluck().get(configKey) as string | undefined);
    ids = bots.filter(bot => selected(bot, options.revert)).map(bot => bot.appId);
  } finally { db.close(); }
  if (options.dryRun || (options.revert && !ids.length)) return { appIds: ids };

  const repos = createRepositories(database);
  const appIds: string[] = [];
  const checkReader = () => {
    if (options.revert) return;
    const capabilities = repos.control.runtimeCapabilities();
    if (capabilities && !capabilities.includes('lark_secret_refs')) throw new SecretCliError('LARK_SECRET_READER_REQUIRED',
      'Cannot confirm the running service reads Lark secret references. Stop it or deploy a compatible service before migrating.');
  };
  try {
    if (!ids.length) checkReader();
    for (const id of ids) {
      const changed = repos.transaction(tx => {
        // BEGIN IMMEDIATE also excludes runtime registrations until this bot has committed.
        checkReader();
        const bots = entries(tx.config.get(configKey));
        const matches = bots.filter(bot => bot?.appId === id);
        if (matches.length > 1) throw new SecretCliError('INVALID_LARK_CONFIG', 'Duplicate bot identifier');
        const bot = matches[0];
        if (!bot || !selected(bot, options.revert)) return false;
        const appId = id.trim();
        const current = bot.appSecretRef ? readLiveLarkSecret(database, appId, bot.appSecretRef) : undefined;
        if (options.revert) {
          if (!current && !bot.appSecret) throw new SecretCliError('SECRET_VALUE_MISSING', 'Live bot credential is missing');
          bot.appSecret = current ?? bot.appSecret;
          delete bot.appSecretRef;
        } else {
          if (current === undefined) {
            const provider = new LocalFileSecretProvider(secretDirectoryForDatabase(database), { createDirectory: true });
            const version = randomUUID().replaceAll('-', '');
            provider.writeExclusive(liveLarkSecretKey(appId, version), Buffer.from(bot.appSecret!, 'utf8'));
            bot.appSecretRef = version;
          }
          if (readLiveLarkSecret(database, appId, bot.appSecretRef!) !== bot.appSecret) throw new SecretCliError('SECRET_CONDITION_FAILED', 'Live bot credential verification failed');
          delete bot.appSecret;
        }
        tx.config.set(configKey, JSON.stringify(bots));
        return true;
      });
      if (changed) appIds.push(id);
    }
    return { appIds };
  } catch (error) {
    if (error instanceof SecretProviderError || error instanceof SecretCliError) throw error;
    throw new SecretCliError('SECRET_MIGRATION_FAILED', 'Live bot credential migration failed');
  } finally { repos.close(); }
}
