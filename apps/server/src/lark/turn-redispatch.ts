import { AGENT_IDLE_TIMEOUT, AGENT_LOGIN_REQUIRED, type AgentEvent } from '@dutydeck/shared';

// 服务重启切断的一轮怎么处理：认不认得出、能不能安全重投、给 Agent / 卡片 / Web 的说明文字。
// 本文件只放纯函数；认领、落库与派发在 coordinator（redispatchInterruptedTurn）。
//
// 判定原则：只认得出「只读」，其余一律按可能已产生外部副作用处理。工具名、命令名只取
// 白名单字符写进说明，参数与输出绝不进卡片或 Web：命令行里常带 token。

/**
 * 每个轮次最多自动重投的次数；超过后停在需要人确认的状态。保持 2 次：只读的一轮重投本身无害，
 * 但连续被重启切断说明服务在反复重启，再投只会让同一请求在群里刷屏。
 */
export const larkRedispatchLimit = 2;
/**
 * 被切断那一轮最后一次活动距今超过这个时长就不自动重投：几天前的任务突然在群里重新执行会让人意外。
 * 保持 1 小时：升级重启通常几分钟内完成，单人使用时 1 小时内的中断仍在用户的注意范围里。
 */
export const larkRedispatchMaxAgeMs = 60 * 60_000;

/** 重启切断的一轮。运行时（markOrphanedAttempt / recoverPersistentTurn）对这两个原因码一视同仁。 */
export const isRestartInterruption = (code?: string) => code === 'PREVIOUS_RUNTIME_RESULT_UNKNOWN' || code === 'DAEMON_SHUTDOWN';

/** code：这一轮停下的原因码，Agent 说明据此区分「服务刚才重启」与其他中断；旧记录没有，按重启处理。 */
export type LarkRedispatchInfo = { count: number; resumed: boolean; auto: boolean; code?: string };
/**
 * 停下等人选的原因：可能有外部副作用、中断时间较早（old）或取不到（unknown）、已重投满。count 是此前已重投的次数。
 * code 是这一轮的原因码（没有的旧记录都是重启切断的），agent 是卡上写的 Agent 名，running 表示 Agent 还没确认停下。
 */
export type LarkHeldCause = { count: number; unsafeReason?: string; stale?: 'old' | 'unknown'; code?: string; agent?: string; running?: boolean };

/** 停下的那一轮发生了什么，按原因码说一句人话。 */
export const larkInterruptionSummary = (code?: string, agent = 'Agent') =>
  code === undefined || isRestartInterruption(code) ? '上一轮因服务重启中断，不确定是否做完。'
  : code === 'DRIVER_INPUT_UNCONFIRMED' ? `上一轮 ${agent} 没确认收到消息，可能没开始执行。`
  : code === AGENT_IDLE_TIMEOUT ? `上一轮 ${agent} 长时间没有任何输出，已停止等待，不确定是否做完。`
  : code === AGENT_LOGIN_REQUIRED ? `上一轮 ${agent} 没登录，没有处理这条消息。`
  : '上一轮执行中断，不确定是否做完。';

/**
 * 这一轮最后一次活动的时间（毫秒）：取这一轮最后一个事件，没有就用开始时间，都取不到返回 undefined。
 * 账本在关停、启动时给这一轮补记的 task / status 事件不算活动，否则刚启动时每一轮看起来都是刚活动过。
 */
export function larkLastActivityAt(events: AgentEvent[], startedAt?: string): number | undefined {
  let last: number | undefined;
  for (const event of events) {
    if (event.type === 'task' || event.type === 'status') continue;
    const at = Date.parse(event.timestamp);
    if (Number.isFinite(at) && (last === undefined || at > last)) last = at;
  }
  if (last !== undefined) return last;
  const started = startedAt ? Date.parse(startedAt) : NaN;
  return Number.isFinite(started) ? started : undefined;
}

/** 只读的工具（Claude Code 的工具名，小写比较）。子 Agent、发消息、改文件、MCP 都不在内。 */
const readOnlyTools = new Set(['read', 'grep', 'glob', 'ls', 'notebookread', 'todowrite', 'todoread', 'taskcreate', 'taskupdate', 'tasklist', 'taskget',
  'webfetch', 'websearch', 'skill', 'listagents', 'bashoutput', 'toolsearch', 'exitplanmode']);
