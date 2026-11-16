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
