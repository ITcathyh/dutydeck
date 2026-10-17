/**
 * dutydeck agent：飞书会话里的 Agent 能用的全部操作，统一入口、统一输出。
 * - 帮助（--help）不需要服务或凭证；开头是写给 Agent 的快速说明，每个子命令的帮助有一行 Risk 和例子。
 * - stdout 只输出一个 JSON：成功 {"ok":true,"data":...}，失败 {"ok":false,"error":{code,message,hint?,params?}}，退出码非 0。
 * - 不用带 --turn：服务按本会话正在执行的这一轮认。写入命令都支持 --dry-run。
 * 请求都发到本机服务的 /api/lark/agent-tools/*；查看类与写入类的处理见 agent-request-tools.ts。
 */
import { open } from 'node:fs/promises';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { AgentGroupToolCliError, AgentGroupToolHttpClient } from './lark/agent-tools-cli.js';
import { collaborationHelp, groupToolsHelp, layeredWorkbenchHelp, memoryToolsHelp, workbenchHelp } from './agent-tool-help.js';

type Risk = 'read' | 'write-confirm' | 'write';
type Options = Record<string, any>;
interface AgentRequest { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: Record<string, unknown> }
interface Operation { risk: Risk; request(args: any[], options: Options): AgentRequest | Promise<AgentRequest>; serverDryRun?: boolean }
export type AgentCliRunner = (operation: string, args: unknown[], options: Options) => void | Promise<void>;
export interface AgentCliClientOptions { env?: NodeJS.ProcessEnv; fetcher?: typeof globalThis.fetch }

/** 发请求之前就能判断的错误（参数、文件、命令行用法），指出是哪个参数。 */
export class AgentCliError extends Error {
  constructor(readonly code: string, message: string, readonly params?: Array<{ name: string; reason: string }>, readonly hint?: string) {
    super(message);
    this.name = 'AgentCliError';
  }
}

const riskLabels: Record<Risk, string> = {
  read: 'read（只读：直接返回数据）',
  'write-confirm': 'write-confirm（写入·需确认：发确认卡，用户点了才生效）',
  write: 'write（写入·直接生效）'
};

export const agentQuickstart = `QUICKSTART（给 Agent）
  dutydeck agent 是你在 Dutydeck 飞书会话里能用的全部操作。先读这里，再用 dutydeck agent <命令> --help 看参数、风险和例子；帮助不需要服务或凭证。
  例子里的 dutydeck 指本轮提示给出的完整命令前缀，原样使用，不要换成 PATH 里的 dutydeck。不用带 --turn：服务按本会话正在执行的这一轮认。

风险分级（每个命令的 --help 都有一行 Risk）
  read           只读：直接返回数据，不发卡、不改东西。
  write-confirm  写入·需确认：在本轮请求消息下发确认卡，用户点了才生效。返回 pendingConfirmation:true 时只回一句“已发确认卡，点确认后生效”，不要说已完成。
  write          写入·直接生效：调用成功就已经生效。

输出
  stdout 只有一个 JSON。成功 {"ok":true,"data":...}；失败 {"ok":false,"error":{"code","message","hint"?,"params"?:[{"name","reason"}]}}，退出码非 0。
  params 指出哪个参数不对，能给可选值时写在 reason 里；按它改了再试。

--dry-run
  写入命令都支持：只返回将要做什么、要不要确认、确认卡上会写什么，不执行、不发卡。

只能由用户做的事（告诉用户怎么做，不要说已完成）
  停止当前任务：点进度卡上的「中断」，或直接说“停”。
  批准工具调用：点审批卡上的按钮，或回复“可以”。
  回答你的提问：直接在话题里回复。

常用
  dutydeck agent status                                        本会话的 Agent、模型、工作区、运行状态和排队
  dutydeck agent session resume [--id <编号>]  恢复本话题最近关闭的会话（先发确认卡）
  dutydeck agent session fork [--task '<任务>']  带上下文在新话题开分身（先发确认卡）
  dutydeck agent session new --agent <编号> --task '<完整任务>'  换 Agent 重新做（先发确认卡；编号用 agents 查）
  dutydeck agent group messages --limit 20                     读本群或本话题最近的消息
  dutydeck agent history list --query '<关键词>'                查本聊天以前的任务和结论
`;

const query = (path: string, params: Record<string, unknown>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  return search.size ? `${path}?${search}` : path;
};
const id = encodeURIComponent;
const read = (path: (args: any[], options: Options) => string): Operation => ({ risk: 'read', request: (args, options) => ({ method: 'GET', path: path(args, options) }) });
const write = (method: AgentRequest['method'], path: (args: any[]) => string, body?: (args: any[], options: Options) => Record<string, unknown>, risk: Risk = 'write'): Operation =>
  ({ risk, request: (args, options) => ({ method, path: path(args), ...(body ? { body: body(args, options) } : {}) }) });
