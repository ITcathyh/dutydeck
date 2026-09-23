import { describe, expect, it } from 'vitest';
import {
  availableLarkCardActions,
  buildLarkCardActions,
  isLarkCardActionAvailable,
  larkCardActionBudget,
  larkCardActionHint,
  parseLarkCardActionValue,
  safeLarkWebUrl,
  type LarkCardActionContext,
  type LarkCardActionName,
  type LarkCardActionState,
  type LarkCardCapabilities,
  type LarkCardElement
} from './card-actions.js';

// 卡片操作是「渲染」与「鉴权」共用的一张表，所以本文件的断言分两类：
// 1. 单侧行为：某状态该出哪个主操作、能力为 false 时不出按钮、只读卡零按钮。
// 2. 双侧一致：渲染出的每个回调按钮都必须能被 parse + authorize 接受，
//    两端一旦分叉就会重现「死按钮」和「越权入口」两类线上事故。

const allCapabilities: LarkCardCapabilities = {
  canCancelQueued: true,
  canInterrupt: true,
  canRetry: true,
  canRefresh: true
};

const context = (
  state: LarkCardActionState,
  overrides: Partial<LarkCardActionContext> = {},
  capabilities: Partial<LarkCardCapabilities> = {}
): LarkCardActionContext => ({
  state,
  taskId: 'om_task_1',
  turn: 0,
  ...overrides,
  capabilities: { ...allCapabilities, ...capabilities, ...(overrides.capabilities ?? {}) }
});

const terminalStates: LarkCardActionState[] = ['completed', 'failed', 'interrupted'];
const allStates: LarkCardActionState[] = ['queued', 'running', 'interrupting', 'completed', 'failed', 'interrupted'];

const buttonIds = (elements: LarkCardElement[]) => elements.map(element => element.element_id);
const labels = (elements: LarkCardElement[]) => elements.map(element => element.text?.content);
const callbackButtons = (elements: LarkCardElement[]) =>
  elements.filter(element => element.behaviors?.some((behavior: any) => behavior.type === 'callback'));
const callbackValue = (element: LarkCardElement) =>
  element.behaviors.find((behavior: any) => behavior.type === 'callback').value;

describe('飞书卡片操作按钮：状态收敛', () => {
  it('每个状态只出该状态匹配的主操作', () => {
    // 一个状态一个主要下一步：排队可取消、运行可中断、失败/取消可重试。
    const queued = buildLarkCardActions(context('queued'));
    expect(buttonIds(queued)).toContain('cancel');
    expect(buttonIds(queued)).not.toContain('interrupt');
    expect(buttonIds(queued)).not.toContain('retry');
    expect(labels(queued)[0]).toBe('取消');

    const running = buildLarkCardActions(context('running'));
    expect(buttonIds(running)).toContain('interrupt');
    expect(buttonIds(running)).not.toContain('cancel');
    expect(buttonIds(running)).not.toContain('retry');
    expect(labels(running)[0]).toBe('中断');
    // 中断不用红框：语义由文案和停止图标承载，按钮本身保持无边框。
    expect(running[0]).toMatchObject({ type: 'text', icon: { tag: 'standard_icon', token: 'stop_outlined', color: 'grey' } });

    for (const state of ['failed', 'interrupted'] as const) {
      const elements = buildLarkCardActions(context(state));
      expect(buttonIds(elements)).toEqual(['retry']);
      expect(labels(elements)).toEqual(['重试']);
    }

    // completed 是可验收终态，没有可执行的下一步；结果已由 fresh final 送达。
    expect(buildLarkCardActions(context('completed'))).toEqual([]);
  });

  it('interrupting 不提供中断，只保留刷新作为逃生通道', () => {
    // 停止请求已在途，再点「中断」会被 handleAction 直接拒绝（那就是死按钮）；
    // 「刷新」让用户能立即确认停止是否已生效，而不必销毁会话。
    const elements = buildLarkCardActions(context('interrupting'));
    expect(buttonIds(elements)).toEqual(['refresh']);
    expect(isLarkCardActionAvailable('interrupt', context('interrupting'))).toBe(false);
    expect(isLarkCardActionAvailable('refresh', context('interrupting'))).toBe(true);
  });

  it('刷新只出现在非终态，主操作永远排在刷新之前', () => {
    for (const state of ['queued', 'running', 'interrupting'] as const) {
      expect(buttonIds(buildLarkCardActions(context(state)))).toContain('refresh');
    }
    for (const state of terminalStates) {
      expect(buttonIds(buildLarkCardActions(context(state)))).not.toContain('refresh');
      expect(isLarkCardActionAvailable('refresh', context(state))).toBe(false);
    }
    expect(availableLarkCardActions(context('queued'))).toEqual(['cancel', 'refresh']);
    expect(availableLarkCardActions(context('running'))).toEqual(['interrupt', 'refresh']);
  });

  it('retryable 为 false 时不提供重试入口', () => {
    // 诚实表达能力：明确标记不可重试的任务（配置错误、权限不足）不给注定失败的按钮。
    for (const state of ['failed', 'interrupted'] as const) {
      expect(buildLarkCardActions(context(state, { retryable: false }))).toEqual([]);
      expect(isLarkCardActionAvailable('retry', context(state, { retryable: false }))).toBe(false);
      // 未显式声明 retryable（undefined）时保持既有默认：可重试。
      expect(isLarkCardActionAvailable('retry', context(state))).toBe(true);
    }
  });
});

