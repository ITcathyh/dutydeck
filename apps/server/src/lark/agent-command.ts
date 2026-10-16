/**
 * Agent 代用户执行飞书命令：用户说人话，Agent 用 `dutydeck agent` 的对应命令（旧入口 `dutydeck command '/…'`）代办，用户不用记命令。
 * 查看类以这一轮发起人的身份立即执行，旧入口把结果卡发在请求消息下，dutydeck agent 把结果交回给 Agent；会改东西的先发确认卡，点「确认」的人以自己的身份执行，带出的新一轮挂在确认卡下。
 * 两种都和在原话题里自己发这条命令走同一条路：授权、白名单、回执都不变（见 coordinator-inbound 的 agentCommand）。
 */
import { z } from 'zod';
import { RuntimeError } from '@dutydeck/shared';
import { larkCommandRegistry, parseSlashCommand, resolveLarkCommand, type ParsedSlashCommand } from './commands.js';

/** 只能由用户自己做的：停止和插话针对 Agent 正在跑的这一轮，批准和回答是用户对 Agent 的答复；记忆另有 dutydeck memory。 */
const userOnly: Record<string, string> = {
  cancel: '停止当前任务要用户点进度卡上的「中断」，或直接说“停”。',
  steer: '插话要用户在你执行时直接发消息。',
  approve: '批准工具调用要用户在审批卡上点按钮，或回复“可以”。',
  reject: '拒绝工具调用要用户在审批卡上点按钮。',
  answer: '你的提问要用户在话题里直接回复。',
  remember: '记忆用 dutydeck memory add。',
  memory: '记忆用 dutydeck memory list/search。',
  forget: '记忆用 dutydeck memory remove。'
};
/** 自己会先发确认卡的命令，不再加一道确认。 */
const confirmsItself = new Set(['pr', 'repair']);
/** 不带参数时只是查看。 */
const viewWithoutArgs = new Set(['work', 'schedule', 'ci', 'queue']);

/** 代发命令确认卡的种类（confirm-cards.ts）：每个机器人一种，处理器由它的消息处理器登记。 */
export const larkAgentCommandKind = (appId: string) => `agent_command.${appId}`;

/** dutydeck agent 的查看类命令：和用户在原话题发对应的 / 命令同一条路，结果交回给 Agent，不发卡。 */
export const larkAgentViews = ['status', 'agents', 'tasks', 'queue', 'schedules', 'ci'] as const;
export type LarkAgentViewName = typeof larkAgentViews[number];

/** action 是 dutydeck agent 的写入命令名（见 agentActionCommand）；带了它的请求失败要报错给 Agent，dryRun 只预览。 */
export interface LarkAgentCommandRequest { sessionId: string; taskId: string; actorId: string; command: string; action?: string; dryRun?: boolean; members?: string[] }
export type LarkAgentCommandHandler = (request: LarkAgentCommandRequest) => Promise<Record<string, unknown>>;
export interface LarkAgentViewRequest { sessionId: string; taskId: string; actorId: string; view: LarkAgentViewName; page?: number }
export type LarkAgentViewHandler = (request: LarkAgentViewRequest) => Promise<Record<string, unknown>>;

/** 各机器人的消息处理器在监听启动时登记；Agent 工具按会话所属的机器人转过去。 */
export class LarkAgentCommands {
  private readonly handlers = new Map<string, { run: LarkAgentCommandHandler; view?: LarkAgentViewHandler }>();
  set(appId: string, handler: LarkAgentCommandHandler, view?: LarkAgentViewHandler) { this.handlers.set(appId, { run: handler, ...(view ? { view } : {}) }); }
  delete(appId: string, handler: LarkAgentCommandHandler) { if (this.handlers.get(appId)?.run === handler) this.handlers.delete(appId); }
  has(appId: string) { return this.handlers.has(appId); }
  run(appId: string, request: LarkAgentCommandRequest) {
    const handler = this.handlers.get(appId)?.run;
    if (!handler) throw new RuntimeError('AGENT_COMMAND_UNAVAILABLE', '这个机器人的飞书监听没有在运行，现在不能代办命令。', 503);
    return handler(request);
  }
  view(appId: string, request: LarkAgentViewRequest) {
    const handler = this.handlers.get(appId)?.view;
    if (!handler) throw new RuntimeError('AGENT_COMMAND_UNAVAILABLE', '这个机器人的飞书监听没有在运行，现在不能代办命令。', 503);
    return handler(request);
  }
}

