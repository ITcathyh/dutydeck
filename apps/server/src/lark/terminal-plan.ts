import { planTaskOf } from '../plan-mode.js';
import { larkFallbackNoteElements } from './agent-fallback.js';
import { isBotSenderType } from './card-mentions.js';
import type { StoredLarkConfig } from './config.js';
import { larkNotice } from './notify-tier.js';
import { persistedMessageAnchor, persistedReplyTarget } from './persisted-card-task.js';
import { larkCompletionReactionOnly, larkResultKey, larkSilentResultAnchor } from './result-delivery.js';
import { larkTaskAgentGuid } from './task-agent.js';
import type { PersistedLarkCardTask } from './turn-record.js';

export type TerminalState = 'completed' | 'failed' | 'interrupted' | 'cancelled';
type TerminalFacts = {
  state: TerminalState; now: number; explicit?: boolean; quiet?: boolean; hasReport?: boolean; steered?: boolean;
  interruptedByUser?: boolean; receiptOnly?: boolean; resultDue?: boolean;
};

/** Both executors use the effective group settings and the same visible message anchor. */
export function planTerminalDelivery(record: PersistedLarkCardTask, messageId: string, config: StoredLarkConfig, facts: TerminalFacts) {
  const completed = facts.state === 'completed';
  const delivered = record.final_delivery_state === 'reaction' || record.final_delivery_state === 'delivered' && Boolean(record.final_message_id);
  const reactionOnly = completed && !facts.explicit && !facts.hasReport && !record.fallback_note && larkCompletionReactionOnly(config, record.prompt, messageId);
  const kind = facts.quiet ? 'quiet' : delivered ? 'delivered' : facts.receiptOnly ? 'receipt_only'
    : facts.resultDue === false || record.final_delivery_state === 'failed' ? 'wait' : reactionOnly ? 'reaction' : 'result';
  const anchor = persistedMessageAnchor(record, messageId);
  const mention = larkNotice('result', config, {
    chatType: record.chat_type, senderType: record.sender_type, senderOpenId: record.sender_open_id
  }, facts.now).mention;
  const reaction = kind === 'reaction' || kind === 'result' && facts.state !== 'cancelled' && !facts.interruptedByUser && !larkTaskAgentGuid(messageId)
    ? { appId: record.app_id, messageId: anchor, completed } : undefined;
  return {
    kind, reaction, target: persistedReplyTarget(record),
    closeProcess: Boolean(record.card_message_id) && !record.progress_frozen,
    resultFollows: kind === 'result' || kind === 'delivered' && record.final_delivery_state === 'delivered',
    key: larkResultKey(record.card_message_id ?? larkSilentResultAnchor(messageId, record.turn)),
    mention, mentionElements: mention ? [{ tag: 'markdown', element_id: 'group_mention', content: mention }] : [],
    fallbackElements: larkFallbackNoteElements(record.fallback_note),
    polish: completed && !facts.explicit && !facts.steered && planTaskOf(record.prompt) === undefined && !isBotSenderType(record.sender_type)
  };
}
