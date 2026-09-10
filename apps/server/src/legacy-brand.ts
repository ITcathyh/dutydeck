import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * dockmux 时期遗留状态的一次性接管。
 *
 * 不做这件事的后果不是报错而是静默失灵：改名后的二进制在同一个工作目录启动时，
 * 找不到 `.dutydeck/dutydeck.db` 就会当成全新安装建一个空库，用户看到的是任务历史凭空消失。
 *
 * 光把目录搬走并不够——凡是「已经落盘、内容里写死了旧路径或旧文件名」的地方都得跟着走，
 * 否则它们会把刚搬好的状态重新指回不存在的位置。本模块覆盖三处：状态目录本身、
 * `last-daemon-dir` 指针、以及 `.env` 里带路径的环境变量。
 */

const LEGACY_NAME = 'dockmux';
const CURRENT_NAME = 'dutydeck';
const LEGACY_DIR = `.${LEGACY_NAME}`;
const CURRENT_DIR = `.${CURRENT_NAME}`;
const LEGACY_ENV_PREFIX = 'DOCKMUX_';
const CURRENT_ENV_PREFIX = 'DUTYDECK_';
const POINTER_FILE = 'last-daemon-dir';

/**
 * 按名字被代码查找的运行时文件只在这两层：状态目录顶层（`dockmux.db` 及其 -wal/-shm/备份）
 * 和 `daemon/`（pid、log、state.json）。
 *
 * 不递归是有意的：`verification/` 下存着历次验证留底的构建产物（`before-dist/`、
 * `previous-public/` 里的 dockmux.svg 等），那是历史快照，改名就是篡改存档。
 */
const RUNTIME_FILE_DIRS = ['', 'daemon'];

/** 把一段文本里指向旧状态目录的路径改写为新的；形近路径（如 /srv/dockmuxer）不受影响。 */
function repointText(text: string): string {
  return text
    .split(`${LEGACY_DIR}/`).join(`${CURRENT_DIR}/`)
    .split(`/${LEGACY_NAME}.`).join(`/${CURRENT_NAME}.`);
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
 * 迁移单个状态目录。目标目录已存在时整体跳过并如实上报：
 * 宁可让用户看到两份自己决定，也不合并覆盖——但不能一声不吭地跳过。
 */
function migrateDir(parent: string): { migrated?: string; skipped?: string } {
  const legacy = join(parent, LEGACY_DIR);
  const current = join(parent, CURRENT_DIR);
  if (!existsSync(legacy)) return {};
  if (existsSync(current)) return { skipped: legacy };
  renameSync(legacy, current);
  renameBrandedFiles(current);
  return { migrated: current };
}

/** 读出 `last-daemon-dir` 记录的项目根目录——状态目录常常不在 cwd 也不在 home 底下。 */
function pointedRoot(home: string): string | undefined {
  for (const dir of [CURRENT_DIR, LEGACY_DIR]) {
    const file = join(home, dir, POINTER_FILE);
    if (!existsSync(file)) continue;
    const recorded = readFileSync(file, 'utf8').trim();
    if (!recorded || !isAbsolute(recorded)) continue;
    // 内容形如 <root>/.dockmux/daemon 或迁移中途的 <root>/.dutydeck/daemon
    const parent = dirname(dirname(recorded));
    const leaf = recorded.slice(parent.length + 1);
    if (leaf === `${LEGACY_DIR}/daemon` || leaf === `${CURRENT_DIR}/daemon`) return parent;
  }
  return undefined;
}

/**
 * 指针内容是绝对路径，跟着文件搬走并不会自动生效。
 *
 * 但只有在它指向的目录**确实**已经迁移过时才能改写：否则会把指针指到一个从不存在的路径上，
 * 而这个指针正是「换个工作目录启动别再建第二套库」的唯一依据，指错等于亲手造出它要拦的东西。
 */
function repointPointer(home: string): void {
  const file = join(home, CURRENT_DIR, POINTER_FILE);
  if (!existsSync(file)) return;
  const before = readFileSync(file, 'utf8');
  const after = repointText(before);
  if (after === before || !existsSync(after.trim())) return;
  writeFileSync(file, after);
}

/** daemon 自己记的状态；`database` 是绝对路径，同样只在新路径确实存在时才改写。 */
function repointState(dir: string): void {
  const file = join(dir, 'daemon', `${CURRENT_NAME}.state.json`);
  if (!existsSync(file)) return;
  const before = readFileSync(file, 'utf8');
  const after = repointText(before);
  if (after === before) return;
  let parsed: { database?: unknown };
  try { parsed = JSON.parse(after) as { database?: unknown }; } catch { return; }
  if (typeof parsed.database === 'string' && !existsSync(parsed.database)) return;
  writeFileSync(file, after);
}

/**
 * 把 `DOCKMUX_X` 补成 `DUTYDECK_X`，返回被接管的旧变量名。
 * 新名已显式设置时不覆盖——用户写了新名就以新名为准。
 *
 * 值里的路径要一起改写，否则 `.env.example` 默认就带的
 * `DOCKMUX_DATABASE_URL=./.dockmux/dockmux.db` 会在目录迁移后指回空位置，
 * storage 随即重建 `.dockmux/`，此后目录迁移因「目标已存在」永久跳过——迁移把自己废掉。
 * 只有改写后的路径确实存在才改，避免在迁移被跳过时把用户指离自己的真实数据。
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const adopted: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.startsWith(LEGACY_ENV_PREFIX)) continue;
    const renamed = `${CURRENT_ENV_PREFIX}${key.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[renamed] !== undefined) continue;
    const repointed = repointText(value);
    env[renamed] = repointed !== value && existsSync(resolve(cwd, repointed)) ? repointed : value;
    adopted.push(key);
  }
  return adopted;
}

export interface LegacyBrandMigration {
  /** 实际完成迁移的新目录。 */
  migrated: string[];
  /** 因为新目录已存在而没动的旧目录——用户需要自己决定留哪一份。 */
  skipped: string[];
}

/**
 * 迁移工作目录、home、以及指针记录的项目根目录下的旧状态目录。
 *
 * 目录改名是原子的，daemon 正在运行也安全：已打开的 fd 跟着 inode 走，
 * pid 文件也随目录一起移动，之后的存活判断仍能找到同一个进程。
 */
export function migrateLegacyBrandDirs(
  cwd = process.cwd(),
  home = process.env.HOME ?? homedir()
): LegacyBrandMigration {
  const roots = new Set([cwd, home]);
  const pointed = pointedRoot(home);
  if (pointed) roots.add(pointed);

  const migrated: string[] = [];
  const skipped: string[] = [];
  for (const root of roots) {
    const result = migrateDir(root);
    if (result.migrated) migrated.push(result.migrated);
    if (result.skipped) skipped.push(result.skipped);
  }
  // 目录都就位之后再改写指针和 state，这样「新路径是否存在」的判断才有意义。
  repointPointer(home);
  for (const dir of migrated) repointState(dir);
  return { migrated, skipped };
}