const view = (name: string): Operation => read((_args, options) => query(`/views/${name}`, { page: options.page }));
const action = (name: string, params: (args: any[], options: Options) => Record<string, unknown> = () => ({})): Operation =>
  ({ risk: 'write-confirm', serverDryRun: true, request: (args, options) => ({ method: 'POST', path: `/actions/${name}`, body: params(args, options) }) });

/** --file 读 JSON 对象（work create/delegate 不超过 512 KB）；--json 直接给（collaborate）。 */
async function jsonInput(options: Options, required: boolean): Promise<Record<string, unknown> | undefined> {
  if (options.json !== undefined && options.file !== undefined) throw new AgentCliError('INVALID_ARGUMENT', '--json 和 --file 只选一个。', [{ name: '--json/--file', reason: '只选一个' }]);
  const name = options.file !== undefined ? '--file' : '--json';
  let raw: string | undefined = options.json;
  if (options.file !== undefined) {
    try {
      const handle = await open(options.file, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 512_000) throw new AgentCliError('INVALID_ARGUMENT', '--file 要是小于 512 KB 的普通 JSON 文件。', [{ name, reason: '要是小于 512 KB 的普通 JSON 文件' }]);
        raw = await handle.readFile('utf8');
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof AgentCliError) throw error;
      throw new AgentCliError('INVALID_ARGUMENT', `读不了 ${options.file}：${error instanceof Error ? error.message : String(error)}`, [{ name, reason: '文件读不了' }]);
    }
  }
  if (raw === undefined) {
    if (required) throw new AgentCliError('INVALID_ARGUMENT', '要用 --file 或 --json 给出 JSON 参数。', [{ name: '--file/--json', reason: '必填' }]);
    return undefined;
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new AgentCliError('INVALID_ARGUMENT', `${name} 不是合法的 JSON。`, [{ name, reason: '不是合法的 JSON' }]); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AgentCliError('INVALID_ARGUMENT', `${name} 要是 JSON 对象。`, [{ name, reason: '要是 JSON 对象' }]);
  return body as Record<string, unknown>;
}

const collaborate = (method: AgentRequest['method'], path: (args: any[]) => string, risk: Risk = 'write', create = false): Operation => ({
  risk,
  request: async (args, options) => {
    const body = await jsonInput(options, true);
    if (create && !body?.id) throw new AgentCliError('INVALID_ARGUMENT', '创建需要稳定 id；重试时沿用同一个 id。', [{ name: '--json/--file', reason: 'JSON 里要有稳定的 id' }]);
    return { method, path: `/collaboration${path(args)}`, body };
  }
});
const workFile = (path: string): Operation => ({ risk: 'write', request: async (_args, options) => ({ method: 'POST', path, body: await jsonInput({ file: options.file }, true) }) });

