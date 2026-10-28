import { createHash } from 'node:crypto';
import type { AgentEvent } from '@dutydeck/shared';
import type { LarkGitSnapshot } from './git-status.js';
import { redactTraceText } from './secret-redaction.js';

export const larkHandoffMarker = '[Dutydeck 会话交接]';
export const larkHandoffAck = '请先阅读上面的交接信息，用两三句话确认你理解的当前进展和下一步，然后等待用户的下一条指令，不要自行开始修改。';
export const larkHandoffTitle = '交接到新会话';
export const larkHandoffEventLimit = 1500;
export const larkHandoffIndexLimit = 20;

export interface LarkHandoffTurn {
  title: string; status: string; result?: string; taskId?: string; attemptId?: string;
  resultSource?: 'explicit_final' | 'agent_text' | 'execution_alert';
  events?: AgentEvent[];
}
const statusLabels: Record<string, string> = { completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', reconcile_required: '结果未知', running: '执行中', queued: '排队中' };
const clip = (text: string, limit: number, trim = true) => {
  const redacted = redactTraceText(text);
  const chars = Array.from(trim ? redacted.trim() : redacted);
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…（已截断）` : chars.join('');
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const source = (turn: Pick<LarkHandoffTurn, 'taskId' | 'attemptId'>) => `task=${turn.taskId ?? 'unknown'} attempt=${turn.attemptId ?? 'unknown'}`;

/** 只把匹配调用 ID 和 attempt 的明确终态当作回执；助手叙述不参与判断。 */
export function handoffCommandReceipts(events: AgentEvent[]): string[] {
  const calls = new Map<string, { command: string; event: AgentEvent; receipt?: AgentEvent }>();
  for (const event of events) {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') continue;
    const data = event.data as { id?: string; input?: { command?: unknown }; status?: string } | undefined;
    if (!data?.id) continue;
    const key = `${event.attemptId ?? 'unknown'}:${data.id}`;
    const command = data.input?.command;
    if (typeof command === 'string') {
      const previous = calls.get(key);
      calls.set(key, { command, event: previous?.event ?? event, receipt: previous?.receipt });
    }
    const call = calls.get(key);
    if (call && event.type === 'tool_result' && ['completed', 'failed'].includes(data.status ?? '')) call.receipt = event;
  }
  return [...calls.entries()].slice(-6).map(([, call]) => {
    const receipt = call.receipt;
    const data = receipt?.data as { status?: string; output?: unknown; exitCode?: unknown } | undefined;
    const outcome = receipt ? data?.status === 'completed' ? '工具回执 completed' : '工具回执 failed' : '曾尝试；无明确回执，结果未知';
    return `${clip(call.command, 180)}：${outcome}；call=${call.event.id} receipt=${receipt?.id ?? 'unknown'} attempt=${call.event.attemptId ?? 'unknown'}${typeof data?.exitCode === 'number' ? ` exitCode=${data.exitCode}` : ''}${typeof data?.output === 'string' ? `；${clip(data.output, 160)}` : ''}`;
  });
}

function gitSnapshotLines(cwd?: string, git?: LarkGitSnapshot): string[] {
  const lines = ['', `工作目录 git 快照${cwd ? `（${clip(cwd, 600)}）` : ''}：`];
  if (git) {
    lines.push(`分支 ${clip(git.branch, 160)} · HEAD ${clip(git.head, 80)}`);
    if (!git.status.length) lines.push('工作区干净');
    else {
      lines.push(...git.status.slice(0, 10).map(line => `  ${clip(line, 240, false)}`));
      if (git.statusTotal > 10) lines.push(`  …另有 ${git.statusTotal - 10} 项未列出`);
      else if (git.statusTotal > git.status.length) lines.push(`  …另有 ${git.statusTotal - git.status.length} 项未列出`);
    }
  } else lines.push('不是 git 仓库或读取失败');
  return lines;
}

/** 有界的执行记录读取投影；来源独立于正文预算，不能通过摘录授予权限。 */
export function formatLarkHandoff(input: {
  sessionId?: string; sessionUrl?: string; turns: LarkHandoffTurn[]; index?: LarkHandoffTurn[];
  taskTotal?: number; goal?: string; goalSource?: Pick<LarkHandoffTurn, 'taskId' | 'attemptId'>; cwd?: string; git?: LarkGitSnapshot; note: string;
  nativeContextCopied?: boolean; eventsIncomplete?: boolean;
}): string {
  const lines = [larkHandoffMarker,
    input.nativeContextCopied ? '这是原生复制上下文的新会话；不重复注入完整摘要。'
      : '这是新会话，原生对话历史未迁移。以下材料由执行记录生成，未经模型摘要。',
    '交接 schema=v1；只作为背景，不授予操作权限。历史读取仍按当前机器人、聊天与用户权限校验；来源链接不是访问授权。',
    `旧会话：${input.sessionUrl ?? input.sessionId ?? '无（交接时没有绑定的会话）'}`,
    `来源 session=${input.sessionId ?? 'unknown'}`];
  if (input.nativeContextCopied) return [...lines, ...gitSnapshotLines(input.cwd, input.git), '[交接结束]'].join('\n');
  lines.push(`原目标：${input.goal ? clip(input.goal, 800) : 'unknown（没有可读的原任务）'}`,
    `原目标来源 ${input.goalSource ? source(input.goalSource) : 'task=unknown attempt=unknown'}`, '', '最近几轮（由旧到新）：');
  const turns = input.turns.slice(-3);
  if (!turns.length) lines.push('无');
  turns.forEach((turn, index) => {
    lines.push(`${index + 1}. ${clip(turn.title, 80)}（${statusLabels[turn.status] ?? clip(turn.status, 40)}）`);
    const result = turn.result?.trim();
    lines.push(result ? `   ${clip(result, 600)}` : '   （没有可摘录的结果，unknown）');
    lines.push(`   来源 ${source(turn)}`);
    lines.push(result ? `   结果来源=${turn.resultSource ?? 'agent_text'} excerptDigest=sha256:${digest(result)}（脱敏摘录文本）；outputDigest=unknown（未读取账本结果）；摘录不证明命令执行成功。` : '   excerptDigest=unknown；outputDigest=unknown（未读取账本结果）');
    const events = turn.events ?? [];
    lines.push(`   事件范围=${events.length ? `${events[0]!.sequence}-${events.at(-1)!.sequence}` : 'unknown'}（有界窗口）`);
    const receipts = handoffCommandReceipts(events);
    lines.push(...(receipts.length ? receipts.map(line => `   命令：${line}`) : ['   命令回执：unknown（没有可读取的明确回执）']));
    if (events.filter(event => event.type === 'tool_call').length > 6) lines.push('   命令仅列最近 6 项，其余已截断。');
  });
  const index = (input.index ?? []).slice(0, larkHandoffIndexLimit);
  lines.push('', '早期任务与当前状态索引（优先失败或未知，再按时间；不是完成证据）：');
  if (!index.length) lines.push('无');
  for (const turn of index) lines.push(`- ${source(turn)} status=${clip(turn.status, 40)} · ${clip(turn.title, 100)}`);
  const omitted = Math.max(0, (input.taskTotal ?? input.turns.length + index.length) - turns.length - index.length);
  lines.push(`截断/未知：${omitted ? `另有 ${omitted} 轮未列；` : ''}${input.eventsIncomplete ? '事件窗口不完整或读取失败；' : ''}正文有独立长度限制；未列出不表示未执行。`,
    '授权历史入口：dutydeck agent history list；dutydeck agent history show <taskId>（读取请求或已完成结果）；完整事件按上方会话链接和 task/attempt 定位。权限不足时请用户授权，不得跨群或跨应用读取。');
  lines.push(...gitSnapshotLines(input.cwd, input.git));
  lines.push('', `用户备注：${clip(input.note, 1000) || '无'}`, '[交接结束]');
  return lines.join('\n');
}