/** Codex 等 ACP Agent 把动作写成标题。 */
const readOnlyTitle = /^(?:read file|search for|list files in|view image)\b/i;
/**
 * 内置 Claude ACP 适配器（claude-agent-acp）也把工具写成标题：Read 是「Read <路径>」，Glob 是「Find …」，Grep 是「grep …」，
 * WebFetch 是「Fetch <网址>」，WebSearch 是带引号的查询。子 Agent 的标题是它的描述、提问的标题是问题原文，可能碰巧以这些词开头，
 * 所以参数名也要都属于对应的只读工具。
 */
const claudeAcpReadTools: Array<[RegExp, string[]]> = [
  [/^Read\b/, ['file_path', 'offset', 'limit', 'pages']],
  [/^Find\b/, ['pattern', 'path']],
  [/^grep\b/, ['pattern', 'path', 'glob', 'type', 'output_mode', '-i', '-n', '-o', '-A', '-B', '-C', 'context', 'head_limit', 'offset', 'multiline']],
  [/^Fetch\b/, ['url', 'prompt']],
  [/^(?:"|Web search\b)/, ['query', 'allowed_domains', 'blocked_domains']]
];
const claudeAcpReadOnly = (title: string, input?: Record<string, unknown>) =>
  Boolean(input) && claudeAcpReadTools.some(([pattern, keys]) => pattern.test(title) && Object.keys(input!).every(key => keys.includes(key)));
/** ACP 的更新、结果事件常不带标题，acpx 与 normalizeAcpxEvent 补的缺省名。 */
const genericToolName = (name: string) => !name || /^(?:tool|tool call)$/i.test(name);

const shells = new Set(['sh', 'bash', 'zsh', 'dash']);

/**
 * 按 shell 语法切成命令段（管道、&&、||、;、&、换行都分段），每段是去掉引号后的词。
 * 命令替换、进程替换、heredoc、写文件的重定向都看不透，返回 undefined。
 * 只放过丢弃输出与合并流（>/dev/null、2>&1）和读文件的 <。
 */
function shellSegments(command: string): string[][] | undefined {
  const segments: string[][] = [[]];
  let word = '', quoted = false;
  const push = () => { if (word || quoted) segments.at(-1)!.push(word); word = ''; quoted = false; };
  for (let i = 0; i < command.length;) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return;
      word += command.slice(i + 1, end); quoted = true; i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '`' || command[j] === '$' && command[j + 1] === '(') return;
        if (command[j] === '\\' && j + 1 < command.length) j++;
        word += command[j];
      }
      if (j >= command.length) return;
      quoted = true; i = j + 1;
    } else if (c === '\\') {
      word += command[i + 1] ?? ''; i += 2;
    } else if (c === '`' || c === '$' && command[i + 1] === '(') {
      return;
    } else if (c === '<') {
      if (command[i + 1] === '<' || command[i + 1] === '(') return;
      push(); i++;
    } else if (c === '>') {
      const discard = /^>\s*\/dev\/null(?=$|[\s;&|])|^>&\d/.exec(command.slice(i));
      if (!discard) return;
      if (/^\d+$/.test(word)) word = '';
      push(); i += discard[0].length;
    } else if (c === '|' || c === '&' || c === ';' || c === '\n') {
      push(); if (segments.at(-1)!.length) segments.push([]);
      i += (c === '|' || c === '&') && command[i + 1] === c ? 2 : 1;
    } else if (/\s/.test(c)) {
      push(); i++;
    } else {
      word += c; i++;
    }
  }
  push();
  return segments.filter(segment => segment.length);
}

const displayName = (value: string) => /^[A-Za-z0-9._+-]{1,32}$/.test(value) ? value : '';

/** curl 认得的只读选项：前一组不带值，后一组带一个值。 */
const curlFlags = new Set(['-s', '-S', '-L', '-i', '-I', '-v', '-f', '-k', '-g', '-#', '--silent', '--show-error', '--location', '--include',
  '--head', '--verbose', '--fail', '--fail-with-body', '--insecure', '--globoff', '--progress-bar', '--compressed', '--no-progress-meter']);
