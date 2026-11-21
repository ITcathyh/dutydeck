import { larkRecoveryRetainedNote } from '../task-recovery.js';
import { larkForkWorkspaceMode, larkNativeForkId, larkResumeUnavailable } from '../session-branches.js';
import { parseLarkNewSession, validateLarkLaunchOptions } from '../new-session.js';
import type { AgentModelsResult } from '../../agent-models.js';
import { discoverSessionAgentModels } from '../../session-model-probe.js';
import { larkHandoffAck, larkHandoffTitle } from '../handoff.js';
import { isRunnable } from '../../ci-common.js';
import { normalizeSessionName, RuntimeError, SESSION_NAME_MAX_LENGTH, type AgentConfig, type Session } from '@dutydeck/shared';
import { larkPermissionMode, type StoredLarkConfig } from '../config.js';
import { LarkServiceError } from '../service.js';
import { safeLarkWebUrl } from '../card-actions.js';
import { larkCommandEcho, type LarkCommandRoute } from '../commands.js';
import { escapeLarkPromptEcho } from '../queue-summary.js';
import { larkTaskAgentAllowlistConfigured } from '../task-agent.js';
import { larkSourceId, larkGroupKey, larkSessionConfigKey } from '../session-resolver.js';
import type { LarkMessageEvent } from '../listener.js';
import { larkTaskTitle } from '../coordinator-core.js';
import type { ChatCommandHandler, CommandContext } from './command-context.js';

/** /model、/effort 查看与切换共用的一次探测：按会话当前的模型、目录和机器人的审批模式取 Agent 模型列表（与 /new 首轮校验同一份缓存键），10 秒内读不到返回 undefined。 */
type LarkProbeAgent = Pick<AgentConfig, 'id' | 'name'> & Partial<AgentConfig>;
async function larkSessionConfigProbe(agent: LarkProbeAgent | undefined, session: Session, permissionMode: AgentConfig['permissionMode']): Promise<{ agent?: LarkProbeAgent; result?: AgentModelsResult }> {
  if (!agent) return {};
  const model = session.model ?? agent.model;
  const probeAgent: LarkProbeAgent = { ...agent, ...(model ? { model } : {}), cwd: session.cwd, permissionMode };
  // 校验会先拒绝这些情况，不需要探测。
  if (!['acp', 'auto'].includes(probeAgent.protocol ?? '') || !probeAgent.command || !probeAgent.args || !probeAgent.env) return { agent: probeAgent, result: { models: [], reasoningEfforts: [] } };
  try {
    const result = await discoverSessionAgentModels(probeAgent as AgentConfig, model);
    return { agent: probeAgent, ...(result ? { result } : {}) };
  } catch { return { agent: probeAgent, result: { models: [], reasoningEfforts: [] } }; }
}

/** 运行时拒绝切换的已知原因翻成人话；返回 undefined 表示不是已知原因，交给通用失败回执。 */
function larkSessionConfigFailure(error: unknown, input: { command: string; label: string; flag: string; agent: string }): string | undefined {
  if (!(error instanceof RuntimeError)) return undefined;
  const { command, label, flag, agent } = input;
  switch (error.code) {
    case 'TURN_IN_PROGRESS': return `**当前有一轮正在执行，${label}没有改动。**\n\n等本轮结束后再发送 \`${command} ...\`；要立刻停下可发 \`/cancel\`。`;
    case 'DRIVER_CONFIGURATION_BUSY': return `**上一次配置变更还没完成，${label}没有改动。**\n\n稍后再试。`;
    case 'MODEL_SWITCH_UNSUPPORTED': case 'REASONING_SWITCH_UNSUPPORTED': case 'TASK_OPTIONS_UNSUPPORTED':
      return `**${larkCommandEcho(agent, 64)} 不支持在会话中切换${label}，${label}没有改动。**\n\n要换${label}，用 \`/new ${flag} -- 任务\` 开新会话。`;
    case 'MODEL_SWITCH_FAILED': case 'REASONING_SWITCH_FAILED': return `**切换${label}失败。**\n\n${larkCommandEcho(error.message, 200)}\n\n发送 \`${command}\` 查看当前值。`;
    default: return undefined;
  }
}

