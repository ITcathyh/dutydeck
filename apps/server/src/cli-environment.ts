import type { CliOptions } from './cli-program.js';
import { loadEnvFile } from 'node:process';
import { adoptLegacyEnv, migrateLegacyBrandDirs } from './legacy-brand.js';

/** Shared by the public CLI and the internal Agent entry, after internal routing. */
export function prepareCliEnvironment(isolatedBackupCommand = process.argv[2] === 'backup'): void {
  // 文件不存在是正常的（没有 .env）；存在却读不了/解析失败不能静默，否则配置悄悄失效。
  try { if (!isolatedBackupCommand) loadEnvFile(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') process.stderr.write(`警告：无法读取 ${process.cwd()}/.env，其中的配置没有生效：${error instanceof Error ? error.message : String(error)}\n`);
  }

  // 先把旧状态目录就位，再接管环境变量——否则无从判断变量里改写后的路径是否真的存在。
  const legacyState = isolatedBackupCommand ? { migrated: [], skipped: [] } : migrateLegacyBrandDirs();
  for (const dir of legacyState.migrated) process.stderr.write(`已接管 dockmux 时期的状态目录：${dir}\n`);
  for (const dir of legacyState.skipped) {
    process.stderr.write(`未接管 ${dir}：同级已有 .dutydeck，两份状态都留着，请自行确认用哪一份。\n`);
  }
  if (!isolatedBackupCommand) adoptLegacyEnv();
}

export function environmentFromCli(options: CliOptions, base: NodeJS.ProcessEnv = process.env) {
  const env = { ...base };
  if (options.host !== undefined) env.DUTYDECK_HOST = options.host;
  if (options.localOnly === true) env.DUTYDECK_LOCAL_ONLY = 'true';
  if (options.auth !== undefined) env.DUTYDECK_AUTH = String(options.auth);
  if (options.unsafeNoAuth === true) {
    env.DUTYDECK_AUTH = 'false';
    env.DUTYDECK_UNSAFE_NO_AUTH = 'true';
  }
  if (options.port !== undefined) env.DUTYDECK_PORT = options.port;
  if (options.cwd !== undefined) env.DUTYDECK_DEFAULT_CWD = options.cwd;
  if (options.database !== undefined) env.DUTYDECK_DATABASE_URL = options.database;
  if (options.botAppId !== undefined) env.DUTYDECK_BOT_APP_ID = options.botAppId;
  if (options.driverIdleCpuAction !== undefined) env.DUTYDECK_DRIVER_IDLE_CPU_ACTION = options.driverIdleCpuAction;
  if (options.idleTimeoutMs !== undefined) env.DUTYDECK_DRIVER_IDLE_TIMEOUT_MS = options.idleTimeoutMs;
  if (options.cleanupIntervalMs !== undefined) env.DUTYDECK_CLEANUP_INTERVAL_MS = options.cleanupIntervalMs;
  if (options.larkAppId !== undefined) env.LARK_APP_ID = options.larkAppId;
  if (options.larkAppSecret !== undefined) env.LARK_APP_SECRET = options.larkAppSecret;
  if (options.larkReceiveId !== undefined) env.LARK_RECEIVE_ID = options.larkReceiveId;
  if (options.larkChatId !== undefined) env.LARK_CHAT_ID = options.larkChatId;
  if (options.larkReceiveIdType !== undefined) env.LARK_RECEIVE_ID_TYPE = options.larkReceiveIdType;
  if (options.larkAgentName !== undefined) env.LARK_AGENT_NAME = options.larkAgentName;
  if (options.larkBaseUrl !== undefined) env.LARK_OPEN_API_BASE_URL = options.larkBaseUrl;
  if (options.larkListen === false) env.DUTYDECK_DISABLE_LARK_LISTENER = 'true';
  return env;
}