describe('飞书卡片操作按钮：只读收据不接受改写结论的操作', () => {
  it('readOnly 的每个终态都渲染零按钮', () => {
    // 卡片进入终态即冻结为收据。收据上出现任何改写结论的按钮都是「假操作」：
    // 要么被后端拒绝，要么改写已经交付给用户的结论。
    for (const state of terminalStates) {
      expect(buildLarkCardActions(context(state, { readOnly: true }))).toEqual([]);
    }
  });

  it('readOnly 在任意状态、任意能力下都不给改写结论的四个操作，连查看详情链接也不渲染', () => {
    for (const state of allStates) {
      const elements = buildLarkCardActions(context(state, {
        readOnly: true,
        capabilities: { ...allCapabilities, webUrl: 'https://dutydeck.example.com/sessions/ses_1' }
      }));
      expect(elements).toEqual([]);
      for (const action of ['cancel', 'interrupt', 'retry', 'refresh'] as LarkCardActionName[]) {
        expect(isLarkCardActionAvailable(action, context(state, { readOnly: true }))).toBe(false);
        // 能力全开也一样：只读规则不看能力。
        expect(isLarkCardActionAvailable(action, context(state, { readOnly: true, capabilities: { ...allCapabilities, canVerify: true } }))).toBe(false);
      }
    }
  });

  it('运行验证是唯一的例外，且只在跑过的终态上出现', () => {
    // 验证只在工作目录跑一条命令、新增一条独立证据，卡上的结论一个字都不动，
    // 所以它是闭集里唯一允许出现在收据上的操作。
    const verifiable = new Set(['completed', 'failed', 'interrupted']);
    for (const state of allStates) {
      const readOnly = context(state, { readOnly: true, capabilities: { ...allCapabilities, canVerify: true } });
      expect(isLarkCardActionAvailable('verify', readOnly), state).toBe(verifiable.has(state));
      expect(buildLarkCardActions(readOnly).map(element => element.element_id), state)
        .toEqual(verifiable.has(state) ? ['verify'] : []);
      // 没声明 canVerify（没配验证命令的工作区）时永远不出现。
      expect(isLarkCardActionAvailable('verify', context(state, { readOnly: true })), state).toBe(false);
    }
  });
});

