import type { Agent } from './api';
import { supportsModelServiceSettings } from './agent-model-support';
import type { CommandAction } from './components/CommandPalette';
import type { OverlayRoute } from './app-route';

/** Form labels and stable destinations; values and credentials are never indexed. */
export const modelSettingFields = {
  model: { label: '默认模型', botKey: 'defaultModel' },
  baseUrl: { label: '服务地址', botKey: 'modelBaseUrl' },
  authMode: { label: '认证方式', botKey: 'modelAuthMode' },
  apiKey: { label: 'API Key', botKey: 'modelApiKey' }
} as const;
export const modelSettingAnchor = (agentId: string, key: keyof typeof modelSettingFields) => `model-${encodeURIComponent(agentId)}-${key}`;
export const botSettingFields = {
  modelBaseUrl: { label: modelSettingFields.baseUrl.label, step: 2, anchor: 'bot-setting-modelBaseUrl', parent: 'defaultAgentId' },
  modelAuthMode: { label: modelSettingFields.authMode.label, step: 2, anchor: 'bot-setting-modelAuthMode', parent: 'defaultAgentId' },
  modelApiKey: { label: modelSettingFields.apiKey.label, step: 2, anchor: 'bot-setting-modelApiKey', parent: 'defaultAgentId' },
  appId: {label: 'App ID', step: 1, anchor: 'bot-setting-appId'},
  appSecret: {label: 'App Secret', step: 1, anchor: 'bot-setting-appSecret'},
  workspace: {label: '默认工作区', step: 1, anchor: 'bot-setting-workspace'},
  webBaseUrl: {label: 'Web 访问地址（可选）', step: 1, anchor: 'bot-setting-webBaseUrl'},
  verificationCommand: {label: '验证命令（可选）', step: 1, anchor: 'bot-setting-verificationCommand'},
  notifyQuietHours: {label: '免打扰时段（可选）', step: 1, anchor: 'bot-setting-notifyQuietHours'},
  urgentThresholdSeconds: {label: '加急前等待（秒）', step: 1, anchor: 'bot-setting-urgentThresholdSeconds', parent: 'urgentEnabled'},
  urgentMaxPerHourPerChat: {label: '每群每小时最多加急', step: 1, anchor: 'bot-setting-urgentMaxPerHourPerChat', parent: 'urgentEnabled'},
  pinAfterSeconds: {label: '跑多久算长任务（秒）', step: 1, anchor: 'bot-setting-pinAfterSeconds', parent: 'pinLongTasks'},
  pushIntervalMs: {label: '飞书推送间隔', step: 1, anchor: 'bot-setting-pushIntervalMs'},
  traceLimit: {label: 'Trace 阶段上限', step: 1, anchor: 'bot-setting-traceLimit'},
  defaultAgentWeights: {label: 'Agent 分流权重（可选）', step: 2, anchor: 'bot-setting-defaultAgentWeights'},
  defaultModel: {label: '默认模型', step: 2, anchor: 'bot-setting-defaultModel', parent: 'defaultAgentId'},
  permissionMode: {label: '操作确认方式', step: 2, anchor: 'bot-setting-permissionMode'},
  preInjectPrompt: {label: '预注入 Prompt（可选，默认空）', step: 2, anchor: 'bot-setting-preInjectPrompt'},
  decisionAgentId: {label: '群判定 Agent', step: 2, anchor: 'bot-setting-decisionAgentId'},
  decisionModel: {label: '群判定模型', step: 2, anchor: 'bot-setting-decisionModel'},
  responseAgentId: {label: '群回复 Agent', step: 2, anchor: 'bot-setting-responseAgentId', keywords: '回复方式'},
  responseModel: {label: '群回复模型', step: 2, anchor: 'bot-setting-responseModel', keywords: '回复方式'},
  groupMemoryScope: {label: '群记忆范围', step: 2, anchor: 'bot-setting-groupMemoryScope', parent: 'memoryEnabled'},
  memoryAgentId: {label: '整理 Agent', step: 2, anchor: 'bot-setting-memoryAgentId', parent: 'memoryEnabled'},
  memoryModel: {label: '整理模型', step: 2, anchor: 'bot-setting-memoryModel', parent: 'memoryEnabled'},
  riskControlMode: {label: '风险控制', step: 2, anchor: 'bot-setting-riskControlMode'},
  highRiskPattern: {label: '高危操作正则表达式', step: 2, anchor: 'bot-setting-highRiskPattern', parent: 'riskControlMode'},
  webMobileReachable: {label: '手机能打开这个地址', step: 1, anchor: 'lark-switch-web-mobile'},
  structuredAskCards: {label: '结构化问答卡片（默认开启）', step: 1, anchor: 'lark-switch-structured-ask'},
  compactTrace: {label: '精简过程卡（默认开启）', step: 1, anchor: 'lark-switch-compact-trace'},
  showAgentName: {label: '卡片显示 Agent 名称（默认关闭）', step: 1, anchor: 'lark-switch-agent-name'},
  groupCardMention: {label: '群卡片 @ 发起人（默认开启）', step: 1, anchor: 'lark-switch-group-mention'},
  notifyMentionAction: {label: '需要你操作的消息 @ 发起人（默认开启）', step: 1, anchor: 'lark-switch-notify-action', parent: 'groupCardMention'},
  notifyMentionDone: {label: '完成通知 @ 发起人（默认开启）', step: 1, anchor: 'lark-switch-notify-done', parent: 'groupCardMention'},
  completionReactionOnly: {label: '完成时只贴表情、不发结果卡（默认关闭）', step: 1, anchor: 'lark-switch-completion-reaction', keywords: '回复方式'},
  silentProgress: {label: '中间进展静默（默认关闭）', step: 1, anchor: 'lark-switch-silent-progress', keywords: '回复方式'},
  urgentEnabled: {label: '长时间没人处理时发加急（默认关闭）', step: 1, anchor: 'lark-switch-urgent'},
  pinLongTasks: {label: '长任务进度卡置顶（默认关闭）', step: 1, anchor: 'lark-switch-pin'},
  peerBotsAllowed: {label: '群协作 peer 机器人默认放行', step: 1, anchor: 'lark-switch-peer-bots'},
  listening: {label: '监听飞书消息', step: 2, anchor: 'lark-switch-listening'},
  groupToolsEnabled: {label: '启用 Agent 群协作工具', step: 2, anchor: 'lark-switch-group-tools'},
  groupToolsAllowSend: {label: '允许 Agent 发消息与 @交接', step: 2, anchor: 'lark-switch-group-send', parent: 'groupToolsEnabled'},
  busyTriage: {label: '忙时先判断', step: 2, anchor: 'lark-switch-busy-triage'},
  botLoopGuard: {label: '机器人互聊门禁（默认关闭）', step: 2, anchor: 'lark-switch-bot-loop-guard'},
  memoryEnabled: {label: '启用会话记忆', step: 2, anchor: 'lark-switch-memory'},
  memoryAutoExtract: {label: '自动提取与整理', step: 2, anchor: 'lark-switch-memory-auto', parent: 'memoryEnabled'},
  workspaceAliases: {label: '工作区别名（可选）', step: 1, anchor: 'bot-setting-workspaceAliases'},
  allowedUserNames: {label: '可使用机器人的成员', step: 1, anchor: 'bot-setting-allowedUserNames'},
  allowedBotNames: {label: '可调用机器人的其他机器人', step: 1, anchor: 'bot-setting-allowedBotNames'},
  defaultAgentId: {label: '默认 Agent', step: 2, anchor: 'bot-setting-defaultAgentId'},
  fallbackAgentId: {label: '兜底 Agent', step: 2, anchor: 'bot-setting-fallbackAgentId'},
  defaultReasoningEffort: {label: '推理强度', step: 2, anchor: 'bot-setting-defaultReasoningEffort', parent: 'defaultAgentId'},
  highRiskAllowedUserNames: {label: '允许执行高危操作的成员', step: 2, anchor: 'bot-setting-highRiskAllowedUserNames', parent: 'riskControlMode'},
  fallbackModel: {label: '兜底模型', step: 2, anchor: 'setup-fallback-model', parent: 'fallbackAgentId'},
  fullTrustConfirmed: {label: '确认飞书任务以 full-trust 运行', step: 2, anchor: 'bot-setting-fullTrustConfirmed', parent: 'permissionMode'},
} as const;
export type BotSettingField = keyof typeof botSettingFields;

