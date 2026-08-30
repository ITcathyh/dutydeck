/**
 * dockmux skill 契约。
 *
 * 一个 skill = 一个目录名 + 一份 SKILL.md 全文。投递后由被桥接的 CLI 自己
 * 发现并加载（Claude Code 的 `--plugin-dir`、其它 CLI 的 skills 目录约定）。
 * dockmux 不解析、不执行 skill 正文——它只负责把文件放到 CLI 能看到的地方。
 *
 * 与 botmux 的差异：botmux 的 `SkillDef` 通过外部数组（`BUILTIN_SKILLS` /
 * `WORKFLOW_FEATURE_SKILLS` / `ASK_SKILL` …）表达「是否安装」的条件，条件本身
 * 散在 worker-pool 里。dockmux 不复制这套耦合：内置集就是一个数组，条件性
 * 投递交给调用方按 `SkillDef.name` 过滤。
 */

/** dockmux 投递的 skill 目录名统一前缀——命名空间隔离的硬约束 */
export const DOCKMUX_SKILL_PREFIX = 'dockmux-';

/** 一个可投递的 skill */
export interface SkillDef {
  /**
   * 目录名，同时必须等于 SKILL.md frontmatter 里的 `name`。
   * 约束：`dockmux-` 前缀 + 文件系统安全（见 `isSafeSkillName`）。
   */
  readonly name: string;
  /** SKILL.md 全文，含 YAML frontmatter */
  readonly content: string;
}

/** 从 SKILL.md frontmatter 解出的元信息 */
export interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
}

/** 单次投递的结果。路径都是绝对路径。 */
export interface SkillInstallResult {
  /** 本次真正写入磁盘的文件（新建或内容有变） */
  readonly written: string[];
  /** 内容一致、跳过未写的文件（幂等命中） */
  readonly skipped: string[];
  /** 清理掉的陈旧 `dockmux-*` skill 目录 */
  readonly removed: string[];
}

export interface InstallSkillsOptions {
  /** 要投递的 skill 集；默认 `DOCKMUX_BUILTIN_SKILLS` */
  readonly skills?: readonly SkillDef[];
  /**
   * 允许写入用户全局 skill 目录（`~/.claude/skills` 等）。
   *
   * 默认 `false` 且**应当保持 false**：全局目录里的 skill 会污染用户自己开的
   * 独立 CLI 会话——那些会话不在 dockmux 桥接里，读到「你运行在无人值守桥接
   * 会话中」是纯粹的错误信息。botmux 是先踩了这个坑、再补 `removeGlobal-
   * BotmuxSkills` 去扫全局残留；dockmux 从一开始就默认拒绝。
   */
  readonly allowGlobalDir?: boolean;
  /**
   * 清理目标目录下不属于本次 skill 集的陈旧 `dockmux-*` 目录。默认 `true`。
   * 只按 `dockmux-` 前缀清理，绝不触碰用户自己的 skill。
   */
  readonly pruneStale?: boolean;
}

/** `name` 是否文件系统安全：不含分隔符、不是 `.`/`..`、无空白与控制字符 */
export function isSafeSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(name)
    && !name.includes('..')
    && name !== '.'
    && !name.endsWith('.');
}

/** 是否是 dockmux 命名空间下的 skill 目录名 */
export function isDockmuxSkillName(name: string): boolean {
  return name.startsWith(DOCKMUX_SKILL_PREFIX) && isSafeSkillName(name);
}

/**
 * 解析 SKILL.md 的 YAML frontmatter。
 *
 * 只取 `name` / `description` 两个标量键——与 `apps/server/src/skill-catalog.ts`
 * 的 `discoverSkills` 采用同一套宽松规则，保证 dockmux 自己投递的 skill 一定
 * 能被自己的发现逻辑读出来。不引 YAML 依赖：frontmatter 契约就这两个键。
 */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const block = markdown.match(/^---\s*\n([\s\S]*?)\n---/)?.[1];
  if (!block) return {};
  const read = (key: string) => {
    const value = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
    return value ? value.replace(/^['"]|['"]$/g, '') : undefined;
  };
  const name = read('name');
  const description = read('description');
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

/**
 * 校验一个 skill 定义是否自洽。返回问题列表，空数组表示合法。
 * 投递前会逐个跑——把「目录名与 frontmatter 不一致」这类错误挡在写盘之前，
 * 而不是让 CLI 加载出一个名字对不上的 skill。
 */
export function validateSkillDef(skill: SkillDef): string[] {
  const problems: string[] = [];
  if (!isSafeSkillName(skill.name)) problems.push(`name 不是文件系统安全的目录名：${JSON.stringify(skill.name)}`);
  if (!skill.name.startsWith(DOCKMUX_SKILL_PREFIX)) problems.push(`name 必须以 ${DOCKMUX_SKILL_PREFIX} 开头（命名空间隔离）：${skill.name}`);
  const frontmatter = parseSkillFrontmatter(skill.content);
  if (!frontmatter.name) problems.push(`${skill.name}: SKILL.md frontmatter 缺少 name`);
  else if (frontmatter.name !== skill.name) problems.push(`${skill.name}: frontmatter name 与目录名不一致（${frontmatter.name}）`);
  if (!frontmatter.description) problems.push(`${skill.name}: SKILL.md frontmatter 缺少 description`);
  return problems;
}