describe('飞书卡片操作按钮：能力为 false 即不渲染（反死按钮）', () => {
  it('canCancelQueued 为 false 时排队卡没有取消', () => {
    // 死按钮的根因是渲染端假设能力存在。能力必须是显式入参：
    // runtime 没有 cancelQueued、或任务还没拿到 runtimeTaskId，就不该出现取消。
    const elements = buildLarkCardActions(context('queued', {}, { canCancelQueued: false }));
    expect(buttonIds(elements)).not.toContain('cancel');
    expect(buttonIds(elements)).toEqual(['refresh']);
    expect(isLarkCardActionAvailable('cancel', context('queued', {}, { canCancelQueued: false }))).toBe(false);
  });

  it('canInterrupt 为 false 时运行卡没有中断', () => {
    const elements = buildLarkCardActions(context('running', {}, { canInterrupt: false }));
    expect(buttonIds(elements)).toEqual(['refresh']);
  });

  it('canRetry 为 false 时失败/取消卡没有重试', () => {
    for (const state of ['failed', 'interrupted'] as const) {
      expect(buildLarkCardActions(context(state, {}, { canRetry: false }))).toEqual([]);
    }
  });

  it('canRefresh 为 false 时非终态没有刷新', () => {
    expect(buttonIds(buildLarkCardActions(context('queued', {}, { canRefresh: false })))).toEqual(['cancel']);
    expect(buildLarkCardActions(context('interrupting', {}, { canRefresh: false }))).toEqual([]);
  });

  it('所有能力为 false 时任何状态都不渲染回调按钮', () => {
    const none: LarkCardCapabilities = { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false };
    for (const state of allStates) {
      expect(callbackButtons(buildLarkCardActions(context(state, { capabilities: none })))).toEqual([]);
    }
  });

  it('taskId 缺失或超长时不渲染回调按钮', () => {
    // 回调必须能被 coordinator 用 task_id 定位到任务，否则点击只会得到一个错误 toast。
    for (const taskId of ['', '   ', 'x'.repeat(257)]) {
      expect(callbackButtons(buildLarkCardActions(context('running', { taskId })))).toEqual([]);
      expect(isLarkCardActionAvailable('interrupt', context('running', { taskId }))).toBe(false);
    }
  });
});

describe('飞书卡片操作按钮：回调 value 全字符串（跨重启幂等）', () => {
  it('所有生成按钮的 callback value 字段都是字符串', () => {
    // 飞书只能稳定保留 value 里的字符串；更关键的是 daemon 重启后内存上下文全丢，
    // 只有 value 自带的 action/task_id/turn 能让新进程独立解释这次点击。
    const contexts = allStates.flatMap(state => [
      context(state, { turn: 0 }),
      context(state, { turn: 7 }),
      context(state, { turn: 12, capabilities: { ...allCapabilities, webUrl: 'https://dutydeck.example.com/sessions/ses_1' } })
    ]);
    let asserted = 0;
    for (const ctx of contexts) {
      for (const button of callbackButtons(buildLarkCardActions(ctx))) {
        const value = callbackValue(button);
        expect(Object.keys(value).length).toBeGreaterThan(0);
        for (const [key, field] of Object.entries(value)) {
          expect(typeof field, `${String(button.element_id)}.${key} 必须是字符串`).toBe('string');
        }
        asserted++;
      }
    }
    expect(asserted).toBeGreaterThan(0);
  });

  it('turn 被字符串化后写入 value，且能解析回数字', () => {
    const [cancel] = buildLarkCardActions(context('queued', { turn: 3 }));
    expect(callbackValue(cancel!)).toEqual({ action: 'cancel', task_id: 'om_task_1', turn: '3' });
    expect(parseLarkCardActionValue(callbackValue(cancel!))).toEqual({ action: 'cancel', taskId: 'om_task_1', turn: 3 });
    // 非法轮次（NaN / 负数）归一化为第 0 轮，不因为脏数据丢掉整个操作入口。
    expect(callbackValue(buildLarkCardActions(context('queued', { turn: Number.NaN }))[0]!).turn).toBe('0');
    expect(callbackValue(buildLarkCardActions(context('queued', { turn: -5 }))[0]!).turn).toBe('0');
  });
});

