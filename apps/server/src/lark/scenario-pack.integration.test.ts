// 场景包的全链路集成测试（场景包设计 9.3 第 1–3 项）。
// 组装见 scenario-pack.test-helpers.ts：真实 DutydeckRuntime（mock driver）+ SQLite + LarkMessageCoordinator + LarkGroupParticipation，
// 飞书 service 是内存实现，判定器是恒为 silent 的桩。
// 这些断言要在 P3 把告警移到场景包之后照样成立：判定记录、派发事件、订阅、确认单、卡片关联行、prompt 片段都经 test-helpers 的投影函数比较（第①类结构映射），
// P3 只改投影函数。记录 id、intro 幂等键、指纹按第②类公式或字面值精确比较。会按设计有意改变的部分（第③类：初筛指令最后一行、
// 告警原文和上次结论移进不可信材料）只断言改了以后仍成立的内容。

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deciderMetaOf, type CollaborationScenarioSnapshot } from '@dutydeck/shared';
import { PluginHost } from '../plugins/host.js';
import { PluginStore } from '../plugins/store.js';
import { alarmDecisionId, alarmDispatchView, alarmIntroKey, alarmPromptView, cardRecallLineView, confirmCardView, createAlarmHarness, inboxAdoptionView, recallLineView, SCENARIO_BOT, SCENARIO_MEMBER,
  SCENARIO_REQUESTER, waitFor, type AlarmHarness, type AlarmHarnessOptions } from './scenario-pack.test-helpers.js';

