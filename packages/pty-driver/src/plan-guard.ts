/**
 * 计划阶段守卫：任务以 deny-all 运行（先出计划的第一阶段）时，Claude 家族终端的 PreToolUse hook 跑这份脚本。
 *
 * 新版 Claude Code 没有 Grep / Glob，调研要靠 Bash，所以 Bash 不能一刀切：只放行保守白名单里的只读命令，
 * 拿不准的一律按写处理。其它过守卫的工具（Edit、Write、MCP 等，只读工具在 hook 的 matcher 里已排除）一律拒绝。
 * hook 用退出码 2 拒绝，用户 allow 规则和 bypass 模式都绕不过去。
 */

/**
 * Bash 命令是否只读。自包含（不引用模块里的其它东西），守卫脚本直接内联它的源码。
 * 同一份判断要同时防 bash 和 zsh，拿不准就按写处理：
 * - 不认任何展开和子 shell：引号外的 $ ( ) { }、双引号里的 $、反引号、词首的 #（注释会让两边看到的命令不一样）；
 * - 不认写文件的重定向、heredoc、后台执行、只有重定向的命令（zsh 会交给 $NULLCMD 执行）、环境变量前缀、带路径的命令名；
 * - 只放行白名单命令；有写文件或执行程序参数的命令再逐个查参数，参数里带通配符（展开后可能变成选项）就不放行。
 */