describe('飞书卡片操作按钮：渲染与鉴权不可分叉', () => {
  it('渲染出的每个回调按钮都能 parse 回一个被 authorize 接受的操作', () => {
    // 这是防「权限差」的核心断言：界面上出现的按钮集合必须等于后端接受的回调集合。
    const contexts = allStates.flatMap(state => [
      context(state),
      context(state, { turn: 4 }),
      context(state, { retryable: false }),
      context(state, {}, { canCancelQueued: false }),
      context(state, {}, { canInterrupt: false }),
      context(state, {}, { canRefresh: false }),
      context(state, { capabilities: { ...allCapabilities, webUrl: 'https://dutydeck.example.com/sessions/ses_1' } })
    ]);
    let roundTripped = 0;
    for (const ctx of contexts) {
      const rendered = callbackButtons(buildLarkCardActions(ctx));
      for (const button of rendered) {
        const parsed = parseLarkCardActionValue(callbackValue(button));
        expect(parsed, `${String(button.element_id)} 的 value 必须可解析`).toBeDefined();
        expect(parsed!.taskId).toBe(ctx.taskId);
        expect(isLarkCardActionAvailable(parsed!.action, ctx), `${parsed!.action} 渲染了却不被授权`).toBe(true);
        roundTripped++;
      }
      // 反向一致：authorize 认可的操作集合正是渲染出的按钮集合，不多也不少。
      expect(rendered.map(button => parseLarkCardActionValue(callbackValue(button))!.action).sort())
        .toEqual(availableLarkCardActions(ctx).slice().sort());
    }
    expect(roundTripped).toBeGreaterThan(0);
  });

  it('未渲染的操作一律不被授权', () => {
    const all: LarkCardActionName[] = ['cancel', 'interrupt', 'retry', 'refresh'];
    for (const state of allStates) {
      const ctx = context(state);
      const rendered = new Set(availableLarkCardActions(ctx));
      for (const action of all) {
        expect(isLarkCardActionAvailable(action, ctx)).toBe(rendered.has(action));
      }
    }
  });
});

describe('parseLarkCardActionValue', () => {
  it('接受 JSON 字符串与对象两种形态', () => {
    // listener 直接透传 event.action.value，线上两种形态都出现过。
    expect(parseLarkCardActionValue('{"action":"retry","task_id":"om_1","turn":"2"}'))
      .toEqual({ action: 'retry', taskId: 'om_1', turn: 2 });
    expect(parseLarkCardActionValue({ action: 'retry', task_id: 'om_1', turn: '2' }))
      .toEqual({ action: 'retry', taskId: 'om_1', turn: 2 });
  });

  it('兼容线上遗留形态 {action, task_id}（不带 turn）', () => {
    // 已经发给用户的老卡片必须继续可用，不能因为新增 turn 字段就变成死按钮。
    expect(parseLarkCardActionValue({ action: 'cancel', task_id: 'om_legacy' }))
      .toEqual({ action: 'cancel', taskId: 'om_legacy' });
    expect(parseLarkCardActionValue('{"action":"interrupt","task_id":"om_legacy"}'))
      .toEqual({ action: 'interrupt', taskId: 'om_legacy' });
    expect(parseLarkCardActionValue({ action: 'cancel', task_id: 'om_legacy' })).not.toHaveProperty('turn');
  });

  it('同时兼容 task_id 与 taskId 两种键名', () => {
    expect(parseLarkCardActionValue({ action: 'cancel', taskId: 'om_camel' }))
      .toEqual({ action: 'cancel', taskId: 'om_camel' });
  });

  it('拒绝畸形输入且不抛异常', () => {
    // 回调路径抛异常只会让用户看到一个无信息的失败 toast，所以宽进严出、一律返回 undefined。
    const malformed: unknown[] = [
      'not json',
      '',
      '   ',
      null,
      undefined,
      42,
      true,
      [],
      [{ action: 'cancel', task_id: 'om_1' }],
      {},
      { action: 'destroy', task_id: 'om_1' },
      { action: '', task_id: 'om_1' },
      { action: 'cancel' },
      { action: 'cancel', task_id: '' },
      { action: 'cancel', task_id: '   ' },
      { action: 'cancel', task_id: 123 },
      { action: 'cancel', task_id: 'x'.repeat(257) },
      { task_id: 'om_1' },
      '"cancel"',
      '[1,2,3]'
    ];
    for (const value of malformed) {
      expect(parseLarkCardActionValue(value), `${JSON.stringify(value) ?? String(value)} 应被拒绝`).toBeUndefined();
    }
  });

  it('容忍数值型 turn，但丢弃非法轮次', () => {
    expect(parseLarkCardActionValue({ action: 'cancel', task_id: 'om_1', turn: 5 })?.turn).toBe(5);
    expect(parseLarkCardActionValue({ action: 'cancel', task_id: 'om_1', turn: 'abc' })?.turn).toBeUndefined();
    expect(parseLarkCardActionValue({ action: 'cancel', task_id: 'om_1', turn: '-1' })?.turn).toBeUndefined();
    expect(parseLarkCardActionValue({ action: 'cancel', task_id: 'om_1', turn: '' })?.turn).toBeUndefined();
  });
});