export const globalSettingFields = {
  terminalBackend: { label: '主终端后端', section: 'agents', anchor: 'global-setting-terminalBackend' }
} as const;


/** Fields owned by the persistent Bot detail draft, rather than the connection wizard. */
export const botDetailFields = {
  p2pMode: { label: '私聊时', anchor: 'bot-p2p-mode', keywords: '回复方式' },
  groupReplyMode: { label: '群里回复到哪', anchor: 'bot-group-reply', keywords: '回复方式' },
  participationLevel: { label: '群里接话方式', anchor: 'bot-participation-level' },
  mentionPolicy: { label: '群里怎样才唤醒', anchor: 'bot-mention' },
  defaultGroupParticipation: { label: '默认群参与模式', anchor: 'bot-default-group-participation' },
  idleCompactEnabled: { label: '空闲后自动压缩上下文', anchor: 'bot-idle-compact' },
  idleCompactHours: { label: '空闲时长（小时）', anchor: 'bot-idle-hours' },
  executionMode: { label: '执行方式', anchor: 'bot-execution-mode' },
  leaderAgentId: { label: 'Leader Agent', anchor: 'bot-leader-agent', parent: 'executionMode' },
  workerAgentIds: { label: 'Worker Agent（最多 8 个）', anchor: 'bot-worker-agents', parent: 'executionMode' },
  adhdMode: { label: 'ADHD 友好输出', anchor: 'bot-adhd-mode', keywords: '回复方式' },
  roleTitle: { label: '角色名称', anchor: 'bot-role-title' },
  roleScope: { label: '负责范围', anchor: 'bot-role-scope' }
} as const;
export type SettingsDestination = OverlayRoute | { kind: 'bot-settings'; appId: string; field: string };