const curlValueOptions = new Set(['-H', '-X', '-m', '-A', '-e', '-u', '-r', '-b', '-x', '--header', '--request', '--max-time', '--user-agent',
  '--referer', '--user', '--range', '--cookie', '--proxy', '--connect-timeout', '--retry', '--url', '--resolve', '--noproxy', '--cacert']);

/**
 * curl 只放过表里的选项、且方法是 GET / HEAD。短选项可以连写，值可以贴在后面（-sSL、-XGET、-H'Accept: x'）。
 * 表外的写法一律算写：-d / -F / -T / -o 这类带请求体或写文件的，以及 --request=POST 这种 curl 自己都不认的写法。
 */
function curlReadOnly(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) continue;
    let option = arg, value: string | undefined;
    if (!arg.startsWith('--')) {
      let j = 1;
      while (j < arg.length && curlFlags.has(`-${arg[j]}`)) j++;
      if (j === arg.length) continue;
      option = `-${arg[j]}`;
      value = arg.slice(j + 1) || undefined;
    } else if (curlFlags.has(arg)) {
      continue;
    }
    if (!curlValueOptions.has(option)) return false;
    value ??= args[++i];
    if ((option === '-X' || option === '--request') && !/^(?:GET|HEAD)$/i.test(value ?? '')) return false;
  }
  return true;
}

/**
 * 只读程序的参数核对（OCR-02）：只放行核对过的参数组合，写文件、执行别的程序的参数和表外参数都按可能有副作用处理。
 * 例如 rg --pre 会执行预处理程序，sort -o、xxd -r、git diff --output 会写文件。
 */
type OptionSpec = {
  /** 不带值的参数；短参数可以连写（-inw）。 */
  flags: readonly string[];
  /** 带一个值的参数：-k2、-k 2、--key=2、--key 2 都认。 */
  values?: readonly string[];
  /** 认 -20 这种数字简写（git log -3）。 */
  numeric?: boolean;
  /** 位置参数个数上限：uniq 的第二个位置参数是输出文件。 */
  maxPositional?: number;
};

/**
 * 以 - 开头的词都要在表里：单独成词的值只在不以 - 开头时才当值跳过，
 * 这样表把某个参数错记成带值时，后面的 --output=… 也不会被当成值放过。
 */
function optionsAllowed(args: string[], spec: OptionSpec): boolean {
  const flags = new Set(spec.flags), values = new Set(spec.values ?? []);
  const skipValue = (at: number) => at + 1 < args.length && !args[at + 1]!.startsWith('-') ? at + 1 : at;
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { positional += args.length - i - 1; break; }
    if (arg === '-' || !arg.startsWith('-')) { positional++; continue; }
    if (spec.numeric && /^-\d+$/.test(arg)) continue;
    if (arg.startsWith('--')) {
      const name = arg.split('=', 1)[0]!;
      if (flags.has(arg)) continue;
      if (!values.has(name)) return false;
      if (!arg.includes('=')) i = skipValue(i);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const option = `-${arg[j]}`;
      if (flags.has(option)) continue;
      if (!values.has(option)) return false;
      if (j === arg.length - 1) i = skipValue(i);
      break;
    }
  }
  return spec.maxPositional === undefined || positional <= spec.maxPositional;
}

/** 没有写文件、执行程序类参数的程序，参数不用核对。less / more / ag 会按环境变量执行预处理程序，不在内。 */
const anyArgsPrograms = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'zgrep', 'zcat', 'ls', 'pwd', 'echo', 'printf', 'which',
  'whereis', 'type', 'stat', 'du', 'df', 'cut', 'tr', 'nl', 'column', 'diff', 'cmp', 'comm', 'jq', 'whoami', 'id', 'uname', 'printenv', 'ps', 'free',
  'uptime', 'realpath', 'dirname', 'basename', 'readlink', 'test', '[', 'true', 'false', 'cd', 'sleep', 'md5sum', 'sha1sum', 'sha256sum', 'seq', 'od',
  'strings']);

