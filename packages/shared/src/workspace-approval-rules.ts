/**
 * 按工作区记住的审批规则：飞书审批卡上点「本工作区允许此类命令」时，从这条命令推导出一条规则，
 * 之后同一工作区里被规则覆盖的命令不再弹卡。
 *
 * 推导和匹配只做保守的词法判断，不执行、不展开任何东西，看不懂就弹卡：
 * - 命令只能由普通单词组成（字母、数字和 `._/@:+=,%^-`），词之间用空格或制表符分隔；
 * - 只认未加引号的 `&&` 与 `;` 两种分段，每段都必须被规则覆盖；
 * - 引号、反斜杠、`$`（含 `$(`）、反引号、`<(`、任何重定向、管道、`&`、换行、heredoc、括号、花括号、
 *   通配符、`~`、`#`、`!` 任一出现，或某段以 `NAME=value` 环境变量赋值开头，都不生成规则、也不算覆盖。
 * - 只有白名单里的命令能建规则（见 `safeCommands`），其余一律不能；规则就是白名单那一项的命令词。
 *   规则后面的参数也按同一项逐个检查：只认列出的选项，位置参数不能以 `-` 开头、不能含 `=`、
 *   不能是绝对路径、不能含 `..` 路径段；`make <目标>` 不接受任何参数。
 * - 匹配时每段按同一白名单重新推导，推导结果等于库里某条规则才算覆盖；库里不合白名单的旧规则不生效。
 * 高危正则不在这里判断：调用方在推导和每次匹配前都先跑一遍部署配置的高危正则，命中就照常弹卡。
 */

export interface WorkspaceApprovalRule {
  id: string;
  /** 建规则的飞书机器人；规则只对同一机器人的会话生效，不跨机器人共享。 */
  appId: string;
  /** 工作区：建规则时 Agent 实际执行目录（审批卡上显示的目录）的真实路径（realpath）。worktree 与主检出是不同的工作区。 */
  workspace: string;
  /** 白名单里的命令词，以单个空格连接（如 `pnpm test`、`pnpm run build`、`pytest`）。 */
  pattern: string;
  /** 建规则的人（飞书 open_id）。 */
  createdBy: string;
  createdAt: string;
}

export interface WorkspaceApprovalRuleRepository {
  /** 不传条件时列出全部；传 appId / workspace 时按它们精确过滤。 */
  list(filter?: { appId?: string; workspace?: string }): WorkspaceApprovalRule[];
  /** 同一机器人、同一工作区、同一规则重复添加时返回已有那条。 */
  add(input: Omit<WorkspaceApprovalRule, 'id' | 'createdAt'>): WorkspaceApprovalRule;
  remove(id: string): boolean;
}

const plainCommand = /^[A-Za-z0-9._/@:+=,%^\- \t;&]*$/;
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** 脚本名、make 目标：字母开头的普通单词。 */
const nameWord = /^[A-Za-z][A-Za-z0-9:_-]*$/;

/** 位置参数：不是选项、不带 `=`（npm 把 `--x=y` 当配置、make 把 `X=y` 当变量）、不跳出工作区。 */
const relativeArgument = (word: string) => !word.startsWith('-') && !word.includes('=') && !word.startsWith('/') && !word.split('/').includes('..');
/** go 的包参数只认工作区内的相对写法（`.`、`./...`、`./pkg`），不认远程模块路径。 */
const goPackage = (word: string) => relativeArgument(word) && (word === '.' || word.startsWith('./'));

interface SafeCommand {
  /** 规则的命令词；`<name>` 位置取命令里对应的那个词（脚本名或 make 目标）。 */
  words: readonly string[];
  /** 规则之后允许出现的选项，逐词整体匹配。 */
  options: readonly (string | RegExp)[];
  /** 规则之后允许出现的位置参数；不给表示不接受位置参数。 */
  argument?: (word: string) => boolean;
}

const gitStat = ['--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--no-color', '--no-ext-diff', '--no-textconv'];
const cargoOptions = ['--release', '--workspace', '--all-targets', '--all-features', '--no-default-features', '--lib', '--bins', '--tests',
  '--locked', '--offline', '--frozen', '-q', '--quiet', '-v', '--verbose', '-p', '--package', '--features'];
const goOptions = ['-v', '-race', '-short', '-cover', '-failfast', /^-count=\d+$/, /^-run=[A-Za-z0-9_./^-]+$/, /^-timeout=\d+[smh]$/];
const packageScript = { options: [], argument: relativeArgument } as const;

/**
 * 能建规则的命令。只收跑仓库自己的测试、构建脚本和只读 git 查询；能写任意文件、改配置、
 * 装包或转交执行任意程序的选项一律不收（如 git 的 `--output`/`--ext-diff`，go 的 `-exec`/`-o`/`-ldflags`，
 * cargo 的 `--config`/`--manifest-path`/`--target-dir`，pytest 的 `-p`/`-c`/`--basetemp`，npm 的 `--<配置>=`）。
 * `pnpm <脚本>` 简写不收：脚本不存在时 pnpm 会改为执行同名程序；`yarn run` 同理。
 */
