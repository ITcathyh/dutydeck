#!/usr/bin/env node
import { AgentCardTurn, LarkCardClient } from './lark-agent-card.mjs';

const receiveId = process.env.LARK_RECEIVE_ID?.trim();
if (!receiveId) throw new Error('Missing required environment variable: LARK_RECEIVE_ID');

const turn = new AgentCardTurn(LarkCardClient.fromEnv(), {
  receiveId,
  receiveIdType: process.env.LARK_RECEIVE_ID_TYPE?.trim() || 'email',
  taskName: 'Agent Debug',
  taskId: '18779161860',
  refreshIntervalMs: 5000
});
turn.startedAt -= 35_000;

const result = await turn.start('当前步骤：正在定位任务恢复异常');
turn.setMarkdown('当前步骤：正在检查任务恢复链路\n\n进展：读取最近的运行事件');

await new Promise(resolve => setTimeout(resolve, 5200));
turn.setMarkdown('进展：运行事件检查完成\n\n当前步骤：验证 SSE 游标恢复');

await new Promise(resolve => setTimeout(resolve, 5200));
await turn.complete(`**Agent Debug 已完成**

已检查 Dockmux 任务运行链路，结果如下：

- 任务运行可以正常创建并连续执行
- SSE 使用 \`sequence\` 恢复，未发现事件重复
- 排队消息按顺序执行
- 中断后可以恢复 Agent 上下文

\`typecheck\`、\`test\` 和 \`build\` 均已通过。`);

process.stdout.write(`${JSON.stringify({ ok: true, messageId: result.messageId, chatId: result.chatId })}\n`);