/** git diff / log / show 和同样认 --output 的 blame / rev-list / shortlog。--output 写文件、--ext-diff 执行外部比较程序、--show-signature 执行 gpg，都不在表里。 */
const gitHistoryOptions: OptionSpec = {
  flags: ['-p', '-u', '--patch', '-s', '--no-patch', '--raw', '--stat', '--numstat', '--shortstat', '--summary', '--name-only', '--name-status',
    '--check', '-M', '-C', '-R', '-w', '-b', '--ignore-all-space', '--ignore-space-change', '-W', '--function-context', '--word-diff', '--color',
    '--no-color', '--exit-code', '--quiet', '--no-ext-diff', '--no-textconv', '--no-prefix', '-z', '--cached', '--staged', '--merge-base', '--no-index',
    '--first-parent', '--oneline', '--graph', '--decorate', '--no-decorate', '--all', '--merges', '--no-merges', '--reverse', '--topo-order',
    '--abbrev-commit', '--follow', '--left-right', '--parents', '--relative-date', '--pretty', '-n', '-e', '-c', '--count', '--summary'],
  values: ['-U', '-L', '-S', '-G', '--stat', '--format', '--pretty', '--date', '--max-count', '--skip', '--since', '--after', '--until', '--before',
    '--author', '--committer', '--grep', '--diff-filter', '--unified', '--color', '--word-diff', '--decorate', '--abbrev'],
  numeric: true
};

const programOptions: Record<string, OptionSpec> = {
  // 不认 --pre / --pre-glob（执行预处理程序）、--hostname-bin（执行程序）、-z / --search-zip（执行解压程序）。
  rg: {
    flags: ['-i', '-s', '-S', '-n', '-N', '-l', '-c', '-w', '-x', '-v', '-F', '-o', '-u', '-L', '-H', '-I', '-a', '-U', '-P', '-q', '-0', '--hidden',
      '--no-ignore', '--no-ignore-vcs', '--files', '--files-with-matches', '--files-without-match', '--count', '--count-matches', '--fixed-strings',
      '--ignore-case', '--smart-case', '--case-sensitive', '--word-regexp', '--line-regexp', '--invert-match', '--only-matching', '--line-number',
      '--no-line-number', '--column', '--heading', '--no-heading', '--with-filename', '--no-filename', '--json', '--vimgrep', '--stats', '--trim',
      '--follow', '--multiline', '--multiline-dotall', '--pcre2', '--null', '--text', '--quiet', '--no-messages', '--no-config', '--type-list', '--sort-files'],
    values: ['-e', '-f', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '-d', '-M', '-r', '-j', '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not',
      '--after-context', '--before-context', '--context', '--max-count', '--max-depth', '--max-columns', '--max-filesize', '--replace', '--sort', '--sortr',
      '--color', '--threads']
  },
  // 不认 -o / --output（写文件）、--compress-program（执行程序）。
  sort: {
    flags: ['-b', '-d', '-f', '-g', '-h', '-i', '-M', '-n', '-R', '-r', '-V', '-c', '-C', '-m', '-s', '-u', '-z', '--ignore-case', '--human-numeric-sort',
      '--numeric-sort', '--general-numeric-sort', '--version-sort', '--reverse', '--unique', '--stable', '--check', '--merge', '--zero-terminated'],
    values: ['-k', '-t', '-S', '--key', '--field-separator', '--buffer-size', '--parallel']
  },
  uniq: {
    flags: ['-c', '-d', '-D', '-i', '-u', '-z', '--count', '--repeated', '--all-repeated', '--ignore-case', '--unique', '--zero-terminated'],
    values: ['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'],
    maxPositional: 1
  },
  // 不认 -o（写文件）。
  tree: {
    flags: ['-a', '-d', '-f', '-i', '-l', '-x', '-p', '-u', '-g', '-s', '-h', '-D', '-F', '-v', '-t', '-r', '-C', '-n', '--noreport', '--dirsfirst',
      '--gitignore', '--du', '--prune'],
    values: ['-L', '-P', '-I']
  },
  // 脚本另在 segmentRisk 里核对。不认 -i（改文件）、-f / -e（脚本可能带 w / e）。
  sed: { flags: ['-n', '-E', '-r', '-s', '-u', '-z', '--quiet', '--silent'] }
};

