// 飞书入站消息「醒不醒」的判定：纯函数，不读配置、不查库。
//
// 调用方先算好要 I/O 的事实（读配置、话题归属、续接判断），按两步调用：
// 1. wakeSignals：交给群参与观察之前，算出是否在叫本机器人、要不要按老规则唤醒，以及交给群参与的输入；
// 2. decideWake：拿到群参与的结果后，决定唤醒、让给群参与，还是不响应，并给出原因。

export type WakeMentionPolicy = 'always' | 'topic' | 'never' | 'ambient';

export interface WakeFacts {
  chatType: string;
  /** 发送者是机器人（app / bot）。 */
  botSender: boolean;
  mentionsBot: boolean;
  /** 消息里有任何 @，包括 @ 本机器人。 */
  hasMentions: boolean;
  /** 消息引用了一个还在等待的工作流交互。 */
  quotedWorkflow: boolean;
  /** 群参与判为 act、告警初筛或恢复时按显式请求受理。 */
  adopted: boolean;
  recovering: boolean;
  /** 已识别的斜杠命令。 */
  recognizedCommand: boolean;
  /** 本群生效的唤醒方式（已含群覆盖和旧配置默认值）。 */
  mentionPolicy: WakeMentionPolicy;
  /** 消息在本机器人接手的话题里（含续接了发起人顶层会话的话题）。 */
  ownedTopic: boolean;
  /** 告警初筛派来的消息：不经群参与观察，也不过机器人回合门禁。 */
  triage: boolean;
  /** 发起人在同一话题里直接回复仍在等待的提问。 */
  pendingAskContinuation: boolean;
  /** 发起人在自己请求的话题里免 @ 续说。 */
  requestContinuation: boolean;
}

export type WakeExplicitFacts = Pick<WakeFacts, 'chatType' | 'botSender' | 'mentionsBot' | 'quotedWorkflow' | 'adopted'>;

export interface WakeSignals {
  /** 真人明确在叫本机器人：私聊、@、引用工作流或已受理。 */
  explicit: boolean;
  /** 在叫本机器人，含免 @ 续说自己的请求。 */
  addressed: boolean;
  /** 不经群参与也会唤醒的老规则。 */
  legacyWake: boolean;
  /** 会唤醒的已识别命令：沿用原有唤醒和授权规则。 */
  commandInteraction: boolean;
  /** 交给群参与观察的输入。 */
  participation: { explicit: boolean; addressed: boolean; ownedTopic: boolean };
}

export type WakeReason =
  | 'quoted_workflow' | 'p2p' | 'mention' | 'continued_topic' | 'never_policy' | 'ambient_open'
  | 'adopted' | 'pending_ask' | 'request_continuation';

export type WakeDecision =
  | { wake: true; reason: WakeReason; /** 群聊里要先过机器人回合门禁。 */ guardBotTurn: boolean }
  | { wake: false; reason: 'participation_handled' | 'participation_observes' | 'not_addressed' };

export function isExplicitWake(facts: WakeExplicitFacts): boolean {
  return !facts.botSender && (facts.chatType === 'p2p' || facts.mentionsBot || facts.quotedWorkflow || facts.adopted);
}

function legacyWakeReason(facts: WakeFacts): WakeReason | undefined {
  if (facts.quotedWorkflow) return 'quoted_workflow';
  if (facts.chatType === 'p2p') return 'p2p';
  if (facts.chatType !== 'group') return undefined;
  if (facts.mentionsBot) return 'mention';
  if (facts.botSender) return undefined;
  // 按需、积极档的接手话题只交给群参与规则，不直接唤醒。
  if (facts.mentionPolicy === 'topic' && facts.ownedTopic) return 'continued_topic';
  if (facts.mentionPolicy === 'never') return 'never_policy';
  // ambient 与 never 的区别在这里：ambient 在消息指名了别人时让路，只接没有指名任何人的消息。
  // 走到这里已排除 mentionsBot，所以出现的任何 mention 都是「点了别人」。
  if (facts.mentionPolicy === 'ambient' && !facts.hasMentions) return 'ambient_open';
  return undefined;
}

export function wakeSignals(facts: WakeFacts): WakeSignals {
  const explicit = isExplicitWake(facts);
  const legacyWake = legacyWakeReason(facts) !== undefined;
  // Known commands retain their existing wake and authorization rules; unknown /paths remain material.
  const commandInteraction = !facts.botSender && facts.recognizedCommand && legacyWake;
  const addressed = explicit || facts.requestContinuation;
  // 话题内免 @ 续聊也算在叫它，可以直接改档或问「为什么没回」；是否接手仍按老规则。
  const topicContinuation = facts.ownedTopic && !facts.botSender;
  return {
    explicit, addressed, legacyWake, commandInteraction,
    participation: {
      explicit: addressed || facts.pendingAskContinuation || commandInteraction,
      addressed: (addressed || topicContinuation) && !facts.recognizedCommand && !facts.recovering,
      ownedTopic: topicContinuation
    }
  };
}

/** participation 为 undefined 表示没交给群参与（告警初筛或没接群参与）。 */
export function decideWake(facts: WakeFacts, participation?: { enabled: boolean; handled?: boolean }): WakeDecision {
  const signals = wakeSignals(facts);
  // 改档短语、「为什么没回」已由群参与直接回应；「没问你」这类纠正只记录，不当成新请求。
  if (participation?.handled) return { wake: false, reason: 'participation_handled' };
  // 定向机器人交接仍走下方循环门禁和访问授权，不作为人类显式指令或主动判定。
  if (participation?.enabled && !signals.addressed && !facts.pendingAskContinuation && !signals.commandInteraction && !(facts.botSender && signals.legacyWake)) {
    return { wake: false, reason: 'participation_observes' };
  }
  const reason = legacyWakeReason(facts)
    ?? (facts.adopted ? 'adopted' : facts.pendingAskContinuation ? 'pending_ask' : participation?.enabled && facts.requestContinuation ? 'request_continuation' : undefined);
  if (!reason) return { wake: false, reason: 'not_addressed' };
  return { wake: true, reason, guardBotTurn: facts.chatType === 'group' && !facts.triage };
}