async function executeSessionConfigCommand(ctx: CommandContext,
  route: Extract<LarkCommandRoute, { kind: 'intent' }>, config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string | undefined, reply: CommandContext['replyCard']
) {
  const model = route.command === 'model';
  const command = model ? '/model' : '/effort';
  const label = model ? '模型' : '思考强度';
  const flag = model ? '--model 模型' : '--effort 档位';
  const fail = (markdown: string) => reply(`${command} 未执行`, markdown, { failed: true });
  if (route.args.length > 1) { await fail(`**用法：\`${model ? '/model [模型]' : '/effort [档位]'}\`**`); return; }
  const session = sessionId ? await ctx.runtime.getSession(sessionId) : undefined;
  if (!session) { await fail(`**当前话题还没有会话。**\n\n先发一条任务开始会话；想在开始时就指定${label}，用 \`/new ${flag} -- 任务\`。`); return; }
  if (!isRunnable(session)) { await fail('**当前会话已关闭，不能切换。**\n\n发送 `/resume` 恢复，或用 `/new` 开新会话。'); return; }
  const agent = (await ctx.runtime.listAgents?.())?.find(item => item.id === session.agentId);
  const current = model ? session.model ?? agent?.model : session.reasoningEffort ?? agent?.reasoningEffort;
  const currentLine = `**当前${label}：${current ? `\`${larkCommandEcho(current, 64)}\`` : '未指定（Agent 默认）'}**`;
  const unsupported = `${larkCommandEcho(agent?.name ?? session.agentId, 64)} 不支持在会话中切换${label}`;
  const requested = route.args[0];
  // 终端驱动没有会话内切换：不列档位、不去连终端（连接会拉起终端进程）再被拒绝。
  if (session.protocol === 'pty-cli') {
    if (!requested) await reply(`当前${label}`, `${currentLine}\n\n当前 Agent 不支持在会话中切换${label}。要换${label}，用 \`/new ${flag} -- 任务\` 开新会话。`);
    else await fail(`**${unsupported}，${label}没有改动。**\n\n要换${label}，用 \`/new ${flag} -- 任务\` 开新会话。`);
    return;
  }
  if (!requested) {
    const found = (await larkSessionConfigProbe(agent, session, larkPermissionMode(config))).result;
    const options = (model ? found?.models : found?.reasoningEfforts)?.map(item => item.id) ?? [];
    const shown = options.slice(0, 30).map(item => `\`${larkCommandEcho(item, 64)}\``).join('、');
    await reply(`当前${label}`, [
      currentLine,
      shown ? `可选：${shown}${options.length > 30 ? `，等共 ${options.length} 项` : ''}` : '可选项暂时读取不到，可以直接输入名称尝试。',
      `切换：\`${command} ${model ? '<模型>' : '<档位>'}\`。只在会话空闲时切换，下一轮起使用新值；本轮运行中会被拒绝。`
    ].join('\n\n'));
    return;
  }
  // 权限照搬 /new --model：执行策略先过，受管理的群再过群级授权（run.change_model 是群管理员动作）。
  try { await ctx.requireExecution('session', 'run.change_model'); }
  catch (error) {
    if (!(error instanceof LarkServiceError)) throw error;
    await fail(`**当前没有切换${label}的权限。**\n\n${larkCommandEcho(error.message, 200)}`); return;
  }
  if (config.managedGroup) {
    const decision = await ctx.groupManager?.authorize(config.appId, event.chatId, event.senderOpenId, 'run.change_model');
    if (!decision?.allowed) { await fail(`**当前账号没有切换会话${label}的权限。**\n\n${larkCommandEcho(decision?.reason ?? '群里受管理时，这需要群管理员权限。', 200)}`); return; }
  }
  if (!agent) { await fail('**找不到本会话的 Agent，没有切换。**'); return; }
  // 与查看同一次探测、同一个 10 秒上限（命中同一份缓存）；思考强度按会话当前模型取档位。
  const probe = await larkSessionConfigProbe(agent, session, larkPermissionMode(config));
  if (!probe.result) { await fail(`**10 秒内没有读到 Agent 的可选${label}，没有切换。**\n\n稍后再试，或发送 \`${command}\` 查看可选项。`); return; }
  const available = probe.result;
  try {
    await validateLarkLaunchOptions(model ? { model: requested } : { reasoningEffort: requested }, probe.agent!, config.workspaceAliases, async () => available);
  } catch (error) { await fail(`**${larkCommandEcho(error instanceof Error ? error.message : String(error), 200)}**\n\n发送 \`${command}\` 查看可选项。`); return; }
  if (requested === (model ? session.model : session.reasoningEffort)) { await reply(`${command} 无需切换`, `**当前${label}已经是 \`${larkCommandEcho(requested, 64)}\`。**`); return; }
  let updated: Session;
  try {
    updated = await (model ? ctx.runtime.setModel!(session.id, requested) : ctx.runtime.setReasoningEffort!(session.id, requested));
  } catch (error) {
    const text = larkSessionConfigFailure(error, { command, label, flag, agent: agent.name ?? session.agentId });
    if (!text) throw error;
    await fail(text); return;
  }
  const pinned = await ctx.pinSwitchedSession(config, updated);
  await reply(`已切换${label}`, `**${label}已切换为 \`${larkCommandEcho(requested, 64)}\`。**\n\n原值：${current ? `\`${larkCommandEcho(current, 64)}\`` : 'Agent 默认'}。下一轮起使用新值。${pinned ? '' : '\n\n注意：没能保存会话绑定，服务重启后这个话题可能不会沿用当前会话。'}`);
}

async function executeRenameCommand(ctx: CommandContext,
  route: Extract<LarkCommandRoute, { kind: 'intent' }>, config: StoredLarkConfig, event: LarkMessageEvent, sessionId: string | undefined, reply: CommandContext['replyCard']
) {
  const fail = (markdown: string) => reply('/rename 未执行', markdown, { failed: true });
  const text = route.argsText;
  if (!text || text.startsWith('--') && text !== '--clear') { await fail('**用法：`/rename <名称>`；`/rename --clear` 恢复默认标题。**'); return; }
  // Web 改名要求安装管理员。飞书里与之对应的是安装管理员在机器人设置里配置的操作白名单（机器人所有者），
  // 受管理的群也一样；群管理员角色只管本群，不能改全局可见的会话名。未配置白名单时不开放。
  if (!larkTaskAgentAllowlistConfigured(config)) { await fail('未配置操作白名单时，飞书里不能执行 /rename，请在 Web 上改名。'); return; }
  if (!event.senderOpenId || !await ctx.isStaticOperatorAllowed(config, event.senderOpenId, event.chatId)) {
    await fail('当前账号无权改名：需要是机器人所有者（机器人设置里操作白名单中的人），群管理员不够（与 Web 改名需要安装管理员一致）。');
    return;
  }
  let name: string | null;
  try { name = text === '--clear' ? null : normalizeSessionName(text); }
  catch (error) {
    if (!(error instanceof RuntimeError)) throw error;
    await fail(`**名称不合法。**\n\n名称不能为空、不能换行，最长 ${SESSION_NAME_MAX_LENGTH} 个字符。`); return;
  }
  const session = sessionId ? await ctx.runtime.getSession(sessionId) : undefined;
  if (!session) { await fail('**当前话题还没有会话。**\n\n先发一条任务开始会话，再改名。'); return; }
  try { await ctx.runtime.setSessionName!(session.id, name); }
  catch (error) {
    if (!(error instanceof RuntimeError) || error.code !== 'INVALID_WORK_SESSION') throw error;
    await fail('**工作项管理的会话不能改名。**'); return;
  }
  const before = session.name ? `\`${escapeLarkPromptEcho(larkCommandEcho(session.name, 80))}\`` : '默认标题';
  await reply('已改名', name === null ? `**已恢复默认标题。**\n\n原名称：${before}。` : `**会话名称已改为 \`${escapeLarkPromptEcho(larkCommandEcho(name, 80))}\`。**\n\n原名称：${before}。Web、/tasks 和 /resume list 都显示新名称。`);
}