/** xxd 的参数是整词：-r / -revert 把十六进制写回文件，第二个位置参数也是输出文件。 */
const xxdFlags = new Set(['-a', '-b', '-C', '-e', '-E', '-i', '-p', '-ps', '-plain', '-u', '-d']);
const xxdValues = new Set(['-c', '-cols', '-g', '-groupsize', '-l', '-len', '-o', '-offset', '-s', '-seek']);
function xxdReadOnly(args: string[]): boolean {
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (xxdValues.has(arg)) i++;
    else if (arg.startsWith('-') && arg !== '-') { if (!xxdFlags.has(arg)) return false; }
    else positional++;
  }
  return positional <= 1;
}

/** find 认得的条件；-delete、-exec、-ok、-fprint 一类删文件、执行程序、写文件的不在内。-7、+30 这种比较值另认。 */
const findPredicates = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-regextype', '-type', '-xtype',
  '-maxdepth', '-mindepth', '-size', '-empty', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-newer', '-perm', '-user', '-group', '-links',
  '-readable', '-writable', '-executable', '-print', '-print0', '-printf', '-ls', '-prune', '-quit', '-not', '-a', '-and', '-o', '-or', '-true', '-false',
  '-depth', '-xdev', '-mount', '-follow', '-L', '-H', '-P', '-lname', '-ilname', '-samefile', '-inum', '-nouser', '-nogroup']);

/** git 的全局参数只认这几个；-c、--config-env、--exec-path 能让后面的子命令执行别的程序。 */
const gitGlobalFlags = new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs']);
const gitGlobalValues = new Set(['-C', '--git-dir', '--work-tree']);
/** 这些子命令没有写文件、执行程序类的参数（在临时仓库里核对过它们都不认 --output）。 */
const readOnlyGit = new Set(['status', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'cat-file', 'merge-base', 'show-ref', 'name-rev',
  'count-objects', 'version']);

/** 命令前的变量赋值只认不改变行为的这几个：RIPGREP_CONFIG_PATH、GIT_EXTERNAL_DIFF、LESSOPEN、PATH 一类能让只读命令执行别的程序。 */
const harmlessAssignment = /^(?:(?:LC_[A-Z]+|LANG|LANGUAGE|TZ|NO_COLOR|TERM|COLUMNS)=|(?:GIT_PAGER|PAGER)=(?:cat)?$)/;

