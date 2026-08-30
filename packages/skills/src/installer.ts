import { readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { atomicWriteFile } from './atomic-write.js';
import { DOCKMUX_BUILTIN_SKILLS } from './definitions.js';
import {
  DOCKMUX_SKILL_PREFIX,
  isDockmuxSkillName,
  validateSkillDef,
  type InstallSkillsOptions,
  type SkillDef,
  type SkillInstallResult,
} from './types.js';

/** Claude Code plugin 清单文件名（`.claude-plugin/plugin.json`） */
const PLUGIN_MANIFEST_DIR = '.claude-plugin';
const PLUGIN_MANIFEST_FILE = 'plugin.json';
/** plugin dir 下 skill 的子目录 */
const PLUGIN_SKILLS_SUBDIR = 'skills';
/** 每个 skill 目录里的正文文件名，CLI 生态统一约定 */
const SKILL_FILE = 'SKILL.md';

/**
 * plugin 清单内容。稳定序列化（2 空格 + 结尾换行）——幂等比较靠逐字节相等，
 * 序列化只要抖一下就会每次都重写。
 */
const PLUGIN_MANIFEST_CONTENT = `${JSON.stringify({
  name: 'dockmux',
  description: 'dockmux 桥接会话内置 skill —— 仅在 dockmux 拉起的会话内通过 --plugin-dir 注入，不写入用户全局 skill 目录。',
  version: '1.0.0',
  author: { name: 'dockmux' },
}, null, 2)}\n`;

/** 已知的用户全局 skill 目录。默认拒绝写入这些位置。 */
function globalSkillDirs(): string[] {
  const home = homedir();
  return [
    join(home, '.claude', 'skills'),
    join(home, '.claude', 'plugins'),
    join(home, '.agents', 'skills'),
    join(home, '.codex', 'skills'),
    join(home, '.gemini', 'skills'),
    join(home, '.cursor', 'skills'),
    join(home, '.trae', 'skills'),
    join(home, '.config', 'opencode', 'skills'),
  ];
}

/** `~` 展开 + 绝对化，供路径比较用 */
function expandHome(path: string): string {
  const expanded = path.startsWith('~')
    ? join(homedir(), path.slice(1))
    : path;
  return resolve(expanded);
}

/**
 * 目标目录是否落在用户全局 skill 目录里（含其子目录）。
 *
 * 写进全局目录的 skill 会被用户**自己开的、与 dockmux 无关的** CLI 会话读到，
 * 那些会话里「你运行在无人值守桥接会话中」是错的。所以默认 fail closed。
 */
export function isGlobalSkillDir(directory: string): boolean {
  const target = expandHome(directory);
  return globalSkillDirs().some(global => target === global || target.startsWith(global + sep));
}

class GlobalSkillDirError extends Error {
  constructor(directory: string) {
    super(
      `拒绝把 dockmux skill 写入用户全局目录：${directory}。`
      + ' 全局 skill 会污染用户自己开的独立 CLI 会话；请改用会话级 plugin dir，'
      + ' 确需写入时显式传 allowGlobalDir: true。',
    );
    this.name = 'GlobalSkillDirError';
  }
}

/** 读现有内容；不存在（或不可读）返回 undefined，交给调用方按「需要写」处理。 */
async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** 内容一致就跳过，否则原子写。幂等的唯一实现点。 */
async function writeIfChanged(path: string, content: string, result: SkillInstallResult): Promise<void> {
  if (await readIfExists(path) === content) {
    result.skipped.push(path);
    return;
  }
  await atomicWriteFile(path, content);
  result.written.push(path);
}

/**
 * 清掉目标目录下**属于 dockmux 命名空间**、但不在本次 skill 集里的陈旧目录。
 *
 * 只按 `dockmux-` 前缀清理，且只清目录——用户自己的 skill 与任何非 dockmux
 * 内容永远不动。按前缀而不是按「上一版的名单」清，是为了让降级/改名也能被
 * 收干净（旧版投递过、新版不再有的 skill，名单法看不见它）。
 */
async function pruneStaleSkills(directory: string, keep: ReadonlySet<string>, result: SkillInstallResult): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // 目录还不存在：没有可清理的东西
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isDockmuxSkillName(entry.name)) continue;
    if (keep.has(entry.name)) continue;
    const stale = join(directory, entry.name);
    await rm(stale, { recursive: true, force: true });
    result.removed.push(stale);
  }
}