describe('查看详情：只在页脚出现一次', () => {
  const webUrl = 'https://dutydeck.example.com/sessions/ses_1';

  it('顶部操作行不渲染查看详情按钮（页脚已有同一去向的链接）', () => {
    // 同一个链接在卡片上出现两次是重复入口。详情统一由页脚的 markdown 链接承担，
    // 顶部只放真正改变任务状态的动作。
    for (const state of allStates) {
      const elements = buildLarkCardActions(context(state, { capabilities: { ...allCapabilities, webUrl } }));
      expect(buttonIds(elements), `state=${state} 顶部不应有详情按钮`).not.toContain('view_detail');
      expect(JSON.stringify(elements)).not.toContain('open_url');
      expect(JSON.stringify(elements)).not.toContain('查看详情');
    }
  });

  it('顶部只保留真正会改变任务状态的操作', () => {
    const withUrl = (state: LarkCardActionState) => buttonIds(buildLarkCardActions(context(state, { capabilities: { ...allCapabilities, webUrl } })));
    expect(withUrl('queued')).toEqual(['cancel', 'refresh']);
    expect(withUrl('running')).toEqual(['interrupt', 'refresh']);
    expect(withUrl('failed')).toEqual(['retry']);
    expect(withUrl('interrupted')).toEqual(['retry']);
    expect(withUrl('completed')).toEqual([]);
  });

  it('taskId 不可用时顶部零按钮，Web 出口由页脚承担', () => {
    // 回调不可用不代表用户失去去向：页脚链接不依赖 taskId（见 service.test.ts 的页脚断言）。
    expect(buildLarkCardActions(context('running', { taskId: '', capabilities: { ...allCapabilities, webUrl } }))).toEqual([]);
  });

  it('safeLarkWebUrl 只放行 http/https，且限制长度', () => {
    // 校验必须随链接一起保留：页脚是唯一出口，它自己要挡住 javascript: 之类的目标。
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'not a url', '', undefined, `https://x.example.com/${'p'.repeat(600)}`]) {
      expect(safeLarkWebUrl(url), `${url} 不应被放行`).toBeUndefined();
    }
    expect(safeLarkWebUrl(webUrl)).toBe(webUrl);
    expect(safeLarkWebUrl('http://internal.example.com/')).toBe('http://internal.example.com/');
    expect(safeLarkWebUrl('  https://trim.example.com/  ')).toBe('https://trim.example.com/');
  });
});

