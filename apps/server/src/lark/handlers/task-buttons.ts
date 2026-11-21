import { clearTaskReportSafely, deferredConfirmationId, errorMessage } from '@dutydeck/shared';
import { saveLarkConfig } from '../config.js';
import { isLarkCardActionAvailable } from '../card-actions.js';
import type { TaskButtonHandler } from './button-context.js';

const refresh: TaskButtonHandler = async (ctx, input) => {
  const { task, taskId } = input;
  if (!isLarkCardActionAvailable('refresh', {
    state: task.state, taskId: task.id, turn: task.turn,
    ...(task.retryable !== undefined ? { retryable: task.retryable } : {}),
    capabilities: ctx.capabilitiesForTask(task)
  })) {
    return { type: 'warning', content: '当前状态无法刷新，任务已结束或心跳已停止' };
  }
  try {
    await task.requestUpdate?.(task.state === 'queued' ? 'queued' : 'running', false);
    return { type: 'success', content: '已拉取最新状态' };
  } catch (error) {
    ctx.log.warn({ error, taskId }, '刷新飞书卡片失败');
    return { type: 'error', content: '刷新失败，请稍后重试或前往 Dutydeck Web 查看' };
  }
};

const steer: TaskButtonHandler = async (ctx, input) => {
  const { task, taskId, actionStale, effectiveConfig, operatorOpenId } = input;
  const action = input.action === 'steer_inject' ? 'steer_inject' : 'steer_promote';
  const sessionId = task.sessionId;
  const runtimeTaskId = task.runtimeTaskId;
  if (!sessionId || !runtimeTaskId || !isLarkCardActionAvailable(action, {
    state: task.state, taskId: task.id, turn: task.turn,
    capabilities: { ...ctx.capabilitiesForTask(task), ...(await ctx.queuedSteerCapabilities(task)) }
  })) {
    return { type: 'warning', content: '这条已不在紧挨着当前这一轮的位置，无法插队；请发送 /status 查看最新状态' };
  }
  const actor = { ...task.event, senderOpenId: operatorOpenId };
  const denial = await ctx.currentTurnInterruptDenial(effectiveConfig, actor, sessionId);
  if (denial) return { type: 'warning', content: denial };
  void (async () => {
    const steering = await ctx.steerQueuedTurn(effectiveConfig, actor, sessionId, { id: runtimeTaskId, status: 'queued' }, action === 'steer_inject' ? 'inject' : 'promote')
      .catch(error => { ctx.log.warn({ error, taskId }, '排队卡插队失败'); return { steered: undefined, note: '插队没有成功：这条内容按正常顺序排队。' }; });
    if (actionStale()) return;
    if (steering.steered) task.steered = steering.steered;
    task.steerNote = steering.note;
    if (action === 'steer_promote') task.promoted = true;
    await task.requestUpdate?.(task.state === 'running' ? 'running' : 'queued').catch(() => undefined);
  })();
  return { type: 'success', content: action === 'steer_inject' ? '正在把这条插进当前这一轮' : '正在把这条提到队首' };
};

const useCommand: TaskButtonHandler = async (ctx, input) => {
  const { task, taskId, currentConfig, effectiveConfig, operatorOpenId } = input;
  const command = (await ctx.verificationView(task, effectiveConfig, task.state)).capabilities.verificationSuggestion;
  if (!command) return { type: 'warning', content: '这个机器人已经配置了验证命令，或这张卡没有可用的候选命令。' };
  if (!await ctx.isOperatorAllowed(effectiveConfig, operatorOpenId, task.event.chatId, task.sessionId, task.event.senderOpenId, 'channel_bot.update')) {
    return { type: 'warning', content: '当前账号没有修改机器人配置的权限。' };
  }
  try {
    await saveLarkConfig(ctx.store, undefined, { originalAppId: currentConfig.appId, expectedRevision: currentConfig.revision ?? 1, verificationCommand: command });
  } catch (error) {
    ctx.log.warn({ error, taskId }, '保存验证命令失败');
    return { type: 'error', content: '保存失败：机器人配置可能刚被修改过，请稍后重试或在 Web 端配置。' };
  }
  void ctx.refreshResultVerification(task, { ...effectiveConfig, verificationCommand: command })
    .catch(error => ctx.log.warn({ error, taskId }, '验证命令已保存，结果卡未能更新'));
  return { type: 'success', content: '已保存验证命令，之后改了代码会自动验证。' };
};