export interface AgentParamIssue { name: string; reason: string }
/** 参数不对：指出是哪个参数、为什么；能给可选值时写在 reason 里。 */
export class AgentCommandParamError extends RuntimeError {
  constructor(code: string, message: string, readonly params: AgentParamIssue[], readonly hint?: string) { super(code, message, 400); this.name = 'AgentCommandParamError'; }
  response() { return { error: { code: this.code, message: this.message, params: this.params, ...(this.hint ? { hint: this.hint } : {}) } }; }
}
const paramError = (name: string, reason: string, hint?: string) => new AgentCommandParamError('INVALID_ARGUMENT', `${name}：${reason}`, [{ name, reason }], hint);

/** 校验 Agent 给的命令；confirm 表示要先发确认卡。 */
export function agentCommandPlan(command: string): { parsed: ParsedSlashCommand; summary: string; confirm: boolean } {
  const parsed = parseSlashCommand(command);
  const definition = parsed && resolveLarkCommand(parsed);
  if (!parsed || !definition) throw new RuntimeError('AGENT_COMMAND_UNKNOWN', `不是 Dutydeck 命令：${command.trim().slice(0, 80)}。可用命令见 dutydeck command --help。`, 400);
  const reason = userOnly[definition.name];
  if (reason) throw new RuntimeError('AGENT_COMMAND_USER_ONLY', reason, 400);
  if (definition.name === 'schedule' && parsed.args[0] === 'every') throw new RuntimeError('AGENT_COMMAND_UNSUPPORTED', '新建定时任务用 dutydeck schedule request。', 400);
  return { parsed, summary: definition.summary, confirm: definition.mutating && !confirmsItself.has(definition.name) && !(viewWithoutArgs.has(definition.name) && !parsed.args.length) };
}

/** 确认卡正文：命令说明加原样命令，dry-run 预览和真发的卡用同一份。 */
export const agentCommandConfirmSummary = (summary: string, command: string) => `${summary}\n\n\`${command.replace(/`/g, "'").slice(0, 300)}\``;

/** dutydeck command --help 列出的命令：和飞书里的 / 命令同一份注册表，去掉只能由用户自己做的。 */
export const agentCommandHelp = () => larkCommandRegistry.filter(definition => !userOnly[definition.name])
  .map(definition => `  ${definition.name === 'schedule' ? '/schedule；/schedule enable 编号；/schedule disable 编号（新建用 dutydeck schedule request）' : definition.usage}\n      ${definition.summary}`).join('\n');

const text = () => z.string({ required_error: '必填', invalid_type_error: '要是文字' }).trim().min(1, '不能为空');
const word = text().regex(/^\S+$/, '不能含空白');
const index = z.number({ required_error: '必填', invalid_type_error: '要是整数' }).int('要是整数').min(1, '从 1 开始');
const workspace = z.enum(['shared', 'worktree'], { errorMap: () => ({ message: '只能是 shared 或 worktree' }) });

/**
 * dutydeck agent 写入命令的参数 → 与用户自己发的 / 命令相同的那一条，之后走 agentCommand 同一条路（确认卡、点击人身份执行、重启回执、权限都不变）。
 * 参数名是命令行上的写法，报错时原样指给 Agent。
 */
const actions = {
  'session.new': z.object({ agent: word.optional(), model: word.optional(), effort: word.optional(), cwd: text().optional(), workspace: workspace.optional(),
    handoff: z.boolean().optional(), note: text().optional(), task: text().optional() }).strict(),
  retry: z.object({}).strict(),
  plan: z.object({ task: text() }).strict(),
  'schedule.enable': z.object({ id: word }).strict(),
  'schedule.disable': z.object({ id: word }).strict(),
  'queue.cancel': z.object({ index }).strict(),
  'queue.top': z.object({ index }).strict(),
  'access.grant': z.object({ members: z.array(text()).optional() }).strict(),
  'access.revoke': z.object({ members: z.array(text()).optional() }).strict(),
  'pr.open': z.object({ title: text().optional() }).strict(),
  'ci.wait': z.object({ workflow: word.optional() }).strict(),
  'ci.fix': z.object({}).strict(),
  'ci.cancel': z.object({ id: word }).strict(),
  repair: z.object({}).strict()
};
export type AgentActionName = keyof typeof actions;
export const agentActionNames = Object.keys(actions) as AgentActionName[];