describe('飞书卡片操作按钮：文案与元素预算', () => {
  it('每个按钮都有非空文案，语义不靠颜色单独承载', () => {
    for (const state of allStates) {
      const elements = buildLarkCardActions(context(state, {
        capabilities: { ...allCapabilities, webUrl: 'https://dutydeck.example.com/sessions/ses_1' }
      }));
      for (const element of elements) {
        expect(element.tag).toBe('button');
        expect(element.text?.tag).toBe('plain_text');
        expect(typeof element.text?.content).toBe('string');
        expect(String(element.text?.content).trim().length).toBeGreaterThan(0);
        expect(element.element_id).toBeTruthy();
        // 主操作按钮走默认尺寸：small 在手机上点击面积偏小，且与其他卡片按钮不一致。
        expect(element.size).toBeUndefined();
        // 一律无边框 + 图标；只有「重试」用蓝字标出下一步。
        expect(element.type).toBe(element.element_id === 'retry' ? 'primary_text' : 'text');
        expect(element.icon).toMatchObject({ tag: 'standard_icon', color: element.element_id === 'retry' ? 'blue' : 'grey' });
        expect(element.icon.token).toBe({
          cancel: 'close-small_outlined', interrupt: 'stop_outlined', retry: 'refresh_outlined',
          verify: 'safe-pass_outlined', refresh: 'refresh_outlined'
        }[element.element_id as string]);
      }
    }
  });

  it('每个回调操作都有「动作 + 对象 + 预期结果」的完整说明', () => {
    // 禁止用「处理」「继续」这类缺少对象的抽象动词作为唯一指引。
    for (const action of ['cancel', 'interrupt', 'retry', 'refresh'] as LarkCardActionName[]) {
      const hint = larkCardActionHint(action);
      expect(hint, `${action} 缺少说明文案`).toBeTruthy();
      expect(hint!.length).toBeGreaterThan(6);
      expect(hint).not.toMatch(/^(处理|继续)$/);
    }
    expect(larkCardActionHint('retry')).toContain('重新运行');
    expect(larkCardActionHint('refresh')).toContain('最新状态');
  });

  it('操作区不会撑爆飞书元素预算', () => {
    // 按钮会占用整卡 ~24KB / 180 组件的额度，操作区必须保持紧凑。
    for (const state of allStates) {
      const elements = buildLarkCardActions(context(state, {
        capabilities: { ...allCapabilities, webUrl: 'https://dutydeck.example.com/sessions/ses_1' }
      }));
      expect(elements.length).toBeLessThanOrEqual(larkCardActionBudget.maxButtons);
      // 每个按钮 = button 自身 + text.plain_text + icon 三个组件。
      const components = elements.length * larkCardActionBudget.componentsPerButton;
      expect(components).toBeLessThanOrEqual(larkCardActionBudget.maxButtons * larkCardActionBudget.componentsPerButton);
      expect(Buffer.byteLength(JSON.stringify(elements), 'utf8')).toBeLessThan(2_048);
    }
  });

  it('复用既有 element_id，保证既有测试与快照定位方式不变', () => {
    expect(buttonIds(buildLarkCardActions(context('queued', {}, { canRefresh: false })))).toEqual(['cancel']);
    expect(buttonIds(buildLarkCardActions(context('running', {}, { canRefresh: false })))).toEqual(['interrupt']);
    expect(buttonIds(buildLarkCardActions(context('failed')))).toEqual(['retry']);
    // 与 service.ts 当前硬编码的按钮形状保持一致，避免快照漂移。
    expect(buildLarkCardActions(context('running', { taskId: 'task-running' }, { canRefresh: false }))[0]).toEqual({
      tag: 'button',
      text: { tag: 'plain_text', content: '中断' },
      type: 'text',
      icon: { tag: 'standard_icon', token: 'stop_outlined', color: 'grey' },
      behaviors: [{ type: 'callback', value: { action: 'interrupt', task_id: 'task-running', turn: '0' } }],
      margin: '0px',
      element_id: 'interrupt'
    });
  });
});
