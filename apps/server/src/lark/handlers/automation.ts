import { createHash } from 'node:crypto';
import { executeScheduleCommand } from '../schedule-command.js';
import { buildPullRequestConfirmCard, buildPullRequestFollowCard } from '../pull-request-card.js';
import type { ChatCommandHandler } from './command-context.js';

export const handleWork: ChatCommandHandler = async (ctx) => {
  const { event, config, scopeId, group, sessionId, replyCard, route, acknowledgement } = ctx;
  const workbench = ctx.workbench;
  if (!workbench) throw new Error('当前服务尚未接入目标工作台。');
  if (!sessionId && !route.args.length) {
    await replyCard('Dutydeck 工作台', '在此话题描述目标，或发送 `/work research 研究目标`，Dutydeck 会分配两个独立分析步骤并汇总成果。已有目标可用 `/work` 查看，常用流程可用 `/work templates` 查看。');
    return 'handled';
  }
  const parentSessionId = sessionId ?? (await ctx.sessionFor(group, config, event.chatId, event.chatType, scopeId)).id;
  await workbench.command(parentSessionId, route.argsText, event, config);
  await ctx.clearAcknowledgementReaction({ event, acknowledgement });
  return 'handled';
};

export const handleSchedule: ChatCommandHandler = async (ctx) => {
  const { event, config, scopeId, group, sessionId, replyCard, route } = ctx;
  const automation = ctx.automation;
  if (!automation) throw new Error('当前服务未接入定时任务。');
  if (!event.senderOpenId || !await ctx.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) throw new Error('当前账号没有操作此任务的权限。');
  if (!sessionId && !route.args.length) {
    await replyCard('定时任务', '此话题暂无计划。发送 `/schedule every 分钟 指令` 创建停用的计划，再按回执核对并启用。');
    return 'handled';
  }
  const parentSessionId = sessionId ?? (await ctx.sessionFor(group, config, event.chatId, event.chatType, scopeId)).id;
  await replyCard('定时任务', await executeScheduleCommand(automation, ctx.store, parentSessionId, route.argsText, event, config));
  return 'handled';
};

