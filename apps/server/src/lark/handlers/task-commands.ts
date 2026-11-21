import { larkSteeringUnknownNote } from '../task-recovery.js';
import { deferredConfirmationId, type PolicyAction } from '@dutydeck/shared';
import { steeringOutcomeText } from '../card-renderer.js';
import { larkCommandEcho } from '../commands.js';
import { escapeLarkPromptEcho, renderQueueSummary, QUEUE_SUMMARY_MAX_ITEMS } from '../queue-summary.js';
import { larkTaskTitle } from '../coordinator-core.js';
import { planPrompt } from '../../plan-mode.js';
import type { ChatCommandHandler } from './command-context.js';

export const handleQueue: ChatCommandHandler = async (ctx) => {
  const { event, config, sessionId, replyCard, route } = ctx;
  if (!sessionId) throw new Error('当前话题还没有会话，也就没有待执行的指令。');
  // 编号口径与心跳里的排队摘要同源（runtime.getTasks 里 status=queued 的那些，按收到顺序）。
  const tasks = await ctx.runtime.getTasks!(sessionId);
  const queued = tasks.filter(task => task.status === 'queued');
  const runningAtCommand = tasks.find(task => task.status === 'running');
  const [action, argument, ...extra] = route.args;
  if (!action) {
    const displayed = await Promise.all(queued.map(async task => ({ id: task.id,
      prompt: await ctx.taskDisplayPrompt(config, event.chatId, sessionId, task) })));
    const summary = renderQueueSummary(displayed, { blockedByApproval: queued.length > 0 && (await ctx.runtime.getPendingPermissions?.(sessionId) ?? []).length > 0 });
    // 摘要为卡片预算只列前几条，编号却一直有效：不写这句，第 6 条以后就成了看不见也够不着的死区。
    const hidden = queued.length > QUEUE_SUMMARY_MAX_ITEMS ? `上面只列出前 ${QUEUE_SUMMARY_MAX_ITEMS} 条，编号 ${QUEUE_SUMMARY_MAX_ITEMS + 1}-${queued.length} 同样可用。` : '';
    await replyCard('待执行指令', summary
      ? `${summary}\n\n编号按收到顺序，共 ${queued.length} 条。${hidden}取消：\`/queue cancel <编号>\`；提到队首：\`/queue top <编号>\`；立即插话：\`/queue steer <编号>\`。`
      : '**当前没有待执行的指令。**');
    return 'handled';
  }
  if (action !== 'cancel' && action !== 'top' && action !== 'steer' || !argument || extra.length) {
    throw new Error('用法：`/queue`、`/queue cancel <编号>`、`/queue top <编号>`、`/queue steer <编号>`');
  }
  const index = Number(argument);
  if (!Number.isInteger(index) || index < 1 || index > queued.length) {
    await replyCard('/queue 未执行', `**编号超出范围：当前有 ${queued.length} 条待执行指令。**\n\n发送 \`/queue\` 查看最新编号。`, { failed: true });
    return 'handled';
  }
  const target = queued[index - 1]!;
  const policy: PolicyAction = action === 'cancel' ? 'queue.cancel' : 'queue.promote';
  if (!await ctx.isTaskOperatorAllowed(config, event, { id: target.id, sessionId }, policy)) {
    await replyCard('/queue 未执行', '当前账号没有操作这条排队指令的权限。', { failed: true });
    return 'handled';
  }
  const displayedPrompt = await ctx.taskDisplayPrompt(config, event.chatId, sessionId, target);
  if (action === 'cancel') {
    if (!ctx.runtime.cancelQueued) throw new Error('当前 Dutydeck 运行时无法取消排队任务，请前往 Dutydeck Web 处理。');
    await ctx.runtime.cancelQueued(sessionId, target.id, event.senderOpenId);
    await replyCard('已取消排队指令', `**第 ${index} 条待执行指令不会再执行。**\n\n${escapeLarkPromptEcho(larkCommandEcho(displayedPrompt, 120))}`);
  } else if (action === 'steer') {
    if (!ctx.runtime.injectQueued) throw new Error('当前 Dutydeck 运行时不支持插话，可用 `/queue top <编号>` 提到队首。');
    // 插话会改变正在执行的那一轮，与提到队首同一道中断门。
    const denial = await ctx.currentTurnInterruptDenial(config, event, sessionId);
    if (denial) {
      await replyCard('/queue 未执行', `**插话会改变当前正在执行的那一轮，而那一轮不是你的任务。**\n\n${denial}这条指令仍在排队。`, { failed: true });
      return 'handled';
    }
    const steering = await ctx.runtime.injectQueued(sessionId, target.id, event.senderOpenId);
    const echo = escapeLarkPromptEcho(larkCommandEcho(displayedPrompt, 120));
    if (steering.task.status === 'reconcile_required') await replyCard('/queue 插话结果未知', `**${larkSteeringUnknownNote}**\n\n${echo}`, { failed: true });
    else if (steering.outcome === 'injected' || steering.outcome === 'startedNewTurn') {
      const permissionStatus = steering.outcome === 'injected'
        ? await ctx.steeringPermissionStatus(sessionId, steering.target, runningAtCommand)
        : 'confirmed-none';
      await replyCard('已插话', `**${steeringOutcomeText(steering.outcome, permissionStatus)}**\n\n${echo}`);
    }
    else if (steering.task.status !== 'queued') await replyCard('/queue 状态已变化', `**这条指令已不在队列中，请通过 \`/status\` 核对最新执行记录。**\n\n${echo}`, { failed: true });
    else await replyCard('/queue 未插话', `**${steeringOutcomeText(steering.outcome)}第 ${index} 条指令仍在排队，顺序没有改动。**\n\n要尽快执行可用 \`/queue top ${index}\` 提到队首。\n\n${echo}`, { failed: true });
  } else {
    if (!ctx.runtime.steerQueued) throw new Error('当前 Dutydeck 运行时无法调整队列顺序，请前往 Dutydeck Web 处理。');
    const denial = await ctx.currentTurnInterruptDenial(config, event, sessionId);
    if (denial) {
      await replyCard('/queue 未执行', `**提到队首会中断当前正在执行的那一轮，而那一轮不是你的任务。**\n\n${denial}队列顺序没有改动。`, { failed: true });
      return 'handled';
    }
    await ctx.runtime.steerQueued(sessionId, target.id, event.senderOpenId);
    for (const task of ctx.tasks.values()) if (task.runtimeTaskId === target.id) task.promoted = true;
    await replyCard('已提到队首', `**第 ${index} 条待执行指令已排到队首，当前这一轮会被中断。**\n\n${escapeLarkPromptEcho(larkCommandEcho(displayedPrompt, 120))}`);
  }
  return 'handled';
};

