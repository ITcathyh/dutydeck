import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * dockmux 时期遗留状态的一次性接管。
 *
 * 不做这件事的后果不是报错而是静默失灵：改名后的二进制在同一个工作目录启动时，
 * 找不到 `.dutydeck/dutydeck.db` 就会当成全新安装建一个空库，用户看到的是任务历史凭空消失。
 */

const LEGACY_NAME = 'dockmux';
const CURRENT_NAME = 'dutydeck';
const LEGACY_DIR = `.${LEGACY_NAME}`;
const CURRENT_DIR = `.${CURRENT_NAME}`;
const LEGACY_ENV_PREFIX = 'DOCKMUX_';
const CURRENT_ENV_PREFIX = 'DUTYDECK_';

/**
 * 按名字被代码查找的运行时文件只在这两层：状态目录顶层（`dockmux.db` 及其 -wal/-shm/备份）
 * 和 `daemon/`（pid、log、state.json）。
 *
 * 不递归是有意的：`verification/` 下存着历次验证留底的构建产物（`before-dist/`、
 * `previous-public/` 里的 dockmux.svg 等），那是历史快照，改名就是篡改存档。
 */
const RUNTIME_FILE_DIRS = ['', 'daemon'];

/** 迁移后内容仍指向旧位置的文件——存的是绝对路径，跟着目录搬走并不会自动生效。 */
const PATH_BEARING_FILES = ['last-daemon-dir', join('daemon', `${CURRENT_NAME}.state.json`)];

/**
 * 把 `DOCKMUX_X` 补成 `DUTYDECK_X`，返回被接管的旧变量名。
 * 新名已显式设置时不覆盖——用户写了新名就以新名为准。
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const adopted: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.startsWith(LEGACY_ENV_PREFIX)) continue;
    const renamed = `${CURRENT_ENV_PREFIX}${key.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[renamed] !== undefined) continue;
    env[renamed] = value;
    adopted.push(key);
  }
  return adopted;
}

/** `dockmux.db-wal` → `dutydeck.db-wal`、`dockmux.state.json` → `dutydeck.state.json`。 */
function renameBrandedFiles(dir: string): void {
  for (const relative of RUNTIME_FILE_DIRS) {
    const target = join(dir, relative);
    if (!existsSync(target)) continue;
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(`${LEGACY_NAME}.`)) continue;
      renameSync(join(target, entry.name), join(target, `${CURRENT_NAME}${entry.name.slice(LEGACY_NAME.length)}`));
    }
  }
}

/**
 * `last-daemon-dir` 尤其不能漏：它是「换个工作目录启动也别再建一套库」这条保护的唯一依据，
 * 内容失效后会回退到当前目录，正好造出它本来要拦住的第二份安装。
 */
function repointLegacyPaths(dir: string): void {
  for (const relative of PATH_BEARING_FILES) {
    const file = join(dir, relative);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    const after = before
      .split(`/${LEGACY_DIR}/`).join(`/${CURRENT_DIR}/`)
      .split(`/${LEGACY_NAME}.`).join(`/${CURRENT_NAME}.`);
    if (after !== before) writeFileSync(file, after);
  }
}

/**
 * 迁移单个状态目录。目标目录已存在时整体跳过：
 * 宁可让用户看到两份自己决定，也不合并覆盖。
 */
function migrateDir(parent: string): string | undefined {
  const legacy = join(parent, LEGACY_DIR);
  const current = join(parent, CURRENT_DIR);
  if (!existsSync(legacy) || existsSync(current)) return undefined;
  renameSync(legacy, current);
  renameBrandedFiles(current);
  repointLegacyPaths(current);
  return current;
}

/**
 * 迁移工作目录和 home 下的旧状态目录，返回实际动过的路径。
 * 目录改名是原子的，daemon 正在运行也安全：已打开的 fd 跟着 inode 走，
 * pid 文件也随目录一起移动，之后的存活判断仍能找到同一个进程。
 */
export function migrateLegacyBrandDirs(
  cwd = process.cwd(),
  home = process.env.HOME ?? homedir()
): string[] {
  const migrated = [migrateDir(cwd)];
  if (home !== cwd) migrated.push(migrateDir(home));
  return migrated.filter((path): path is string => path !== undefined);
}
