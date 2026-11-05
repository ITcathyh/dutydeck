/**
 * 按工作区记住的审批规则：飞书审批卡上点「本工作区允许此类命令」时，从这条命令推导出一条命令前缀规则，
 * 之后同一工作区里被规则覆盖的命令不再弹卡。
 *
 * 推导和匹配只做保守的词法判断，不执行、不展开任何东西，看不懂就弹卡：
 * - 命令只能由普通单词组成（字母、数字和 `._/@:+=,%^-`），词之间用空格或制表符分隔；
 * - 只认未加引号的 `&&` 与 `;` 两种分段，每段都必须被规则覆盖；
 * - 引号、反斜杠、`$`（含 `$(`）、反引号、`<(`、任何重定向、管道、`&`、换行、heredoc、括号、花括号、
 *   通配符、`~`、`#`、`!` 任一出现，或某段以 `NAME=value` 环境变量赋值开头，都不生成规则、也不算覆盖。
 * - 规则至少两个词，按词比较前缀：`pnpm test` 覆盖 `pnpm test --filter x`，不覆盖 `pnpm testx`。
 * - 首词是 shell、解释器或包装器（sh、bash、env、sudo、xargs、node、python、npx……），或是 `pnpm exec`、
 *   `pnpm dlx` 这类转交执行的子命令，不生成规则；匹配时同样不算覆盖，即使库里已有旧规则。
 * 高危正则不在这里判断：调用方在推导和每次匹配前都先跑一遍部署配置的高危正则，命中就照常弹卡。
 */

export interface WorkspaceApprovalRule {
  id: string;
  /** 建规则的飞书机器人；规则只对同一机器人的会话生效，不跨机器人共享。 */
  appId: string;
  /** 工作区：建规则时会话执行目录的真实路径（realpath）。worktree 与主检出是不同的工作区。 */
  workspace: string;
  /** 以单个空格连接的命令词，至少两个。 */
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
/** 像子命令的词（`test`、`run`、`build:web`）；路径、文件名和选项都不算。 */
const subcommandWord = /^[A-Za-z][A-Za-z0-9:_-]*$/;
/**
 * 不生成规则、也不按规则放行的首词：shell 与各类解释器、命令包装器、提权、远程执行、
 * 能执行任意命令的工具，以及删除、改权限、杀进程、联网下载这类破坏性或外发操作。
 */
const deniedProgram = new RegExp('^(?:' + [
  '(?:ba|da|z|k|c|tc|a|mk|r|yash)?sh', 'fish', 'nu', 'xonsh', 'elvish', 'pwsh', 'powershell', 'cmd(?:\\.exe)?',
  'eval', 'exec', 'source', 'xargs', 'env', 'command', 'builtin', 'nohup', 'time', 'timeout', 'nice', 'ionice', 'stdbuf', 'unbuffer',
  'setsid', 'chroot', 'nsenter', 'unshare', 'watch', 'parallel', 'flock', 'script', 'expect', 'strace', 'ltrace', 'gdb', 'lldb',
  'sudo', 'su', 'doas', 'pkexec', 'runuser',
  'node(?:js)?', 'deno', 'bun', 'bunx', 'npx', 'pnpx', 'tsx', 'ts-node', 'esno', 'vite-node',
  'python[0-9.]*', 'pypy[0-9.]*', 'ipython[0-9.]*', 'perl[0-9.]*', 'ruby', 'irb', 'php', 'lua(?:jit)?[0-9.]*', 'tclsh', 'wish', 'r', 'rscript', 'julia', 'groovy', 'jshell', 'osascript',
  'awk', 'gawk', 'mawk', 'nawk', 'sed', 'gsed', 'find', 'vim?', 'nvim', 'emacs', 'ed',
  'uv', 'uvx', 'pipx', 'poetry', 'pipenv', 'pdm', 'hatch', 'conda', 'mamba', 'pixi', 'nix', 'nix-shell',
  'ssh', 'scp', 'sftp', 'rsync', 'socat', 'nc', 'ncat', 'netcat', 'telnet', 'curl', 'wget',
  'docker', 'podman', 'kubectl', 'helm',
  'rm', 'rmdir', 'shred', 'dd', 'mkfs(?:\\..*)?', 'truncate', 'chmod', 'chown', 'chgrp', 'chattr',
  'kill', 'pkill', 'killall', 'reboot', 'shutdown', 'halt', 'poweroff', 'systemctl', 'launchctl', 'crontab', 'at', 'batch'
].join('|') + ')$', 'i');
/** 不生成规则的子命令：转交执行任意程序的，以及发布、改写远端或工作树、改执行行为的（与默认高危正则同一口径再收紧）。 */
const deniedSubcommand = /^(?:exec|dlx|x|create|publish|unpublish)$/i;
const deniedGitSubcommand = /^(?:push|reset|clean|checkout|restore|switch|config|submodule|bisect|rebase|filter-branch|filter-repo|daemon|credential|remote)$/i;
/** `<包管理器> run <脚本>`：规则连同脚本名一起记。 */
const scriptRunners = new Set(['npm', 'pnpm', 'yarn']);

const basename = (word: string) => word.slice(word.lastIndexOf('/') + 1);
const denied = (program: string) => deniedProgram.test(basename(program));

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

/**
 * 从一条单段命令推导工作区规则，推导不出返回 undefined：
 * - 第二个词像子命令：记前两个词（`pnpm test --filter x` → `pnpm test`）；
 * - `npm|pnpm|yarn run <脚本>`：连同脚本名记三个词（`pnpm run build` → `pnpm run build`）；
 * - 只有一个词、第二个词是选项或路径、复合命令、首词或子命令被禁止：不生成。
 */
export function deriveWorkspaceApprovalRule(command: string): string | undefined {
  const segments = splitApprovalCommand(command);
  if (segments?.length !== 1) return undefined;
  const [program, sub, script] = segments[0]!;
  if (!program || !sub || denied(program) || !subcommandWord.test(sub) || deniedSubcommand.test(sub)) return undefined;
  const name = basename(program).toLowerCase();
  if (name === 'git' && deniedGitSubcommand.test(sub)) return undefined;
  if (/^run(?:-script)?$/i.test(sub)) {
    if (!scriptRunners.has(name) || !script || !subcommandWord.test(script)) return undefined;
    return [program, sub, script].join(' ');
  }
  return [program, sub].join(' ');
}

/**
 * 命令的每一段都被某条规则按词前缀覆盖时，返回用到的规则（去重，按段的顺序）；
 * 任一段没覆盖、看不懂，或首词被禁止，返回 undefined。
 */
export function matchWorkspaceApprovalRules<T extends Pick<WorkspaceApprovalRule, 'pattern'>>(command: string, rules: readonly T[]): T[] | undefined {
  if (!rules.length) return undefined;
  const segments = splitApprovalCommand(command);
  if (!segments) return undefined;
  const used: T[] = [];
  for (const words of segments) {
    if (denied(words[0]!)) return undefined;
    const rule = rules.find(item => {
      const tokens = item.pattern.split(' ');
      return tokens.length >= 2 && tokens.length <= words.length && tokens.every((token, index) => token === words[index]);
    });
    if (!rule) return undefined;
    if (!used.includes(rule)) used.push(rule);
  }
  return used;
}