const safeCommands: readonly SafeCommand[] = [
  { words: ['git', 'status'], options: ['-s', '--short', '-b', '--branch', '--porcelain', '--no-color'], argument: relativeArgument },
  { words: ['git', 'diff'], options: [...gitStat, '--cached', '--staged', '--check'], argument: relativeArgument },
  { words: ['git', 'log'], options: [...gitStat, '--oneline', '--graph', '--decorate', '--no-decorate', '--all', '--no-merges', '--merges', '--reverse', '-p', '--patch', '-n', /^-\d+$/, /^--max-count=\d+$/], argument: relativeArgument },
  { words: ['git', 'show'], options: [...gitStat, '--oneline', '-s', '--no-patch'], argument: relativeArgument },
  { words: ['pnpm', 'test'], ...packageScript },
  { words: ['pnpm', 'run', '<name>'], ...packageScript },
  { words: ['npm', 'test'], ...packageScript },
  { words: ['npm', 'run', '<name>'], ...packageScript },
  { words: ['yarn', 'test'], ...packageScript },
  { words: ['cargo', 'test'], options: cargoOptions, argument: relativeArgument },
  { words: ['cargo', 'build'], options: cargoOptions, argument: relativeArgument },
  { words: ['cargo', 'check'], options: cargoOptions, argument: relativeArgument },
  { words: ['go', 'test'], options: goOptions, argument: goPackage },
  { words: ['go', 'build'], options: ['-v', '-race'], argument: goPackage },
  { words: ['go', 'vet'], options: ['-v'], argument: goPackage },
  { words: ['make', '<name>'], options: [] },
  { words: ['pytest'], options: ['-q', '-v', '-vv', '-x', '-s', '--lf', '--ff', '-k'], argument: relativeArgument }
];

/**
 * 把命令按未加引号的 `&&` 与 `;` 拆成若干段，每段是空白分隔的词。
 * 含任何不在白名单里的字符、单个 `&`、空段，或某段以环境变量赋值开头，都返回 undefined。
 */
export function splitApprovalCommand(command: string): string[][] | undefined {
  if (!plainCommand.test(command)) return undefined;
  const segments: string[][] = [];
  const parts = command.split(/&&|;/);
  for (const [index, part] of parts.entries()) {
    if (part.includes('&')) return undefined;
    const words = part.split(/[ \t]+/).filter(Boolean);
    // 末尾的 `;` 可以没有后续命令；`&&` 后面必须还有。
    if (!words.length) {
      if (index === parts.length - 1 && index > 0 && /;[ \t]*$/.test(command)) continue;
      return undefined;
    }
    if (assignment.test(words[0]!)) return undefined;
    segments.push(words);
  }
  return segments.length ? segments : undefined;
}

/** 一段命令对应的规则：命令词命中白名单某项、其后每个参数都合那一项的要求时返回规则写法。 */
function segmentRule(words: readonly string[]): string | undefined {
  for (const safe of safeCommands) {
    if (words.length < safe.words.length) continue;
    const head = words.slice(0, safe.words.length);
    if (!safe.words.every((word, index) => word === '<name>' ? nameWord.test(head[index]!) : word === head[index])) continue;
    const allowed = words.slice(safe.words.length).every(word =>
      safe.options.some(option => typeof option === 'string' ? option === word : option.test(word)) || (safe.argument?.(word) ?? false));
    return allowed ? head.join(' ') : undefined;
  }
  return undefined;
}

/**
 * 从一条单段命令推导工作区规则，推导不出返回 undefined：
 * 命令词要在白名单里（`pnpm test --filter x` 不行：`--filter` 不是允许的选项），复合命令不生成。
 */
export function deriveWorkspaceApprovalRule(command: string): string | undefined {
  const segments = splitApprovalCommand(command);
  return segments?.length === 1 ? segmentRule(segments[0]!) : undefined;
}

/**
 * 命令的每一段按白名单推导出的规则都在 rules 里时，返回用到的规则（去重，按段的顺序）；
 * 任一段推导不出、或推导结果不在 rules 里，返回 undefined。库里不合白名单的规则因此永远不会被用到。
 */
export function matchWorkspaceApprovalRules<T extends Pick<WorkspaceApprovalRule, 'pattern'>>(command: string, rules: readonly T[]): T[] | undefined {
  if (!rules.length) return undefined;
  const segments = splitApprovalCommand(command);
  if (!segments) return undefined;
  const used: T[] = [];
  for (const words of segments) {
    const pattern = segmentRule(words);
    const rule = pattern === undefined ? undefined : rules.find(item => item.pattern === pattern);
    if (!rule) return undefined;
    if (!used.includes(rule)) used.push(rule);
  }
  return used;
}