export function settingsSearchActions(bots: Array<{ appId: string; name: string }>, navigate: (route: SettingsDestination) => void, agents: Agent[] = []): CommandAction[] {
  return [
    ...agents.filter(agent => supportsModelServiceSettings(agent, agent.id)).flatMap(agent => Object.entries(modelSettingFields).map(([key, definition]) => ({ id: `settings-model-${agent.id}-${key}`, label: `全局设置 · ${agent.name} · ${definition.label}`, hint: '作用域：当前实例的 Agent 默认配置', group: '具体设置', keywords: `global settings model ${key} ${agent.id}`, searchOnly: true, run: () => navigate({ kind: 'settings', section: 'agents', field: modelSettingAnchor(agent.id, key as keyof typeof modelSettingFields) }) }))),
    ...Object.entries(globalSettingFields).map(([field, definition]) => ({ id: `settings-global-${field}`, label: `全局设置 · ${definition.label}`, hint: '作用域：当前实例', group: '具体设置', keywords: `global settings ${field}`, searchOnly: true, run: () => navigate({ kind: 'settings', section: definition.section, field }) })),
    ...bots.flatMap(bot => [
      ...Object.entries(botDetailFields).map(([field, definition]) => ({ id: `settings-detail-${bot.appId}-${field}`, label: `${bot.name} · ${definition.label}`, hint: `作用域：机器人 ${bot.appId}`, group: '具体设置', keywords: `${bot.appId} bot 设置 配置 ${field} ${'keywords' in definition ? definition.keywords : ''}`, searchOnly: true, run: () => navigate({ kind: 'bot-settings', appId: bot.appId, field }) })),
      { id: `settings-bot-${bot.appId}`, label: `机器人 · ${bot.name}`, hint: `作用域：机器人 ${bot.appId}`, group: '机器人', keywords: `${bot.appId} bot 配置 设置`, searchOnly: true, run: () => navigate({ kind: 'lark-setup', target: { appId: bot.appId } }) },
      ...Object.entries(botSettingFields).map(([field, definition]) => ({ id: `settings-bot-${bot.appId}-${field}`, label: `${bot.name} · ${definition.label}`, hint: `作用域：机器人 ${bot.appId}`, group: '具体设置', keywords: `${bot.appId} bot 设置 配置 ${field} ${'keywords' in definition ? definition.keywords : ''}`, searchOnly: true, run: () => navigate({ kind: 'lark-setup', target: { appId: bot.appId }, field }) }))
    ])
  ];
}

/** Open existing disclosure panels; focusing never changes a saved setting. */
export function focusSettingField(root: HTMLElement, anchor: string): boolean {
  const target = Array.from(root.querySelectorAll<HTMLElement>('[id]')).find(node => node.id === anchor);
  if (!target) return false;
  for (let parent = target.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  target.scrollIntoView?.({ block: 'center' });
  target.focus({ preventScroll: true });
  return true;
}