const positional: Record<string, string> = { id: '<编号>', index: '<编号>', members: '--member' };
const paramName = (key: string) => positional[key] ?? `--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;

/** 把 zod 的错误换成按命令行参数名列出的 params。 */
export function agentParamIssues(error: z.ZodError, name: (key: string) => string = paramName): AgentParamIssue[] {
  return error.issues.flatMap(issue => issue.code === 'unrecognized_keys'
    ? issue.keys.map(key => ({ name: name(key), reason: '不支持这个参数' }))
    : [{ name: issue.path.length ? name(String(issue.path[0])) : '(参数组合)', reason: issue.message }]);
}

/** 值里有空白时加引号，和用户在飞书里写 /new --cwd "带空格的路径" 一样。 */
const quoted = (name: string, value: string) => {
  if (!/[\s"']/.test(value)) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw paramError(name, '不能同时含单引号和双引号');
};

export function agentActionCommand(action: string, input: unknown): { command: string; members?: string[] } {
  if (!Object.hasOwn(actions, action)) throw new AgentCommandParamError('AGENT_ACTION_UNKNOWN', `没有 ${action} 这个操作。`, [{ name: '<命令>', reason: `可用：${agentActionNames.join('、')}` }], '运行 dutydeck agent --help 看全部命令。');
  const parsed = actions[action as AgentActionName].safeParse(input ?? {});
  if (!parsed.success) {
    const params = agentParamIssues(parsed.error);
    throw new AgentCommandParamError('INVALID_ARGUMENT', params.map(param => `${param.name}：${param.reason}`).join('；'), params, `运行 dutydeck agent ${action.replace('.', ' ')} --help 看用法。`);
  }
  const p = parsed.data as Record<string, any>;
  switch (action as AgentActionName) {
    case 'session.new': {
      const flags = (['agent', 'cwd', 'workspace', 'model', 'effort'] as const).filter(key => p[key] !== undefined)
        .map(key => `--${key} ${quoted(`--${key}`, p[key])}`);
      if (p.note !== undefined && !p.handoff) throw paramError('--note', '只能和 --handoff 一起用');
      if (p.note !== undefined && /(^|\s)--(\s|$)|^--/.test(p.note)) throw paramError('--note', '不能以 -- 开头，也不能含单独的 --');
      if (p.handoff) return { command: ['/new', ...flags, '--handoff', ...(p.note ? [p.note] : []), ...(p.task ? ['--', p.task] : [])].join(' ') };
      if (flags.length && !p.task) throw paramError('--task', '指定了 Agent、模型、工作目录或工作区时要同时给 --task（新对话的完整任务），或加 --handoff');
      return { command: p.task ? `/new ${[...flags, '--', p.task].join(' ')}` : '/new' };
    }
    case 'retry': return { command: '/retry' };
    case 'plan': return { command: `/plan ${p.task}` };
    case 'schedule.enable': return { command: `/schedule enable ${p.id}` };
    case 'schedule.disable': return { command: `/schedule disable ${p.id}` };
    case 'queue.cancel': return { command: `/queue cancel ${p.index}` };
    case 'queue.top': return { command: `/queue top ${p.index}` };
    case 'access.grant':
    case 'access.revoke': {
      const members = (p.members ?? []).map((name: string) => name.replace(/^@/, '').trim());
      // 给了 --member 却是空名字时不能退化成对全群生效的 /grant、/revoke。
      if (p.members && (!members.length || members.some((name: string) => !name))) throw paramError('--member', '要填用户这条消息里 @ 过的人的名字，不能为空');
      return { command: [action === 'access.grant' ? '/grant' : '/revoke', ...members.map((name: string) => `@${name}`)].join(' '), members };
    }
    case 'pr.open': return { command: p.title ? `/pr ${p.title}` : '/pr' };
    case 'ci.wait': return { command: p.workflow ? `/ci wait ${p.workflow}` : '/ci wait' };
    case 'ci.fix': return { command: '/ci fix' };
    case 'ci.cancel': return { command: `/ci cancel ${p.id}` };
    case 'repair': return { command: '/repair' };
  }
}
