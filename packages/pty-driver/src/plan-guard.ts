/**
 * 计划阶段守卫：任务以 deny-all 运行（先出计划的第一阶段）时，Claude 家族终端的 PreToolUse hook 跑这份脚本。
 *
 * 新版 Claude Code 没有 Grep / Glob，调研要靠 Bash，所以 Bash 不能一刀切：只放行保守白名单里的只读命令，
 * 拿不准的一律按写处理。其它过守卫的工具（Edit、Write、MCP 等，只读工具在 hook 的 matcher 里已排除）一律拒绝。
 * hook 用退出码 2 拒绝，用户 allow 规则和 bypass 模式都绕不过去。
 */

/**
 * Bash 命令是否只读。自包含（不引用模块里的其它东西），守卫脚本直接内联它的源码。
 * 不认：命令替换、进程替换、写文件的重定向、heredoc、后台执行、环境变量前缀、带路径的命令名，
 * 以及白名单外的命令和白名单命令里能写文件或执行程序的参数。
 */
export function planGuardAllowsBash(command: string): boolean {
  const text = String(command ?? '');
  if (!text.trim() || text.length > 4000 || /`|\$\(|<\(|>\(/.test(text)) return false;
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  const endWord = () => { if (started) words.push(word); word = ''; started = false; };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  // 只认指向 /dev/null 的输出重定向和描述符复制；返回目标结束的位置，不合规返回 -1。
  const redirectTarget = (from: number) => {
    let index = from;
    if (text[index] === '&') return /[0-9-]/.test(text[index + 1] ?? '') ? index + 2 : -1;
    while (text[index] === ' ' || text[index] === '\t') index++;
    const start = index;
    while (index < text.length && !/[\s;|&<>]/.test(text[index]!)) index++;
    return text.slice(start, index) === '/dev/null' ? index : -1;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && index + 1 < text.length) word += text[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === '\\') { if (index + 1 < text.length) { word += text[++index]; started = true; } continue; }
    if (char === ' ' || char === '\t') { endWord(); continue; }
    if (char === '\n' || char === ';') { endSegment(); continue; }
    if (char === '|') { if (text[index + 1] === '|') index++; endSegment(); continue; }
    if (char === '&') {
      if (text[index + 1] === '&') { index++; endSegment(); continue; }
      // 单个 & 是后台执行；&> 与 > 同样处理。
      if (text[index + 1] !== '>') return false;
      index++;
    }
    if (text[index] === '>') {
      // 紧贴在前面的数字是文件描述符（2>/dev/null），不是参数。
      if (started && /^[0-9]$/.test(word)) { word = ''; started = false; }
      endWord();
      const next = redirectTarget(text[index + 1] === '>' ? index + 2 : index + 1);
      if (next < 0) return false;
      index = next - 1;
      continue;
    }
    if (char === '<') {
      if (text[index + 1] === '<' || text[index + 1] === '>' || text[index + 1] === '&') return false;
      endWord();
      // 输入重定向只读文件：跳过目标，不当参数。
      index++;
      while (text[index] === ' ' || text[index] === '\t') index++;
      while (index < text.length && !/[\s;|&<>]/.test(text[index]!)) index++;
      index--;
      continue;
    }
    word += char;
    started = true;
  }
  if (quote) return false;
  endSegment();
  if (!segments.length) return false;
  const simple = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'pwd', 'echo', 'printf', 'stat', 'du', 'df',
    'which', 'whereis', 'whoami', 'id', 'date', 'uname', 'basename', 'dirname', 'realpath', 'readlink', 'nl', 'cut', 'tr',
    'column', 'diff', 'cmp', 'comm', 'jq', 'true', 'false', 'test', '[', 'seq', 'md5sum', 'sha1sum', 'sha256sum', 'od', 'strings', 'cd',
    'ps', 'printenv', 'type']);
  const flagged = (args: string[], forbidden: RegExp) => args.some(arg => forbidden.test(arg));
  const gitReadOnly = new Set(['log', 'show', 'diff', 'status', 'blame', 'grep', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog',
    'cat-file', 'merge-base', 'rev-list', 'show-ref', 'whatchanged', 'diff-tree', 'diff-files', 'diff-index', 'for-each-ref', 'check-ignore', 'count-objects']);
  const git = (args: string[]) => {
    let rest = args;
    while (rest.length && rest[0]!.startsWith('-')) {
      if (rest[0] === '-C' && rest.length > 1) rest = rest.slice(2);
      else if (rest[0] === '--no-pager' || rest[0] === '-P') rest = rest.slice(1);
      else return false;
    }
    const [sub, ...params] = rest;
    if (!sub || flagged(params, /^--output|^-O|^--open-files-in-pager|^--ext-diff/)) return false;
    if (gitReadOnly.has(sub)) return true;
    const options = params.every(param => param.startsWith('-'));
    if (sub === 'branch') return (options || params.some(param => param === '--list' || param === '-l'))
      && !flagged(params, /^(-[a-zA-Z]*[dDmMcCfu]|--delete|--move|--copy|--force|--set-upstream|--unset-upstream|--track|--no-track|--edit-description|--create-reflog)/);
    if (sub === 'tag') return !params.length || params.some(param => param === '--list' || param === '-l') && !flagged(params, /^(-[a-zA-Z]*[dasfmFue]|--delete|--annotate|--sign|--force|--message|--file|--edit)/);
    if (sub === 'remote') return !params.length || params.length === 1 && params[0] === '-v' || params.length === 2 && ['show', 'get-url'].includes(params[0]!);
    if (sub === 'config') return params.some(param => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(param)) && !flagged(params, /^(--unset|--add|--replace-all|--rename-section|--remove-section|-e|--edit)/);
    if (sub === 'stash') return ['list', 'show'].includes(params[0] ?? '');
    if (sub === 'worktree') return params[0] === 'list';
    if (sub === 'reflog') return !params.length || params[0] === 'show';
    return false;
  };
  return segments.every(([name, ...args]) => {
    if (!name || name.includes('=') || name.includes('/')) return false;
    if (simple.has(name)) return true;
    if (name === 'rg') return !flagged(args, /^--pre/);
    if (name === 'find') return !flagged(args, /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/);
    // tree -o 写到文件，-R（配 -H）在每层目录写 00Tree.html。
    if (name === 'tree') return !flagged(args, /^-[a-zA-Z]*[oR]/);
    if (name === 'sort') return !flagged(args, /^(-[a-zA-Z]*o|--output|--compress-program)/);
    if (name === 'uniq') return args.filter(arg => !arg.startsWith('-')).length <= 1;
    if (name === 'env') return !args.length;
    if (name === 'sed') {
      // sed 只认按行号打印（sed -n '1,80p' file）：-i 原地改写，脚本里的 w / e 命令能写文件、执行程序。
      const options = args.filter(arg => arg.startsWith('-'));
      const scripts = args.filter(arg => !arg.startsWith('-'));
      return options.includes('-n') && options.every(option => ['-n', '-E', '-r', '-u', '-z', '--quiet', '--silent'].includes(option))
        && /^(\d+|\$)(,(\d+|\$))?p$/.test(scripts[0] ?? '');
    }
    if (name === 'git') return git(args);
    return false;
  });
}

export const planGuardBashReason = '先出计划阶段只能运行只读命令（如 ls、cat、rg、git log），这条命令可能修改文件或执行程序，已被 Dutydeck 拦截。请改用只读方式调研，把要执行的操作写进计划，等用户批准后再做。';
export const planGuardToolReason = '先出计划阶段不能修改文件或做有副作用的操作，已被 Dutydeck 拦截。请把这一步写进计划，等用户批准后再执行。';

/** 写进会话私有设置目录的守卫脚本：只读 Bash 放行，其余拒绝（退出码 2，原因写 stderr）。 */
export function planGuardScript(): string {
  return `// dutydeck-plan-guard-v1
${planGuardAllowsBash.toString()}
let input = '';
for await (const chunk of process.stdin) input += chunk;
let event = {};
try { event = JSON.parse(input); } catch {}
const tool = String(event?.tool_name ?? '');
if (tool === 'Bash' && planGuardAllowsBash(String(event?.tool_input?.command ?? ''))) process.exit(0);
process.stderr.write(tool === 'Bash' ? ${JSON.stringify(planGuardBashReason)} : ${JSON.stringify(planGuardToolReason)});
process.exit(2);
`;
}
