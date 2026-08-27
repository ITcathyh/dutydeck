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

const result = await turn.start('思考：正在定位 Agent 会话异常');
turn.setMarkdown('思考：已确定需要检查事件恢复链路\n\n工具：正在读取 Session 事件');

await new Promise(resolve => setTimeout(resolve, 5200));
turn.setMarkdown('工具：已完成 Session 事件检查\n\n工具：正在验证 SSE 游标恢复');

await new Promise(resolve => setTimeout(resolve, 5200));
await turn.complete(`**Agent Debug 已完成**

已检查 Dockmux 会话链路，结果如下：

- Session 可以正常创建并连续对话
- SSE 使用 \`sequence\` 恢复，未发现事件重复
- 排队消息按顺序执行
- 中断后可以重新连接 ACP Session

\`typecheck\`、\`test\` 和 \`build\` 均已通过。`);

process.stdout.write(`${JSON.stringify({ ok: true, messageId: result.messageId, chatId: result.chatId })}\n`);
