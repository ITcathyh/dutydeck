import type { AgentEvent } from '@dutydeck/shared';

// 服务重启切断的一轮怎么处理：认不认得出、能不能安全重投、给 Agent / 卡片 / Web 的说明文字。
// 本文件只放纯函数；认领、落库与派发在 coordinator（redispatchInterruptedTurn）。
//
// 判定原则：只认得出「只读」，其余一律按可能已产生外部副作用处理。工具名、命令名只取
// 白名单字符写进说明，参数与输出绝不进卡片或 Web：命令行里常带 token。

/** 每个轮次最多自动重投的次数；超过后停在需要人确认的状态。 */
export const larkRedispatchLimit = 2;
/** 被切断那一轮最后一次活动距今超过这个时长就不自动重投：几天前的任务突然在群里重新执行会让人意外。 */
export const larkRedispatchMaxAgeMs = 60 * 60_000;

/** 重启切断的一轮。运行时（markOrphanedAttempt / recoverPersistentTurn）对这两个原因码一视同仁。 */
export const isRestartInterruption = (code?: string) => code === 'PREVIOUS_RUNTIME_RESULT_UNKNOWN' || code === 'DAEMON_SHUTDOWN';

export type LarkRedispatchInfo = { count: number; resumed: boolean; auto: boolean };
/** 停下等人选的原因：可能有外部副作用、中断时间较早（old）或取不到（unknown）、已重投满。count 是此前已重投的次数。 */
export type LarkHeldCause = { count: number; unsafeReason?: string; stale?: 'old' | 'unknown' };

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

const readOnlyPrograms = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ls', 'tree', 'pwd', 'echo',
  'printf', 'which', 'whereis', 'type', 'file', 'stat', 'du', 'df', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'diff', 'cmp', 'comm', 'jq',
  'date', 'whoami', 'id', 'hostname', 'uname', 'printenv', 'ps', 'free', 'uptime', 'realpath', 'dirname', 'basename', 'readlink', 'test', '[',
  'true', 'false', 'cd', 'sleep', 'md5sum', 'sha1sum', 'sha256sum', 'seq', 'xxd', 'od', 'strings', 'zcat', 'zgrep']);
const readOnlyGit = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'blame', 'ls-files', 'ls-tree', 'grep', 'describe', 'shortlog',
  'cat-file', 'rev-list', 'merge-base', 'show-ref', 'name-rev', 'count-objects', 'version', 'help']);
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

/** 一段命令是否只读：只读返回 undefined，否则返回写进说明的命令名（名字不规整时是空串）。 */
function segmentRisk(words: string[]): string | undefined {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
  const args = words.slice(index + 1);
  const program = (words[index] ?? '').split('/').at(-1)!;
  if (!program) return undefined;
  const name = displayName(program);
  if (shells.has(program)) {
    // bash -c '<脚本>' / zsh -lc '<脚本>'：Codex 的命令都包在这一层里。
    return /^-l?c$/.test(args[0] ?? '') && args[1] !== undefined && args.length === 2 ? shellRisk(args[1]) : name;
  }
  if (readOnlyPrograms.has(program)) return undefined;
  if (program === 'env') return args.length ? name : undefined;
  if (program === 'find') return args.some(arg => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(arg)) ? name : undefined;
  if (program === 'sed') {
    // 只认 sed -n '1,200p' 这种按行号打印；别的脚本可能带 w / e。
    const scripts = args.filter(arg => !arg.startsWith('-'));
    return args.includes('-n') && !args.some(arg => /^-i|^--in-place/.test(arg)) && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(scripts[0] ?? '') ? undefined : name;
  }
  if (program === 'curl') return curlReadOnly(args) ? undefined : name;
  if (program === 'git') {
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) i += ['-C', '-c'].includes(args[i]!) ? 2 : 1;
    const sub = args[i] ?? '';
    const rest = args.slice(i + 1);
    const label = `git ${displayName(sub)}`.trim();
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

const progress = (info: LarkRedispatchInfo) => info.auto ? `第 ${info.count}/${larkRedispatchLimit} 次自动重投` : '按「重新执行」重投';
const redone = (info: LarkRedispatchInfo) => info.auto ? `已自动重投（第 ${info.count}/${larkRedispatchLimit} 次）` : '已按「重新执行」重投';

/** 注入 Agent prompt 的说明，排在用户请求之前。 */
export const larkRedispatchAgentNote = (info: LarkRedispatchInfo) => `[Dutydeck 重启恢复 · 系统说明]\n${info.resumed
  ? `服务重启打断了上一轮，这是${progress(info)}，请从停下处继续。上一轮可能做到一半，重复任何对外操作（推送代码、发消息、调用写接口等）前先检查是否已经完成。`
  : `服务重启打断了上一轮，原会话无法恢复，这是在新会话里的${progress(info)}，之前的对话不在上下文里。之前的动作可能已经生效，重复任何对外操作（推送代码、发消息、调用写接口等）前先检查。`}`;

/** 重投这一轮的进度卡注记。 */
export const larkRedispatchCardNote = (info: LarkRedispatchInfo) =>
  `服务重启打断了上一轮，这是${progress(info)}${info.resumed ? '，在原会话中从停下处继续' : '，原会话无法恢复，在新会话中重新执行'}。`;

/** 被切断那一轮的旧卡收尾。 */
export const larkRedispatchedCardMarkdown = (info: LarkRedispatchInfo, retainedNote: string) =>
  `**结果未知**\n\n服务重启打断了这一轮，执行结果未知。${redone(info)}，${info.resumed
    ? '在原会话中继续，进度见新的任务卡。'
    : `原会话无法恢复，已在本话题的新会话中重新执行，进度见新的任务卡；之后本话题的消息也进入新会话。\n\n${retainedNote}`}`;

/** 写进原会话时间线的说明（Web 上能看到）。 */
export const larkRedispatchWebNote = (info: LarkRedispatchInfo) =>
  `**Dutydeck 重启恢复**：服务重启打断了这一轮，执行结果未知。${redone(info)}。`;

export const larkHeldWebNote = (cause: LarkHeldCause) =>
  `**Dutydeck 重启恢复**：服务重启打断了这一轮，执行结果未知。${larkHeldReason(cause)}需要在飞书任务卡上选择「重新执行」或「放弃」。`;

export const larkHeldReason = ({ count, unsafeReason, stale }: LarkHeldCause) => {
  const earlier = count ? `此前已重投 ${count} 次。` : '';
  if (unsafeReason) return `这一轮${unsafeReason}，可能已产生外部副作用，没有自动重投。${earlier}`;
  if (stale) return `${stale === 'old' ? '中断时间较早' : '无法确认中断时间'}，没有自动重投。${earlier}`;
  return `已重投 ${count} 次仍被重启打断，不再自动重投。`;
};