/** 一段命令是否只读：只读返回 undefined，否则返回写进说明的命令名（名字不规整时是空串）。 */
function segmentRisk(words: string[]): string | undefined {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
  const args = words.slice(index + 1);
  const program = (words[index] ?? '').split('/').at(-1)!;
  const name = displayName(program);
  if (words.slice(0, index).some(assignment => !harmlessAssignment.test(assignment))) return name;
  if (!program) return undefined;
  if (shells.has(program)) {
    // bash -c '<脚本>' / zsh -lc '<脚本>'：Codex 的命令都包在这一层里。
    return /^-l?c$/.test(args[0] ?? '') && args[1] !== undefined && args.length === 2 ? shellRisk(args[1]) : name;
  }
  if (anyArgsPrograms.has(program)) return undefined;
  // 引号已经去掉，分不出 $X 是不是变量展开；展开的值看不见，可能是 --pre=…，按写处理。
  if (args.some(arg => arg.includes('$'))) return name;
  const spec = programOptions[program];
  if (spec && !optionsAllowed(args, spec)) return name;
  // 只认 sed -n '1,200p' 这种按行号打印；别的脚本可能带 w / e。
  if (program === 'sed') return args.includes('-n') && /^\d+(?:,\d+)?p$/.test(args.find(arg => !arg.startsWith('-')) ?? '') ? undefined : name;
  if (spec) return undefined;
  if (program === 'xxd') return xxdReadOnly(args) ? undefined : name;
  if (program === 'find') return args.every(arg => !arg.startsWith('-') || /^-\d/.test(arg) || findPredicates.has(arg)) ? undefined : name;
  // date -s / --set 和不以 + 开头的位置参数（MMDDhhmm）会改系统时间；-d 后面的值另认。
  if (program === 'date') return args.every((arg, at) => !/^(?:-s|--set)/.test(arg) && (/^[-+]/.test(arg) || /^(?:-d|--date)$/.test(args[at - 1] ?? ''))) ? undefined : name;
  // hostname 带位置参数会改主机名。
  if (program === 'hostname') return args.every(arg => /^-[fsiIdaA]$/.test(arg)) ? undefined : name;
  // file -C 会编译并写出 magic 文件。
  if (program === 'file') return args.some(arg => arg === '--compile' || /^-[^-]*C/.test(arg)) ? name : undefined;
  if (program === 'env') return args.length ? name : undefined;
  if (program === 'curl') return curlReadOnly(args) ? undefined : name;
  if (program === 'git') {
    let i = 0;
    for (; i < args.length && args[i]!.startsWith('-'); i++) {
      const option = args[i]!;
      if (gitGlobalFlags.has(option)) continue;
      if (!gitGlobalValues.has(option.split('=', 1)[0]!)) return 'git';
      if (!option.includes('=')) i++;
    }
    const sub = args[i] ?? '';
    const rest = args.slice(i + 1);
    const label = `git ${displayName(sub)}`.trim();
    if (['diff', 'log', 'show', 'blame', 'rev-list', 'shortlog'].includes(sub)) return optionsAllowed(rest, gitHistoryOptions) ? undefined : label;
    // git grep -O 会用分页程序打开匹配到的文件。
    if (sub === 'grep') return rest.some(arg => /^-[^-]*O|^--open-files-in-pager/.test(arg)) ? label : undefined;
    if (readOnlyGit.has(sub)) return undefined;
    if (sub === 'branch' || sub === 'tag') return rest.every(arg => ['-a', '-r', '-v', '-vv', '-l', '--list', '--all', '--remotes', '--verbose', '--show-current'].includes(arg)) ? undefined : label;
    if (sub === 'remote') return !rest.length || rest.length === 1 && rest[0] === '-v' || ['show', 'get-url'].includes(rest[0]!) ? undefined : label;
    if (sub === 'stash' || sub === 'worktree') return rest[0] === 'list' || sub === 'stash' && rest[0] === 'show' ? undefined : label;
    if (sub === 'config') return rest.some(arg => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(arg)) ? undefined : label;
    return label;
  }
  return name;
}

function shellRisk(command: string): string | undefined {
  const segments = shellSegments(command);
  if (!segments) return '';
  for (const segment of segments) {
    const risk = segmentRisk(segment);
    if (risk !== undefined) return risk;
  }
  return undefined;
}

const commandText = (input: unknown): string | undefined => {
  const command = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).command ?? (input as Record<string, unknown>).cmd : undefined;
  if (typeof command === 'string') return command;
  if (!Array.isArray(command) || !command.every(part => typeof part === 'string')) return undefined;
  // ['bash', '-lc', '<脚本>'] 这种直接取脚本；其余按空格拼回去，引号丢了只会更保守。
  const parts = command as string[];
  return parts.length === 3 && shells.has(parts[0]!.split('/').at(-1)!) && /^-l?c$/.test(parts[1]!) ? parts[2] : parts.join(' ');
};

/**
 * 这一轮已记录的工具调用里有没有可能已经对外生效的：返回写进说明的原因（「执行过 git push」「调用过 SendMessage」），
 * 全是只读时返回 undefined。
 * 同一次调用的开始、更新、结果按 id 合起来看：ACP 的开始事件参数常是空的，更新与结果常只有缺省名，单看哪一条都认不出。
 */
