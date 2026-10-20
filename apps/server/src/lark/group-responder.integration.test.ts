import { afterEach, describe, expect, it, vi } from 'vitest';
import { deciderMetaOf } from '@dutydeck/shared';
import { responderClaimText, responderReleaseText } from './group-responder.js';
import { createAlarmHarness, waitFor, type AlarmHarness } from './scenario-pack.test-helpers.js';
import type { LarkMessageEvent } from './listener.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const responder = { appId: 'cli_current_responder', openId: 'ou_current_responder', name: 'Responder' };
const alarm = { appId: 'cli_alarm_source', openId: 'ou_alarm_source', name: 'Alarm' };
const harness = async () => {
  const h = await createAlarmHarness({ participation: 'eager', bots: [responder, alarm] });
  cleanups.push(() => h.close());
  return h;
};
const deliver = async (h: AlarmHarness, event: LarkMessageEvent) => { await h.receive(event); await h.settle(event.messageId); };
const announcement = (h: AlarmHarness, id: string, kind: 'claim' | 'release', at: number) => h.fromBot(responder, {
  messageId: id, content: JSON.stringify({ text: kind === 'claim' ? responderClaimText(responder.name) : responderReleaseText(responder.name) }), createTime: String(at)
});
const notify = (h: AlarmHarness, id: string) => h.fromBot(alarm, { messageId: id, content: JSON.stringify({ text: `【P1】${id}` }), createTime: String(Date.now()) });

describe('durable responder announcements', () => {
  it('preserves a newer claim when an old release arrives for the first time and keeps direct alarms suppressed', async () => {
    const h = await harness();
    const at = Date.now() - 10_000;
    await h.subscribe({ sources: [{ appId: alarm.appId, name: alarm.name }] });
    await deliver(h, announcement(h, 'om_claim', 'claim', at + 3_000));
    const claimed = await h.repos.collaboration.getDuty(h.scope);
    expect(claimed.responder).toMatchObject({ appId: responder.appId, since: new Date(at + 3_000).toISOString() });
    await deliver(h, notify(h, 'om_alarm_before'));
    expect((await h.alarmDecisionFor('om_alarm_before'))?.outcome).toBe('not_responder');
    await deliver(h, announcement(h, 'om_late_release', 'release', at + 2_000));
    expect(await h.repos.collaboration.getDuty(h.scope)).toEqual(claimed);
    expect((await h.inboxRecord('om_late_release'))?.state).toBe('ignored');
    await deliver(h, notify(h, 'om_alarm_after'));
    expect((await h.alarmDecisionFor('om_alarm_after'))?.outcome).toBe('not_responder');
    expect(h.dispatched).toEqual([]);
    expect(h.prompts).toEqual([]);
  });

  it('preserves a reclaimed responder when a failed release is retried by the inbound recovery timer', async () => {
    const h = await harness();
    const at = Date.now() - 10_000;
    await deliver(h, announcement(h, 'om_first_claim', 'claim', at + 1_000));
    const release = announcement(h, 'om_retry_release', 'release', at + 2_000);
    const observe = h.repos.collaboration.observe.bind(h.repos.collaboration);
    let failed = false;
    vi.spyOn(h.repos.collaboration, 'observe').mockImplementation(async input => {
      if (input.eventId === release.messageId && !failed) { failed = true; throw new Error('temporary observation failure after responder sync'); }
      return observe(input);
    });
    await h.receive(release);
    await waitFor(async () => failed && (await h.inboxRecord(release.messageId))?.state === 'unrouted');
    expect((await h.repos.collaboration.getDuty(h.scope)).responder).toBeUndefined();
    await deliver(h, announcement(h, 'om_reclaim', 'claim', at + 3_000));
    const reclaimed = await h.repos.collaboration.getDuty(h.scope);
    expect(reclaimed.responder?.appId).toBe(responder.appId);
    // This is the coordinator's actual scheduled recovery, without private method calls.
    await waitFor(async () => (await h.inboxRecord(release.messageId))?.state === 'ignored', 35_000);
    expect(failed).toBe(true);
    expect(await h.repos.collaboration.getDuty(h.scope)).toEqual(reclaimed);
    expect(h.dispatched).toEqual([]);
    expect(h.prompts).toEqual([]);
  }, 40_000);

  it.each([0, 1_000])('allows a current release (offset %i), preserves inbox dedup, and retains the ambient no-responder guard', async offset => {
    const h = await harness();
    const at = Date.now() - 10_000;
    await h.subscribe({ sources: [{ appId: alarm.appId, name: alarm.name }] });
    await deliver(h, announcement(h, 'om_current_claim', 'claim', at + 1_000));
    const release = announcement(h, 'om_current_release', 'release', at + 1_000 + offset);
    await deliver(h, release);
    expect((await h.repos.collaboration.getDuty(h.scope)).responder).toBeUndefined();
    await deliver(h, h.fromUser({ messageId: 'om_ambient', text: '今天下午三点发版' }));
    const ambient = (await h.repos.collaboration.listDecisions(h.scope)).find(item => (item.inputSnapshot as { decider?: { trigger?: { messageId?: string } } }).decider?.trigger?.messageId === 'om_ambient');
    expect(deciderMetaOf(ambient!)).toMatchObject({ kind: 'rule', rule: 'no_responder' });
    expect(h.dispatched).toEqual([]);
    await deliver(h, notify(h, 'om_alarm_without_responder'));
    expect((await h.alarmDecisionFor('om_alarm_without_responder'))?.outcome).toBe('triaged');
    expect(h.dispatched.map(event => event.messageId)).toEqual(['om_alarm_without_responder']);
    expect(h.prompts).toHaveLength(1);
    await deliver(h, announcement(h, 'om_current_reclaim', 'claim', at + 3_000));
    const reclaimed = await h.repos.collaboration.getDuty(h.scope);
    await deliver(h, release);
    expect((await h.inboxRecord(release.messageId))?.state).toBe('ignored');
    expect(await h.repos.collaboration.getDuty(h.scope)).toEqual(reclaimed);
  });

  it('ignores releases with no responder and releases sent by a different bot', async () => {
    const h = await harness();
    const at = Date.now() - 10_000;
    const empty = await h.repos.collaboration.getDuty(h.scope);
    await deliver(h, announcement(h, 'om_empty_release', 'release', at));
    expect(await h.repos.collaboration.getDuty(h.scope)).toEqual(empty);
    await deliver(h, announcement(h, 'om_other_claim', 'claim', at + 1_000));
    const claimed = await h.repos.collaboration.getDuty(h.scope);
    await deliver(h, h.fromBot(alarm, { messageId: 'om_foreign_release', content: JSON.stringify({ text: responderReleaseText(alarm.name) }), createTime: String(at + 2_000) }));
    expect(await h.repos.collaboration.getDuty(h.scope)).toEqual(claimed);
  });
});
