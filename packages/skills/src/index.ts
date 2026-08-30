/**
 * `@dockmux/skills` —— 把「dockmux 运行环境说明」投递给被桥接的 CLI。
 *
 * 用法（集成方）：
 *
 *     import { installSkillsToPluginDir } from '@dockmux/skills';
 *     const { written } = await installSkillsToPluginDir(join(sessionDir, 'plugin'));
 *     // 然后 spawn CLI 时带上 --plugin-dir <sessionDir>/plugin
 *
 * 设计要点见 `definitions.ts` 顶部注释（为什么内置集这么小）与
 * `installer.ts` 的 `isGlobalSkillDir`（为什么默认不写用户全局目录）。
 */

export {
  DOCKMUX_SKILL_PREFIX,
  isDockmuxSkillName,
  isSafeSkillName,
  parseSkillFrontmatter,
  validateSkillDef,
  type InstallSkillsOptions,
  type SkillDef,
  type SkillFrontmatter,
  type SkillInstallResult,
} from './types.js';

export {
  DOCKMUX_BUILTIN_SKILLS,
  builtinSkill,
  builtinSkillNames,
} from './definitions.js';

export {
  PLUGIN_MANIFEST_CONTENT,
  SKILL_FILE,
  installSkillsToDir,
  installSkillsToPluginDir,
  isGlobalSkillDir,
  removeDockmuxSkills,
} from './installer.js';

export { atomicWriteFile } from './atomic-write.js';