export function larkReplayUnsafeReason(events: AgentEvent[]): string | undefined {
  const calls = new Map<string, { names: Set<string>; commands: Set<string>; input?: Record<string, unknown> }>();
  events.forEach((event, index) => {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') return;
    const data = (event.data ?? {}) as { id?: unknown; name?: unknown; input?: unknown };
    const key = data.id === undefined || data.id === null ? `#${index}` : String(data.id);
    const call = calls.get(key) ?? { names: new Set<string>(), commands: new Set<string>() };
    calls.set(key, call);
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!genericToolName(name)) call.names.add(name);
    const command = commandText(data.input);
    if (command !== undefined) call.commands.add(command);
    if (data.input && typeof data.input === 'object' && !Array.isArray(data.input)) call.input = { ...call.input, ...data.input };
  });
  for (const call of calls.values()) {
    if (call.commands.size) {
      for (const command of call.commands) {
        const risk = shellRisk(command);
        if (risk !== undefined) return risk ? `执行过 ${risk}` : '执行过无法判断是否只读的命令';
      }
      continue;
    }
    const name = call.names.size ? [...call.names].find(name => !readOnlyTools.has(name.toLowerCase()) && !readOnlyTitle.test(name) && !claudeAcpReadOnly(name, call.input)) : '';
    if (name === undefined) continue;
    return /^[A-Za-z0-9_.:-]{1,48}$/.test(name) ? `调用过 ${name}` : '调用过无法判断是否只读的工具';
  }
  return undefined;
}

const redone = (info: LarkRedispatchInfo) => info.auto ? `服务更新中断，已自动继续（第 ${info.count}/${larkRedispatchLimit} 次）` : '已按「重新执行」重新执行';

/** 注入 Agent prompt 的说明，排在用户请求之前。在原会话续做时就是那句「请从中断处继续」。 */
export const larkRedispatchAgentNote = (info: LarkRedispatchInfo) => {
  const what = info.code === undefined || isRestartInterruption(info.code) ? '服务刚才重启' : '上一轮被中断了，用户选择重新执行';
  return `[Dutydeck 重启恢复 · 系统说明]\n${info.resumed
    ? `${what}，请从中断处继续，不要重复已经完成的操作。推送代码、发消息、调用写接口之前，先检查上一轮是不是已经做过。`
    : `${what}，原会话无法恢复，这是在新会话里重新执行，之前的对话不在上下文里。之前的动作可能已经生效，推送代码、发消息、调用写接口之前先检查。`}`;
};

/** 重投这一轮的进度卡注记。 */
export const larkRedispatchCardNote = (info: LarkRedispatchInfo) =>
  `${redone(info)}${info.resumed ? '，在原对话里接着做' : '，原对话无法恢复，在新会话里重新执行'}。`;

/** 被切断那一轮的旧卡收尾。 */
export const larkRedispatchedCardMarkdown = (info: LarkRedispatchInfo, retainedNote: string) =>
  `**${redone(info)}**\n\n${info.code === undefined || isRestartInterruption(info.code) ? '上一轮因服务重启中断，' : ''}${info.resumed
    ? '已在原对话里接着做，进度见新的任务卡。'
    : `原对话无法恢复，已在本话题的新会话中重新执行，进度见新的任务卡；之后本话题的消息也进入新会话。\n\n${retainedNote}`}`;

/** 写进原会话时间线的说明（Web 上能看到）。 */
export const larkRedispatchWebNote = (info: LarkRedispatchInfo) =>
  `**Dutydeck 重启恢复**：${redone(info)}。`;

export const larkHeldWebNote = (cause: LarkHeldCause) =>
  `**Dutydeck 恢复**：${larkInterruptionSummary(cause.code, cause.agent)}${larkHeldReason(cause)}需要在飞书任务卡上选择「在原对话继续」「重新执行」或「放弃」。`;

/** 为什么没有自动处理。 */
export const larkHeldReason = ({ count, unsafeReason, stale, running }: LarkHeldCause) => {
  const earlier = count ? `此前已自动继续 ${count} 次。` : '';
  if (unsafeReason) return `这一轮${unsafeReason}，可能已经对外生效，所以没有自动继续。${earlier}`;
  if (running) return `Agent 还没确认停下，所以没有自动结束这一轮。${earlier}`;
  if (stale) return `${stale === 'old' ? '中断已经超过 1 小时' : '不知道是什么时候中断的'}，所以没有自动继续。${earlier}`;
  return count ? `已经自动继续 ${count} 次仍被重启打断，不再自动继续。` : '';
};