const operations: Record<string, Operation> = {
  'settings.show': read(() => '/settings'),
  'settings.set': { risk: 'write-confirm', serverDryRun: true, request: ([pairs]) => ({ method: 'POST', path: '/settings', body: { pairs } }) },
  status: view('status'), agents: view('agents'), tasks: view('tasks'), queue: view('queue'), schedules: view('schedules'), ci: view('ci'),
  'session.resume': action('session.resume', (_args, o) => ({ id: o.id })),
  'session.fork': action('session.fork', (_args, o) => ({ agent: o.agent, model: o.model, effort: o.effort, cwd: o.cwd, workspace: o.workspace, task: o.task })),
  'session.new': action('session.new', (_args, o) => ({ agent: o.agent, model: o.model, effort: o.effort, cwd: o.cwd, workspace: o.workspace, handoff: o.handoff, note: o.note, task: o.task })),
  retry: action('retry'),
  plan: action('plan', (_args, o) => ({ task: o.task })),
  'schedule.create': { risk: 'write-confirm', serverDryRun: true, request: (_args, o) => ({ method: 'POST', path: '/schedules', body: { prompt: o.prompt, name: o.name, every: o.every, cron: o.cron, at: o.at } }) },
  'schedule.enable': action('schedule.enable', ([scheduleId]) => ({ id: scheduleId })),
  'schedule.disable': action('schedule.disable', ([scheduleId]) => ({ id: scheduleId })),
  'queue.cancel': action('queue.cancel', ([index]) => ({ index })),
  'queue.top': action('queue.top', ([index]) => ({ index })),
  'access.grant': action('access.grant', (_args, o) => ({ members: o.member })),
  'access.revoke': action('access.revoke', (_args, o) => ({ members: o.member })),
  'pr.open': action('pr.open', (_args, o) => ({ title: o.title })),
  'ci.wait': action('ci.wait', (_args, o) => ({ workflow: o.workflow })),
  'ci.fix': action('ci.fix'),
  'ci.cancel': action('ci.cancel', ([waitId]) => ({ id: waitId })),
  repair: action('repair'),

  'group.self': read(() => '/self'),
  'group.peers': read(() => '/peers'),
  'group.members': read(() => '/members'),
  'group.bots': read(() => '/bots'),
  'group.messages': read((_args, o) => query('/messages', { after: o.after, limit: o.limit, since: o.since, until: o.until, query: o.query })),
  'group.message': read(([messageId]) => query('/message', { messageId })),
  'group.team-search': read(([text]) => query('/team-search', { query: text })),
  'group.wait': read((_args, o) => query('/wait', { after: o.after, limit: o.limit, timeoutMs: o.timeoutMs })),
  'group.send': write('POST', () => '/send', ([content], o) => ({ content, final: o.final, to: o.to, replyTo: o.replyTo, inThread: o.inThread, idempotencyKey: o.idempotencyKey })),
  'group.send-file': write('POST', () => '/send-file', ([path], o) => ({ path, replyTo: o.replyTo, inThread: o.inThread, idempotencyKey: o.idempotencyKey, image: o.image })),
  'group.handoff': write('POST', () => '/handoff', ([to, content]) => ({ to, content })),
  'group.reply-agent': write('POST', () => '/reply-agent', ([content]) => ({ content })),
  'history.list': read((_args, o) => query('/history', { since: o.since, until: o.until, query: o.query, limit: o.limit })),
  'history.show': read(([taskId], o) => query(`/history/${id(taskId)}`, { field: o.field, offset: o.offset, length: o.length, cursor: o.cursor })),
  'memory.list': read((_args, o) => query('/memory', { topic: o.topic })),
  'memory.show': read(([topic]) => `/memory/topics/${id(topic)}`),
  'memory.search': read(([text], o) => query('/memory/search', { q: text, topic: o.topic, limit: o.limit })),
  'memory.add': write('POST', () => '/memory', ([content], o) => ({ content, topic: o.topic })),
  'memory.remove': write('DELETE', ([memoryId]) => `/memory/${id(memoryId)}`),
  'work.list': read(() => '/work-items'),
  'work.templates': read(() => '/work-items'),
  'work.agents': read(() => '/work-items/agents'),
  'work.skills': read(() => '/work-items/skills'),
  'work.show': read(([goalId]) => `/work-items/${id(goalId)}`),
  'work.create': workFile('/work-items'),
  'work.delegate': workFile('/work-items/delegations'),
  'work.save': write('POST', ([goalId]) => `/work-items/${id(goalId)}/template`, ([, name]) => ({ name })),
  'work.run': write('POST', ([template]) => `/work-items/templates/${id(template)}/run`, ([, version, goal], o) => ({ version, goal, idempotencyKey: o.key })),
  'collaborate.status': read(() => '/collaboration'),
  'collaborate.followup-create': collaborate('POST', () => '/followups', 'write', true),
  'collaborate.followup-update': collaborate('PATCH', ([recordId]) => `/followups/${id(recordId)}`),
  'collaborate.mandate-create': collaborate('POST', () => '/mandates', 'write-confirm', true),
  'collaborate.mandate-update': collaborate('PATCH', ([recordId]) => `/mandates/${id(recordId)}`),
  'collaborate.feedback': collaborate('POST', ([decisionId]) => `/decisions/${id(decisionId)}/feedback`)
};