export const handleModel: ChatCommandHandler = async (ctx) => {
  const { event, config, sessionId, replyCard, route } = ctx;
  await executeSessionConfigCommand(ctx, route, config, event, sessionId, replyCard);
  return 'handled';
};

export const handleRename: ChatCommandHandler = async (ctx) => {
  const { event, config, sessionId, replyCard, route } = ctx;
  await executeRenameCommand(ctx, route, config, event, sessionId, replyCard);
  return 'handled';
};

export const handleResume: ChatCommandHandler = async (ctx) => {
  const { event, config, scopeId, group, sessionId, replyCard, route } = ctx;
  if (!ctx.runtime.resume || !ctx.cardMappings) throw new Error('当前运行时不支持恢复会话。可以用 /new --handoff。');
  if (route.args.length > 1 || (route.args[0]?.startsWith('--'))) throw new Error('用法：/resume [会话编号]；用 /resume list 查看最近关闭的会话。');
  const epoch = group.epoch ?? 0;
  const candidates = await ctx.closedScopeSessions(config, event, scopeId);
  if (route.args[0] === 'list') {
    await replyCard('最近关闭的会话', candidates.length ? candidates.slice(0, 5).map(({ session, title, closedAt, approximate }) => `\`${session.id}\` · ${closedAt}${approximate ? '（近似，按更新时间）' : ''} · ${session.agentId}\n${escapeLarkPromptEcho(larkCommandEcho(title, 100))}`).join('\n\n') + '\n\n发送 `/resume` 恢复最近一个，或 `/resume 会话编号` 选择。' : '本话题没有可恢复的已关闭会话。');
    return 'handled';
  }
  const target = route.args[0] ? candidates.find(item => item.session.id === route.args[0]) : candidates[0];
  if (!target) throw new Error('本话题没有这个可见的已关闭会话；发送 /resume list 查看可选会话。');
  const agent = (await ctx.runtime.listAgents?.())?.find(item => item.id === target.session.agentId);
  if (target.session.permissionMode !== larkPermissionMode(config)) throw new Error('旧会话的权限模式与机器人当前设置不同，不能恢复旧权限。请按当前权限用 /new --handoff 交接。');
  const unavailable = larkResumeUnavailable(target.session, agent);
  if (unavailable) throw new Error(unavailable);
  const denial = sessionId ? await ctx.currentTurnInterruptDenial(config, event, sessionId) : undefined;
  if (denial) throw new Error(denial);
  if (epoch !== (group.epoch ?? 0)) throw new Error('会话已发生变化，请重新发送恢复请求。');
  ctx.cancelUndeliveredRetries(group);
  await ctx.retireScopeSession(group, config, event, scopeId);
  const resumeEpoch = group.epoch;
  // Re-read after closing the current scope; a concurrent command must not resurrect a stale target.
  const current = await ctx.runtime.getSession(target.session.id);
  if (!current || current.archivedAt || !['stopped', 'failed'].includes(current.state) || resumeEpoch !== group.epoch) throw new Error('目标会话已发生变化，请重新选择。');
  const targetTask = { id: target.firstTaskId, sessionId: current.id };
  if (!(await ctx.larkTaskOrigin(config, event.chatId, targetTask))?.requester || !await ctx.isTaskOperatorAllowed(config, event, targetTask, 'run.resume')) throw new Error('当前账号没有恢复此会话的权限。');
  const restored = await ctx.runtime.resume(current.id);
  await ctx.runtime.trackMatterSession?.(restored.id, { sourceSessionId: current.id, relation: 'resume', title: target.title });
  if (resumeEpoch !== group.epoch) { await ctx.runtime.stop?.(restored.id, { kind: 'channel', id: event.senderOpenId!, appId: config.appId }); throw new Error('恢复期间会话已切换，请重新选择。'); }
  const sourceId = larkSourceId(config, event.chatId, event.chatType, scopeId);
  try {
    await ctx.cardMappings.save({ id: `lark-launch:${sourceId}`, channel: `lark-launch:${config.appId}`, externalId: sourceId,
      sessionId: restored.id, extra: JSON.stringify({ baseConfigKey: larkSessionConfigKey(config) }), createdAt: new Date().toISOString() });
  } catch (error) { await ctx.runtime.stop?.(restored.id, { kind: 'channel', id: event.senderOpenId!, appId: config.appId }); throw error; }
  group.retiredSessionIds?.delete(restored.id);
  group.sessionId = restored.id; group.sessionConfigKey = larkSessionConfigKey(config);
  await replyCard('会话已恢复', `已恢复会话 \`${restored.id}\`（${restored.agentId}）：${escapeLarkPromptEcho(larkCommandEcho(target.title, 100))}。下一条消息会接着原来的上下文。`);
  return 'handled';
};