export function planGuardAllowsBash(command: string): boolean {
  const text = String(command ?? '');
  // 反引号和 $( ${ $[ 在单引号里也不认：防白名单里哪个命令自己把参数当代码求值。
  if (!text.trim() || text.length > 4000 || /`|\$[({[]/.test(text)) return false;
  const segments: Array<{ words: string[]; globbed: boolean }> = [];
  let words: string[] = [];
  let globbed = false;
  let redirected = false;
  let valid = true;
  let word = '';
  let started = false;
  let quote = '';
  const endWord = () => { if (started) words.push(word); word = ''; started = false; };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push({ words, globbed });
    else if (redirected) valid = false;
    words = []; globbed = false; redirected = false;
  };
  // 输出重定向只认 /dev/null 和描述符复制（>&2、2>&1、>&-，后面紧跟分隔符）；返回目标结束的位置，不合规返回 -1。
  const redirectTarget = (from: number) => {
    let index = from;
    if (text[index] === '&') {
      const dup = /^&([0-9]+|-)(?=$|[\s;|&<>])/.exec(text.slice(index));
      return dup ? index + dup[0].length : -1;
    }
    while (text[index] === ' ' || text[index] === '\t') index++;
    const start = index;
    while (index < text.length && !/[\s;|&<>]/.test(text[index]!)) index++;
    return text.slice(start, index) === '/dev/null' ? index : -1;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = '';
      else if (quote === '"' && char === '$') return false;
      else if (char === '\\' && quote === '"' && index + 1 < text.length) word += text[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === '\\') { if (index + 1 < text.length) { word += text[++index]; started = true; } continue; }
    if (/[$(){}]/.test(char) || char === '#' && !started) return false;
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
      redirected = true;
      const next = redirectTarget(text[index + 1] === '>' ? index + 2 : index + 1);
      if (next < 0) return false;
      index = next - 1;
      continue;
    }
    if (char === '<') {
      if (/[<>&]/.test(text[index + 1] ?? '')) return false;
      endWord();
      redirected = true;
      // 输入重定向只读文件：目标只认普通路径字符（不带引号、通配符和展开），跳过它，不当参数。
      index++;
      while (text[index] === ' ' || text[index] === '\t') index++;
      const start = index;
      for (; index < text.length && !/[\s;|&<>]/.test(text[index]!); index++) if (!/[\w./@%+:,~-]/.test(text[index]!)) return false;
      if (index === start) return false;
      index--;
      continue;
    }
    // 通配符（含 zsh extendedglob 的 ^ 和 #）展开后可能以 - 开头被当成选项，也可能多出参数（uniq 的第二个就是输出文件）。
    if (/[*?[^#]/.test(char)) globbed = true;
    word += char;
    started = true;
  }
  if (quote) return false;
  endSegment();
  if (!valid || !segments.length) return false;
  // test / [ 不在内：bash 的 test -v 'a[$(cmd)]' 会执行下标里的命令。printf -v 能给变量赋值，也不在内。
  const simple = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'pwd', 'echo', 'du', 'df',
    'which', 'whereis', 'whoami', 'id', 'uname', 'basename', 'dirname', 'realpath', 'readlink', 'nl', 'cut', 'tr',
    'column', 'diff', 'cmp', 'comm', 'jq', 'true', 'false', 'seq', 'md5sum', 'sha1sum', 'sha256sum', 'od', 'strings', 'cd',
    'ps', 'printenv', 'type']);
  const flagged = (args: string[], forbidden: RegExp) => args.some(arg => forbidden.test(arg));
  // GNU 工具和 git 的长选项可以只写前缀（sort --out=x 就是 --output=x）：参数是任一危险长选项的前缀就算。
  const abbreviates = (args: string[], longs: string[]) => args.some(arg => {
    const name = arg.split('=')[0]!;
    return name.length > 2 && name.startsWith('--') && longs.some(long => long.startsWith(name));
  });
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
    if (!sub || flagged(params, /^-[^-]*O/) || abbreviates(params, ['--output', '--output-directory', '--open-files-in-pager', '--ext-diff'])) return false;
    if (gitReadOnly.has(sub)) return true;
    const options = params.every(param => param.startsWith('-'));
    if (sub === 'branch') return (options || params.some(param => param === '--list' || param === '-l'))
      && !flagged(params, /^-[^-]*[dDmMcCfut]/) && !abbreviates(params, ['--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream',
        '--track', '--no-track', '--edit-description', '--create-reflog', '--recurse-submodules']);
    if (sub === 'tag') return !params.length || params.some(param => param === '--list' || param === '-l') && !flagged(params, /^-[^-]*[dasfmFue]/)
      && !abbreviates(params, ['--delete', '--annotate', '--sign', '--force', '--message', '--file', '--edit', '--local-user', '--create-reflog', '--cleanup', '--trailer']);
    if (sub === 'remote') return !params.length || params.length === 1 && params[0] === '-v' || params.length === 2 && ['show', 'get-url'].includes(params[0]!);
    if (sub === 'config') return params.some(param => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(param)) && !flagged(params, /^-[^-]*e/)
      && !abbreviates(params, ['--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '--edit']);
    if (sub === 'stash') return ['list', 'show'].includes(params[0] ?? '');
    if (sub === 'worktree') return params[0] === 'list';
    if (sub === 'reflog') return !params.length || params[0] === 'show';
    return false;
  };
  return segments.every(({ words: [name, ...args], globbed }) => {
    if (!name || name.includes('=') || name.includes('/')) return false;
    if (simple.has(name)) return true;
    if (globbed) return false;
    // zsh 加载 zsh/stat 后 stat 是内建命令，-A / -H 给数组赋值，下标里的命令会执行。
    if (name === 'stat') return !flagged(args, /^-[^-]*[AH]/);
    if (name === 'date') return !flagged(args, /^-[^-]*s/) && !abbreviates(args, ['--set']);
    if (name === 'rg') return !abbreviates(args, ['--pre', '--pre-glob', '--hostname-bin']);
    if (name === 'find') return !flagged(args, /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/);
    // tree -o 写到文件，-R（配 -H）在每层目录写 00Tree.html。
    if (name === 'tree') return !flagged(args, /^-[^-]*[oR]/);
    if (name === 'sort') return !flagged(args, /^-[^-]*o/) && !abbreviates(args, ['--output', '--compress-program']);
    if (name === 'uniq') {
      // uniq [输入 [输出]]：第二个位置参数就是输出文件。- 也是位置参数，-- 之后的全算。
      const end = args.indexOf('--');
      return args.filter((arg, at) => end >= 0 && at > end || arg === '-' || !arg.startsWith('-')).length <= 1;
    }
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