function assertValid(skills: readonly SkillDef[]): void {
  const problems = skills.flatMap(validateSkillDef);
  const names = skills.map(skill => skill.name);
  const duplicated = names.filter((name, index) => names.indexOf(name) !== index);
  for (const name of new Set(duplicated)) problems.push(`skill 名字重复：${name}`);
  if (problems.length) throw new Error(`skill 定义不合法：\n- ${problems.join('\n- ')}`);
}

function emptyResult(): SkillInstallResult {
  return { written: [], skipped: [], removed: [] };
}

/**
 * 把 skill 投递到一个通用 skills 目录：`<skillsDir>/<name>/SKILL.md`。
 *
 * 适用于没有 plugin 机制、只认约定目录的 CLI。目标目录由调用方给出——通常是
 * **会话级**的临时目录，而不是用户全局目录（后者默认被拒绝）。
 */
export async function installSkillsToDir(
  skillsDir: string,
  options: InstallSkillsOptions = {},
): Promise<SkillInstallResult> {
  const skills = options.skills ?? DOCKMUX_BUILTIN_SKILLS;
  assertValid(skills);
  if (!options.allowGlobalDir && isGlobalSkillDir(skillsDir)) throw new GlobalSkillDirError(skillsDir);

  const root = expandHome(skillsDir);
  const result = emptyResult();
  for (const skill of skills) {
    await writeIfChanged(join(root, skill.name, SKILL_FILE), skill.content, result);
  }
  if (options.pruneStale !== false) {
    await pruneStaleSkills(root, new Set(skills.map(skill => skill.name)), result);
  }
  return result;
}

/**
 * 把 skill 投递成一个 Claude Code plugin：
 *
 *     <pluginDir>/.claude-plugin/plugin.json
 *     <pluginDir>/skills/<name>/SKILL.md
 *
 * 集成方随后用 `--plugin-dir <pluginDir>` 拉起 CLI，skill 只在这一个会话里可见，
 * 不落进用户全局配置。
 */
export async function installSkillsToPluginDir(
  pluginDir: string,
  options: InstallSkillsOptions = {},
): Promise<SkillInstallResult> {
  const skills = options.skills ?? DOCKMUX_BUILTIN_SKILLS;
  assertValid(skills);

  const root = expandHome(pluginDir);
  const skillsRoot = join(root, PLUGIN_SKILLS_SUBDIR);
  // 校验**实际写入路径**，而不只是入参：pluginDir 本身不是全局目录、但拼出的
  // `<pluginDir>/skills` 恰好是的情况会绕过检查（如 pluginDir='~/.claude' →
  // 写进 ~/.claude/skills）。清单目录同理。
  if (!options.allowGlobalDir) {
    for (const path of [root, skillsRoot, join(root, PLUGIN_MANIFEST_DIR)]) {
      if (isGlobalSkillDir(path)) throw new GlobalSkillDirError(path);
    }
  }

  const result = emptyResult();
  await writeIfChanged(join(root, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE), PLUGIN_MANIFEST_CONTENT, result);
  // skill 正文复用 skills-dir 写入路径，两种形态只有一套写盘逻辑。
  // 上面已按实际路径校验过，往下透传避免二次判定。
  const skillsResult = await installSkillsToDir(skillsRoot, {
    ...options,
    skills,
    allowGlobalDir: true,
  });
  result.written.push(...skillsResult.written);
  result.skipped.push(...skillsResult.skipped);
  result.removed.push(...skillsResult.removed);
  return result;
}

/**
 * 清掉一个目录下所有 dockmux 命名空间的 skill（不碰其它内容）。
 * 用于会话结束回收，或把某个 CLI 的 skill 投递整体关掉。
 */
export async function removeDockmuxSkills(directory: string): Promise<string[]> {
  const result = emptyResult();
  await pruneStaleSkills(expandHome(directory), new Set(), result);
  return result.removed;
}

export { DOCKMUX_SKILL_PREFIX, PLUGIN_MANIFEST_CONTENT, SKILL_FILE };