export const handlePr: ChatCommandHandler = async (ctx) => {
  const { event, config, sessionId, replyCard, route } = ctx;
  const pullRequests = ctx.automation?.pullRequests;
  if (!pullRequests) throw new Error('当前服务未接入开 PR。');
  if (!sessionId) throw new Error('当前话题还没有可用的工作项，请先发送任务。');
  if (!event.senderOpenId || !await ctx.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) throw new Error('当前账号没有操作此任务的权限。');
  // `/pr follow <链接或编号>` 认领已有的 PR；其余参数仍是新 PR 的标题。
  const [subcommand, link, ...extra] = route.args;
  if (subcommand === 'follow' && link && !extra.length && /^(?:[#!]?\d{1,9}|https?:\/\/\S+)$/i.test(link)) {
    const card = buildPullRequestFollowCard(await pullRequests.follow(sessionId, { pullRequest: link }, event.senderOpenId));
    await replyCard(card.title, card.markdown, { elements: card.elements });
    return 'handled';
  }
  // A failed busy confirmation queues this same request; its Agent may retry /pr later.
  const proposalKey = `lark.pr_proposal.${config.appId}.${createHash('sha256').update(JSON.stringify([event.messageId, sessionId, event.senderOpenId, route.argsText.trim()])).digest('hex')}`;
  const preparedId = await ctx.store?.get(proposalKey);
  const prepared = preparedId ? (await pullRequests.listBySession(sessionId)).find(item => item.id === preparedId) : undefined;
  if (preparedId && (!prepared || prepared.status !== 'proposed' || Date.parse(prepared.expiresAt) <= Date.now())) throw new Error('之前准备的 PR 提案已不可用，请重新发送开 PR 请求。');
  const proposal = prepared ?? await pullRequests.prepare(sessionId, route.argsText.trim() ? { title: route.argsText.trim() } : {}, event.senderOpenId);
  if (!preparedId) await ctx.store?.set(proposalKey, proposal.id);
  const card = buildPullRequestConfirmCard(proposal);
  const sent = await replyCard(card.title, card.markdown, { elements: card.elements });
  if (sent?.messageId) await pullRequests.attachCard(proposal.id, sent.messageId);
  return 'handled';
};

export const handleCi: ChatCommandHandler = async (ctx) => {
  const { event, config, sessionId, replyCard, route } = ctx;
  const automation = ctx.automation;
  if (!automation || !sessionId) throw new Error('当前话题还没有可用的工作项，请先发送任务。');
  if (!event.senderOpenId || !await ctx.isOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId)) throw new Error('当前账号没有操作此任务的权限。');
  const [action, argument, ...extra] = route.args;
  const ciWebhook = automation.ciWebhook;
  // origin 归配了 webhook 的 CI 插件时走事件驱动的订阅；否则回落到轮询构建状态。
  const webhookItem = (action === 'wait' || action === 'fix') && !argument && ciWebhook
    ? await ciWebhook.subscribe(sessionId, { autoFix: action === 'fix' }, event.senderOpenId) : undefined;
  if (webhookItem) {
    await replyCard(`等待 ${webhookItem.providerName}`, `已等待 ${webhookItem.repository} 的 ${webhookItem.branch} 在提交 ${webhookItem.headSha.slice(0, 12)} 上的流水线结果。\n\n`
      + `${webhookItem.autoFix ? '失败时自动交给 Agent 修复' : '失败时发送失败卡，可点「交给 Agent 修」'}：最多 3 轮；同一错误出现 2 次、每轮改动超过 10 个文件或 300 行、head SHA 变化时停下。\n\n`
      + `截止：${webhookItem.expiresAt}\n取消：/ci cancel ${webhookItem.id}`);
  } else if (action === 'fix') {
    throw new Error(ciWebhook ? '/ci fix 需要 webhook：当前工作区的 origin 不归任何配了 webhook 的 CI 插件处理。' : '/ci fix 需要 webhook：已安装的 CI 插件都没有配置 webhook 密钥。');
  } else if (action === 'wait' && !extra.length) {
    const item = await automation.subscribeCi(sessionId, argument ? { workflow: argument } : {}, event.senderOpenId);
    const providerName = automation.listCiProviders().find(provider => provider.id === item.provider)?.displayName ?? 'CI';
    await replyCard(`等待 ${providerName}`, `已等待 ${item.repository.slug} 的提交 ${item.headSha.slice(0, 12)}。\n\n截止：${item.expiresAt}\n取消：/ci cancel ${item.id}`);
  } else if (action === 'cancel' && argument && !extra.length) {
    if (ciWebhook && await ciWebhook.get(argument)) await ciWebhook.cancel(sessionId, argument);
    else {
      const items = await automation.listBySession(sessionId, event.senderOpenId);
      const item = items.subscriptions.find(value => value.id === argument);
      if (!item) throw new Error('此工作项中找不到该等待记录。');
      await automation.cancelCi(sessionId, item.id, { expectedRevision: item.revision }, event.senderOpenId);
    }
    await replyCard('已取消 CI 等待', '尚未开始的自动续作不会再执行。已经运行的任务可通过 /cancel 中断。');
  } else if (!action) {
    const items = await automation.listBySession(sessionId, event.senderOpenId);
    const labels: Record<string, string> = { waiting: '等待中', dispatching: '提交中', accepted: '续作已接收', completed: '续作已结束', cancelled: '已取消', expired: '已过期', stale_head: '提交已变化', session_inactive: '会话已结束', revoked: '权限已撤销', error: '查询失败' };
    const webhookLabels: Record<string, string> = { waiting: '等待中', failed: '失败待修复', running: '处理中', passed: '已通过', stopped: '已停止', closed: '合并请求已结束', cancelled: '已取消', expired: '已过期' };
    const webhookLines = (await ciWebhook?.listBySession(sessionId) ?? []).slice(-10)
      .map(item => `${webhookLabels[item.status] ?? item.status} · ${item.repository} · ${item.branch} · ${item.headSha.slice(0, 12)} · 已修复 ${item.rounds}/3 轮\n${item.reason ?? ''}\n/ci cancel ${item.id}`);
    await replyCard('CI 等待记录', [...items.subscriptions.slice(0, 10).map(item => `${labels[item.status] ?? item.status} · ${item.repository.slug} · ${item.headSha.slice(0, 12)}\n${item.error ?? ''}\n/ci cancel ${item.id}`), ...webhookLines].join('\n\n') || '尚无等待记录。发送 /ci wait [工作流文件名或 ID] 等待当前提交。');
  } else throw new Error('用法：/ci、/ci wait [工作流文件名或 ID]、/ci fix、/ci cancel 等待编号');
  return 'handled';
};