export const handleFork: ChatCommandHandler = async (ctx) => {
  const { event, config, scopeId, group, sessionId, replyCard, route } = ctx;
  if (route.args.length === 1 && route.args[0] === 'list') {
    await ctx.replyForkList(config, event, sessionId, replyCard);
    return 'handled';
  }
  if (event.chatType !== 'group' && config.p2pMode !== 'thread') throw new Error('当前私聊整段共用一个会话，没有独立话题，不能并行开分身。请在机器人设置把私聊模式改成“每条消息一个话题”后再试。');
  if (!sessionId || !ctx.cardMappings || !ctx.inbox) throw new Error('当前没有可分身的会话，或未接入新话题存储。请先在此话题开始一个任务。');
  const source = await ctx.runtime.getSession(sessionId);
  if (!source || source.archivedAt || ['stopped', 'failed'].includes(source.state)) throw new Error('源会话已关闭，请先恢复它再开分身。');
  const tasks = await ctx.runtime.getTasks?.(source.id) ?? [];
  const first = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!first || !await ctx.isTaskOperatorAllowed(config, event, { id: first.id, sessionId: source.id }, 'task.view_result')) throw new Error('当前账号没有访问源会话的权限。');
  const requester = (await ctx.larkTaskOrigin(config, event.chatId, { id: first.id, sessionId: source.id }))?.requester;
  if (!requester || requester !== event.senderOpenId) throw new Error('分身沿用源会话的请求人，请由源会话的第一条任务发起人开分身；无法核实原请求人时不能开分身。');
  const request = parseLarkNewSession(route.argsText);
  if (request.handoff) throw new Error('/fork 自动继承上下文，无需 --handoff。');
  const sourceConfig = { ...config, defaultAgentWeights: undefined, defaultAgentId: source.agentId, defaultModel: source.model, defaultReasoningEffort: source.reasoningEffort, workspace: source.cwd };
  const explicit = request.launchOptions ? await ctx.validateNewSession(sourceConfig, event, request.launchOptions) : {};
  const switchingAgent = explicit.agentId !== undefined && explicit.agentId !== source.agentId;
  const agent = (await ctx.runtime.listAgents?.())?.find(item => item.id === source.agentId);
  if (!agent) throw new Error('找不到源会话的 Agent。');
  const cwd = explicit.cwd ?? source.cwd;
  const workspaceMode = await larkForkWorkspaceMode(cwd, explicit.workspaceMode);
  // A copied Codex rollout in the same cwd also carries its parent's marker.
  // Keep that case on handoff so later native discovery cannot choose the child as its parent.
  const nativeForkSessionId = (agent.adapterId ?? agent.id) === 'codex' && workspaceMode === 'shared' && cwd === source.cwd
    ? undefined : larkNativeForkId(source, agent, explicit.agentId ?? source.agentId);
  const launchOptions = { useAgentDefaults: true, agentId: source.agentId, cwd, ...(!switchingAgent && source.model ? { model: source.model } : {}), ...(!switchingAgent && source.reasoningEffort ? { reasoningEffort: source.reasoningEffort } : {}),
    workspaceMode, ...explicit,
    ...(nativeForkSessionId ? { nativeForkSessionId } : {}) };
  const handoff = await ctx.newSessionHandoff(config, event, source.id, tasks, '', Boolean(nativeForkSessionId));
  const context = nativeForkSessionId ? 'Agent 原生复制的会话上下文，以及来源与权限提示' : '最近结果、git 状态和备注交接（此 Agent/接入方式不支持原生复制，或源上下文尚未落盘）';
  const workspaceNote = launchOptions.workspaceMode === 'worktree' ? '分身使用独立 worktree，不含原会话未提交的改动；这些改动只列在 git 状态交接中。' : '分身与原会话共享目录，同时修改同一文件可能冲突。';
  const seed = await ctx.service.sendText({ chatId: event.chatId, text: `从会话 ${source.id} 分出的新话题。\n携带：${context}。\n${workspaceNote}\n任务：${escapeLarkPromptEcho(larkCommandEcho(request.prompt || '继续原会话的任务', 160))}`, idempotencyKey: `fork_${event.messageId}`.slice(0, 50) });
  const goal = request.prompt || '请先阅读继承的上下文，简短确认已接手并等待我的下一条任务。';
  const forkEvent: LarkMessageEvent = { ...event, messageId: seed.messageId, replyMessageId: undefined, rootId: seed.messageId, threadId: seed.messageId, content: JSON.stringify({ text: goal }), messageType: 'text', mentions: [] };
  const forkScope = `thread:${seed.messageId}`;
  const seeded = await ctx.inbox.seed(config.appId, forkEvent, { prompt: goal, scopeId: forkScope, resources: [], launchOptions,
    materialPrompt: `${handoff}\n\n${workspaceNote}\n\n${goal}` }, { lineage: { sessionId: source.id, relation: 'fork' } });
  if (!seeded) throw new Error('分身话题已存在，请在新话题继续。');
  await ctx.handle(forkEvent, config, false, true);
  // handle only schedules runTurn. Wait for startup/dispatch, not for the Agent's response.
  await ctx.groups.get(larkGroupKey(forkEvent, forkScope, config.appId))?.tail;
  const forkTask = ctx.tasks.get(seed.messageId);
  const started = Boolean(forkTask?.runtimeTaskId && !['failed', 'interrupted'].includes(forkTask.state));
  const messageLink = await ctx.service.getMessageLink(seed.messageId).catch(() => undefined);
  const jump = messageLink ? `[打开新话题](${messageLink})` : `飞书暂未返回跳转链接，请打开本聊天刚发出的分身话题（${seed.messageId}）`;
  await replyCard(started ? '已开分身' : '分身未启动', started
    ? `已在新话题开分身：${jump}。源会话 \`${source.id}\` 继续运行。`
    : `新话题已创建，但分身未启动：${jump}。请查看新话题中的失败原因。源会话 \`${source.id}\` 不受影响。`, { failed: !started });
  return 'handled';
};

