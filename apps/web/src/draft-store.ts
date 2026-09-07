import { create } from 'zustand';
import type { RoleChange } from './api';

/**
 * 跨视图存活的编辑草稿。
 *
 * ## 为什么不放在组件的 useState 里
 *
 * 机器人页与群聊页都是 <main> 里按 primaryNav 分派的一级视图，切换即卸载。
 * 草稿留在组件 state 里的话，「改了目录 → 切去任务看一眼 → 切回来」就会静默
 * 丢掉用户填的东西——契约要求的是「切换对象、失败与冲突均不丢草稿」，其中
 * 「切换」包含切走整个视图。
 *
 * 用 store 而不是把 state 提到 App 里：App 已经承担了路由、任务流、快捷键三件事，
 * 再塞两张按对象分键的草稿表会让它更难读，而 store 天然是模块级、不随任何组件
 * 卸载。测试之间要显式 reset（下面的 resetDrafts）。
 *
 * ## 键的形状
 *
 * Bot 草稿按 appId 分键；群内 Bot 草稿按 `${groupKey}:${appId}` 分键——**用群 key
 * 而不是 chatId**：chatId 只在单个租户内唯一，跨租户同 ID 会让两个群共用一份草稿。
 */

export type BotDraft = {
  /**
   * 开始编辑这一份草稿时看到的版本号。
   *
   * 保存时必须用它，**不能用当下 activeBot.revision**：后台每 30 秒会刷新一次
   * lark-config，别人在这期间保存过的话 activeBot.revision 已经变成新的了，
   * 拿它当 expectedRevision 提交，CAS 会认为「你看到的就是最新版」而放行——
   * 用户会在毫不知情的情况下覆盖掉别人的修改。这个字段就是「我编辑的是哪一版」。
   */
  baseRevision?: number;
  workspace: string;
  defaultAgentId: string;
  defaultModel: string;
  defaultReasoningEffort: string;
  p2pMode: 'chat' | 'thread';
  groupReplyMode: '' | 'chat' | 'shared' | 'new-topic' | 'chat-topic';
  mentionPolicy: 'always' | 'topic' | 'never' | 'ambient';
  preInjectPrompt: string;
  listening: boolean;
  groupToolsEnabled: boolean;
  groupToolsAllowSend: boolean;
  riskControlMode: 'off' | 'guidance' | 'enforced';
  highRiskPattern: string;
};

/** 群内 Bot 的访问范围。与 shared 的 accessOverride.mode 一一对应，不另造取值。 */
export type GroupAccessMode = 'inherit' | 'owner_only' | 'allowlist' | 'all_chat_members' | 'disabled';

export type GroupBotDraft = {
  /** 开始编辑时这条群绑定的版本号；0 表示当时还没有绑定。理由同 BotDraft.baseRevision。 */
  baseRevision: number;
  agentMode: 'inherit' | 'set';
  agentValue: string;
  workspaceMode: 'inherit' | 'set';
  workspaceValue: string;
  modelMode: 'inherit' | 'clear' | 'set';
  modelValue: string;
  reasoningMode: 'inherit' | 'clear' | 'set';
  reasoningValue: string;
  groupReplyMode: 'inherit' | 'chat' | 'shared' | 'new-topic' | 'chat-topic';
  mentionPolicy: 'inherit' | 'always' | 'topic' | 'never' | 'ambient';
  accessMode: GroupAccessMode;
  accessPrincipalIds: string[];
  oncall: boolean;
  toolRead: 'inherit' | 'allow' | 'deny';
  toolDiscover: 'inherit' | 'allow' | 'deny';
  toolSend: 'inherit' | 'allow' | 'deny';
  roleChanges: RoleChange[];
};

type DraftStore = {
  botDrafts: Record<string, BotDraft>;
  groupBotDrafts: Record<string, GroupBotDraft>;
  /** 保存冲突。保留住是为了在用户切回来时仍然看到「为什么没保存成功」。 */
  botConflicts: Record<string, string>;
  groupBotConflicts: Record<string, string>;
  setBotDraft(appId: string, draft: BotDraft): void;
  clearBotDraft(appId: string): void;
  setBotConflict(appId: string, message?: string): void;
  setGroupBotDraft(key: string, draft: GroupBotDraft): void;
  clearGroupBotDraft(key: string): void;
  setGroupBotConflict(key: string, message?: string): void;
};

const withoutKey = <T,>(map: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
};

export const useDraftStore = create<DraftStore>(set => ({
  botDrafts: {},
  groupBotDrafts: {},
  botConflicts: {},
  groupBotConflicts: {},
  setBotDraft: (appId, draft) => set(state => ({ botDrafts: { ...state.botDrafts, [appId]: draft } })),
  clearBotDraft: appId => set(state => ({ botDrafts: withoutKey(state.botDrafts, appId), botConflicts: withoutKey(state.botConflicts, appId) })),
  setBotConflict: (appId, message) => set(state => ({ botConflicts: message ? { ...state.botConflicts, [appId]: message } : withoutKey(state.botConflicts, appId) })),
  setGroupBotDraft: (key, draft) => set(state => ({ groupBotDrafts: { ...state.groupBotDrafts, [key]: draft } })),
  clearGroupBotDraft: key => set(state => ({ groupBotDrafts: withoutKey(state.groupBotDrafts, key), groupBotConflicts: withoutKey(state.groupBotConflicts, key) })),
  setGroupBotConflict: (key, message) => set(state => ({ groupBotConflicts: message ? { ...state.groupBotConflicts, [key]: message } : withoutKey(state.groupBotConflicts, key) }))
}));

/** 测试之间清空。store 是模块级的，不清会让用例互相串草稿。 */
export const resetDrafts = () => useDraftStore.setState({ botDrafts: {}, groupBotDrafts: {}, botConflicts: {}, groupBotConflicts: {} });