export const handlePlan: ChatCommandHandler = async (ctx) => {
  const { replyCard, route } = ctx;
  if (!route.argsText) {
    await replyCard('/plan 未执行', '**用法：`/plan <任务>`**\n\n例如：`/plan 把登录页的报错改成中文`。Agent 先只调研、出计划，不改文件；你在计划卡上批准后才会执行。', { failed: true });
    return 'handled';
  }
  // 任务内容走完整建任务链路；请求原文保留 /plan 前缀，runTurn 据此按计划轮执行（重试、恢复都带着它）。
  return planPrompt(route.argsText);
};

export const handleSteer: ChatCommandHandler = async (ctx) => {
  const { event, config, sessionId, replyCard, route } = ctx;
  if (!route.argsText) {
    await replyCard('/steer 未执行', '**用法：`/steer <内容>`**\n\n例如：`/steer 先跑一遍测试再改`。', { failed: true });
    return 'handled';
  }
  // 提到队首会中断当前这一轮，因此必须先过与 /cancel 同一道中断门；
  // 否则只有 own_runs 权限的成员能用一条 /steer 打断别人的任务，而 /cancel 会拒绝他。
  const denial = sessionId ? await ctx.currentTurnInterruptDenial(config, event, sessionId) : undefined;
  if (denial) {
    await replyCard('/steer 未执行', `**当前正在执行的是他人的任务，你没有中断它的权限。**\n\n${denial}直接把这条内容作为普通消息发出来，它会排到队尾执行。`, { failed: true });
    return 'handled';
  }
  // 内容仍走完整建任务链路（授权、风险检查、附件、卡片一个都不能少）；
  // 派发拿到 runtime task id 之后先试插话，不支持再降级为队首提升，结果如实写在这张卡上。
  return { prompt: route.argsText, steer: true };
};