/** 执行一条 dutydeck agent 命令，返回服务给的数据；--dry-run 时写入类只预览。 */
export async function runAgentOperation(operation: string, args: unknown[], options: Options, client: AgentCliClientOptions = {}): Promise<unknown> {
  const spec = operations[operation];
  if (!spec) throw new AgentCliError('UNKNOWN_COMMAND', `没有 ${operation} 这个命令。`, [{ name: '<命令>', reason: '没有这个命令' }], '运行 dutydeck agent --help 看全部命令。');
  const request = await spec.request(args, options);
  if (options.dryRun && spec.risk !== 'read' && !spec.serverDryRun) {
    return { dryRun: true, risk: spec.risk, request, needsConfirmation: spec.risk === 'write-confirm',
      effect: spec.risk === 'write-confirm' ? '执行后宿主在原话题发确认卡，用户点确认后才生效。' : '去掉 --dry-run 执行后立即生效。' };
  }
  const body = options.dryRun && spec.serverDryRun ? { ...request.body, dryRun: true } : request.body;
  return new AgentGroupToolHttpClient(client).request(request.path, { method: request.method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

/** 失败统一成 {code,message,hint?,params?}；服务给的其他字段（如授权地址）原样带上。 */
export function agentCliErrorBody(error: unknown): Record<string, unknown> {
  if (error instanceof AgentGroupToolCliError) return { ...error.error };
  if (error instanceof AgentCliError) return { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}), ...(error.params ? { params: error.params } : {}) };
  return { code: 'AGENT_CLI_FAILED', message: error instanceof Error ? error.message : String(error) };
}

export async function runAgentCli(operation: string, args: unknown[], options: Options, client: AgentCliClientOptions = {}, write = (text: string) => { process.stdout.write(text); }) {
  try {
    write(`${JSON.stringify({ ok: true, data: await runAgentOperation(operation, args, options, client) })}\n`);
  } catch (error) {
    write(`${JSON.stringify({ ok: false, error: agentCliErrorBody(error) })}\n`);
    process.exitCode = 1;
  }
}

/** Commander 的用法错误换成带 params 的 AgentCliError；帮助照常输出、退出码 0。 */
function usageError(error: CommanderError, path: string, command: Command): AgentCliError {
  const message = error.message.replace(/^error:\s*/, '');
  const hint = `运行 dutydeck agent ${path ? `${path} ` : ''}--help 看用法。`;
  const option = /option '(-{1,2}[\w-]+)/.exec(message)?.[1];
  const argument = /argument '([\w-]+)'/.exec(message)?.[1];
  const invalid = /is invalid(?: for argument '[^']+')?\.\s*(.*)$/.exec(message)?.[1]?.replace(/^Allowed choices are (.*)\.$/, (_, list: string) => `可选：${list.split(', ').join('、')}`);
  const [name, reason] = error.code === 'commander.unknownCommand' ? ['<命令>', `没有这个命令：${/command '([^']+)'/.exec(message)?.[1] ?? ''}`]
    : error.code === 'commander.excessArguments' && command.commands.length ? ['<命令>', `没有这个命令：${command.args[0]}；可用：${command.commands.map(item => item.name()).join('、')}`]
    : error.code === 'commander.excessArguments' ? ['<参数>', '多余的参数']
    : error.code === 'commander.unknownOption' ? [option ?? '<参数>', '不支持这个参数']
    : error.code === 'commander.invalidArgument' ? [option ?? (argument ? `<${argument}>` : '<参数>'), invalid || message]
    : error.code === 'commander.optionMissingArgument' ? [option ?? '<参数>', '缺少值']
    : [option ?? (argument ? `<${argument}>` : '<参数>'), '必填'];
  return new AgentCliError(name === '<命令>' ? 'UNKNOWN_COMMAND' : 'INVALID_ARGUMENT', `${name}：${reason}`, [{ name, reason }], hint);
}

const integer = (min: number, max?: number) => (value: string) => {
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < min || (max !== undefined && number > max)) throw new InvalidArgumentError(max === undefined ? `要是不小于 ${min} 的整数` : `要是 ${min}-${max} 的整数`);
  return number;
};
const collect = (value: string, previous: string[] = []) => [...previous, value];