const verify: TaskButtonHandler = async (ctx, input) => {
  const { task, effectiveConfig, operatorOpenId } = input;
  // 与渲染端同一个判断：verificationView 内部就走 isLarkCardActionAvailable，
  // 所以「界面上出现的按钮」与「后端接受的回调」严格等价，不存在死按钮也不存在旁路。
  if (!(await ctx.verificationView(task, effectiveConfig, task.state)).canRun) {
    return { type: 'warning', content: '当前没有可运行的验证命令，或这份验证记录已能证明当前代码。' };
  }
  if (ctx.verifyInFlight.has(task.id)) {
    return { type: 'warning', content: '验证正在执行中，完成后会更新这张卡片，请勿重复点击。' };
  }
  ctx.verifyInFlight.add(task.id);
  const command = effectiveConfig.verificationCommand!.trim();
  void (async () => {
    // 带上点击人：管理群的执行授权要求验证有可核验的发起人。
    try { await ctx.runtime.runVerification!(task.sessionId!, { command }, operatorOpenId); }
    catch (error) { ctx.log.warn({ error, taskId: task.id }, '运行验证失败，卡片按最新记录呈现'); }
    finally {
      // 先把卡刷成最新结论再放开重入：否则这段空档里的第二次点击会再起一个真实进程。
      await ctx.refreshResultVerification(task, effectiveConfig)
        .catch(error => ctx.log.warn({ error, taskId: task.id }, '验证结果未能更新到结果卡'));
      ctx.verifyInFlight.delete(task.id);
    }
  })();
  return { type: 'success', content: '已开始运行验证，完成后会更新这张卡片。' };
};

const cancel: TaskButtonHandler = async (ctx, input) => {
  const { task, taskId, actionStale, actionTurn, operatorOpenId } = input;
  if (task.state !== 'queued') return { type: 'warning', content: '任务已不在排队中' };
  if (!task.sessionId || !task.runtimeTaskId || !ctx.runtime.cancelQueued) return { type: 'warning', content: '排队任务当前不可取消' };
  task.state = 'interrupting';
  const sessionId = task.sessionId;
  const runtimeTaskId = task.runtimeTaskId;
  const cancelQueued = ctx.runtime.cancelQueued.bind(ctx.runtime);
  void (async () => {
    try {
      await cancelQueued(sessionId, runtimeTaskId, operatorOpenId);
      // 取消这一轮的排队期间可能已经 /retry 开了新一轮：旧点击不得改写新一轮状态，
      // 也不得触发新卡重绘。这一轮的实际终态由它自己的事件流负责。
      if (actionStale()) {
        ctx.log.info({ taskId, turn: actionTurn }, '排队取消完成时任务已进入新一轮，跳过旧轮次的状态改写');
        return;
      }
      task.state = 'cancelled';
      await task.requestUpdate?.('cancelled', false);
    } catch (error) {
      // 排队任务可能在点击时已转为运行态；绝不回退中断 Session，交由任务事件流对账实际状态。
      ctx.log.warn({ error, taskId, sessionId, runtimeTaskId }, '取消飞书排队任务失败');
      if (actionStale()) return;
      if (task.state === 'interrupting') task.state = 'queued';
      ctx.pushTaskError(task, `取消排队任务失败：${error instanceof Error ? error.message : String(error)}`);
      await task.requestUpdate?.(task.state === 'running' ? 'running' : 'queued', false).catch(() => undefined);
    }
  })();
  return { type: 'success', content: '正在取消排队任务' };
};

const interrupt: TaskButtonHandler = async (ctx, input) => {
  const { task, taskId, actionStale, actionTurn, operatorOpenId } = input;
  if (!task.sessionId || task.state !== 'running') return { type: 'warning', content: '任务当前不可中断' };
  const runtimeTaskId = task.runtimeTaskId;
  if (ctx.runtime.dispatch && !runtimeTaskId) return { type: 'warning', content: '任务尚未完成接收，请稍后再试' };
  task.state = 'interrupting';
  task.interruptRequested = true;
  const sessionId = task.sessionId;
  void (async () => {
    try {
      if (runtimeTaskId) await ctx.runtime.interrupt(sessionId, runtimeTaskId, operatorOpenId);
      else await ctx.runtime.interrupt(sessionId, undefined, operatorOpenId);
      // 中断返回时可能已经 /retry：新一轮正在跑，旧点击不能把它标成 interrupted。
      if (actionStale()) {
        ctx.log.info({ taskId, turn: actionTurn }, '中断完成时任务已进入新一轮，跳过旧轮次的状态改写');
        return;
      }
      // The signal is only an intent. Runtime's task event supplies the
      // confirmed terminal state; do not publish a cancellation receipt yet.
      await task.requestUpdate?.('running', false);
    } catch (error) {
      ctx.log.warn({ error, taskId, sessionId }, '中断飞书任务失败');
      if (actionStale()) return;
      task.state = 'running';
      task.interruptRequested = false;
      ctx.pushTaskError(task, `中断任务失败：${error instanceof Error ? error.message : String(error)}`);
      await task.requestUpdate?.('running', false).catch(() => undefined);
    }
  })();
  return { type: 'success', content: '正在取消任务' };
};