export const handleCancel: ChatCommandHandler = async (ctx) => {
  const { event, config, group, sessionId, replyCard } = ctx;
  // /cancel（/stop）动两样：正在执行的那一轮（中断口径：发起人和管理员），以及发送人自己在本会话的排队项。
  // 别人的排队指令不动；判据来自 runtime 的真实任务状态，重建之后内存是空的也一样。
  const runtimeTasks = sessionId && ctx.runtime.getTasks ? await ctx.runtime.getTasks(sessionId) : undefined;
  const running = runtimeTasks?.find(task => task.status === 'running');
  // 内存里的这一轮持有 requestUpdate，能把进度卡就地收敛成取消收据；runtime 没有任务记录时只能靠它。
  const liveTurn = [...ctx.tasks.values()].reverse().find(task => task.group === group && task.state === 'running' && !ctx.preparingTurn(task)
    && (runtimeTasks ? Boolean(running) && (!task.runtimeTaskId || task.runtimeTaskId === running!.id) : true));
  // 私聊里只有这一个人能发消息：找不到记录的任务也是他发起的。
  const requesterOf = async (id: string) => (await ctx.larkTaskOrigin(config, event.chatId, { id, sessionId: sessionId! }))?.requester
    ?? (event.chatType === 'p2p' ? event.senderOpenId : undefined);
  const ownQueued = runtimeTasks
    ? (await Promise.all(runtimeTasks.filter(task => task.status === 'queued').map(async task => ({ task, requester: await requesterOf(task.id) }))))
      .filter(item => item.requester && item.requester === event.senderOpenId).map(item => ({ id: item.task.id, sessionId: item.task.sessionId }))
    : [...ctx.tasks.values()].filter(task => task.group === group && task.state === 'queued' && task.sessionId && task.runtimeTaskId && task.event.senderOpenId === event.senderOpenId)
      .map(task => ({ id: task.runtimeTaskId!, sessionId: task.sessionId! }));
  // 先取消排队、再中断：先中断的话，下一条排队可能立刻开跑，就取消不掉了。
  // 内存里的排队卡就地改成已取消，不再另发一张「已取消」结果卡：这张回执已经说了。
  // 还在准备、runtime 还没有记录的自己的请求（下载附件、读上下文）也算排队，一并取消。
  let cancelled = await ctx.cancelPreparingTurns(group, event.senderOpenId);
  for (const item of ownQueued) {
    const live = [...ctx.tasks.values()].find(task => task.runtimeTaskId === item.id && task.state === 'queued');
    if (live ? await ctx.absorbQueuedTask(live, '**已取消**\n\n这条请求不会再执行。', '已取消', event.senderOpenId)
      : await ctx.runtime.cancelQueued!(item.sessionId, item.id, event.senderOpenId).then(() => true, error => {
        ctx.log.warn({ error, runtimeTaskId: item.id }, '/cancel 取消排队任务失败'); return false;
      })) cancelled++;
  }
  const cancelledText = `已取消你的 ${cancelled} 条排队`;
  if (!running && !liveTurn) {
    if (cancelled) await replyCard('/cancel 已受理', `**${cancelledText}。**\n\n这些请求不会再执行。`);
    else if (ownQueued.length) await replyCard('/cancel 未执行', '**你的排队请求没能取消，可能已经开始执行。**\n\n发送 `/status` 查看最新状态。', { failed: true });
    else await replyCard('/cancel 未执行', '**当前没有正在执行的一轮，也没有你排队的请求。**\n\n发送新的请求即可开始一轮执行。', { failed: true });
    return 'handled';
  }
  const runningOrigin = running && !liveTurn ? await ctx.larkTaskOrigin(config, event.chatId, { id: running.id, sessionId: sessionId! }) : undefined;
  const title = escapeLarkPromptEcho(larkCommandEcho(liveTurn ? ctx.taskTitle(liveTurn, liveTurn.prompt, config) : runningOrigin?.title ?? larkTaskTitle(running!.prompt, config.name), 40));
  const requester = liveTurn?.event.senderOpenId ?? (running ? await requesterOf(running.id) : undefined);
  if (!await ctx.isInterruptOperatorAllowed(config, event.senderOpenId, event.chatId, sessionId ?? liveTurn?.sessionId, requester)) {
    const denial = ctx.requesterOnlyReason(config, requester, '中断正在执行的这一轮', true);
    if (cancelled) await replyCard('/cancel 已受理', `**${cancelledText}。**\n\n没有中断『${title}』：${denial}`);
    else await replyCard('/cancel 未执行', `**没有中断『${title}』。**\n\n${denial}`, { failed: true });
    return 'handled';
  }
  // 停止原语必须真的被调用；调不动就说调不动，不发一句空口「已受理」。
  const result = liveTurn
    ? await ctx.handleAction({ action: 'interrupt', task_id: liveTurn.id, turn: String(liveTurn.turn) }, event.senderOpenId)
    : await ctx.runtime.interrupt(sessionId!, running!.id, event.senderOpenId).then(() => ({ type: 'success', content: '' }));
  if (result?.type === 'success') {
    await replyCard('/cancel 已受理', `**已请求中断『${title}』${cancelled ? `，并${cancelledText.slice(1)}` : ''}。**\n\n任务停止后会更新原任务卡。`);
  } else if (cancelled) {
    await replyCard('/cancel 已受理', `**${cancelledText}。**\n\n中断『${title}』没有执行：${result?.content ?? '停止请求未完成'}`);
  } else {
    await replyCard('/cancel 未执行', `**${result?.content ?? '停止请求未完成'}**`, { failed: true });
  }
  return 'handled';
};

