import { open } from 'node:fs/promises';
import { InvalidArgumentError, Option, type Command } from 'commander';
import { untrustedNotice } from '@dutydeck/shared';
import { collaborationHelp, groupToolsHelp, layeredWorkbenchHelp, memoryToolsHelp, workbenchHelp } from '../agent-tool-help.js';
import type { LarkAgentToolsService } from '../lark/agent-tools.js';

export type Risk = 'read' | 'write-confirm' | 'write';
export type Options = Record<string, any>;
type Fields = Record<string, unknown>;
type Mapping = (args: any[], options: Options) => Fields | undefined;
type BodyMapping = (args: any[], options: Options) => ReturnType<Mapping> | Promise<ReturnType<Mapping>>;

// The turn guard binds every route to a current channel turn. Domain services enforce the
// additional policy below, including rechecks around long polls and delivery.
const channelTurn = { channel: 'lark', turn: 'current-attempt' } as const;
export const toolNeeds = {
  groupRead: { ...channelTurn, groupTools: 'read' },
  groupDiscover: { ...channelTurn, groupTools: 'discover' },
  groupSend: { ...channelTurn, groupTools: 'send' },
  memory: { ...channelTurn, memory: true },
  work: { ...channelTurn, actor: 'active', groupTools: 'read' },
  collaboration: { ...channelTurn, actor: 'active', groupTools: 'read', chat: 'group' },
  humanRequest: { ...channelTurn, actor: 'human-requester' },
  scheduledRequest: { ...channelTurn, actor: 'active', allowAutomated: true },
  pluginResult: { ...channelTurn, actor: 'human-requester', groupTools: 'send' }
} as const;
export type ToolNeed = (typeof toolNeeds)[keyof typeof toolNeeds];
export interface Endpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  need: ToolNeed;
}
export type GroupRequest = {
  query: Record<string, string | undefined>;
  params: Record<string, string>;
  body?: Record<string, unknown>;
};
export interface AgentTool extends Endpoint {
  name: string;
  risk: Risk;
  description: string;
  examples: string[];
  usage?: string;
  help?: string;
  configure?(command: Command): void;
  query?: Mapping;
  body?: BodyMapping;
  legacyBody?: BodyMapping;
  serverDryRun?: boolean;
  bodyTurn?: (options: Options) => boolean;
  handlerName?: string;
  namedPath?: boolean;
  serve?(service: LarkAgentToolsService, token: string | undefined, request: GroupRequest): Promise<unknown>;
}
export const toolBase = '/api/lark/agent-tools';
export function toolPath(tool: Endpoint, args: unknown[] = []) {
  let index = 0;
  return tool.path.replace(/:\w+/g, () => encodeURIComponent(String(args[index++])));
}

export function queryString(fields?: Fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields ?? {})) if (value !== undefined) params.set(key, String(value));
  return params.size ? '?' + params : '';
}

export async function toolRequest(tool: AgentTool, args: unknown[], options: Options, search = queryString(tool.query?.(args, options)), mapBody = tool.body) {
  const path = toolPath(tool, tool.namedPath ? [tool.name] : args) + search;
  const body = await mapBody?.(args, options);
  return { method: tool.method, path, ...(body === undefined ? {} : { body }) };
}

/** 发请求之前就能判断的错误（参数、文件、命令行用法），指出是哪个参数。 */
export class AgentCliError extends Error {
  constructor(readonly code: string, message: string, readonly params?: Array<{ name: string; reason: string }>, readonly hint?: string) {
    super(message);
    this.name = 'AgentCliError';
  }
}

/** --file 读 JSON 对象（work create/delegate 不超过 512 KB）；--json 直接给（collaborate）。 */
async function jsonInput(options: Options): Promise<Record<string, unknown>> {
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
    throw new AgentCliError('INVALID_ARGUMENT', '要用 --file 或 --json 给出 JSON 参数。', [{ name: '--file/--json', reason: '必填' }]);
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new AgentCliError('INVALID_ARGUMENT', `${name} 不是合法的 JSON。`, [{ name, reason: '不是合法的 JSON' }]); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AgentCliError('INVALID_ARGUMENT', `${name} 要是 JSON 对象。`, [{ name, reason: '要是 JSON 对象' }]);
  return body as Record<string, unknown>;
}

const integer = (min: number, max?: number) => (value: string) => {
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < min || (max !== undefined && number > max)) throw new InvalidArgumentError(max === undefined ? `要是不小于 ${min} 的整数` : `要是 ${min}-${max} 的整数`);
  return number;
};
const collect = (value: string, previous: string[] = []) => [...previous, value];