const retry: TaskButtonHandler = async (ctx, input) => {
  const { task, taskId, actionStale, effectiveConfig, operatorOpenId } = input;
  // 检查与 task.state = 'queued' 之间隔着 await：同步占位，第一次点击挂上 runTurn 或放弃之前，同一任务的其他点击一律拒绝。
  if (ctx.retryInFlight.has(task.id)) return { type: 'warning', content: '正在重试，请勿重复点击' };
  ctx.retryInFlight.add(task.id);
  try {
    if (deferredConfirmationId(task.events, task.runtimeTaskId ?? task.id) || task.sessionId && task.runtimeTaskId && await ctx.isDeferredTask(task.sessionId, task.runtimeTaskId)) return { type: 'warning', content: '确认已登记，请使用原确认卡。' };
    if (task.state !== 'failed' && task.state !== 'interrupted' && task.state !== 'cancelled') return { type: 'warning', content: '只有失败、已中断或已取消的任务可以重试' };
    // 与渲染端同一张表：标记为不可重试（例如旧对话启动器版本变化）时卡上没有「重试」，
    // 回调端同样拒绝，不在旧会话上再跑一遍注定失败的请求。
    if (!isLarkCardActionAvailable('retry', {
      state: task.state, taskId: task.id, turn: task.turn,
      ...(task.retryable !== undefined ? { retryable: task.retryable } : {}),
      capabilities: ctx.capabilitiesForTask(task)
    })) return { type: 'warning', content: '这个任务不能在当前对话重试，请按卡片上的说明处理' };
    if (!operatorOpenId) return { type: 'warning', content: '缺少操作人身份，无法重试' };
    // runtime 已接收过这一轮：只有它确认停在失败、中断或取消才重试；已执行、仍在跑或读不到都不重发。
    if (task.sessionId && task.runtimeTaskId && ctx.runtime.getTasks) {
      const runtimeTaskId = task.runtimeTaskId;
      const status = (await ctx.runtime.getTasks(task.sessionId).catch(() => undefined))?.find(item => item.id === runtimeTaskId)?.status;
      if (actionStale()) return { type: 'warning', content: '任务已开始新一轮，请在最新的卡片上操作' };
      if (!status || !['failed', 'interrupted', 'cancelled'].includes(status)) return { type: 'warning', content: '这一轮在 Agent 那边已执行或结果未知，不能直接重试，请发送 /status 查看' };
    }
    const retryEvent = { ...task.event, senderOpenId: operatorOpenId, senderType: 'user', senderAppId: undefined };
    const previousState = task.state;
    task.state = 'queued';
    try {
      if (task.inbox) await ctx.inbox!.update(task.inbox, { event: retryEvent, state: 'received', turn: task.turn + 1, cardId: undefined, taskId: undefined, materials: undefined,
        ...(task.inbox.request ? { request: { ...task.inbox.request, materialPrompt: task.retryMaterialPrompt ?? task.prompt } } : {}) });
    } catch (error) {
      if (!actionStale()) task.state = previousState;
      return { type: 'warning', content: error instanceof Error ? error.message : '重试记录保存失败，请稍后重试' };
    }
    if (actionStale()) return { type: 'warning', content: '任务已开始新一轮，请在最新的卡片上操作' };
    if (task.runtimeTaskId && ctx.store) await clearTaskReportSafely(ctx.store, task.runtimeTaskId);
    task.event = retryEvent;
    task.config = effectiveConfig;
    task.cancelRequested = undefined;
    task.recovered = undefined;
    // 生命周期字段在 runTurn 递增 turn 后再重置，避免上一轮在途的
    // 过程更新或结果发送把旧消息 ID 写进新一轮。
    task.group.tail = task.group.tail.then(() => ctx.runTurn(task)).catch(error => {
      ctx.log.error({ error, chatId: task.event.chatId, messageId: task.event.messageId }, '重试飞书任务失败');
      ctx.pushTaskError(task, `重试任务失败：${errorMessage(error)}`);
      task.state = 'failed';
      task.requestUpdate?.('failed', false).catch(() => undefined);
    });
    return { type: 'success', content: '已开始重试' };
  } finally {
    ctx.retryInFlight.delete(task.id);
  }
};

export const taskButtons = {
  refresh: refresh,
  steer_promote: steer,
  steer_inject: steer,
  use_verification_command: useCommand,
  verify: verify,
  cancel: cancel,
  interrupt: interrupt,
  retry: retry,
};
