#!/usr/bin/env node
/**
 * nl-control-eval 专用 dutydeck 桩：不连任何服务、没有副作用。
 *
 * - `dutydeck agent --help` / `dutydeck agent <子命令> --help`：用评测包（nl-control-eval.mjs 启动时打包）
 *   里线上同一份 addAgentCommands 渲染真实帮助。
 * - 其他 `dutydeck agent ...`：把 argv、解析出的 operation/args/options 追加到环境变量
 *   NL_EVAL_LOG 指定的 JSONL，然后打印一个合理的模拟 JSON（只读给示例数据，写入给确认卡/成功）。
 * - 非 agent 调用同样记录，返回错误 JSON（防止 Agent 走宿主命令）。
 *
 * 由 scripts/nl-control-eval.mjs 放进临时 PATH 最前面，不由人直接调用。
 */
import { appendFileSync } from 'node:fs';
import { addAgentCommands, agentCliErrorBody, AgentCliError, Command, CommanderError } from '../apps/server/node_modules/.cache/nl-eval/nl-eval.mjs';

const logFile = process.env.NL_EVAL_LOG;
const record = (entry) => { if (logFile) appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`); };

const program = new Command();
program.name('dutydeck').exitOverride();
addAgentCommands(program, (operation, args, options) => writeResult(operation, args, options));
const agentCommand = program.commands.find(command => command.name() === 'agent');
/** 风险分级取自线上命令树：操作名就是命令路径，只读命令没有 --dry-run（addAgentCommands 只给写操作加）。 */
const riskOf = (operation) => {
  const command = operation.split('.').reduce((parent, name) => parent?.commands.find(child => child.name() === name), agentCommand);
  return command && !command.options.some(option => option.long === '--dry-run') ? 'read' : 'write';
};

const sampleAgents = [
  { id: 'codex', name: 'Codex', model: 'gpt-5', running: 0, queued: 0 },
  { id: 'claude', name: 'Claude Code', model: 'claude-opus-5-5', running: 1, queued: 0 },
  { id: 'traex', name: 'TraeX', model: 'trae-agent', running: 0, queued: 0 }
];

function sampleData(operation) {
  switch (operation) {
    case 'status':
      return { sessionId: 'ses_eval', agent: 'codex', model: 'gpt-5', cwd: '/tmp/eval-workspace', state: 'running', running: 1, queued: 0 };
    case 'agents':
      return { agents: sampleAgents };
    case 'tasks':
      return { tasks: [{ id: 'task-eval', state: 'running', request: '当前正在做的事', createdAt: '2026-10-17T10:00:00+08:00' }] };
    case 'queue':
      // 给两条排队项，让 queue cancel 2 / queue top 1 / “队列里那个”这类说法有真实指代。
      return { queue: [
        { index: 1, state: 'queued', request: '修复登录页白屏报错', createdAt: '2026-10-17T10:05:00+08:00' },
        { index: 2, state: 'queued', request: '把报错文案改成中文', createdAt: '2026-10-17T10:06:00+08:00' }
      ] };
    case 'schedules':
      return { schedules: [{ id: 'sch_1', name: '晨报', cron: '0 9 * * 1-5', enabled: true, prompt: '汇总昨天的告警' }] };
    case 'ci':
      // 不给已有等待：否则「等 CI 跑完告诉我」时 Agent 看到已在跟踪、不再建等待也是对的。
      return { waits: [] };
    default:
      // group.*/history.*/memory.*/work.*/collaborate.status：空列表/空对象即合理的只读结果。
      return { items: [], messages: [], members: [], peers: [], bots: [], memories: [], goals: [] };
  }
}

function writeResult(operation, args, options) {
  const risk = riskOf(operation);
  record({ kind: 'call', argv: process.argv.slice(2), operation, args, options, risk });
  if (risk === 'read') {
    process.stdout.write(`${JSON.stringify({ ok: true, data: sampleData(operation) })}\n`);
    return;
  }
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: { dryRun: true, operation, needsConfirmation: true, effect: '执行后宿主在原话题发确认卡，用户点确认后才生效。' } })}\n`);
    return;
  }
  const data = operation === 'schedule.create'
    ? { pendingConfirmation: true, scheduleId: 'sch_new', message: '已发确认卡，用户点「启用」后才开始。只回一句已发卡，不要说已设置。' }
    : { pendingConfirmation: true, message: '已发确认卡，用户在卡上确认后才执行。只回一句已发确认卡，不要说已完成，也不要让用户发命令。' };
  // 直接生效的写操作（group send、memory add 等）不发确认卡。
  const immediate = new Set(['group.send', 'group.send-file', 'group.handoff', 'group.reply-agent', 'memory.add', 'memory.remove']);
  process.stdout.write(`${JSON.stringify({ ok: true, data: immediate.has(operation) ? { done: true } : data })}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'agent') {
    record({ kind: 'non-agent', argv });
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'AGENT_COMMAND_UNKNOWN', message: '评测桩只支持 dutydeck agent 子命令；可用操作见 dutydeck agent --help。' } })}\n`);
    process.exitCode = 1;
    return;
  }
  await program.parseAsync(argv, { from: 'user' });
}

main().catch(error => {
  const argv = process.argv.slice(2);
  // 读帮助（commander.help*，退出码 0）是正常行为，不记 operation；真实用法错误才从 argv
  // 推断 operation（dutydeck agent a b → a.b），让打分器把「尝试了但命令不对」记成做错。
  const isHelp = error instanceof CommanderError && error.code.startsWith('commander.help');
  let operation;
  if (!isHelp && argv[0] === 'agent') {
    const segments = argv.slice(1).filter(part => !part.startsWith('-') && !part.includes('='));
    const groups = new Set(['session', 'schedule', 'queue', 'ci', 'access', 'pr', 'group', 'history', 'memory', 'work', 'collaborate']);
    if (segments.length === 1) operation = segments[0];
    else if (segments.length >= 2) operation = groups.has(segments[0]) ? `${segments[0]}.${segments[1]}` : segments[0];
  }
  record({ kind: isHelp ? 'help' : 'error', argv, ...(operation ? { operation, risk: riskOf(operation) } : {}), error: error instanceof Error ? error.message : String(error) });
  if (error instanceof CommanderError) return; // help / 版本等正常退出
  if (error instanceof AgentCliError) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: agentCliErrorBody(error) })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'AGENT_CLI_FAILED', message: error instanceof Error ? error.message : String(error) } })}\n`);
  process.exitCode = 1;
});