vi.mock('./open-platform-session.js', () => ({ connectLarkOpenPlatformSession: vi.fn() }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const source = { appId: 'cli_alarm_source', openId: 'ou_alarm_source', name: '监控' };
const otherBot = { appId: 'cli_other_bot', openId: 'ou_other_bot', name: '别的机器人' };
const ruleTitle = '[critical] 【RDS 报警】<P0> 分片代理限流报错';
// 旧告警：材料里还没有服务字段。新告警：同一规则，带服务和集群。
const oldAlert = `${ruleTitle}\n\n报警前30分钟今(红)昨(蓝)同比\n\nmax:rate{counter}:demo.proxy.err{db=orders,port=3330}`;
const newAlert = `${ruleTitle}\n\n服务: demo.mysql.orders_write\n集群: region-a: orders\n报警时间: 2026-09-25 08:51:23 (UTC+0)`;
/** newAlert 由 source 发出时的指纹（第②类：sha256(JSON.stringify([sourceAppId, 规整后的正文])) 前 32 位）。 */
const NEW_ALERT_FINGERPRINT = 'cd7f2fbd1d1a528c101b4cba3d63fa6f';
const conclusion = '文件服务流量突增触发代理限流';
const triageLines = [
  '[告警初筛] 下面是「监控」在群里发的告警。本群订阅了告警初筛，请先做一次初步分析，按这个格式简短回答：',
  '1. 判断：真异常 / 误报 / 待确认，一句话说明理由。',
  '2. 证据：支撑判断的关键数据、日志或链接；没查到就写没查到。',
  '3. 需要谁做什么：没有就写「暂不需要处理」。',
  '4. 可直接转发：一段能直接转给相关同学的话。',
  '拿不准就写「待确认」并说明还缺什么，不要猜。'
];
const subscription = '来源 监控（cli_alarm_source）；级别不限；同一条告警 6 小时内只分析一次，每小时最多 3 条';
const text = (value: string) => JSON.stringify({ text: value });
const T0 = Date.parse('2026-10-15T01:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;

async function harness(clock: { now: number }, bots: Array<{ appId: string; name: string }> = [{ appId: source.appId, name: source.name }]) {
  const h = await createAlarmHarness({ participation: 'selective', now: () => new Date(clock.now), bots, answer: () => `**结论**\n\n${conclusion}。\n\n证据：样例。` });
  cleanups.push(() => h.close());
  return h;
}
const callsTo = (h: AlarmHarness, method: string, messageId: string) => h.calls.filter(call => call.method === method && (call.input as { messageId?: string }).messageId === messageId);
const mapping = async (h: AlarmHarness, messageId: string) => (await h.mappings()).find(item => item.externalId === messageId)?.saved;
const alarmAt = async (h: AlarmHarness, clock: { now: number }, messageId: string, body: string, at: number) => {
  clock.now = at;
  await h.receive(h.fromBot(source, { messageId, content: text(body) })); await h.settle(messageId);
  return (await h.alarmDecisionFor(messageId))?.outcome;
};
/** 确认人在群里 @ 机器人说一句话，等回复文字或确认卡发在这条消息下。 */
const say = async (h: AlarmHarness, messageId: string, value: string) => {
  await h.receive(h.fromUser({ messageId, text: value, mentionBot: true, sender: SCENARIO_REQUESTER }));
  await waitFor(() => h.calls.some(call => ['reply', 'replyText'].includes(call.method) && (call.input as { messageId?: string }).messageId === messageId), 10_000, `${messageId} answer`);
};
const clickConfirm = async (h: AlarmHarness, replyTo: string) => {
  const confirm = (await h.alarmConfirms()).find(item => item.replyToMessageId === replyTo)!;
  return h.coordinator.handleAction({ dutydeck_confirm: 'confirm', confirm_id: confirm.id, chat_id: h.scope.chatId }, SCENARIO_REQUESTER, { messageId: confirm.cardMessageId, chatId: h.scope.chatId });
};

describe('告警全链路', () => {
  it('来源告警起初筛：回 intro 开话题、记判定、以确认人身份收养进 coordinator、出过程卡和结果卡；同一规则的下一轮在另一个话题带关联行', async () => {
    const clock = { now: T0 };
    const h = await harness(clock);

    // 旧轮次：订阅开启前的同规则告警，有人在它的话题里 @ 机器人。这一轮的材料里有告警卡，算得出告警键。
    await h.receive(h.fromBot(source, { messageId: 'om_alert_old', content: text(oldAlert) })); await h.settle('om_alert_old');
    await h.receive(h.fromUser({ messageId: 'om_ask_old', text: '分析 top psm 流量占比', mentionBot: true, parentId: 'om_alert_old', inThread: true, sender: SCENARIO_REQUESTER }));
    await h.settle('om_ask_old');
    expect(await h.alarmDecisionFor('om_alert_old')).toBeUndefined();
    expect(await mapping(h, 'om_ask_old')).toMatchObject({ state: 'completed', scope_id: 'thread:om_alert_old' });

    // 开启订阅后，来源机器人发新告警。
    await h.subscribe({ sources: [{ appId: source.appId, name: source.name }], maxPerHour: 3 });
    clock.now += 7 * HOUR;
    await h.receive(h.fromBot(source, { messageId: 'om_alarm_1', content: text(newAlert) })); await h.settle('om_alarm_1');

    // intro：在告警下回复、开出话题；文字和幂等键是第②类不变量。
    expect(callsTo(h, 'replyText', 'om_alarm_1').map(call => call.input)).toEqual([{ messageId: 'om_alarm_1', replyInThread: true,
      text: '收到「监控」的告警，开始初筛。在这个话题里直接追问就行，不用 @。', idempotencyKey: alarmIntroKey(h.scope, 'om_alarm_1') }]);
    // 判定记录。
    expect(await h.alarmDecisionFor('om_alarm_1')).toEqual({ id: alarmDecisionId(h.scope, 'om_alarm_1'), action: 'act', status: 'sent', reason: '告警命中订阅，已起初筛任务',
      outcome: 'triaged', dedupeKey: NEW_ALERT_FINGERPRINT, sourceAppId: source.appId, policyVersion: 'alarm-triage', rule: 'alarm_triaged', triggerMessageId: 'om_alarm_1',
      createdAt: new Date(clock.now).toISOString() });
    // 收养：派发时判定记录还是 candidate；派发事件以确认人身份、在 intro 开出的话题里；coordinator 按确认人重新鉴权（不按群里观察到的成员身份放行）。
    expect(h.statusAtDispatch).toEqual(['candidate']);
    expect(h.dispatched.map(alarmDispatchView)).toEqual([{ messageId: 'om_alarm_1', rootId: 'om_alarm_1', threadId: 'omt_om_alarm_1', senderOpenId: SCENARIO_REQUESTER, senderType: 'user',
      instruction: { lines: triageLines, lastLine: expect.any(String) } }]);
    expect(h.authorizations).toContainEqual({ actor: SCENARIO_REQUESTER, action: 'task.create', memberObserved: false });
    expect(inboxAdoptionView((await h.inboxRecord('om_alarm_1'))!)).toEqual({ state: 'accepted', senderOpenId: SCENARIO_REQUESTER, senderType: 'user', rootId: 'om_alarm_1', threadId: 'omt_om_alarm_1', adopted: true });
    expect(h.decideCalls).toEqual([]);
    // 执行 prompt：初筛指令（除最后一行）和告警原文都在（P3 把原文移进不可信材料，这两条仍成立）。
    const triage = h.prompts.map(alarmPromptView).find(view => view.triage)!.triage!;
    expect(triage.instruction.lines).toEqual(triageLines);
    expect(triage.alarm.text).toBe(newAlert);
    // 过程卡和结果卡都回在告警话题里，结果卡带结论。
    expect(callsTo(h, 'reply', 'om_alarm_1').map(call => (call.input as { cardKind?: string }).cardKind)).toEqual(['process', 'result']);
    expect(await mapping(h, 'om_alarm_1')).toMatchObject({ state: 'completed', final_delivery_state: 'delivered', scope_id: 'thread:om_alarm_1', thread_id: 'omt_om_alarm_1',
      final_elements: [expect.objectContaining({ element_id: 'final_output', content: expect.stringContaining(conclusion) })] });
    // 初筛这一轮的材料里没有告警卡（告警是本轮请求本身），既不带关联行，也不会被后来的轮次关联。
    expect(recallLineView((await mapping(h, 'om_alarm_1'))!)).toBeUndefined();

    // 同一条告警再来一次：去重跳过，不发 intro、不派发。
    clock.now += 10 * MINUTE;
    await h.receive(h.fromBot(source, { messageId: 'om_alarm_2', content: text(newAlert) })); await h.settle('om_alarm_2');
    expect(await h.alarmDecisionFor('om_alarm_2')).toEqual({ id: alarmDecisionId(h.scope, 'om_alarm_2'), action: 'silent', status: 'suppressed', reason: '同一条告警在去重窗口内已经分析过',
      outcome: 'duplicate', dedupeKey: NEW_ALERT_FINGERPRINT, sourceAppId: source.appId, policyVersion: 'alarm-triage', rule: 'alarm_duplicate', triggerMessageId: 'om_alarm_2',
      createdAt: new Date(clock.now).toISOString() });
    expect(callsTo(h, 'replyText', 'om_alarm_2')).toEqual([]);
    expect(h.dispatched).toHaveLength(1);

    // 下一轮：在这条重复告警的话题里 @ 机器人（与旧轮次不在同一话题），关联到旧轮次的结论。
    clock.now += MINUTE;
    await h.receive(h.fromUser({ messageId: 'om_ask_new', text: '详细排查下流量情况', mentionBot: true, parentId: 'om_alarm_2', inThread: true, sender: SCENARIO_REQUESTER }));
    await h.settle('om_ask_new');
    const line = expect.stringMatching(new RegExp(`^📎 \\d{1,2}-\\d{1,2} 同一告警规则：${conclusion} · \\[查看\\]\\(https://applink\\.feishu\\.cn/client/thread/open\\?.*open_thread_id=omt_om_alert_old`));
    const processCard = callsTo(h, 'reply', 'om_ask_new').find(call => (call.input as { cardKind?: string }).cardKind === 'process')!;
    expect(cardRecallLineView(processCard.input)).toEqual(line);
    expect(recallLineView((await mapping(h, 'om_ask_new'))!)).toEqual(line);
    const ask = alarmPromptView(h.prompts.at(-1)!);
    expect(ask.recall?.conclusion).toBe(conclusion);
    expect(ask.references).toEqual([{ messageId: 'om_alarm_2', text: newAlert }]);
  });

  it('平台重投同一条告警只处理一次：入站记录挡住重推，绕过入站再处理一次也由判定记录挡住', async () => {
    const clock = { now: T0 };
    const h = await harness(clock);
    await h.subscribe({ sources: [{ appId: source.appId, name: source.name }] });
    const alarm = h.fromBot(source, { messageId: 'om_alarm_1', content: text(newAlert) });
    await h.receive(alarm); await h.settle('om_alarm_1');
    clock.now += MINUTE;
    await h.receive(alarm); await h.settle('om_alarm_1');
    await h.coordinator.handle(alarm, h.config); await h.settle('om_alarm_1');

    expect((await h.alarmDecisions()).map(item => [item.id, item.outcome, item.status])).toEqual([[alarmDecisionId(h.scope, 'om_alarm_1'), 'triaged', 'sent']]);
    expect(callsTo(h, 'replyText', 'om_alarm_1')).toHaveLength(1);
    expect(h.dispatched).toHaveLength(1);
    expect(h.prompts).toHaveLength(1);
    expect(callsTo(h, 'reply', 'om_alarm_1').filter(call => (call.input as { cardKind?: string }).cardKind === 'result')).toHaveLength(1);
  });

  it('每小时上限用完后，正文不同的告警也跳过：留判定记录，不回 intro、不派发', async () => {
    const clock = { now: T0 };
    const h = await harness(clock);
    await h.subscribe({ sources: [{ appId: source.appId, name: source.name }], maxPerHour: 2 });
    const alarms = [['om_alarm_a', '【P1】订单服务错误率超过阈值'], ['om_alarm_b', '【P1】支付服务超时'], ['om_alarm_c', '【P1】库存服务告警']] as const;
    for (const [messageId, body] of alarms) await alarmAt(h, clock, messageId, body, clock.now + 10 * MINUTE);
    expect((await h.alarmDecisions()).map(item => [item.triggerMessageId, item.outcome, item.action, item.status])).toEqual([
      ['om_alarm_a', 'triaged', 'act', 'sent'], ['om_alarm_b', 'triaged', 'act', 'sent'], ['om_alarm_c', 'rate_limited', 'silent', 'suppressed']]);
    expect(await h.alarmDecisionFor('om_alarm_c')).toMatchObject({ reason: '本小时初筛条数已到上限', rule: 'alarm_rate_limited' });
    expect(callsTo(h, 'replyText', 'om_alarm_c')).toEqual([]);
    expect(h.dispatched.map(event => event.messageId)).toEqual(['om_alarm_a', 'om_alarm_b']);
    expect(await h.inboxRecord('om_alarm_c')).toMatchObject({ state: 'ignored' });
  });

  it('去重和额度窗口都含端点：恰在 now-1h、now-6h 的记录仍计入，晚 1 毫秒就不计', async () => {
    const clock = { now: T0 };
    const h = await harness(clock);
    await h.subscribe({ sources: [{ appId: source.appId, name: source.name }], maxPerHour: 2 });
    expect(await alarmAt(h, clock, 'om_quota_a', '【P1】订单服务错误率超过阈值', T0)).toBe('triaged');
    expect(await alarmAt(h, clock, 'om_quota_b', '【P1】支付服务超时', T0 + 10 * MINUTE)).toBe('triaged');
    expect(await alarmAt(h, clock, 'om_quota_c', '【P1】库存服务告警', T0 + HOUR)).toBe('rate_limited');
    expect(await alarmAt(h, clock, 'om_quota_d', '【P1】物流服务告警', T0 + HOUR + 1)).toBe('triaged');
    expect(await alarmAt(h, clock, 'om_dedupe_at', '【P1】订单服务错误率超过阈值', T0 + 6 * HOUR)).toBe('duplicate');
    expect(await alarmAt(h, clock, 'om_dedupe_after', '【P1】订单服务错误率超过阈值', T0 + 6 * HOUR + 1)).toBe('triaged');
  });

  it('派发抛错：判定记录从 candidate 变 failed，intro 已发；failed 不计入去重，同一正文再来照常初筛', async () => {
    const clock = { now: T0 };
    const h = await harness(clock);
    await h.subscribe({ sources: [{ appId: source.appId, name: source.name }] });
    h.failNextDispatch();
    expect(await alarmAt(h, clock, 'om_alarm_fail', newAlert, T0)).toBe('triaged');
    expect(await h.alarmDecisionFor('om_alarm_fail')).toMatchObject({ id: alarmDecisionId(h.scope, 'om_alarm_fail'), action: 'act', status: 'failed', reason: '告警命中订阅，已起初筛任务' });
    expect(callsTo(h, 'replyText', 'om_alarm_fail')).toHaveLength(1);
    expect(h.dispatched).toEqual([]);

    expect(await alarmAt(h, clock, 'om_alarm_retry', newAlert, T0 + MINUTE)).toBe('triaged');
    expect(await h.alarmDecisionFor('om_alarm_retry')).toMatchObject({ action: 'act', status: 'sent', dedupeKey: NEW_ALERT_FINGERPRINT });
    expect(h.statusAtDispatch).toEqual(['candidate', 'candidate']);
    expect(h.dispatched.map(event => event.messageId)).toEqual(['om_alarm_retry']);
  });

  it('群里开关告警：回复文字、确认卡标题和完整摘要、自动挑来源、点卡提示和订阅都与现在逐字一致', async () => {
    const clock = { now: T0 };
    const h = await harness(clock, [{ appId: source.appId, name: source.name }, { appId: otherBot.appId, name: otherBot.name }]);
    await say(h, 'om_off', '关闭告警初筛');
    expect(callsTo(h, 'replyText', 'om_off').map(call => (call.input as { text: string }).text)).toEqual(['本群没开告警初筛。']);

    // 来源机器人发过两条、另一个机器人发过一条：自动挑发得最多的，其余列在卡上。
    for (const [bot, messageId] of [[source, 'om_note_1'], [source, 'om_note_2'], [otherBot, 'om_note_3']] as const) {
      clock.now += 1_000;
      await h.receive(h.fromBot(bot, { messageId, content: text('今日巡检正常') })); await h.settle(messageId);
    }
    await say(h, 'om_on', '告警来了先帮我看看');
    expect(callsTo(h, 'reply', 'om_on').map(call => confirmCardView(call.input))).toEqual([{ title: '开启告警初筛', statusLabel: '待确认', state: 'running',
      body: `${subscription}。告警来了我在告警话题里先做初筛，任务以确认人的名义发起。最近在本群发过消息的机器人还有：别的机器人；来源不对可以在 Dutydeck Web 的群设置里改。`, buttons: ['确认', '取消'] }]);
    expect(await clickConfirm(h, 'om_on')).toEqual({ type: 'success', content: `已开启告警初筛：${subscription}。告警来了我在告警话题里先做初筛，任务以你的名义发起。` });
    expect(await h.duty()).toEqual({ alarm: { enabled: true, sources: [{ appId: source.appId, name: source.name }], levels: [], dedupeHours: 6, maxPerHour: 3, requesterId: SCENARIO_REQUESTER }, responder: null });
    // 机器人计数不算告警来源：本机器人和另一个机器人。
    expect((await h.participation.describe(h.scope)).split('\n').filter(item => item.startsWith('**接话人**') || item.startsWith('**告警初筛**'))).toEqual([
      '**接话人**：未指定。本群有 2 个机器人，没 @ 的消息我先不接；要我接，@我 说「你负责接话」，或在 Dutydeck Web 的群设置里指定',
      `**告警初筛**：${subscription}；今天分析 0 条，跳过 0 条`]);

    await say(h, 'om_close', '关闭告警初筛');
    expect(callsTo(h, 'reply', 'om_close').map(call => confirmCardView(call.input))).toEqual([{ title: '关闭告警初筛', statusLabel: '待确认', state: 'running',
      body: `不再自动初筛本群告警（${subscription}）。订阅设置会保留，之后说「告警来了先帮我看看」可以再打开。`, buttons: ['确认', '取消'] }]);
    expect(await clickConfirm(h, 'om_close')).toEqual({ type: 'success', content: '已关闭本群告警初筛，订阅设置保留，之后可以再打开。' });
    expect((await h.duty()).alarm).toMatchObject({ enabled: false, requesterId: SCENARIO_REQUESTER });
  });
});

// ---- 团队答疑（model 模式，9.3 第 2 项）和告警来源话题的归属（第 3 项） ----

const GROUP_B = 'oc_scenario_group_b';
const RUNBOOK = '# 订单服务值班手册\n\n## 5xx 排查\n\n订单服务 5xx 先看网关日志，再看下游库存服务的超时。\n\n## 发布回滚\n\n回滚走发布平台的一键回滚。\n';
const decisionsFor = async (h: AlarmHarness, messageId: string, chatId?: string) => (await h.repos.collaboration.listDecisions({ appId: SCENARIO_BOT.appId, chatId: chatId ?? h.scope.chatId }, 500))
  .filter(item => deciderMetaOf(item)?.trigger?.messageId === messageId);
const frozenScenario = (decision: { inputSnapshot: unknown }) => (decision.inputSnapshot as { scenario?: CollaborationScenarioSnapshot }).scenario;

/** 真实插件加载：内置告警包加上按确认流程安装的 plugins/team-faq，docs_dir 指向一份合成的 runbook。 */
async function faqHarness(options: Partial<AlarmHarnessOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-team-faq-it-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'runbooks'));
  await writeFile(join(dir, 'runbooks', 'orders.md'), RUNBOOK);
  const store = new PluginStore(join(dir, 'data'));
  await store.install(resolve(import.meta.dirname, '../../../../plugins/team-faq'), { yes: true });
  await store.setConfig('team-faq', 'docs_dir', Buffer.from(join(dir, 'runbooks')));
  const host = await PluginHost.load({ dataDir: join(dir, 'data') });
  expect(host.diagnostics).toEqual([]);
  const h = await createAlarmHarness({ participation: 'selective', bots: [{ appId: otherBot.appId, name: otherBot.name }], scenarios: host.scenarios, extraChats: [GROUP_B], ...options });
  cleanups.push(() => h.close());
  return h;
}
const enableFaq = async (h: AlarmHarness, enabled: boolean) => {
  const duty = await h.repos.collaboration.getDuty(h.scope);
  await h.participation.updateDuty(h.scope, { expectedRevision: duty.revision, scenarios: { 'team-faq': { enabled, params: { topics: ['订单服务'], docs: ['orders.md'] } } } }, 'owner');
};
const ask = async (h: AlarmHarness, messageId: string, value: string, patch: { chatId?: string; parentId?: string; inThread?: boolean } = {}) => {
  await h.receive(h.fromUser({ messageId, text: value, ...patch }));
  await h.settle(messageId); await h.settle(messageId);
};

describe('团队答疑（model 场景包）', () => {
  it('群 A 开启、群 B 不开：A 里命中关键字的提问带着冻结的 runbook 交给模型，判 act 后执行 prompt 里是冻结的指令和不可信材料块；B 照原有规则', async () => {
    let decided: CollaborationScenarioSnapshot | undefined;
    const h = await faqHarness({ decide: async (_config, snapshot, triggerId) => {
      decided = snapshot.scenario;
      return snapshot.scenario?.status === 'used' ? { action: 'act', reason: '要查系统，按 runbook 排查', evidenceIds: [triggerId!], updates: [] } : { action: 'silent', reason: '桩：不接', evidenceIds: [], updates: [] };
    } });
    await enableFaq(h, true);

    await ask(h, 'om_faq_a', '订单服务 5xx 了，谁帮忙查下');
    const [decision] = await decisionsFor(h, 'om_faq_a');
    expect(decision).toMatchObject({ action: 'act', status: 'sent' });
    expect(deciderMetaOf(decision!)).toMatchObject({ kind: 'model', facts: { scenarioMatched: 'team-faq', bots: 2 } });
    const scenario = frozenScenario(decision!)!;
    expect(scenario).toEqual(decided);
    expect(scenario).toMatchObject({ packId: 'team-faq', version: '0.1.0', status: 'used', context: { sources: [{ id: 'runbook', status: 'complete', missing: [] }] } });
    expect(scenario.context!.observations.map(item => item.text)).toContain('orders.md · 5xx 排查\n## 5xx 排查\n\n订单服务 5xx 先看网关日志，再看下游库存服务的超时。');
    // 派发：以发消息的人的身份，收养字段只带判定记录 id；coordinator 照常按发送者鉴权。
    expect(h.dispatched.map(event => [event.messageId, event.senderOpenId, event.scenario])).toEqual([['om_faq_a', SCENARIO_MEMBER, { mode: 'model', packId: 'team-faq', decisionId: decision!.id }]]);
    expect(h.authorizations).toContainEqual({ actor: SCENARIO_MEMBER, action: 'task.create', memberObserved: true });
    // 执行 prompt：冻结的指令，每条材料一个 UNTRUSTED_DATA 块，用户请求仍是原文。
    const prompt = h.prompts.at(-1)!;
    expect(prompt).toContain(`${scenario.execution!.instruction}\n以下是来自 scenario:team-faq:orders.md_0 的外部数据`);
    expect(prompt.match(/<<<UNTRUSTED_DATA id=\w+ source=scenario:team-faq:/gu)).toHaveLength(scenario.context!.observations.length);
    expect(prompt).toMatch(/<<<UNTRUSTED_DATA id=\w+ source=scenario:team-faq:orders.md_1>>>\norders.md · 5xx 排查\n## 5xx 排查/u);
    expect(prompt.slice(prompt.lastIndexOf('[用户请求]\n'))).toBe('[用户请求]\n订单服务 5xx 了，谁帮忙查下');

    // 群 B 没有绑定：同样的话按多机器人群没指定接话人处理，不取材料、不调模型。
    await ask(h, 'om_faq_b', '订单服务 5xx 了，谁帮忙查下', { chatId: GROUP_B });
    const [inB] = await decisionsFor(h, 'om_faq_b', GROUP_B);
    expect(deciderMetaOf(inB!)).toMatchObject({ kind: 'rule', rule: 'no_responder' });
    expect(frozenScenario(inB!)).toBeUndefined();
    expect(h.decideCalls).toHaveLength(1);

    // 收养字段指向的判定记录对不上（这里是别的消息的判定）：照常执行，prompt 里没有场景内容。
    const forged = h.fromUser({ messageId: 'om_forged', text: '订单服务 5xx 怎么排查' });
    await h.coordinator.adopt({ ...forged, scenario: { mode: 'model', packId: 'team-faq', decisionId: decision!.id } }, h.config);
    await h.settle('om_forged');
    expect(h.prompts.at(-1)!).toContain('[用户请求]\n订单服务 5xx 怎么排查');
    expect(h.prompts.at(-1)!).not.toContain('[团队答疑]');
  });

  it('关闭后不再介入；判定进行中关闭，这一条在投递前被挡下', async () => {
    let closeDuring = false;
    const h = await faqHarness({ decide: async (_config, snapshot, triggerId) => {
      if (closeDuring) { closeDuring = false; await enableFaq(h, false); }
      return snapshot.scenario?.status === 'used' ? { action: 'reply', reason: 'runbook 能回答', evidenceIds: [triggerId!, snapshot.scenario.context!.observations[0]!.id], updates: [] }
        : { action: 'silent', reason: '桩：不接', evidenceIds: [], updates: [] };
    } });
    await enableFaq(h, true);
    closeDuring = true;
    await ask(h, 'om_inflight', '订单服务回滚怎么操作');
    const [inflight] = await decisionsFor(h, 'om_inflight');
    expect(inflight).toMatchObject({ action: 'reply', status: 'suppressed' });
    expect(callsTo(h, 'replyText', 'om_inflight')).toEqual([]);
    expect(h.dispatched).toEqual([]);

    await ask(h, 'om_closed', '订单服务回滚怎么操作');
    const [closed] = await decisionsFor(h, 'om_closed');
    expect(deciderMetaOf(closed!)).toMatchObject({ kind: 'rule', rule: 'no_responder' });
    expect(h.decideCalls).toHaveLength(1);
    expect((await h.participation.describe(h.scope)).split('\n')).toContain('**团队答疑**：已关闭');
  });
});

describe('告警来源开的话题（告警包 1.1.0 sourceTopics: neutral）', () => {
  it('订阅群里来源话题：没别的机器人接过就按负责范围交给模型；别的机器人回过或话题读失败就让路', async () => {
    const clock = { now: T0 };
    const h = await createAlarmHarness({ participation: 'selective', now: () => new Date(clock.now), bots: [{ appId: source.appId, name: source.name }, { appId: otherBot.appId, name: otherBot.name }],
      configPatch: { roleScope: '告警排查与线上问题' } });
    cleanups.push(() => h.close());
    // 订阅关着也算来源：来源开的话题不记「别人的话题」。
    await h.subscribe({ enabled: false, sources: [{ appId: source.appId, name: source.name }] });
    const alarm = async (messageId: string) => { clock.now += MINUTE; await h.receive(h.fromBot(source, { messageId, content: text(`【P2】${messageId} 磁盘使用率超过阈值`) })); await h.settle(messageId); };
    const factsOf = async (messageId: string) => { const [decision] = await decisionsFor(h, messageId); return { rule: deciderMetaOf(decision!)?.rule, kind: deciderMetaOf(decision!)?.kind, facts: deciderMetaOf(decision!)?.facts }; };

    await alarm('om_alarm_free');
    await ask(h, 'om_q_free', '这个要紧吗？要不要扩容', { parentId: 'om_alarm_free', inThread: true });
    expect(await factsOf('om_q_free')).toMatchObject({ kind: 'model', facts: { threadClaimedByOther: false, threadClaimEvidence: 'complete', bots: 2 } });
    expect((await factsOf('om_q_free')).facts).not.toHaveProperty('threadRootOther');

    await alarm('om_alarm_taken');
    clock.now += MINUTE;
    await h.receive(h.fromBot(otherBot, { messageId: 'om_other_reply', content: text('我来看这条告警'), threadId: 'omt_om_alarm_taken', rootId: 'om_alarm_taken' }));
    h.messages.get('om_alarm_taken')!.threadId = 'omt_om_alarm_taken';
    await h.settle('om_other_reply');
    await ask(h, 'om_q_taken', '这个要紧吗？要不要扩容', { parentId: 'om_alarm_taken', inThread: true });
    expect(await factsOf('om_q_taken')).toMatchObject({ rule: 'topic_of_other', facts: { threadClaimedByOther: true, threadClaimEvidence: 'complete' } });

    await alarm('om_alarm_unreadable');
    h.failThreadReads('omt_om_alarm_unreadable');
    await ask(h, 'om_q_unreadable', '这个要紧吗？要不要扩容', { parentId: 'om_alarm_unreadable', inThread: true });
    expect(await factsOf('om_q_unreadable')).toMatchObject({ rule: 'topic_of_other', facts: { threadClaimedByOther: true, threadClaimEvidence: 'unavailable' } });
    expect(h.decideCalls).toHaveLength(1);
  });
});
