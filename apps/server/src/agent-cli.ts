/**
 * dutydeck agent：飞书会话里的 Agent 能用的全部操作，统一入口、统一输出。
 * - 帮助（--help）不需要服务或凭证；开头是写给 Agent 的快速说明，每个子命令的帮助有一行 Risk 和例子。
 * - stdout 只输出一个 JSON：成功 {"ok":true,"data":...}，失败 {"ok":false,"error":{code,message,hint?,params?}}，退出码非 0。
 * - 沿用本轮完整的 agent --turn 命令前缀，凭证绑定当前任务尝试。写入命令都支持 --dry-run。
 * 请求都发到本机服务的 /api/lark/agent-tools/*；查看类与写入类的处理见 agent-request-tools.ts。
 */
import { Command, CommanderError } from 'commander';
import { AgentGroupToolCliError, AgentGroupToolHttpClient } from './agent-host/http-client.js';
import { AgentCliError, toolRequest, toolGroups, toolTable, toolsByName, type Risk, type Options } from './agent-host/tool-table.js';
export { AgentCliError };

export type AgentCliRunner = (operation: string, args: unknown[], options: Options) => void | Promise<void>;
export interface AgentCliClientOptions { env?: NodeJS.ProcessEnv; fetcher?: typeof globalThis.fetch }

const riskLabels: Record<Risk, string> = {
  read: 'read（只读：直接返回数据）',
  'write-confirm': 'write-confirm（写入·需确认：发确认卡，用户点了才生效）',
  write: 'write（写入·直接生效）'
};

export const agentQuickstart = `QUICKSTART（给 Agent）
  dutydeck agent 提供下列飞书会话操作。先读这里，再用 dutydeck agent <命令> --help 看参数、风险和例子；帮助不需要服务或凭证。
  例子里的 dutydeck agent 指本轮提示给出的完整 Agent 命令前缀，原样使用，不要换成 PATH 里的 dutydeck。所有操作沿用本轮 agent --turn 命令前缀，凭证绑定当前任务尝试。

风险分级（每个命令的 --help 都有一行 Risk）
  read           只读：直接返回数据，不发卡、不改东西。
  write-confirm  写入·需确认：在本轮请求消息下发确认卡，用户点了才生效。返回 pendingConfirmation:true 时只回一句“已发确认卡，点确认后生效”，不要说已完成；若 confirmationDelivery:failed，按返回的 message 说明已保存但发卡失败，并给用户恢复办法。
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
  dutydeck agent risk request --summary '<目的和原因>' --command '<原命令>'  私聊请管理员批准本次请求
  dutydeck agent status                                        本会话的 Agent、模型、工作区、运行状态和排队
  dutydeck agent session resume [--id <编号>]  恢复本话题最近关闭的会话（先发确认卡）
  dutydeck agent session fork [--task '<任务>']  带上下文在新话题开分身（先发确认卡）
  dutydeck agent session new --agent <编号> --task '<完整任务>'  换 Agent 重新做（先发确认卡；编号用 agents 查）
  dutydeck agent group messages --limit 20                     读本群或本话题最近的消息
  dutydeck agent history list --query '<关键词>'                查本聊天以前的任务和结论
`;

/** 执行一条 dutydeck agent 命令，返回服务给的数据；--dry-run 时写入类只预览。 */
export async function runAgentOperation(operation: string, args: unknown[], options: Options, client: AgentCliClientOptions = {}): Promise<unknown> {
  const spec = toolsByName.get(operation);
  if (!spec) throw new AgentCliError('UNKNOWN_COMMAND', `没有 ${operation} 这个命令。`, [{ name: '<命令>', reason: '没有这个命令' }], '运行 dutydeck agent --help 看全部命令。');
  const request = await toolRequest(spec, args, options);
  if (options.dryRun && spec.risk !== 'read' && !spec.serverDryRun) {
    return { dryRun: true, risk: spec.risk, request, needsConfirmation: spec.risk === 'write-confirm',
      effect: spec.risk === 'write-confirm' ? '执行后宿主在原话题发确认卡，用户点确认后才生效。' : '去掉 --dry-run 执行后立即生效。' };
  }
  const http = new AgentGroupToolHttpClient(client);
  if (!options.turn) throw new AgentCliError('AGENT_TURN_REQUIRED', '请使用本轮提供的完整 agent --turn 命令前缀。', [{ name: '--turn', reason: '需要本轮任务尝试凭证' }]);
  let body = options.dryRun && spec.serverDryRun ? { ...request.body, dryRun: true } : request.body;
  if (spec.bodyTurn?.(options)) body = { ...body, turn: options.turn };
  return http.request(request.path, { method: request.method, headers: { 'x-dutydeck-work-turn': options.turn }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
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

/** 挂到 dutydeck 命令树上；run 收到操作名（如 session.new）、位置参数和选项。 */
export function addAgentCommands(program: Command, run: AgentCliRunner) {
  const agent = program.command('agent')
    .option('--turn <token>', 'Immutable task attempt capability supplied in the current prompt')
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
  const parents = new Map<string, Command>();
  for (const tool of toolTable) {
    const [family = tool.name, leaf] = tool.name.split('.');
    let parent = agent;
    if (leaf) {
      parent = parents.get(family) ?? group(agent, family, ...(toolGroups[family] ?? ['']));
      parents.set(family, parent);
    }
    const { description, risk, examples, help } = tool;
    const spec = tool.usage ?? leaf ?? family;
    const command = parent.command(spec).description(description);
    usage(command, pathOf(command));
    if (risk !== 'read') command.option('--dry-run', 'Preview only: what would happen, whether it needs confirmation and what the card says');
    command.addHelpText('after', `\nRisk: ${riskLabels[risk]}\n\nExamples:\n${examples.map(example => `  $ dutydeck agent ${example}`).join('\n')}${help ? `\n\n${help}` : ''}`);
    command.action((...values: unknown[]) => {
      const self = values.at(-1) as Command;
      return run(tool.name, self.processedArgs, { ...self.opts(), turn: agent.opts().turn });
    });
    tool.configure?.(command);
    parents.set(tool.name, command);
  }
  return agent;
}
