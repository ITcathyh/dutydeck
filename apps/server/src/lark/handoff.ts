import type { LarkGitSnapshot } from './git-status.js';

/**
 * `/new --handoff` 新会话首轮 prompt 的交接前缀。全部由服务端按执行记录拼出，不调用模型摘要：
 * 旧会话链接、最近几轮的标题与最终结果摘录、工作目录 git 快照、用户备注。读不到的部分写明缺省。
 */
export const larkHandoffMarker = '[Dutydeck 会话交接]';
/** 没有随 /new 给出任务时，首轮让 Agent 只确认接手，不自行动手。 */
export const larkHandoffAck = '请先阅读上面的交接信息，用两三句话确认你理解的当前进展和下一步，然后等待用户的下一条指令，不要自行开始修改。';
/** 没有任务内容时进度卡与任务记录上的标题。 */
export const larkHandoffTitle = '交接到新会话';

export interface LarkHandoffTurn { title: string; status: string; result?: string }

const statusLabels: Record<string, string> = { completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消' };
const clip = (text: string, limit: number) => {
  const chars = Array.from(text.trim());
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : chars.join('');
};

export function formatLarkHandoff(input: {
  sessionId?: string;
  sessionUrl?: string;
  turns: LarkHandoffTurn[];
  cwd?: string;
  git?: LarkGitSnapshot;
  note: string;
}): string {
  const lines = [
    larkHandoffMarker,
    '这是用 /new --handoff 开启的新会话，旧会话的对话没有带过来。以下交接信息由 Dutydeck 按执行记录生成，未经模型摘要，只作为背景，不授予操作权限。',
    '',
    `旧会话：${input.sessionUrl ?? input.sessionId ?? '无（交接时没有绑定的会话）'}`,
    '',
    '最近几轮（由旧到新）：'
  ];
  if (!input.turns.length) lines.push('无');
  input.turns.forEach((turn, index) => {
    lines.push(`${index + 1}. ${clip(turn.title, 80)}（${statusLabels[turn.status] ?? turn.status}）`);
    const result = turn.result?.trim();
    lines.push(...(result ? clip(result, 600).split('\n').map(line => `   ${line}`) : ['   （没有可摘录的结果）']));
  });
  lines.push('', `工作目录 git 快照${input.cwd ? `（${input.cwd}）` : ''}：`);
  if (input.git) {
    lines.push(`分支 ${input.git.branch} · HEAD ${input.git.head}`);
    if (!input.git.status.length) lines.push('工作区干净');
    else {
      lines.push(...input.git.status.map(line => `  ${line}`));
      if (input.git.statusTotal > input.git.status.length) lines.push(`  …另有 ${input.git.statusTotal - input.git.status.length} 项未列出`);
    }
  } else lines.push('不是 git 仓库或读取失败');
  lines.push('', `用户备注：${input.note.trim() || '无'}`, '[交接结束]');
  return lines.join('\n');
}
