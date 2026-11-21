import { isLarkGroupChatMemoryPool, isLarkMemoryId, larkMemoryLimits } from '../memory.js';
import { larkMemoryEnabled, readLarkConfig } from '../config.js';
import type { CallbackHandler } from './button-context.js';

export const forget: CallbackHandler = async (ctx, { workflow, operatorOpenId, context }) => {
  const memoryId = workflow.dutydeck_memory_forget;
  const turnTaskId = typeof workflow.task_id === 'string' ? workflow.task_id : '';
  const turnSessionId = typeof workflow.session_id === 'string' ? workflow.session_id : '';
  if (!isLarkMemoryId(memoryId) || !turnTaskId || !turnSessionId) return { type: 'error', content: '无法识别要删除的记忆。' };
  if (!context?.chatId || !operatorOpenId || !ctx.reconcileConfig || !ctx.memory) {
    return { type: 'error', content: '删除入口已失效，请发送 /memory 查看，再用 /forget <编号> 删除。' };
  }
  try {
    const config = await readLarkConfig(ctx.store, ctx.reconcileConfig.appId);
    if (!config?.listening) return { type: 'warning', content: '机器人已停用，无法删除记忆。' };
    if (!larkMemoryEnabled(config)) return { type: 'warning', content: '本机器人已关闭会话记忆。' };
    const turn = await ctx.memory.turn(turnSessionId, turnTaskId);
    if (!turn) return { type: 'warning', content: `这张卡片的记忆记录已过期（每个会话只保留最近 ${larkMemoryLimits.turnsPerSession} 轮），请发送 /memory 查看，再用 /forget <编号> 删除。` };
    if (turn.record.appId !== config.appId || turn.record.chatId !== context.chatId
      || ![...turn.injected, ...turn.written].some(entry => entry.id === memoryId)) {
      return { type: 'warning', content: '这条记忆不属于本卡片对应的任务，请发送 /memory 查看。' };
    }
    if (!await ctx.commandAllowlisted(config, isLarkGroupChatMemoryPool(turn.scope) ? 'group' : 'p2p', context.chatId, operatorOpenId, turn.record.sessionId)) {
      return { type: 'warning', content: '当前账号不在机器人白名单中，无法删除记忆。' };
    }
    const removed = await ctx.memory.remove(turn.scope, memoryId, operatorOpenId);
    const task = [...ctx.tasks.values()].find(item => item.runtimeTaskId === turnTaskId);
    if (task) await ctx.refreshResultMemory(task, config).catch(error => ctx.log.warn({ error, taskId: task.id }, '记忆已删除，结果卡刷新失败'));
    return removed
      ? { type: 'success', content: `已删除记忆 ${memoryId}，之后的任务不再带上这条记忆。` }
      : { type: 'warning', content: `记忆 ${memoryId} 已经删除过了。` };
  } catch (error) {
    ctx.log.warn({ error }, '删除结果卡上的记忆失败');
    return { type: 'error', content: '删除失败，请稍后重试，或发送 /forget <编号>。' };
  }
};