export const handleRetry: ChatCommandHandler = async (ctx) => {
  const { event, config, sessionId, latestTask, replyCard } = ctx;
  // /retry 一律是一个新任务，绝不复用旧 task 的 event/config——旧 handleAction 会
  // 沿用原发起人的身份与当时的配置，让「Alice 有高危授权、Bob 点重试」变成
  // Bob 借 Alice 的权限执行。恢复出原 prompt 后交给正常建任务链路，由当前
  // event.senderOpenId 与当前 config 重新过授权与风险检查。
  const runtimeTasks = sessionId && ctx.runtime.getTasks ? await ctx.runtime.getTasks(sessionId) : undefined;
  const target = ctx.pickRetryableRuntimeTask(runtimeTasks);
  // runtime 有这个会话的任务记录时一律以它为准；只有完全没有记录（旧运行时没有
  // getTasks，或这一轮还没落库）才回落到内存里的这一轮，且同样只取 prompt。
  const memoryTask = !runtimeTasks?.length && latestTask && ['failed', 'interrupted', 'cancelled'].includes(latestTask.state)
    ? latestTask
    : undefined;
  if (target && await ctx.isDeferredTask(sessionId!, target.id) || memoryTask && deferredConfirmationId(memoryTask.events, memoryTask.runtimeTaskId ?? memoryTask.id)) {
    await replyCard('/retry 未执行', '确认已登记，请使用原确认卡。', { failed: true });
    return 'handled';
  }
  if (!target && !memoryTask) {
    await replyCard('/retry 未执行', '**只有失败、已中断或已取消的任务可以重试。**\n\n当前没有可重试的任务，请直接发送新的请求。', { failed: true });
    return 'handled';
  }
  const retryAllowed = target ? await ctx.isTaskOperatorAllowed(config, event, target)
    : await ctx.isOperatorAllowed(config, event.senderOpenId, event.chatId, memoryTask?.sessionId, memoryTask?.event.senderOpenId);
  if (!retryAllowed) {
    await replyCard('/retry 未执行', '当前账号没有操作此任务的权限。', { failed: true });
    return 'handled';
  }
  // 原请求只认本 App channel 里、app_id/chat_id 与 runtime_task_id 都对得上的那条记录；
  // 恢复不出来就直说，绝不拿别处或相邻一轮的 prompt 凑一个「看起来能跑」的重试。
  const restored = target
    ? await ctx.restoreRetryPrompt(config, event, target)
    : memoryTask?.prompt?.trim() ? { prompt: memoryTask.prompt, materialPrompt: memoryTask.retryMaterialPrompt ?? memoryTask.prompt } : undefined;
  if (!restored) {
    await replyCard('/retry 未执行', '**找不到这一轮的原始请求内容，无法重试。**\n\n请重新发送你的请求。', { failed: true });
    return 'handled';
  }
  return restored;
};