const jsonOptions = (command: Command) => command.option('--json <json>', 'Parameters as JSON').option('--file <path>', 'Read the JSON parameters from a file');
const memberHelp = '--member 只能填用户这条消息里 @ 过的人的名字；不带 --member 时 grant 放开给全体群成员，revoke 收回到只有管理员。';
const view = { handlerName: 'view', namedPath: true, method: 'GET', path: '/views/:name', need: toolNeeds.humanRequest, risk: 'read',
  query: (_args, options) => ({ page: options.page }) } as const satisfies Partial<AgentTool>;
const action = { handlerName: 'action', namedPath: true, method: 'POST', path: '/actions/:name', need: toolNeeds.humanRequest, risk: 'write-confirm',
  body: () => ({}), serverDryRun: true } as const satisfies Partial<AgentTool>;
const workPlan: BodyMapping = (_args, options) => jsonInput({ file: options.file });
const collaborationInput: BodyMapping = (_args, options) => jsonInput(options);
const collaborationCreate: BodyMapping = async (_args, options) => {
  const body = await jsonInput(options);
  if (!body?.id) throw new AgentCliError('INVALID_ARGUMENT', '创建需要稳定 id；重试时沿用同一个 id。', [{ name: '--json/--file', reason: 'JSON 里要有稳定的 id' }]);
  return body;
};
const untrusted = async <T extends object>(source: string, result: Promise<T>) => ({ untrusted: untrustedNotice(source), ...await result });
const numberFrom = (value?: string) => value === undefined ? undefined : Number(value);
const integerFrom = (value: string) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;

export const toolGroups: Record<string, [string, string?]> = {
  'risk': ['Request administrator approval for the current task'],
  'schedule': ['Create, enable or disable schedules of this conversation'],
  'session': ['Start, resume or fork conversations in this chat'],
  'access': ['Change who in this group may talk to the bot'],
  'pr': ['Pull requests of this conversation'],
  'settings': ['Show or propose common bot defaults and notification settings; changes need a bot admin confirmation'],
  'group': ['Read and send messages in the current Lark chat', groupToolsHelp(true, 'dutydeck agent')],
  'history': ['Review earlier tasks of this chat'],
  'memory': ['Read and maintain the long-term memory of this chat', memoryToolsHelp('dutydeck agent')],
  'work': ['Arrange multi-Agent goals, waits and reusable workflows', `${workbenchHelp('dutydeck agent work')}\n${layeredWorkbenchHelp('dutydeck agent work')}`],
  'collaborate': ['Group follow-ups and ongoing mandates', collaborationHelp('dutydeck agent collaborate')],
};