/** 挂到 dutydeck 命令树上；run 收到操作名（如 session.new）、位置参数和选项。 */
export function addAgentCommands(program: Command, run: AgentCliRunner) {
  const agent = program.command('agent')
    .description('Lark Agent only: everything an Agent can do in its Dutydeck session, with JSON output; start here')
    .configureOutput({ writeErr: () => {}, outputError: () => {} })
    .addHelpText('before', agentQuickstart);
  const usage = (command: Command, path: string) => command.exitOverride(error => {
    if (error.exitCode !== 0) throw usageError(error, path, command);
  });
  usage(agent, '');
  agent.action(() => agent.outputHelp());
  const pathOf = (command: Command): string => command.parent && command.parent !== agent ? `${pathOf(command.parent)} ${command.name()}` : command.name();
  /** 命令组：不带子命令时输出帮助。 */
  const group = (parent: Command, name: string, description: string, help?: string) => {
    const command = parent.command(name).description(description);
    usage(command, pathOf(command));
    if (help) command.addHelpText('after', `\n${help}`);
    return command.action(() => command.outputHelp());
  };
  const sub = (parent: Command, spec: string, description: string, operation: string, risk: Risk, examples: string[], help?: string) => {
    const command = parent.command(spec).description(description);
    usage(command, pathOf(command));
    if (risk !== 'read') command.option('--dry-run', 'Preview only: what would happen, whether it needs confirmation and what the card says');
    command.addHelpText('after', `\nRisk: ${riskLabels[risk]}\n\nExamples:\n${examples.map(example => `  $ dutydeck agent ${example}`).join('\n')}${help ? `\n\n${help}` : ''}`);
    return command.action((...values: unknown[]) => {
      const self = values.at(-1) as Command;
      return run(operation, self.processedArgs, self.opts());
    });
  };

  sub(agent, 'status', 'Show this session: Agent, model, workspace, session id, run state, running and queued counts', 'status', 'read', ['status']);
  sub(agent, 'agents', 'List the Agents on this machine; session new --agent takes their ids', 'agents', 'read', ['agents']);
  sub(agent, 'tasks', 'List tasks the requester may see, newest and pending first, 10 per page', 'tasks', 'read', ['tasks', 'tasks --page 2'])
    .option('--page <n>', 'Page number', integer(1));
  const queue = sub(agent, 'queue', 'List queued requests of this session, numbered in arrival order; cancel or move one with the subcommands', 'queue', 'read', ['queue', 'queue cancel 2', 'queue top 2']);
  sub(queue, 'cancel', 'Cancel a queued request by its number', 'queue.cancel', 'write-confirm', ['queue cancel 2']).argument('<index>', 'Number shown by queue', integer(1));
  sub(queue, 'top', 'Move a queued request to the front; the current turn is interrupted', 'queue.top', 'write-confirm', ['queue top 2']).argument('<index>', 'Number shown by queue', integer(1));
  sub(agent, 'schedules', 'List schedules of this conversation', 'schedules', 'read', ['schedules']);
  const schedule = group(agent, 'schedule', 'Create, enable or disable schedules of this conversation');
  sub(schedule, 'create', 'Set up a schedule for the requester; it is created disabled and starts after they click 启用 on the card', 'schedule.create', 'write-confirm',
    ["schedule create --every 15 --prompt '看看这个话题有没有排查结论'", "schedule create --cron '0 9 * * 1-5' --prompt '汇总昨天的告警' --name 晨报", "schedule create --at 2026-10-17T10:00 --prompt '提醒我看发布结果'"],
    '时间按北京时间；--every、--cron、--at 只选一个。--prompt 只写每次要做的事，不写频率。不要用 crontab、后台 sleep 或循环脚本代替。')
    .requiredOption('--prompt <text>', 'Complete instructions to execute each time')
    .option('--name <name>', 'Short schedule name')
    .option('--every <minutes>', 'Fixed interval in whole minutes', integer(1, 525_600))
    .option('--cron <expression>', 'Five-field cron expression, Asia/Shanghai time')
    .option('--at <local-time>', 'Run once at YYYY-MM-DDTHH:mm, Asia/Shanghai time');
  sub(schedule, 'enable', 'Enable a schedule', 'schedule.enable', 'write-confirm', ['schedule enable <编号>']).argument('<id>', 'Schedule id shown by schedules');
  sub(schedule, 'disable', 'Disable a schedule', 'schedule.disable', 'write-confirm', ['schedule disable <编号>']).argument('<id>', 'Schedule id shown by schedules');
  const ci = sub(agent, 'ci', 'List CI waits of this session; wait, fix or cancel with the subcommands', 'ci', 'read', ['ci', 'ci wait', 'ci cancel <编号>']);
  sub(ci, 'wait', 'Wait for the CI of the current commit and report back here', 'ci.wait', 'write-confirm', ['ci wait', 'ci wait --workflow build.yml'])
    .option('--workflow <name>', 'Workflow file name or id');
  sub(ci, 'fix', 'Wait for CI and hand failures to the Agent to fix, within limits', 'ci.fix', 'write-confirm', ['ci fix']);
  sub(ci, 'cancel', 'Cancel a CI wait', 'ci.cancel', 'write-confirm', ['ci cancel <编号>']).argument('<id>', 'Wait id shown by ci');
  const session = group(agent, 'session', 'Start, resume or fork conversations in this chat');
  sub(session, 'resume', 'Restore a closed conversation in this topic; omit id for the latest', 'session.resume', 'write-confirm', ['session resume', 'session resume --id ses_编号']).option('--id <id>', 'Closed conversation id in the same topic');
  sub(session, 'fork', 'Copy this conversation into a parallel topic; git repositories use a worktree by default', 'session.fork', 'write-confirm', ["session fork --task '检查另一种实现'", 'session fork'])
    .option('--task <text>', 'Task for the fork')
    .option('--agent <id>', 'Agent id from agents; changing Agent uses a handoff')
    .option('--model <model>', 'Model for the fork')
    .option('--effort <level>', 'Reasoning effort for the fork')
    .option('--cwd <path>', 'Absolute workspace path, or a workspace alias of this bot')
    .addOption(new Option('--workspace <mode>', 'Workspace mode').choices(['shared', 'worktree']));
  sub(session, 'new', 'End this conversation and start a new one, optionally with another Agent, model or workspace', 'session.new', 'write-confirm',
    ["session new --agent codex --task '修复登录页报错，改完跑测试'", "session new --handoff --note '接着查内存泄漏'", 'session new'],
    '新对话不带当前上下文：--task 要写全；要带上最近结果、git 状态和备注加 --handoff。--agent 填错时返回可用编号；指定 Agent、模型、工作目录或工作区时要同时给 --task 或 --handoff。不带参数只结束当前对话。')
    .option('--agent <id>', 'Agent id from agents')
    .option('--model <model>', 'Model for the new conversation')
    .option('--effort <level>', 'Reasoning effort for the new conversation')
    .option('--cwd <path>', 'Absolute workspace path, or a workspace alias of this bot')
    .addOption(new Option('--workspace <mode>', 'Workspace mode').choices(['shared', 'worktree']))
    .option('--handoff', 'Hand the recent results, git status and the note over to the new conversation')
    .option('--note <text>', 'Handoff note; only with --handoff')
    .option('--task <text>', 'Complete task for the first turn of the new conversation');
  sub(agent, 'retry', 'Run the latest failed, interrupted or cancelled request of this conversation again', 'retry', 'write-confirm', ['retry']);
  sub(agent, 'plan', 'Have the Agent research and propose a plan first; it runs after the plan card is approved', 'plan', 'write-confirm', ["plan --task '把登录页的报错改成中文'"])
    .requiredOption('--task <text>', 'Task to plan');
  const access = group(agent, 'access', 'Change who in this group may talk to the bot');
  const memberHelp = '--member 只能填用户这条消息里 @ 过的人的名字；不带 --member 时 grant 放开给全体群成员，revoke 收回到只有管理员。';
  sub(access, 'grant', 'Open the bot to all group members, or add @-mentioned members to the list', 'access.grant', 'write-confirm', ['access grant --member 张三', 'access grant'], memberHelp)
    .option('--member <name>', 'Member @-mentioned in the user\'s message (repeatable)', collect);
  sub(access, 'revoke', 'Restrict the bot to its admins, or remove @-mentioned members from the list', 'access.revoke', 'write-confirm', ['access revoke --member 张三', 'access revoke'], memberHelp)
    .option('--member <name>', 'Member @-mentioned in the user\'s message (repeatable)', collect);
  const pr = group(agent, 'pr', 'Pull requests of this conversation');
  sub(pr, 'open', 'Push the changes of this conversation to a dutydeck/ branch and open a PR after the user confirms on the card', 'pr.open', 'write-confirm', ['pr open', "pr open --title '修复登录页报错'"])
    .option('--title <title>', 'PR title');
  sub(agent, 'repair', 'Fix the bot\'s Feishu app permissions, events and card callbacks after an admin confirms on the card', 'repair', 'write-confirm', ['repair']);

  const settings = group(agent, 'settings', 'Show or propose common bot defaults and notification settings; changes need a bot admin confirmation');
  sub(settings, 'show', 'Show only common bot settings', 'settings.show', 'read', ['settings show']);
  sub(settings, 'set <key=value...>', 'Propose bot settings; only a bot admin can confirm', 'settings.set', 'write-confirm', ['settings set defaultAgentId=codex', 'settings set notifyQuietHours=22:00-08:00 busyTriage=true'],
    'Keys: defaultAgentId, defaultModel, defaultReasoningEffort, p2pMode, groupReplyMode, notifyQuietHours, notifyMentionAction, notifyMentionDone, busyTriage. Booleans: true/false; use an empty value to clear model, effort or quiet hours.');

  const chat = group(agent, 'group', 'Read and send messages in the current Lark chat', groupToolsHelp(true, 'dutydeck agent'));
  sub(chat, 'self', 'Show the current bot and scoped chat', 'group.self', 'read', ['group self']);
  sub(chat, 'peers', 'Discover Agents of this Dutydeck instance in the group', 'group.peers', 'read', ['group peers']);
  sub(chat, 'members', 'Discover human members in the group', 'group.members', 'read', ['group members']);
  sub(chat, 'bots', 'List all bots in the group (agentId means managed by this instance)', 'group.bots', 'read', ['group bots']);
  sub(chat, 'messages', 'Read messages of this group or topic', 'group.messages', 'read', ['group messages --limit 20', "group messages --since 2026-10-01 --query '发布'"])
    .option('--after <cursor>', 'Only messages after a cursor returned by messages or wait')
    .option('--limit <count>', 'Maximum messages to return (1-50)', integer(1, 50), 20)
    .option('--since <time>', 'Messages created after this time (ISO 8601 or unix timestamp)')
    .option('--until <time>', 'Messages created before this time (ISO 8601 or unix timestamp)')
    .option('--query <query>', 'Messages containing all whitespace-separated keywords');
  sub(chat, 'message', 'Fetch one message by id, expanding merge_forward content', 'group.message', 'read', ['group message om_xxx']).argument('<message-id>', 'om_* message id');
  sub(chat, 'team-search', 'Search messages in other groups of this bot (needs group participation)', 'group.team-search', 'read', ["group team-search '发布窗口'"]).argument('<query>', 'Keywords');
  sub(chat, 'wait', 'Wait briefly for new messages after a cursor', 'group.wait', 'read', ['group wait --after <cursor>'])
    .requiredOption('--after <cursor>', 'Cursor returned by messages or wait')
    .option('--limit <count>', 'Maximum messages to return (1-50)', integer(1, 50), 20)
    .option('--timeout-ms <milliseconds>', 'Long-poll timeout (0-30000)', integer(0, 30_000), 15_000);
  sub(chat, 'send', 'Send a new message, or reply to a message or topic', 'group.send', 'write', ["group send '发布窗口已开启'", "group send '我已定位问题' --reply-to om_xxx --in-thread", "group send '<完整答复>' --final"])
    .argument('<content>', 'Message content')
    .option('--final', 'Deliver the final answer of the current task (rarely needed)')
    .option('--to <target>', 'Mention a discovered Agent or member by id or name')
    .option('--reply-to <message-id>', 'Reply to an om_* message in this chat')
    .option('--in-thread', 'Put the reply in the topic; needs --reply-to')
    .option('--idempotency-key <key>', 'Stable retry key (up to 50 characters)');
  sub(chat, 'send-file', 'Send a file from the session workspace', 'group.send-file', 'write', ['group send-file report.md', 'group send-file chart.png --image'])
    .argument('<path>', 'Path inside the session workspace')
    .option('--reply-to <message-id>', 'Reply to an om_* message in this chat')
    .option('--in-thread', 'Put the reply in the topic')
    .option('--idempotency-key <key>', 'Stable retry key')
    .option('--image', 'Send as an image (10 MiB limit)');
  sub(chat, 'handoff', 'Hand one task to another bot in this group and topic', 'group.handoff', 'write', ["group handoff <机器人> '<目标、代码版本、工作区、读写边界和验收>'"])
    .argument('<target>', 'Target bot name, appId or openId').argument('<content>', 'Task brief and acceptance criteria');
  sub(chat, 'reply-agent', 'Return the result to the bot that handed the task over', 'group.reply-agent', 'write', ["group reply-agent '<交付结果>'"]).argument('<content>', 'Result');
  const history = group(agent, 'history', 'Review earlier tasks of this chat');
  sub(history, 'list', 'List earlier tasks, newest first', 'history.list', 'read', ["history list --query '部署方案'"])
    .option('--since <time>', 'Tasks created after this time').option('--until <time>', 'Tasks created before this time')
    .option('--query <query>', 'Tasks whose request or answer contains all keywords')
    .option('--limit <count>', 'Maximum tasks (1-50)', integer(1, 50), 20);
  sub(history, 'show', 'Show the request and final answer of an earlier task', 'history.show', 'read', ['history show <taskId>', 'history show <taskId> --field answer --offset 0'])
    .argument('<task-id>', 'Task id from history list')
    .addOption(new Option('--field <field>', 'Read the saved request or answer verbatim').choices(['request', 'answer']))
    .option('--offset <units>', 'UTF-16 offset', integer(0))
    .option('--length <units>', 'Page length in UTF-16 units (1-8000)', integer(1, 8_000))
    .option('--cursor <cursor>', 'Continue a page; exclusive with field/offset/length');
  const memory = group(agent, 'memory', 'Read and maintain the long-term memory of this chat', memoryToolsHelp('dutydeck agent'));
  sub(memory, 'list', 'List memories with their ids', 'memory.list', 'read', ['memory list']).option('--topic <slug>', 'Topic slug');
  sub(memory, 'show', 'Show the memories of a topic', 'memory.show', 'read', ['memory show general']).argument('<topic>', 'Topic slug');
  sub(memory, 'search', 'Search memories by keyword', 'memory.search', 'read', ["memory search '测试命令'"]).argument('<query>', 'Keyword')
    .option('--topic <slug>', 'Topic slug').option('--limit <count>', 'Maximum entries (1-50)', integer(1, 50));
  sub(memory, 'add', 'Save one fact the user explicitly asked to remember', 'memory.add', 'write', ["memory add '项目用 pnpm，测试命令是 pnpm test'"])
    .argument('<content>', 'One sentence (at most 1000 characters)').option('--topic <slug>', 'Topic slug (defaults to general)');
  sub(memory, 'remove', 'Delete a memory the user asked to forget', 'memory.remove', 'write', ['memory remove mem_xxx']).argument('<id>', 'Memory id (mem_*)');
  const work = group(agent, 'work', 'Arrange multi-Agent goals, waits and reusable workflows', `${workbenchHelp('dutydeck agent work')}\n${layeredWorkbenchHelp('dutydeck agent work')}`);
  sub(work, 'list', 'List goals and templates of this topic', 'work.list', 'read', ['work list']);
  sub(work, 'templates', 'List reusable templates', 'work.templates', 'read', ['work templates']);
  sub(work, 'agents', 'List Agent ids steps can use', 'work.agents', 'read', ['work agents']);
  sub(work, 'skills', 'List Skills of the workspace', 'work.skills', 'read', ['work skills']);
  sub(work, 'show', 'Show a goal', 'work.show', 'read', ['work show <目标编号>']).argument('<id>', 'Goal id');
  sub(work, 'create', 'Accept a goal plan; may wait for the user to click 开始执行 depending on settings', 'work.create', 'write', ['work create --file plan.json'])
    .requiredOption('--file <path>', 'JSON plan with goal and a stable idempotencyKey');
  sub(work, 'delegate', 'Hand a brief to the Leader (layered mode)', 'work.delegate', 'write', ['work delegate --file brief.json'])
    .requiredOption('--file <path>', 'JSON brief with goal, context and a stable idempotencyKey');
  sub(work, 'save', 'Save a goal as an immutable template version', 'work.save', 'write', ['work save <目标编号> <流程名称>']).argument('<id>', 'Goal id').argument('<name>', 'Template name');
  sub(work, 'run', 'Run a template version for a new goal', 'work.run', 'write', ['work run <模板编号> 1 <新目标> --key <稳定请求键>'])
    .argument('<template>', 'Template id').argument('<version>', 'Template version', integer(1)).argument('<goal>', 'New goal')
    .requiredOption('--key <key>', 'Stable request key for this run');
  const collaboration = group(agent, 'collaborate', 'Group follow-ups and ongoing mandates', collaborationHelp('dutydeck agent collaborate'));
  sub(collaboration, 'status', 'Read follow-ups, mandates, progress and revisions of this group', 'collaborate.status', 'read', ['collaborate status']);
  const jsonOptions = (command: Command) => command.option('--json <json>', 'Parameters as JSON').option('--file <path>', 'Read the JSON parameters from a file');
  jsonOptions(sub(collaboration, 'followup-create', 'Record a follow-up', 'collaborate.followup-create', 'write', [`collaborate followup-create --json '{"id":"本轮稳定请求键","goal":"跟进目标"}'`]));
  jsonOptions(sub(collaboration, 'followup-update', 'Update a follow-up', 'collaborate.followup-update', 'write', [`collaborate followup-update <编号> --json '{"expectedRevision":1,"progress":"新进展"}'`])).argument('<id>', 'Follow-up id');
  jsonOptions(sub(collaboration, 'mandate-create', 'Propose an ongoing mandate; it is created after the user confirms on the card', 'collaborate.mandate-create', 'write-confirm', ['collaborate mandate-create --file mandate.json']));
  jsonOptions(sub(collaboration, 'mandate-update', 'Change, pause or cancel a mandate', 'collaborate.mandate-update', 'write', [`collaborate mandate-update <编号> --json '{"expectedRevision":1,"status":"paused"}'`])).argument('<id>', 'Mandate id');
  jsonOptions(sub(collaboration, 'feedback', 'Record a correction to a decision', 'collaborate.feedback', 'write', [`collaborate feedback <决策编号> --json '{"correction":"用户修订"}'`])).argument('<id>', 'Decision id');
  return agent;
}