export const handleNew: ChatCommandHandler = async (ctx) => {
  const { event, config, scopeId, group, sessionId, replyCard, route } = ctx;
  // /new 会停掉正在执行的那一轮：那一轮是别人的时，与进度卡「中断」同一口径拒绝。
  const denial = sessionId ? await ctx.currentTurnInterruptDenial(config, event, sessionId) : undefined;
  if (denial) {
    await replyCard('/new 未执行', `**/new 会中断正在执行的那一轮，而那一轮不是你的任务。**\n\n${denial}`, { failed: true });
    return 'handled';
  }
  // 任务内容随 /new 一起到达时，本条消息既要结束旧上下文、又要派发新任务。
  const request = parseLarkNewSession(route.argsText);
  const beforeValidation = group.epoch ?? 0;
  if (request.launchOptions) request.launchOptions = await ctx.validateNewSession(config, event, request.launchOptions);
  if (beforeValidation !== (group.epoch ?? 0)) throw new Error('已有更新的 /new 请求，请在新上下文中重新发送。');
  // 回执要写清 /new 停掉了什么：正在执行的那一轮、排队的条数、随旧会话停用的定时计划。先记下，停掉之后就读不到了。
  const before = sessionId && ctx.runtime.getTasks ? await ctx.runtime.getTasks(sessionId).catch(() => []) : [];
  const running = before.find(task => task.status === 'running');
  const runningOrigin = running ? await ctx.larkTaskOrigin(config, event.chatId, { id: running.id, sessionId: sessionId! }) : undefined;
  const queuedCount = before.filter(task => task.status === 'queued').length;
  const schedules = sessionId && ctx.automation
    ? (await ctx.automation.listBySession(sessionId, event.senderOpenId).catch(() => undefined))?.schedules.filter(item => item.enabled) ?? [] : [];
  // 交接要在结束旧会话之前读：结束之后它的任务和工作目录就不再归这个聊天。
  const handoff = request.handoff ? await ctx.newSessionHandoff(config, event, sessionId, before, request.handoff.note) : undefined;
  const cleanupWorkspace = sessionId && ctx.runtime.getWorkspace ? await ctx.runtime.getWorkspace(sessionId).catch(() => undefined) : undefined;
  ctx.cancelUndeliveredRetries(group);
  const retirement = ctx.retireScopeSession(group, config, event, scopeId);
  const epoch = group.epoch;
  const { retired, retained } = await retirement;
  const goal = request.prompt;
  if (handoff) {
    // 交接前缀只进 Agent 的首轮 prompt，卡片标题仍是任务本身；没给任务时首轮只确认接手。
    return { ...(sessionId ? { lineage: { sessionId, relation: 'handoff' as const } } : {}), prompt: goal || larkHandoffTitle, materialPrompt: `${handoff}\n\n${goal || larkHandoffAck}`,
      ...(request.launchOptions ? { launchOptions: request.launchOptions } : {}), epoch };
  }
  if (goal) {
    // reaction 仍挂在原消息上，交给随后的建任务链路按正常节奏撤销——
    // 这里不发命令回执，因为用户马上会收到这条新任务的进度卡。
    return { ...request, epoch };
  }
  const minutes = running ? Math.floor((Date.now() - (runningOrigin?.startedAt ?? Date.parse(running.createdAt))) / 60_000) : 0;
  const stopped = [
    running ? `已中断『${escapeLarkPromptEcho(larkCommandEcho(runningOrigin?.title ?? larkTaskTitle(running.prompt, config.name), 40))}』（${minutes >= 1 ? `已运行 ${minutes} 分钟` : '已运行不到 1 分钟'}）${queuedCount ? `，取消 ${queuedCount} 条排队` : ''}。`
      : queuedCount ? `已取消 ${queuedCount} 条排队。` : '',
    schedules.length ? `以下定时计划随旧会话停用：${schedules.map(item => escapeLarkPromptEcho(larkCommandEcho(item.name, 40))).join('、')}` : ''
  ].filter(Boolean).map(line => `${line}\n\n`).join('');
  const cleanupUrl = sessionId && cleanupWorkspace?.mode === 'worktree' && config.webBaseUrl
    ? safeLarkWebUrl(`${config.webBaseUrl.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}?panel=workspace`) : undefined;
  const cleanupNote = cleanupUrl ? `\n\n[检查并清理 worktree](${cleanupUrl})：在「工作目录」查看清理预览，确认后清理；正在使用或有未提交改动时不能清理。` : '';
  await replyCard(
    '/new 已受理',
    retained
      ? `**下一条消息将开启全新上下文。**\n\n原会话的执行进程尚未确认停止，没有结束它，之后的消息也不再进入它。${larkRecoveryRetainedNote(config.webBaseUrl)}`
      : retired
      ? `**已结束当前会话，下一条消息将开启全新上下文。**\n\n${stopped}历史记录仍可在 Dutydeck Web 查看。${cleanupNote}`
      : '**当前没有已绑定的会话，下一条消息会直接开启新会话。**'
  );
  return 'handled';
};
