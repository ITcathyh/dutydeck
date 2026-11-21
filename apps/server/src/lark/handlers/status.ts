import { larkMemoryScope, renderLarkMemoryStatusLine } from '../memory.js';
import { larkMemoryEnabled } from '../config.js';
import { larkCommandEcho } from '../commands.js';
import type { ChatCommandHandler } from './command-context.js';

export const handleStatus: ChatCommandHandler = async (ctx) => {
  const { event, config, group, sessionId, latestTask, replyCard } = ctx;
  const participation = event.chatType === 'group'
    ? await ctx.participation?.describe({ appId: config.appId, chatId: event.chatId }).catch(() => undefined) : undefined;
  const usage = await ctx.usage?.describe(config.appId, event.chatType === 'group' ? event.chatId : undefined).catch(() => undefined);
  // 当前一轮停在审批上、后面还有指令排队时给一个拒绝入口：按钮与 /tasks 行内审批同形，
  // 登记成任务导航卡后由 respond 照常做鉴权和一次性决议。
  const approval = sessionId ? (await ctx.approvalBlock(config.appId, sessionId))?.record : undefined;
  const memoryApi = ctx.memoryOptions;
  const memoryLine = memoryApi && larkMemoryEnabled(config)
    ? await (memoryApi.pipeline ?? memoryApi.store).status(larkMemoryScope(config.appId, event.chatId, event.chatType, config.groupMemoryScope)).then(renderLarkMemoryStatusLine).catch(() => undefined) : undefined;
  const status = [await ctx.describeChatStatus(config, sessionId, latestTask, event.chatId), participation, usage, memoryLine].filter(Boolean).join('\n\n');
  // 卡片带了 elements 就不再渲染 markdown 正文，正文要作为第一个元素放在按钮前面。
  const card = await replyCard('任务状态', status,
    approval ? { elements: [{ tag: 'markdown', element_id: 'status_body', content: status, text_align: 'left', text_size: 'normal_v2', margin: '0px' },
      { tag: 'button', element_id: 'status_reject_approval', type: 'danger', text: { tag: 'plain_text', content: '拒绝这条审批' },
        behaviors: [{ type: 'callback', value: { dutydeck_workflow: 'reject', request_id: approval.id, generation: approval.boot } }] }] } : {});
  if (card && approval) {
    await ctx.saveTaskDashboardOrigin(config, card, event);
  }
  return 'handled';
};

export const handleAgents: ChatCommandHandler = async (ctx) => {
  const { config, replyCard } = ctx;
  const agents = await ctx.runtime.listAgents!();
  if (!agents.length) {
    await replyCard('本机可用 Agent', '**这台机器还没有配置任何 Agent。**\n\n请先在 Dutydeck Web 添加 Agent。');
    return 'handled';
  }
  const lines = agents.map(agent => {
    // 版本只来自 Agent 配置里探测到的值；探测不到就说探测不到，不拿命令名冒充版本。
    const version = agent.version?.trim() ? `版本 ${larkCommandEcho(agent.version, 40)}` : '版本未探测到';
    const current = agent.id === config.defaultAgentId ? ' · **本机器人当前默认**' : '';
    return `**${larkCommandEcho(agent.name, 64)}**（\`${larkCommandEcho(agent.id, 64)}\`）\n${version}${current}`;
  });
  await replyCard('本机可用 Agent', lines.join('\n\n'));
  return 'handled';
};