export const toolTable: readonly AgentTool[] = [
  { name: 'status', ...view,
    description: 'Show this session: Agent, model, workspace, session id, run state, running and queued counts',
    examples: ['status'] },
  { name: 'agents', ...view,
    description: 'List the Agents on this machine; session new --agent takes their ids',
    examples: ['agents'] },
  { name: 'tasks', ...view,
    description: 'List tasks the requester may see, newest and pending first, 10 per page',
    examples: ['tasks', 'tasks --page 2'],
    configure: command => command
      .option('--page <n>', 'Page number', integer(1)) },
  { name: 'queue', ...view,
    description: 'List queued requests of this session, numbered in arrival order; cancel or move one with the subcommands',
    examples: ['queue', 'queue cancel 2', 'queue top 2'] },
  { name: 'queue.cancel', ...action,
    body: ([index]) => ({ index }),
    description: 'Cancel a queued request by its number',
    examples: ['queue cancel 2'],
    configure: command => command.argument('<index>', 'Number shown by queue', integer(1)) },
  { name: 'queue.top', ...action,
    body: ([index]) => ({ index }),
    description: 'Move a queued request to the front; the current turn is interrupted',
    examples: ['queue top 2'],
    configure: command => command.argument('<index>', 'Number shown by queue', integer(1)) },
  { name: 'schedules', ...view,
    description: 'List schedules of this conversation',
    examples: ['schedules'] },
  { name: 'risk.request', risk: 'write-confirm', need: toolNeeds.humanRequest, method: 'POST', path: '/risk/requests',
    body: (_args, o) => ({ summary: o.summary, command: o.command }),
    description: 'Ask the bot administrators to approve the high-risk operation for this request',
    examples: ["risk request --summary 'Publish the reviewed changes' --command 'git push'"],
    configure: command => command.requiredOption('--summary <text>', 'What needs to happen and why')
      .requiredOption('--command <text>', 'Original command that was blocked') },
  { name: 'schedule.create', risk: 'write-confirm', need: toolNeeds.humanRequest, method: 'POST', path: '/schedules',
    body: (_args, o) => ({ prompt: o.prompt, name: o.name, every: o.every, cron: o.cron, at: o.at, mode: o.mode, until: o.until, deadline: o.deadline, ...(o.additional ? { additional: true } : {}) }),
    serverDryRun: true,
    description: 'Set up a schedule for the requester; it is created disabled and starts after they click 启用 on the card',
    examples: ["schedule create --every 15 --prompt '看看这个话题有没有排查结论'", "schedule create --cron '0 9 * * 1-5' --prompt '汇总昨天的告警' --name 晨报", "schedule create --at 2026-10-17T10:00 --prompt '提醒我看发布结果'"],
    help: '时间按北京时间；--every、--cron、--at 只选一个。--prompt 只写每次要做的事，不写频率。修改已有计划先用 schedules 查编号，再用 schedule update <编号>；启停用 schedule enable/disable <编号>。同事项已有生效循环计划时，确需再建才加 --additional。循环任务默认每次在新会话里执行；只有用户明确要求接着上次的对话做时才加 --mode session。用户要求一直跟进、直到某件事办完时，用 --until 写完成条件（有期限再加 --deadline），不要把停止条件只写进 --prompt。需要试跑就在本轮直接执行一次，不要建“测试任务”。不要用 crontab、后台 sleep 或循环脚本代替。',
    configure: command => command
      .option('--additional', '确需在本事项另建一个循环计划')
      .requiredOption('--prompt <text>', 'Complete instructions to execute each time')
      .option('--name <name>', '计划名称；修改已有计划请用 schedule update <编号>')
      .option('--every <minutes>', 'Fixed interval in whole minutes', integer(1, 525_600))
      .option('--cron <expression>', 'Five-field cron expression, Asia/Shanghai time')
      .option('--at <local-time>', 'Run once at YYYY-MM-DDTHH:mm, Asia/Shanghai time')
      .addOption(new Option('--mode <mode>', 'fresh (default for --every/--cron): run each time in a new conversation without this conversation\'s history; session (default for --at): run in this conversation with its history, only when the user asks to continue from the previous conversation').choices(['session', 'fresh']))
      .option('--until <condition>', '用户说「一直跟进直到…」时写完成条件；每次运行核对，达成后用 schedule stop-self 停用（仅循环计划）')
      .option('--deadline <local-time>', '到这个北京时间（YYYY-MM-DDTHH:mm）仍未确认完成就自动停用并告知') },
  { name: 'schedule.update', risk: 'write-confirm', need: toolNeeds.humanRequest, method: 'PATCH', path: '/schedules/:id',
    body: (_args, o) => ({ prompt: o.prompt, name: o.name, every: o.every, cron: o.cron, at: o.at, mode: o.mode, until: o.until, deadline: o.deadline }),
    serverDryRun: true,
    description: '修改已有计划并保留编号；更新后需用户确认启用',
    examples: ["schedule update <编号> --every 30", "schedule update <编号> --prompt '汇总新的内容'"],
    configure: command => command
      .argument('<id>', 'schedules 显示的计划编号')
      .option('--prompt <text>', '每次触发时执行的指令')
      .option('--name <name>', '计划名称')
      .option('--every <minutes>', '执行间隔，按整分钟填写', integer(1, 525_600))
      .option('--cron <expression>', '五段 Cron 表达式，按计划自身的时区（聊天里新建的计划是北京时间）')
      .option('--at <local-time>', '仅执行一次的时间，按计划自身的时区，格式 YYYY-MM-DDTHH:mm')
      .addOption(new Option('--mode <mode>', 'session 沿用会话；fresh 每次新会话').choices(['session', 'fresh']))
      .option('--until <condition>', '完成条件；每次运行核对，达成后用 schedule stop-self 停用')
      .option('--deadline <local-time>', '截止的北京时间 YYYY-MM-DDTHH:mm；到点仍未确认完成就自动停用') },
  { name: 'schedule.stop-self', risk: 'write', need: toolNeeds.scheduledRequest, method: 'POST', path: '/schedules/stop-self',
    body: () => ({}),
    description: 'Request disabling this scheduled task after its successful result is delivered',
    examples: ['schedule stop-self'] },
  { name: 'schedule.enable', ...action,
    body: ([scheduleId]) => ({ id: scheduleId }),
    description: 'Enable a schedule',
    examples: ['schedule enable <编号>'],
    configure: command => command.argument('<id>', 'Schedule id shown by schedules') },
  { name: 'schedule.disable', ...action,
    body: ([scheduleId]) => ({ id: scheduleId }),
    description: 'Disable a schedule',
    examples: ['schedule disable <编号>'],
    configure: command => command.argument('<id>', 'Schedule id shown by schedules') },
  { name: 'ci', ...view,
    description: 'List CI waits of this session; wait, fix or cancel with the subcommands',
    examples: ['ci', 'ci wait', 'ci cancel <编号>'] },
  { name: 'ci.wait', ...action,
    body: (_args, o) => ({ workflow: o.workflow }),
    description: 'Wait for the CI of the current commit and report back here',
    examples: ['ci wait', 'ci wait --workflow build.yml'],
    configure: command => command
      .option('--workflow <name>', 'Workflow file name or id') },
  { name: 'ci.fix', ...action,
    description: 'Wait for CI and hand failures to the Agent to fix, within limits',
    examples: ['ci fix'] },
  { name: 'ci.cancel', ...action,
    body: ([waitId]) => ({ id: waitId }),
    description: 'Cancel a CI wait',
    examples: ['ci cancel <编号>'],
    configure: command => command.argument('<id>', 'Wait id shown by ci') },
  { name: 'session.resume', ...action,
    body: (_args, o) => ({ id: o.id }),
    description: 'Restore a closed conversation in this topic; omit id for the latest',
    examples: ['session resume', 'session resume --id ses_编号'],
    configure: command => command.option('--id <id>', 'Closed conversation id in the same topic') },
  { name: 'session.fork', ...action,
    body: (_args, o) => ({ agent: o.agent, model: o.model, effort: o.effort, cwd: o.cwd, workspace: o.workspace, task: o.task }),
    description: 'Copy this conversation into a parallel topic; git repositories use a worktree by default',
    examples: ["session fork --task '检查另一种实现'", 'session fork'],
    configure: command => command
      .option('--task <text>', 'Task for the fork')
      .option('--agent <id>', 'Agent id from agents; changing Agent uses a handoff')
      .option('--model <model>', 'Model for the fork')
      .option('--effort <level>', 'Reasoning effort for the fork')
      .option('--cwd <path>', 'Absolute workspace path, or a workspace alias of this bot')
      .addOption(new Option('--workspace <mode>', 'Workspace mode').choices(['shared', 'worktree'])) },
  { name: 'session.new', ...action,
    body: (_args, o) => ({ agent: o.agent, model: o.model, effort: o.effort, cwd: o.cwd, workspace: o.workspace, handoff: o.handoff, note: o.note, task: o.task }),
    description: 'End this conversation and start a new one, optionally with another Agent, model or workspace',
    examples: ["session new --agent codex --task '修复登录页报错，改完跑测试'", "session new --handoff --note '接着查内存泄漏'", 'session new'],
    help: '新对话不带当前上下文：--task 要写全；要带上最近结果、git 状态和备注加 --handoff。--agent 填错时返回可用编号；指定 Agent、模型、工作目录或工作区时要同时给 --task 或 --handoff。不带参数只结束当前对话。',
    configure: command => command
      .option('--agent <id>', 'Agent id from agents')
      .option('--model <model>', 'Model for the new conversation')
      .option('--effort <level>', 'Reasoning effort for the new conversation')
      .option('--cwd <path>', 'Absolute workspace path, or a workspace alias of this bot')
      .addOption(new Option('--workspace <mode>', 'Workspace mode').choices(['shared', 'worktree']))
      .option('--handoff', 'Hand the recent results, git status and the note over to the new conversation')
      .option('--note <text>', 'Handoff note; only with --handoff')
      .option('--task <text>', 'Complete task for the first turn of the new conversation') },
  { name: 'retry', ...action,
    description: 'Run the latest failed, interrupted or cancelled request of this conversation again',
    examples: ['retry'] },
  { name: 'plan', ...action,
    body: (_args, o) => ({ task: o.task }),
    description: 'Have the Agent research and propose a plan first; it runs after the plan card is approved',
    examples: ["plan --task '把登录页的报错改成中文'"],
    configure: command => command
      .requiredOption('--task <text>', 'Task to plan') },
  { name: 'access.grant', ...action,
    body: (_args, o) => ({ members: o.member }),
    description: 'Open the bot to all group members, or add @-mentioned members to the list',
    examples: ['access grant --member 张三', 'access grant'],
    help: memberHelp,
    configure: command => command
      .option('--member <name>', 'Member @-mentioned in the user\'s message (repeatable)', collect) },
  { name: 'access.revoke', ...action,
    body: (_args, o) => ({ members: o.member }),
    description: 'Restrict the bot to its admins, or remove @-mentioned members from the list',
    examples: ['access revoke --member 张三', 'access revoke'],
    help: memberHelp,
    configure: command => command
      .option('--member <name>', 'Member @-mentioned in the user\'s message (repeatable)', collect) },
  { name: 'pr.open', ...action,
    body: (_args, o) => ({ title: o.title }),
    description: 'Push the changes of this conversation to a dutydeck/ branch and open a PR after the user confirms on the card',
    examples: ['pr open', "pr open --title '修复登录页报错'"],
    configure: command => command
      .option('--title <title>', 'PR title') },
  { name: 'repair', ...action,
    description: 'Fix the bot\'s Feishu app permissions, events and card callbacks after an admin confirms on the card',
    examples: ['repair'] },
  { name: 'settings.show', risk: 'read', need: toolNeeds.humanRequest, method: 'GET', path: '/settings',
    description: 'Show only common bot settings',
    examples: ['settings show'] },
  { name: 'settings.set', risk: 'write-confirm', need: toolNeeds.humanRequest, method: 'POST', path: '/settings',
    body: ([pairs]) => ({ pairs }),
    serverDryRun: true,
    usage: 'set <key=value...>',
    description: 'Propose bot settings; only a bot admin can confirm',
    examples: ['settings set defaultAgentId=codex', 'settings set notifyQuietHours=22:00-08:00 busyTriage=true'],
    help: 'Keys: defaultAgentId, defaultModel, defaultReasoningEffort, p2pMode, groupReplyMode, notifyQuietHours, notifyMentionAction, notifyMentionDone, busyTriage, botLoopGuard. Booleans: true/false; use an empty value to clear model, effort or quiet hours.' },
  { name: 'group.self', risk: 'read', need: toolNeeds.groupRead, method: 'GET', path: '/self',
    serve: (service, token) => service.self(token),
    description: 'Show the current bot and scoped chat',
    examples: ['group self'] },
  { name: 'group.peers', risk: 'read', need: toolNeeds.groupDiscover, method: 'GET', path: '/peers',
    serve: (service, token) => service.peers(token),
    description: 'Discover Agents of this Dutydeck instance in the group',
    examples: ['group peers'] },
  { name: 'group.members', risk: 'read', need: toolNeeds.groupDiscover, method: 'GET', path: '/members',
    serve: (service, token) => service.members(token),
    description: 'Discover human members in the group',
    examples: ['group members'] },
  { name: 'group.bots', risk: 'read', need: toolNeeds.groupDiscover, method: 'GET', path: '/bots',
    serve: (service, token) => service.bots(token),
    description: 'List all bots in the group (agentId means managed by this instance)',
    examples: ['group bots'] },
  { name: 'group.messages', risk: 'read', need: toolNeeds.groupRead, method: 'GET', path: '/messages',
    query: (_args, o) => ({ after: o.after, limit: o.limit, since: o.since, until: o.until, query: o.query }),
    serve: (service, token, { query }) => untrusted('lark:group-messages', service.messages(token, { after: query.after, limit: numberFrom(query.limit), since: query.since, until: query.until, query: query.query })),
    description: 'Read messages of this group or topic',
    examples: ['group messages --limit 20', "group messages --since 2026-10-01 --query '发布'"],
    configure: command => command
      .option('--after <cursor>', 'Only messages after a cursor returned by messages or wait')
      .option('--limit <count>', 'Maximum messages to return (1-50)', integer(1, 50), 20)
      .option('--since <time>', 'Messages created after this time (ISO 8601 or unix timestamp)')
      .option('--until <time>', 'Messages created before this time (ISO 8601 or unix timestamp)')
      .option('--query <query>', 'Messages containing all whitespace-separated keywords') },
  { name: 'group.message', risk: 'read', need: toolNeeds.groupRead, method: 'GET', path: '/message',
    query: ([messageId]) => ({ messageId }),
    serve: (service, token, { query }) => untrusted('lark:group-messages', service.message(token, { messageId: query.messageId ?? '' })),
    description: 'Fetch one message by id, expanding merge_forward content',
    examples: ['group message om_xxx'],
    configure: command => command.argument('<message-id>', 'om_* message id') },
  { name: 'group.team-search', risk: 'read', need: toolNeeds.groupRead, method: 'GET', path: '/team-search',
    query: ([text]) => ({ query: text }),
    serve: (service, token, { query }) => untrusted('lark:team-search', service.teamSearch(token, { query: query.query })),
    description: 'Search messages in other groups of this bot (needs group participation)',
    examples: ["group team-search '发布窗口'"],
    configure: command => command.argument('<query>', 'Keywords') },
  { name: 'group.wait', risk: 'read', need: toolNeeds.groupRead, method: 'GET', path: '/wait',
    query: (_args, o) => ({ after: o.after, limit: o.limit, timeoutMs: o.timeoutMs }),
    serve: (service, token, { query }) => untrusted('lark:group-messages', service.wait(token, { after: query.after, limit: numberFrom(query.limit), timeoutMs: numberFrom(query.timeoutMs) })),
    description: 'Wait briefly for new messages after a cursor',
    examples: ['group wait --after <cursor>'],
    configure: command => command
      .requiredOption('--after <cursor>', 'Cursor returned by messages or wait')
      .option('--limit <count>', 'Maximum messages to return (1-50)', integer(1, 50), 20)
      .option('--timeout-ms <milliseconds>', 'Long-poll timeout (0-30000)', integer(0, 30_000), 15_000) },
  { name: 'group.send', risk: 'write', need: toolNeeds.groupSend, method: 'POST', path: '/send',
    body: async ([content], o) => ({ content, final: o.final, delivery: o.delivery, ...(o.cardFile ? { cardBody: await jsonInput({ file: o.cardFile }) } : {}), to: o.to, replyTo: o.replyTo, inThread: o.inThread, idempotencyKey: o.idempotencyKey }),
    // This alias predates --final. An explicitly supplied turn also belongs in ordinary sends.
    legacyBody: ([content], o) => ({ content, cardBody: o.cardBody, delivery: o.delivery, final: o.final,
      turn: o.turn, to: o.to, replyTo: o.replyTo, inThread: o.inThread, idempotencyKey: o.idempotencyKey }),
    bodyTurn: o => !!o.final,
    serve: (service, token, { body }) => service.send(token, body ?? {}),
    description: 'Send a new message, or reply to a message or topic',
    examples: ["group send '发布窗口已开启'", "group send '我已定位问题' --reply-to om_xxx --in-thread", "group send '<完整答复>' --final"],
    configure: command => command
      .argument('<content>', 'Message content')
      .option('--final', 'Deliver the final answer of the current task (rarely needed)')
      .option('--card-file <path>', 'Static Card 2.0 body JSON file; requires --final and a searchable summary')
      .addOption(new Option('--delivery <mode>', 'Final result targets').choices(['publish', 'reply-agent', 'both']))
      .option('--to <target>', 'Mention a discovered Agent or member by id or name')
      .option('--reply-to <message-id>', 'Reply to an om_* message in this chat')
      .option('--in-thread', 'Put the reply in the topic; needs --reply-to')
      .option('--idempotency-key <key>', 'Stable retry key (up to 50 characters)') },
  { name: 'group.send-file', risk: 'write', need: toolNeeds.groupSend, method: 'POST', path: '/send-file',
    body: ([path], o) => ({ path, replyTo: o.replyTo, inThread: o.inThread, idempotencyKey: o.idempotencyKey, image: o.image }),
    serve: (service, token, { body }) => service.sendFile(token, body ?? {}),
    description: 'Send a file from the session workspace',
    examples: ['group send-file report.md', 'group send-file chart.png --image'],
    configure: command => command
      .argument('<path>', 'Path inside the session workspace')
      .option('--reply-to <message-id>', 'Reply to an om_* message in this chat')
      .option('--in-thread', 'Put the reply in the topic')
      .option('--idempotency-key <key>', 'Stable retry key')
      .option('--image', 'Send as an image (10 MiB limit)') },
  { name: 'group.handoff', risk: 'write', need: toolNeeds.groupSend, method: 'POST', path: '/handoff',
    body: ([to, content]) => ({ to, content }),
    bodyTurn: () => true,
    serve: (service, token, { body }) => service.handoff(token, body ?? {}),
    description: 'Hand one task to another bot in this group and topic',
    examples: ["group handoff <机器人> '<目标、代码版本、工作区、读写边界和验收>'"],
    configure: command => command
      .argument('<target>', 'Target bot name, appId or openId').argument('<content>', 'Task brief and acceptance criteria') },
  { name: 'group.reply-agent', risk: 'write', need: toolNeeds.groupSend, method: 'POST', path: '/reply-agent',
    body: ([content]) => ({ content }),
    bodyTurn: () => true,
    serve: (service, token, { body }) => service.replyAgent(token, body ?? {}),
    description: 'Return the result to the bot that handed the task over',
    examples: ["group reply-agent '<交付结果>'"],
    configure: command => command.argument('<content>', 'Result') },
  { name: 'history.list', risk: 'read', need: toolNeeds.groupRead, method: 'GET', path: '/history',
    query: (_args, o) => ({ since: o.since, until: o.until, query: o.query, limit: o.limit }),
    serve: (service, token, { query }) => untrusted('dutydeck:task-history', service.history(token, { limit: numberFrom(query.limit), since: query.since, until: query.until, query: query.query })),
    description: 'List earlier tasks, newest first',
    examples: ["history list --query '部署方案'"],
    configure: command => command
      .option('--since <time>', 'Tasks created after this time').option('--until <time>', 'Tasks created before this time')
      .option('--query <query>', 'Tasks whose request or answer contains all keywords')
      .option('--limit <count>', 'Maximum tasks (1-50)', integer(1, 50), 20) },
  { name: 'history.show', risk: 'read', need: toolNeeds.groupRead, method: 'GET', path: '/history/:taskId',
    query: (_args, o) => ({ field: o.field, offset: o.offset, length: o.length, cursor: o.cursor }),
    serve: (service, token, { params, query }) => untrusted('dutydeck:task-history', service.historyTask(token, {
      taskId: params.taskId, ...(query.field !== undefined ? { field: query.field } : {}),
      ...(query.offset !== undefined ? { offset: integerFrom(query.offset) } : {}),
      ...(query.length !== undefined ? { length: integerFrom(query.length) } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {})
    })),
    description: 'Show the request and final answer of an earlier task',
    examples: ['history show <taskId>', 'history show <taskId> --field answer --offset 0'],
    configure: command => command
      .argument('<task-id>', 'Task id from history list')
      .addOption(new Option('--field <field>', 'Read the saved request or answer verbatim').choices(['request', 'answer']))
      .option('--offset <units>', 'UTF-16 offset', integer(0))
      .option('--length <units>', 'Page length in UTF-16 units (1-8000)', integer(1, 8_000))
      .option('--cursor <cursor>', 'Continue a page; exclusive with field/offset/length') },
  { name: 'memory.list', risk: 'read', need: toolNeeds.memory, method: 'GET', path: '/memory',
    query: (_args, o) => ({ topic: o.topic }),
    description: 'List memories with their ids',
    examples: ['memory list'],
    configure: command => command.option('--topic <slug>', 'Topic slug') },
  { name: 'memory.show', risk: 'read', need: toolNeeds.memory, method: 'GET', path: '/memory/topics/:topic',
    description: 'Show the memories of a topic',
    examples: ['memory show general'],
    configure: command => command.argument('<topic>', 'Topic slug') },
  { name: 'memory.search', risk: 'read', need: toolNeeds.memory, method: 'GET', path: '/memory/search',
    query: ([text], o) => ({ q: text, topic: o.topic, limit: o.limit }),
    description: 'Search memories by keyword',
    examples: ["memory search '测试命令'"],
    configure: command => command.argument('<query>', 'Keyword')
      .option('--topic <slug>', 'Topic slug').option('--limit <count>', 'Maximum entries (1-50)', integer(1, 50)) },
  { name: 'memory.add', risk: 'write', need: toolNeeds.memory, method: 'POST', path: '/memory',
    body: ([content], o) => ({ content, topic: o.topic }),
    description: 'Save one fact the user explicitly asked to remember',
    examples: ["memory add '项目用 pnpm，测试命令是 pnpm test'"],
    configure: command => command
      .argument('<content>', 'One sentence (at most 1000 characters)').option('--topic <slug>', 'Topic slug (defaults to general)') },
  { name: 'memory.remove', risk: 'write', need: toolNeeds.memory, method: 'DELETE', path: '/memory/:id',
    description: 'Delete a memory the user asked to forget',
    examples: ['memory remove mem_xxx'],
    configure: command => command.argument('<id>', 'Memory id (mem_*)') },
  { name: 'work.list', risk: 'read', need: toolNeeds.work, method: 'GET', path: '/work-items',
    description: 'List goals and templates of this topic',
    examples: ['work list'] },
  { name: 'work.templates', handlerName: 'work.list', risk: 'read', need: toolNeeds.work, method: 'GET', path: '/work-items',
    description: 'List reusable templates',
    examples: ['work templates'] },
  { name: 'work.agents', risk: 'read', need: toolNeeds.work, method: 'GET', path: '/work-items/agents',
    description: 'List Agent ids steps can use',
    examples: ['work agents'] },
  { name: 'work.skills', risk: 'read', need: toolNeeds.work, method: 'GET', path: '/work-items/skills',
    description: 'List Skills of the workspace',
    examples: ['work skills'] },
  { name: 'work.show', risk: 'read', need: toolNeeds.work, method: 'GET', path: '/work-items/:id',
    description: 'Show a goal',
    examples: ['work show <目标编号>'],
    configure: command => command.argument('<id>', 'Goal id') },
  { name: 'work.create', risk: 'write', need: toolNeeds.work, method: 'POST', path: '/work-items',
    body: workPlan,
    description: 'Accept a goal plan; may wait for the user to click 开始执行 depending on settings',
    examples: ['work create --file plan.json'],
    configure: command => command
      .requiredOption('--file <path>', 'JSON plan with goal and a stable idempotencyKey') },
  { name: 'work.delegate', risk: 'write', need: toolNeeds.work, method: 'POST', path: '/work-items/delegations',
    body: workPlan,
    description: 'Hand a brief to the Leader (layered mode)',
    examples: ['work delegate --file "${TMPDIR:-/tmp}/dutydeck-brief-<key>.json"'],
    configure: command => command
      .requiredOption('--file <path>', 'JSON brief with goal, context and a stable idempotencyKey') },
  { name: 'work.revise', risk: 'write', need: toolNeeds.work, method: 'POST', path: '/work-items/:id/revise',
    body: workPlan,
    serverDryRun: true,
    description: 'Revise the plan of an unfinished goal; --dry-run previews the impact',
    examples: ['work revise <目标编号> --file revision.json --dry-run', 'work revise <目标编号> --file revision.json'],
    configure: command => command
      .argument('<id>', 'Goal id').requiredOption('--file <path>', 'JSON with expectedRevision, the complete new plan and an optional reason') },
  { name: 'work.save', risk: 'write', need: toolNeeds.work, method: 'POST', path: '/work-items/:id/template',
    body: ([, name]) => ({ name }),
    description: 'Save a goal as an immutable template version',
    examples: ['work save <目标编号> <流程名称>'],
    configure: command => command.argument('<id>', 'Goal id').argument('<name>', 'Template name') },
  { name: 'work.run', risk: 'write', need: toolNeeds.work, method: 'POST', path: '/work-items/templates/:id/run',
    body: ([, version, goal], o) => ({ version, goal, idempotencyKey: o.key }),
    description: 'Run a template version for a new goal',
    examples: ['work run <模板编号> 1 <新目标> --key <稳定请求键>'],
    configure: command => command
      .argument('<template>', 'Template id').argument('<version>', 'Template version', integer(1)).argument('<goal>', 'New goal')
      .requiredOption('--key <key>', 'Stable request key for this run') },
  { name: 'collaborate.status', risk: 'read', need: toolNeeds.collaboration, method: 'GET', path: '/collaboration',
    description: 'Read follow-ups, mandates, progress and revisions of this group',
    examples: ['collaborate status'] },
  { name: 'collaborate.followup-create', risk: 'write', need: toolNeeds.collaboration, method: 'POST', path: '/collaboration/followups',
    body: collaborationCreate,
    description: 'Record a follow-up',
    examples: [`collaborate followup-create --json '{"id":"本轮稳定请求键","goal":"跟进目标"}'`],
    configure: command => jsonOptions(command) },
  { name: 'collaborate.followup-update', risk: 'write', need: toolNeeds.collaboration, method: 'PATCH', path: '/collaboration/followups/:id',
    body: collaborationInput,
    description: 'Update a follow-up',
    examples: [`collaborate followup-update <编号> --json '{"expectedRevision":1,"progress":"新进展"}'`],
    configure: command => jsonOptions(command).argument('<id>', 'Follow-up id') },
  { name: 'collaborate.mandate-create', risk: 'write-confirm', need: toolNeeds.collaboration, method: 'POST', path: '/collaboration/mandates',
    body: collaborationCreate,
    description: 'Propose an ongoing mandate; it is created after the user confirms on the card',
    examples: ['collaborate mandate-create --file mandate.json'],
    configure: command => jsonOptions(command) },
  { name: 'collaborate.mandate-update', risk: 'write-confirm', need: toolNeeds.collaboration, method: 'PATCH', path: '/collaboration/mandates/:id',
    body: collaborationInput,
    description: 'Change, pause or cancel a mandate; pausing or cancelling applies at once, other changes after the user confirms on the card',
    examples: [`collaborate mandate-update <编号> --json '{"expectedRevision":1,"status":"paused"}'`],
    configure: command => jsonOptions(command).argument('<id>', 'Mandate id') },
  { name: 'collaborate.feedback', risk: 'write', need: toolNeeds.collaboration, method: 'POST', path: '/collaboration/decisions/:id/feedback',
    body: collaborationInput,
    description: 'Record a correction to a decision',
    examples: [`collaborate feedback <决策编号> --json '{"correction":"用户修订"}'`],
    configure: command => jsonOptions(command).argument('<id>', 'Decision id') },
];

export const toolsByName = new Map(toolTable.map(tool => [tool.name, tool]));
export function getTool(name: string) {
  const tool = toolsByName.get(name);
  if (!tool) throw new Error('Unknown Agent tool: ' + name);
  return tool;
}

// Existing HTTP operations with a separate legacy or plugin CLI, or no CLI.
export const otherEndpoints = {
  riskStatus: { method: 'GET', path: '/risk/status', need: toolNeeds.humanRequest },
  command: { method: 'POST', path: '/commands', need: toolNeeds.humanRequest },
  collaborationSettings: { method: 'PATCH', path: '/collaboration/settings', need: toolNeeds.collaboration },
  collaborationReplay: { method: 'POST', path: '/collaboration/replay', need: toolNeeds.collaboration },
  collaborationBootstrap: { method: 'POST', path: '/collaboration/bootstrap', need: toolNeeds.collaboration },
  pluginList: { method: 'GET', path: '/plugin-tools', need: toolNeeds.pluginResult },
  pluginCall: { method: 'POST', path: '/plugin-tools/:plugin/:tool', need: toolNeeds.pluginResult }
} as const satisfies Record<string, Endpoint>;
