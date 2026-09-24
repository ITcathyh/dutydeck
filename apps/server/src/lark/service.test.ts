import { describe, expect, it, vi } from 'vitest';
import { boundLarkCardElements, buildLarkCard, createLarkCardService, larkCardSafeLimits, larkCardSnapshotLimits, larkCardStates, larkConfigurationStatus, larkIdentityPermissionHelp, LarkServiceError, loadLarkBotConfig } from './service.js';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const configured = {
  LARK_APP_ID: 'cli_test',
  LARK_APP_SECRET: 'secret_test',
  LARK_RECEIVE_ID: 'user@example.com',
  LARK_RECEIVE_ID_TYPE: 'email',
  LARK_AGENT_NAME: 'Business Agent'
};

describe('Lark card service', () => {
  const componentCount = (value: unknown): number => Array.isArray(value)
    ? value.reduce((sum, item) => sum + componentCount(item), 0)
    : value && typeof value === 'object'
      ? (typeof (value as any).tag === 'string' ? 1 : 0) + Object.values(value).reduce<number>((sum, item) => sum + componentCount(item), 0)
      : 0;

  it('bounds successful-card snapshots before they are sent and persisted', () => {
    const elements = Array.from({ length: 200 }, (_, index) => ({
      tag: 'collapsible_panel', element_id: `trace_group_${index}`,
      elements: [{ tag: 'markdown', content: `第 ${index} 组 ${'x'.repeat(500)}` }]
    }));
    const bounded = boundLarkCardElements(elements);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(larkCardSnapshotLimits.bytes);
    expect(componentCount(bounded)).toBeLessThanOrEqual(larkCardSnapshotLimits.components);
    expect(JSON.stringify(bounded)).toContain('dutydeck_snapshot_omission');
    expect(bounded.length).toBeLessThan(elements.length);
  });
  const components = (value: any): any[] => {
    if (Array.isArray(value)) return value.flatMap(components);
    if (!value || typeof value !== 'object') return [];
    return [...(typeof value.tag === 'string' ? [value] : []), ...Object.values(value).flatMap(components)];
  };
  const byId = (card: any, elementId: string) => components(card).find(element => element.element_id === elementId);
  it('renders a completed Card 2.0 with a clear task header, status, and compact footer', () => {
    const card = buildLarkCard({ agentName: 'Business Agent', workspace: '/srv/repo', permissionMode: 'full-trust', state: 'completed', taskName: 'Release', taskId: '42', elapsedSeconds: 65, markdown: '**done**' });
    expect(card.schema).toBe('2.0');
    // 这三个色值既当状态圆点又当状态文字，取的是白底上可读的飞书语义色。
    // 失败色曾是低饱和土黄（对比度约 2:1），当文字时几乎读不出来。
    expect(card.config.style.color).toMatchObject({
      trace_success: { light_mode: expect.stringContaining('46,161,33') },
      trace_failure: { light_mode: expect.stringContaining('163,77,0') },
      trace_running: { light_mode: expect.stringContaining('36,91,219') }
    });
    expect(card.header).toMatchObject({
      title: { tag: 'plain_text', content: 'Release' },
      subtitle: { tag: 'plain_text', content: 'Business Agent' },
      template: 'green'
    });
    // 已完成的卡不渲染状态行：结论直接排在最上面，不再被一行「已完成」往下推。
    expect(byId(card, 'task_status')).toBeUndefined();
    expect(card.body.elements[0].content).toBe('**done**');
    // 耗时改由页脚承担。Agent 名已经在 header 副标题里，页脚不写第二遍；
    // 本例没有 webBaseUrl，所以页脚只剩耗时这一列。
    expect(byId(card, 'task_elapsed').content).toContain('用时 1m 5s');
    expect(JSON.stringify(card)).not.toContain('text_tag');
    const rendered = JSON.stringify(card);
    expect(rendered).not.toContain("<font color='grey'>Business Agent</font>");
    expect(rendered).not.toContain('/srv/repo');
    expect(rendered).not.toContain('任务 #42');
    expect(rendered).not.toContain('完全信任');
  });

  it('没有 sessionId 时，Web 出口指向任务中心而不是会命中 not-found 的 /sessions', () => {
    // Web 路由只认 /sessions/:id，裸 /sessions 会落到「找不到这个页面」。
    // 任务尚未建立 session 时（解析中、排队中）飞书卡片仍要给出可用的去向。
    const withoutSession: any = buildLarkCard({ state: 'queued', taskId: 't1', webBaseUrl: 'https://web.example.com' });
    const withSession: any = buildLarkCard({ state: 'running', taskId: 't2', webBaseUrl: 'https://web.example.com', sessionId: 'ses_1' });
    const footerLink = (card: any) => card.body.elements.at(-1)?.columns?.at(-1)?.elements?.[0]?.content ?? '';

    expect(footerLink(withoutSession)).toContain('(https://web.example.com/)');
    expect(JSON.stringify(withoutSession)).not.toContain('web.example.com/sessions');
    expect(footerLink(withSession)).toContain('(https://web.example.com/sessions/ses_1)');
  });

  it('整卡只有一个查看详情入口，且落在页脚', () => {
    // 顶部曾经也有一个 open_url 按钮，与页脚链接指向同一个 session，是重复入口。
    const card: any = buildLarkCard({ state: 'running', taskId: 't1', sessionId: 'ses_1', webBaseUrl: 'https://web.example.com' });
    const rendered = JSON.stringify(card);
    expect(rendered.match(/查看详情/g) ?? []).toHaveLength(1);
    expect(rendered).not.toContain('open_url');
    expect(byId(card, 'view_detail')).toBeUndefined();
    expect(card.body.elements.at(-1).columns.at(-1).elements[0].content).toContain('[查看详情](https://web.example.com/sessions/ses_1)');
  });

  it('只读与恢复卡同样保留页脚的查看详情', () => {
    // 只读卡没有任何按钮，页脚链接是它唯一的 Web 出口，不能一起被拿掉。
    for (const state of larkCardStates) {
      const card: any = buildLarkCard({ state, taskId: 't1', sessionId: 'ses_1', readOnly: true, webBaseUrl: 'https://web.example.com' });
      const rendered = JSON.stringify(card);
      expect(rendered.match(/查看详情/g) ?? [], `state=${state}`).toHaveLength(1);
      expect(card.body.elements.at(-1).columns.at(-1).elements[0].content)
        .toContain('[查看详情](https://web.example.com/sessions/ses_1)');
    }
  });

  it('无效的 Web 深链不渲染任何详情链接', () => {
    // 页脚现在是唯一出口，校验必须由它自己承担，不能假设别处挡过了。
    for (const webBaseUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', '   ']) {
      const card: any = buildLarkCard({ state: 'running', taskId: 't1', sessionId: 'ses_1', webBaseUrl });
      expect(JSON.stringify(card), `${webBaseUrl} 不应渲染详情链接`).not.toContain('查看详情');
      // 链接被拒绝时页脚没有别的内容可放，整行不渲染，不留一个空页脚。
      expect(card.body.elements.filter((element: any) => element.tag === 'column_set' && element.element_id !== 'task_action_row')).toHaveLength(0);
    }
    const noUrl: any = buildLarkCard({ state: 'running', taskId: 't1', sessionId: 'ses_1' });
    expect(JSON.stringify(noUrl)).not.toContain('查看详情');
  });

  it('result 卡页脚一行依次是用时、@ 发起人、查看详情链接', () => {
    const card: any = buildLarkCard({
      cardKind: 'result',
      state: 'completed',
      elapsedSeconds: 75,
      sessionId: 'ses_1',
      webBaseUrl: 'https://web.example.com',
      elements: [
        { tag: 'markdown', element_id: 'final_output', content: '任务已完成' },
        { tag: 'markdown', element_id: 'group_mention', content: '<at id=ou_alice></at>' }
      ]
    });
    expect(card.body.elements.some((el: any) => el.element_id === 'group_mention')).toBe(false);
    const footer = card.body.elements.at(-1);
    expect(footer.tag).toBe('column_set');
    const firstColMarkdown = footer.columns[0].elements[0];
    expect(firstColMarkdown.element_id).toBe('task_elapsed');
    expect(firstColMarkdown.content).toBe("<font color='grey'>用时 1m 15s · </font><at id=ou_alice></at>");
    const secondColMarkdown = footer.columns[1].elements[0];
    expect(secondColMarkdown.content).toContain('[查看详情](https://web.example.com/sessions/ses_1)');
  });

  it('result 卡无耗时（如 failed）时，页脚第一列保留 group_mention 且内容为 mention 本身', () => {
    const card: any = buildLarkCard({
      cardKind: 'result',
      state: 'failed',
      elements: [
        { tag: 'markdown', element_id: 'final_output', content: '任务失败' },
        { tag: 'markdown', element_id: 'group_mention', content: '<at id=ou_alice></at>' }
      ]
    });
    expect(card.body.elements.some((el: any) => el.element_id === 'group_mention')).toBe(false);
    const footer = card.body.elements.at(-1);
    expect(footer.tag).toBe('column_set');
    const firstColMarkdown = footer.columns[0].elements[0];
    expect(firstColMarkdown.element_id).toBe('group_mention');
    expect(firstColMarkdown.content).toBe('<at id=ou_alice></at>');
  });

  it('同 a 的输入但不带 mention 时，与改动前结果一致，确保无回归', () => {
    const card: any = buildLarkCard({
      cardKind: 'result',
      state: 'completed',
      elapsedSeconds: 75,
      sessionId: 'ses_1',
      webBaseUrl: 'https://web.example.com',
      elements: [
        { tag: 'markdown', element_id: 'final_output', content: '任务已完成' }
      ]
    });
    const footer = card.body.elements.at(-1);
    expect(footer.tag).toBe('column_set');
    const firstColMarkdown = footer.columns[0].elements[0];
    expect(firstColMarkdown.element_id).toBe('task_elapsed');
    expect(firstColMarkdown.content).toBe("<font color='grey'>用时 1m 15s</font>");
    const secondColMarkdown = footer.columns[1].elements[0];
    expect(secondColMarkdown.content).toContain('[查看详情](https://web.example.com/sessions/ses_1)');
  });

  it('keeps state-specific actions in the top prompt row', () => {
    const queued: any = buildLarkCard({ state: 'queued', taskId: 'queued' });
    const running: any = buildLarkCard({ state: 'running', taskId: 'running', elapsedSeconds: 31 });
    const failed: any = buildLarkCard({ state: 'failed', taskId: 'failed' });
    const interrupted: any = buildLarkCard({ state: 'interrupted', taskId: 'interrupted' });
    expect(byId(queued, 'cancel')).toMatchObject({ text: { content: '取消' }, behaviors: [{ value: { action: 'cancel', task_id: 'queued' } }] });
    expect(byId(queued, 'interrupt')).toBeUndefined();
    expect(byId(queued, 'task_status').text.content).toContain('排队中');
    expect(queued.config).toMatchObject({ streaming_mode: false, summary: { content: expect.stringContaining('排队中') } });
    expect(byId(running, 'interrupt')).toMatchObject({ text: { content: '中断' }, behaviors: [{ value: { action: 'interrupt', task_id: 'running' } }] });
    expect(byId(failed, 'retry')).toMatchObject({ text: { content: '重试' }, behaviors: [{ value: { action: 'retry', task_id: 'failed' } }] });
    // 执行中不再挂状态标签：状态行左边的 loading 图标已经在说任务在跑，
    // 标签只是第三遍（第二遍在聊天列表的 summary 里）。排队中没有那个图标，
    // 状态只能由文字承担，标签保留。
    expect(byId(running, 'task_status').text.content).not.toContain('text_tag');
    expect(byId(running, 'task_status').icon).toMatchObject({ token: 'loading_outlined' });
    expect(byId(queued, 'task_status').text.content).toContain("<text_tag color='grey'>排队中</text_tag>");
    expect(byId(failed, 'task_status').text.content).toContain('已失败');
    expect(byId(failed, 'task_status').text.content).not.toContain('text_tag');
    expect(byId(interrupted, 'task_status').text.content).toContain('已中断');
    expect(byId(interrupted, 'task_status').text.content).not.toContain('text_tag');
    expect(byId(interrupted, 'retry')).toMatchObject({ behaviors: [{ value: { action: 'retry', task_id: 'interrupted' } }] });
    expect(byId(running, 'task_action_row')).toBe(running.body.elements[0]);
    expect(running.body.elements.filter((element: any) => element.tag === 'column_set').map((element: any) => element.element_id)).toEqual(['task_action_row']);
    expect(running.config).toMatchObject({ streaming_mode: true, summary: { content: expect.stringContaining('执行中') } });
    const loading0: any = buildLarkCard({ state: 'running', elapsedSeconds: 0 });
    const loading1: any = buildLarkCard({ state: 'running', elapsedSeconds: 1 });
    expect(loading0.header).toMatchObject({ template: 'blue', title: { content: 'Dutydeck' } });
    expect(byId(loading0, 'task_status')).toMatchObject({ tag: 'div', icon: { tag: 'standard_icon', token: 'loading_outlined', color: 'grey' } });
    // 0 秒不写耗时：这一格要么是首帧、要么是这张卡不会再更新，「已用时 0s」两种情况下都是假信息。
    expect(byId(loading0, 'task_status').text.content).not.toContain('已用时');
    expect(byId(loading0, 'task_status').text.content).toContain('执行中');
    expect(byId(loading1, 'task_status').text.content).toContain('已用时 1s');
    expect(byId(loading0, 'task_status').text.text_size).toBe('small');
    expect(buildLarkCard({ state: 'running', taskName: '任务摘要' }).header.title).toMatchObject({ tag: 'plain_text', content: '任务摘要' });
    expect(byId(loading1, 'task_status').icon.token).toBe('loading_outlined');
    const animated: any = buildLarkCard({ state: 'running', loadingImageKey: 'img_loading' });
    expect(byId(animated, 'task_status').icon).toMatchObject({ tag: 'custom_icon', img_key: 'img_loading', size: '20px 20px' });
    expect(failed.config.streaming_mode).toBe(false);
    expect(interrupted.config.streaming_mode).toBe(false);
  });

  it('pins interrupt above current running stage without trace overview wrapper', () => {
    const card: any = buildLarkCard({ state: 'running', taskId: 'trace-running', elapsedSeconds: 31, elements: [
      { tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false, header: { title: { tag: 'markdown', content: '步骤' } }, elements: [] }
    ] });
    expect(card.body.elements[0]).toMatchObject({ tag: 'column_set', element_id: 'task_action_row' });
    expect(components(card.body.elements).some(element => element.element_id === 'trace_overview')).toBe(false);
    expect(card.body.elements[1]).toMatchObject({ element_id: 'trace_group_0' });
    expect(byId(card, 'task_status').text.content).toContain('已用时');
    expect(byId(card, 'interrupt')).toMatchObject({ behaviors: [{ value: { action: 'interrupt', task_id: 'trace-running' } }] });
    expect(card.body.elements.filter((element: any) => element.tag === 'column_set').map((element: any) => element.element_id)).toEqual(['task_action_row']);
    const animated: any = buildLarkCard({ state: 'running', taskId: 'trace-animated', loadingImageKey: 'img_bouncing', elements: [
      { tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false, header: { title: { tag: 'markdown', content: '步骤' } }, elements: [] }
    ] });
    expect(byId(animated, 'task_status').icon).toMatchObject({ tag: 'custom_icon', img_key: 'img_bouncing' });
  });

  it('omits all action buttons from read-only cards', () => {
    for (const state of ['queued', 'running', 'failed', 'interrupted'] as const) {
      const card: any = buildLarkCard({ state, taskId: state, readOnly: true });
      expect(card.config.update_multi).toBe(true);
      // 只读卡没有按钮，也没有 webBaseUrl，所以整卡不应出现任何 column_set。
      expect(card.body.elements.filter((element: any) => element.tag === 'column_set')).toHaveLength(0);
    }
  });

  it('passes CLI Markdown through unchanged for every state', () => {
    const markdown = `### 自定义阶段\n\n${'very-long-command '.repeat(8)}\n\n🟢 业务自行决定展示数量`;
    const card: any = buildLarkCard({ state: 'running', markdown });
    expect(card.header).toMatchObject({ template: 'blue', title: { content: 'Dutydeck' } });
    expect(card.body.elements.some((element: any) => element.content === markdown)).toBe(true);
  });

  it('renders the user prompt summary as one plain-text line', () => {
    const card: any = buildLarkCard({
      state: 'running',
      taskName: '请完成 Trace 测试：\n1. 执行 pwd\n2. 读取 **package.json**\n3. 输出结论'
    });
    expect(card.header.title).toMatchObject({
      tag: 'plain_text',
      content: '请完成 Trace 测试： 1. 执行 pwd 2. 读取 **package.json** 3. 输出结论'
    });
  });

  it('keeps oversized trace cards below Feishu byte and component safety budgets', () => {
    const groups = Array.from({ length: 20 }, (_, groupIndex) => ({
      tag: 'collapsible_panel', element_id: `trace_group_${groupIndex}`, expanded: false,
      header: { title: { tag: 'markdown', content: `分组 ${groupIndex}` } },
      elements: Array.from({ length: 5 }, (_, toolIndex) => ({
        tag: 'collapsible_panel', element_id: `trace_tool_${groupIndex}_${toolIndex}`, expanded: false,
        header: { title: { tag: 'markdown', content: `工具 ${toolIndex}` } },
        elements: [{ tag: 'markdown', content: '超长工具输出'.repeat(500) }]
      }))
    }));
    const card = buildLarkCard({ state: 'running', elements: [{ tag: 'markdown', content: '**执行过程**' }, ...groups] });
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    expect(componentCount(card)).toBeLessThanOrEqual(larkCardSafeLimits.components);
    expect(JSON.stringify(card)).toContain('已省略');
  });

  it('bounds oversized card metadata and keeps the final JSON below the hard byte limit', () => {
    const huge = '超长字段'.repeat(7_500);
    const card: any = buildLarkCard({
      state: 'running',
      taskName: huge,
      agentName: huge,
      taskId: huge,
      sessionId: huge,
      webBaseUrl: `https://dutydeck.example/${huge}`,
      loadingImageKey: huge,
      markdown: huge
    });
    const serialized = JSON.stringify(card);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    expect(componentCount(card)).toBeLessThanOrEqual(larkCardSafeLimits.components);
    expect(Array.from(card.header.title.content).length).toBeLessThanOrEqual(160);
    expect(Array.from(card.header.subtitle.content).length).toBeLessThanOrEqual(64);
    expect(byId(card, 'interrupt').behaviors[0].value.task_id).toHaveLength(96);
    expect(serialized).not.toContain(huge);
  });

  it('places the final conclusion before a collapsed compact trace summary', () => {
    const card: any = buildLarkCard({ state: 'completed', taskName: '检查项目', elapsedSeconds: 97, elements: [
      { tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false, header: { title: { tag: 'markdown', content: '步骤' } }, elements: [] },
      { tag: 'markdown', element_id: 'final_output', content: '最终结论' }
    ] });
    const overviewIndex = card.body.elements.findIndex((element: any) => element.element_id === 'trace_overview');
    const statusIndex = card.body.elements.findIndex((element: any) => element.element_id === 'task_status');
    const finalIndex = card.body.elements.findIndex((element: any) => element.element_id === 'final_output');
    // 已完成的卡撤掉状态行，结论因此坐在第一位；耗时退到页脚。
    expect(statusIndex).toBe(-1);
    expect(finalIndex).toBe(0);
    expect(byId(card, 'task_elapsed').content).toContain('用时 1m 37s');
    expect(card.body.elements[overviewIndex]).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(card.body.elements[overviewIndex].header.title.content).toBe('执行记录');
    expect(card.body.elements[overviewIndex].header.title.text_size).toBe('notation');
    expect(card.body.elements[overviewIndex].header.title.icon).toBeUndefined();
    expect(finalIndex).toBeLessThan(overviewIndex);
  });

  it('keeps an explicitly supplied status label instead of the state default', () => {
    // 撤掉终态状态行、以及用 loading 图标顶替「执行中」标签，这两条省略规则都只看 state。
    // workflow 的审批卡、提问卡、办结卡走的正是同一个 buildLarkCard，却靠 statusLabel
    // 表达「停下来等人」「已处理」这些 state 说不出来的状态——被省掉之后，一张等人的卡上
    // 只剩一个表示「正在跑」的转圈图标，语义正好是反的。
    const waiting: any = buildLarkCard({ state: 'running', statusLabel: '等待审批', awaitingHuman: true, readOnly: true, taskName: '确认本次操作' });
    expect(byId(waiting, 'task_status').text.content).toContain('等待审批');
    // 等人的卡用橙色，必须和执行中的蓝色区分开，否则群里滚动时看不出它在等人。
    expect(waiting.header.template).toBe('orange');
    expect(buildLarkCard({ state: 'running', taskName: '确认本次操作' }).header.template).toBe('blue');
    // 审批卡由 workflow-interactions 一次性投递，之后不再心跳。执行中态照常写耗时的话，
    // 这张卡会永久挂着一个「已用时 0s」。
    expect(byId(waiting, 'task_status').text.content).not.toContain('已用时');

    // 提问卡问的是问题，不是让人去批。「等待审批」是 trace 自证那条路径的推断文案，
    // 不能覆盖调用方自己说的状态。
    const asking: any = buildLarkCard({ state: 'running', statusLabel: '等待回答', awaitingHuman: true, readOnly: true, taskName: 'Agent 需要你的回答' });
    expect(byId(asking, 'task_status').text.content).toContain('等待回答');
    expect(byId(asking, 'task_status').text.content).not.toContain('已用时');
    expect(asking.config.summary.content).toContain('等待回答');
    expect(JSON.stringify(asking)).not.toContain('等待审批');

    // 终态同理：「已处理」要留下，而这类卡从不传耗时，「已用时 0s」是永远不会变的假信息。
    const closed: any = buildLarkCard({ state: 'completed', statusLabel: '已处理', readOnly: true, taskName: '确认本次操作' });
    expect(byId(closed, 'task_status').text.content).toContain('已处理');
    expect(JSON.stringify(closed)).not.toContain('0s');
    expect(byId(closed, 'task_elapsed')).toBeUndefined();
  });

  it('never leaves the status row textless when a running card has no elapsed time yet', () => {
    // 「执行中」标签平时由转圈图标顶替，耗时为 0 时又不写耗时——两条省略规则叠在一起，
    // 首帧的状态行会退化成一个没有任何文字的图标。此时标签必须顶上。
    const firstFrame: any = buildLarkCard({ state: 'running', taskName: '构建服务端' });
    expect(byId(firstFrame, 'task_status').text.content).toContain("<text_tag color='wathet'>执行中</text_tag>");
    expect(byId(firstFrame, 'task_status').text.content).not.toContain('已用时');
    // 攒够耗时之后交回给图标，标签退场。
    const ticking: any = buildLarkCard({ state: 'running', taskName: '构建服务端', elapsedSeconds: 12 });
    expect(byId(ticking, 'task_status').text.content).toContain('已用时 12s');
    expect(byId(ticking, 'task_status').text.content).not.toContain('执行中');
  });

  it('shows only the actual task terminal state in the dedicated status row', () => {
    const trace = [{ tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false, header: { title: { tag: 'markdown', content: "步骤 <font color='orange'>● 部分失败</font>" } }, elements: [] }];
    // 已完成没有状态行可言：色带已中性、结果就在下面，「已完成」只会挤掉结果。
    // 失败和取消仍然要说，读者据此决定是否重试。
    expect(byId(buildLarkCard({ state: 'completed', elements: trace }), 'task_status')).toBeUndefined();
    expect(byId(buildLarkCard({ state: 'completed', elapsedSeconds: 97, elements: trace }), 'task_elapsed').content).toContain('用时 1m 37s');
    // 没有耗时可报时页脚不编一个：终态的「0s」不会再变，是永久留在卡上的假信息。
    expect(byId(buildLarkCard({ state: 'completed', elements: trace }), 'task_elapsed')).toBeUndefined();
    expect(byId(buildLarkCard({ state: 'completed', elements: trace }), 'trace_overview').header.title.content).not.toContain('部分失败');
    expect(byId(buildLarkCard({ state: 'failed', elements: trace }), 'task_status').text.content).toContain('已失败');
    expect(byId(buildLarkCard({ state: 'interrupted', elements: trace }), 'task_status').text.content).toContain('已中断');
  });

  it('reports missing bot configuration without exposing secrets', () => {
    expect(larkConfigurationStatus({ LARK_APP_ID: 'cli_test' })).toMatchObject({ configured: false, listening: false, missing: ['LARK_APP_SECRET'], defaultAgentName: 'Dutydeck' });
    expect(larkConfigurationStatus({}, { appId: 'cli_input', appSecret: 'secret_input', agentName: 'Input Agent' })).toMatchObject({ configured: true, listening: false, missing: [], defaultAgentName: 'Input Agent' });
    expect(larkConfigurationStatus({ LARK_CHAT_ID: 'oc_group' })).toMatchObject({ defaultReceiveIdConfigured: true, defaultReceiveIdType: 'chat_id' });
  });

  it('loads app credentials directly from environment variables', () => {
    expect(loadLarkBotConfig({ LARK_APP_ID: 'cli_env', LARK_APP_SECRET: 'secret_env' })).toMatchObject({ appId: 'cli_env', appSecret: 'secret_env' });
  });

  it('sends a card and reuses the tenant token for an update', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { image_key: 'img_loading' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_sent', chat_id: 'oc_chat' } }))
      .mockResolvedValueOnce(response({ code: 0, data: {} }));
    const service = createLarkCardService(configured, fetcher as typeof fetch);
    await expect(service.send({ state: 'running', taskId: '42', elapsedSeconds: 31, markdown: '业务传入的运行态正文', idempotencyKey: 'task-42' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_chat' });
    await expect(service.update({ messageId: 'om_sent', state: 'completed', taskId: '42', markdown: '完成' })).resolves.toEqual({ messageId: 'om_sent', chatId: undefined });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/images');
    const send = fetcher.mock.calls[2];
    expect(send?.[0]).toContain('receive_id_type=email');
    const sendBody = JSON.parse(String(send?.[1]?.body));
    expect(sendBody.receive_id).toBe('user@example.com');
    expect(sendBody.uuid).toBe('task-42');
    const sentCard = JSON.parse(sendBody.content);
    expect(sentCard.header).toMatchObject({ template: 'blue', subtitle: { content: 'Business Agent' } });
    expect(byId(sentCard, 'task_status').text.content).toContain('已用时');
    expect(byId(sentCard, 'task_status').icon).toMatchObject({ tag: 'custom_icon', img_key: 'img_loading' });
    expect(byId(sentCard, 'interrupt')).toMatchObject({ behaviors: [{ value: { action: 'interrupt', task_id: '42' } }] });
    const update = fetcher.mock.calls[3];
    expect(update?.[0]).toContain('/open-apis/im/v1/messages/om_sent');
    expect(update?.[1]?.method).toBe('PATCH');
  });

  it('fails clearly when credentials are absent', async () => {
    expect(() => createLarkCardService({})).toThrowError(expect.objectContaining<LarkServiceError>({ code: 'LARK_NOT_CONFIGURED', statusCode: 503 }));
  });

  it('rejects invalid action windows and recipient ID types', async () => {
    const service = createLarkCardService(configured, vi.fn() as unknown as typeof fetch);
    await expect(service.send({ receiveIdType: 'bad' as any })).rejects.toMatchObject({ code: 'INVALID_RECEIVE_ID_TYPE', statusCode: 400 });
    await expect(service.send({ chatId: 'not-a-chat' })).rejects.toMatchObject({ code: 'INVALID_CHAT_ID', statusCode: 400 });
    await expect(service.send({ chatId: 'oc_group', receiveId: 'user@example.com' })).rejects.toMatchObject({ code: 'CONFLICTING_RECIPIENTS', statusCode: 400 });
  });

  it('sends to a group with the chat_id receive type', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_group', chat_id: 'oc_group' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.send({ chatId: 'oc_group', state: 'completed', markdown: '群聊消息' })).resolves.toEqual({ messageId: 'om_group', chatId: 'oc_group' });
    expect(fetcher.mock.calls[1]?.[0]).toContain('receive_id_type=chat_id');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).receive_id).toBe('oc_group');
  });

  it('replies with an interactive card to the source message', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_group' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.reply({ messageId: 'om_source', replyInThread: true, state: 'completed', taskId: 'task-1', markdown: '话题内回复', idempotencyKey: 'task-1' })).resolves.toEqual({ messageId: 'om_reply', chatId: 'oc_group' });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/messages/om_source/reply');
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({ msg_type: 'interactive', reply_in_thread: true, uuid: 'task-1' });
    // 已完成的卡没有状态行，回复路径的验收改看正文。
    const replied = JSON.parse(body.content);
    expect(replied.body.elements.some((element: any) => element.content === '话题内回复')).toBe(true);
    expect(byId(replied, 'task_status')).toBeUndefined();
  });

  it('anchors a thread reply to the root message when replyRootId is provided', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_group' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.reply({ messageId: 'om_source', replyInThread: true, replyRootId: 'om_root', state: 'completed', taskId: 'task-2', markdown: '锚到话题根' })).resolves.toEqual({ messageId: 'om_reply', chatId: 'oc_group' });
    // 话题根锚点：path 用 replyRootId（om_root），而非触发消息 om_source。
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/messages/om_root/reply');
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({ msg_type: 'interactive', reply_in_thread: true });
  });

  it('ignores replyRootId for non-thread replies (anchors to messageId)', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_group' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await service.reply({ messageId: 'om_source', replyRootId: 'om_root', state: 'completed', taskId: 'task-3', markdown: '非话题回复' });
    // 未开 replyInThread 时 replyRootId 不生效，path 仍用触发消息 om_source。
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/messages/om_source/reply');
    const body = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(body).not.toHaveProperty('reply_in_thread');
  });

  it('adds and removes a reaction through the bot API', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { reaction_id: 'reaction-1' } }))
      .mockResolvedValueOnce(response({ code: 0, data: {} }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.addReaction('om_input', 'SMILE')).resolves.toEqual({ messageId: 'om_input', reactionId: 'reaction-1', emojiType: 'SMILE' });
    await expect(service.deleteReaction('om_input', 'reaction-1')).resolves.toBeUndefined();
    expect(fetcher.mock.calls[1]?.[0]).toContain('/messages/om_input/reactions');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/messages/om_input/reactions/reaction-1');
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });

  it('lists only the current app reactions across all pages', async () => {
    const reaction = (id: string, operatorType: string, operatorId: string, emojiType = 'OK') => ({
      reaction_id: id, operator: { operator_type: operatorType, operator_id: operatorId }, reaction_type: { emoji_type: emojiType }
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [
        reaction('other-app', 'app', 'cli_other'), reaction('human', 'user', 'cli_test'), reaction('other-emoji', 'app', 'cli_test', 'SMILE')
      ], has_more: true, page_token: 'page/2' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [reaction('own', 'app', 'cli_test')], has_more: false } }));
    const service = createLarkCardService(configured, fetcher as typeof fetch);
    await expect(service.listOwnReactions('om/input', 'OK')).resolves.toEqual([{ messageId: 'om/input', reactionId: 'own', emojiType: 'OK' }]);
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://open.feishu.cn/open-apis/im/v1/messages/om%2Finput/reactions?reaction_type=OK&user_id_type=open_id&page_size=50');
    expect(fetcher.mock.calls[2]?.[0]).toContain('&page_token=page%2F2');
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET');
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe('GET');
  });

  it.each([
    { items: [], has_more: true },
    { items: [], has_more: true, page_token: ' ' },
    { items: [] },
    { has_more: false },
    { items: [{ operator: { operator_type: 'app', operator_id: 'cli_test' }, reaction_type: { emoji_type: 'OK' } }], has_more: false }
  ])('rejects an incomplete reaction page instead of reporting no reactions: %j', async data => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data }));
    const service = createLarkCardService(configured, fetcher as typeof fetch);
    await expect(service.listOwnReactions('om_input', 'OK')).rejects.toMatchObject({ code: 'INVALID_LARK_RESPONSE' });
  });

  it('rejects repeated reaction page tokens instead of returning a partial list', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockImplementation(async () => response({ code: 0, data: { items: [], has_more: true, page_token: 'stuck' } }));
    const service = createLarkCardService(configured, fetcher as typeof fetch);
    await expect(service.listOwnReactions('om_input', 'OK')).rejects.toMatchObject({ code: 'INVALID_LARK_RESPONSE' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('propagates a failed reaction page instead of reporting no reactions', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [], has_more: true, page_token: 'page-2' } }))
      .mockResolvedValueOnce(response({ code: 99991672, msg: 'Access denied' }, 403));
    const service = createLarkCardService(configured, fetcher as typeof fetch);
    await expect(service.listOwnReactions('om_input', 'OK')).rejects.toMatchObject({ code: 'LARK_OPENAPI_ERROR' });
  });

  it('downloads a message attachment with the tenant token', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    const service = createLarkCardService(configured, fetcher as typeof fetch);
    await expect(service.downloadMessageResource('om_input', 'img_1', 'image')).resolves.toEqual({
      data: new Uint8Array([1, 2, 3]), contentType: 'image/png'
    });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/messages/om_input/resources/img_1?type=image');
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer token' } });
  });

  it('keeps resource permission failures actionable', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 99991672, msg: 'Access denied', error: { console_url: 'https://open.feishu.cn/app/auth' } }, 403));
    const service = createLarkCardService(configured, fetcher as typeof fetch);
    await expect(service.downloadMessageResource('om_input', 'file_1', 'file')).rejects.toMatchObject({
      code: 'LARK_RESOURCE_DOWNLOAD_FAILED', details: { upstreamCode: 99991672, consoleUrl: 'https://open.feishu.cn/app/auth' }
    });
  });

  it('resolves the bot open ID used to verify mentions', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, bot: { open_id: 'ou_bot' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.getBotOpenId()).resolves.toBe('ou_bot');
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/bot/v3/info');
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET');
  });

  it('resolves bot identity and sender emails through official OpenAPI', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, bot: { app_name: '超级智慧大脑', open_id: 'ou_bot', avatar_url: 'https://example.com/avatar.png', activate_status: 2 } }))
      .mockResolvedValueOnce(response({ code: 0, data: { user: { email: 'USER@example.com', enterprise_email: 'staff@company.com' } } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.getBotInfo()).resolves.toEqual({ appName: '超级智慧大脑', openId: 'ou_bot', avatarUrl: 'https://example.com/avatar.png', activateStatus: 2 });
    await expect(service.getUserEmails('ou_sender')).resolves.toEqual(['user@example.com', 'staff@company.com']);
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/bot/v3/info');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/open-apis/contact/v3/users/ou_sender?user_id_type=open_id');
  });

  it('preflights contact data scope and the email field before enabling identity gates', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { user_ids: ['ou_sample'] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { user: { email: 'SAMPLE@example.com' } } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.checkIdentityResolution()).resolves.toEqual({ verified: true, sampleOpenId: 'ou_sample', sampleEmails: ['sample@example.com'] });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/contact/v3/scopes?user_id_type=open_id&page_size=100');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/open-apis/contact/v3/users/ou_sample?user_id_type=open_id');
  });

  it('reports the precise missing resource when contact scope cannot yield a test user', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { user_ids: [] } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.checkIdentityResolution()).rejects.toMatchObject({ code: 'LARK_CONTACT_DATA_SCOPE_EMPTY', statusCode: 409 });
  });

  it('links identity permission help to the current bot app', () => {
    const help = larkIdentityPermissionHelp(new Error('permission denied'), 'cli_test');
    expect(help).toContain('https://open.larkoffice.com/app/cli_test/auth');
    expect(help).toContain('打开当前机器人的权限配置');
  });

  it('lists the bot groups with real display names for member selection', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ chat_id: 'oc_group', name: '研发群', description: '项目协作', owner_id: 'ou_owner', external: false, chat_mode: 'group', chat_status: 'normal' }], has_more: false } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.listChats()).resolves.toEqual({
      items: [{ chatId: 'oc_group', name: '研发群', description: '项目协作', ownerId: 'ou_owner', external: false, chatMode: 'group', chatStatus: 'normal' }],
      hasMore: false
    });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/chats?user_id_type=open_id&page_size=100&sort_type=ByActiveTimeDesc');
  });

  it('passes sort_type to the chats API when specified, defaulting to ByActiveTimeDesc', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [], has_more: false } }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [], has_more: false } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await service.listChats(undefined, 'ByCreateTimeAsc');
    expect(fetcher.mock.calls[1]?.[0]).toContain('sort_type=ByCreateTimeAsc');
    await service.listChats();
    expect(fetcher.mock.calls[2]?.[0]).toContain('sort_type=ByActiveTimeDesc');
  });

  it('filters out dissolved chats while retaining normal and status-missing chats', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({
        code: 0,
        data: {
          items: [
            { chat_id: 'oc_dissolved_save', name: '解散保留群', chat_mode: 'group', chat_status: 'dissolved_save' },
            { chat_id: 'oc_dissolved', name: '已解散群', chat_mode: 'group', chat_status: 'dissolved' },
            { chat_id: 'oc_normal', name: '正常群', chat_mode: 'group', chat_status: 'normal' },
            { chat_id: 'oc_missing', name: '无状态群', chat_mode: 'group' }
          ],
          has_more: false
        }
      }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    const result = await service.listChats();
    expect(result.items).toEqual([
      { chatId: 'oc_normal', name: '正常群', chatMode: 'group', chatStatus: 'normal', external: false },
      { chatId: 'oc_missing', name: '无状态群', chatMode: 'group', external: false }
    ]);
  });

  it('resolves member names without throwing when dissolved chats are present', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes('tenant_access_token')) {
        return response({ code: 0, tenant_access_token: 'token', expire: 7200 });
      }
      if (href.includes('/open-apis/im/v1/chats?')) {
        return response({
          code: 0,
          data: {
            items: [
              { chat_id: 'oc_ghost', name: '幽灵群', chat_mode: 'group', chat_status: 'dissolved_save' },
              { chat_id: 'oc_live', name: '活跃群', chat_mode: 'group', chat_status: 'normal' }
            ],
            has_more: false
          }
        });
      }
      if (href.includes('/open-apis/im/v1/chats/oc_ghost/members')) {
        return response({ code: 232009, msg: 'Your request specifies a chat which has already been dissolved.' }, 400);
      }
      if (href.includes('/open-apis/im/v1/chats/oc_live/members')) {
        return response({
          code: 0,
          data: {
            items: [{ member_id: 'ou_zhang', member_id_type: 'open_id', name: '张三' }],
            has_more: false
          }
        });
      }
      return response({ code: 99999, msg: 'unexpected URL ' + href }, 500);
    });
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    const resolved = await service.resolveChatUsersByNames(['张三']);
    expect(resolved).toEqual([{ openId: 'ou_zhang', name: '张三' }]);
  });

  it('rejects an ambiguous typed member name instead of authorizing the wrong open_id', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ chat_id: 'oc_one', name: '一群', external: false }, { chat_id: 'oc_two', name: '二群', external: false }], has_more: false } }))
      .mockResolvedValueOnce(response({ code: 0, data: { users: [{ member_id: 'ou_first', open_id: 'ou_first', name: '张伟' }], has_more: false } }))
      .mockResolvedValueOnce(response({ code: 0, data: { users: [{ member_id: 'ou_second', open_id: 'ou_second', name: '张伟' }], has_more: false } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.resolveChatUsersByNames(['张伟'])).rejects.toMatchObject({ code: 'LARK_USER_NAME_AMBIGUOUS', statusCode: 409 });
  });

  it('lists group bots and messages, then sends and replies with plain text', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { bots: [{ member_id: 'ou_peer', member_id_type: 'open_id', name: 'Peer Bot', app_id: 'cli_peer' }], has_more: false, bot_total: 1, truncations: [{ member_type: 'bot', limit: 100 }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ message_id: 'om_1', chat_id: 'oc_group', msg_type: 'text', create_time: '1000', sender: { id: 'ou_peer', id_type: 'open_id', sender_type: 'app', name: 'Peer Bot' }, body: { content: '{"text":"hello"}' } }], has_more: false } }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ message_id: 'om_1', chat_id: 'oc_group', msg_type: 'text', create_time: '1000', body: { content: '{"text":"hello"}' } }] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_sent', chat_id: 'oc_group' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_reply', chat_id: 'oc_group' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.listChatMembers({ chatId: 'oc_group', memberTypes: ['bot'] })).resolves.toMatchObject({
      items: [{ memberId: 'ou_peer', memberType: 'bot', openId: 'ou_peer', appId: 'cli_peer', name: 'Peer Bot' }], hasMore: false, memberTotal: 1, securityLimit: 100, securityLimited: true
    });
    await expect(service.listChatMessages({ chatId: 'oc_group', order: 'desc', pageSize: 20 })).resolves.toMatchObject({
      items: [{ messageId: 'om_1', chatId: 'oc_group', messageType: 'text', rawContent: '{"text":"hello"}', sender: { id: 'ou_peer', type: 'app', name: 'Peer Bot' } }]
    });
    await expect(service.getMessage('om_1')).resolves.toMatchObject({ messageId: 'om_1', chatId: 'oc_group' });
    await expect(service.sendText({ chatId: 'oc_group', text: 'hello', idempotencyKey: 'send-1' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_group' });
    await expect(service.replyText({ messageId: 'om_1', text: 'reply', replyInThread: true, idempotencyKey: 'reply-1' })).resolves.toEqual({ messageId: 'om_reply', chatId: 'oc_group' });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/chats/oc_group/members/list?member_id_type=open_id&member_types=bot');
    expect(fetcher.mock.calls[2]?.[0]).toContain('/open-apis/im/v1/messages?container_id_type=chat&container_id=oc_group');
    expect(fetcher.mock.calls[3]?.[0]).toContain('/open-apis/im/v1/messages/om_1?user_id_type=open_id');
    expect(JSON.parse(String(fetcher.mock.calls[4]?.[1]?.body))).toEqual({ receive_id: 'oc_group', msg_type: 'text', content: '{"text":"hello"}', uuid: 'send-1' });
    expect(JSON.parse(String(fetcher.mock.calls[5]?.[1]?.body))).toEqual({ msg_type: 'text', content: '{"text":"reply"}', reply_in_thread: true, uuid: 'reply-1' });
  });

  it('includes topic replies when listing group messages', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [
        { message_id: 'om_root', chat_id: 'oc_group', msg_type: 'text', create_time: '1000', thread_id: 'omt_topic', body: { content: '{"text":"第一轮"}' } },
        { message_id: 'om_reply', chat_id: 'oc_group', msg_type: 'text', create_time: '2000', thread_id: 'omt_topic', body: { content: '{"text":"第二轮"}' } }
      ], has_more: false } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    const result = await service.listChatMessages({ chatId: 'oc_group', order: 'asc', pageSize: 20 });
    expect(result.items.map(item => ({ messageId: item.messageId, threadId: item.threadId }))).toEqual([
      { messageId: 'om_root', threadId: 'omt_topic' },
      { messageId: 'om_reply', threadId: 'omt_topic' }
    ]);
    const requestUrl = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(requestUrl.searchParams.get('only_thread_root_messages')).toBe('false');
  });

  it('normalizes independent thread/root/parent IDs from authoritative message detail without substituting upper_message_id', async () => {
    const item = { message_id: 'om_edit', chat_id: 'oc_group', msg_type: 'text',
      sender: { id: 'ou_author', id_type: 'open_id', sender_type: 'user' },
      body: { content: '{"text":"edited"}' }, mentions: [{ id: 'ou_bot', id_type: 'open_id', key: '@_user_1' }],
      thread_id: 'omt_thread', root_id: 'om_root', parent_id: 'om_parent', upper_message_id: 'om_forward' };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [item] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ ...item, root_id: undefined, parent_id: undefined }] } }));
    const service = createLarkCardService(configured, fetcher as typeof fetch);
    await expect(service.getMessage('om_edit')).resolves.toMatchObject({
      messageId: 'om_edit', threadId: 'omt_thread', rootId: 'om_root', parentId: 'om_parent', upperMessageId: 'om_forward',
      sender: { id: 'ou_author', idType: 'open_id', type: 'user' }, mentions: [{ id: 'ou_bot', idType: 'open_id' }]
    });
    const noParent = await service.getMessage('om_edit');
    expect(noParent.rootId).toBeUndefined();
    expect(noParent.parentId).toBeUndefined();
    expect(noParent.upperMessageId).toBe('om_forward');
  });

  it('replies with an interactive card under a message so results land in the thread position', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { image_key: 'img_loading' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_reply_card', chat_id: 'oc_group' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.reply({ messageId: 'om_trigger', state: 'running', taskId: 't1', taskName: '任务', idempotencyKey: 'reply-card-1' })).resolves.toEqual({ messageId: 'om_reply_card', chatId: 'oc_group' });
    expect(fetcher.mock.calls[2]?.[0]).toContain('/open-apis/im/v1/messages/om_trigger/reply');
    const body = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(body.msg_type).toBe('interactive');
    expect(body.uuid).toBe('reply-card-1');
    expect(body).not.toHaveProperty('reply_in_thread');
    expect(body.content).toContain('执行中');
    expect(body.content).toContain('任务');
  });

  it('surfaces Retry-After and x-ogw-ratelimit-reset to the rate-limit gate as milliseconds', async () => {
    // service.ts 是唯一能看到响应头的地方。若不把这两个头换算成 details.retryAfterMs，
    // api-gate 就只能盲目指数退避，无法尊重飞书明确要求的等待时长。
    // 两个头同时出现时取较大值：宁可多等，也不要再撞一次频控。
    const rateLimited = () => new Response(JSON.stringify({ code: 230020, msg: 'too many request' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '2', 'x-ogw-ratelimit-reset': '7' }
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockImplementation(async () => rateLimited());
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test', LARK_API_RETRY_MAX_ATTEMPTS: '0' }, fetcher as typeof fetch);
    const error = await service.update({ messageId: 'om_card', state: 'running', taskId: 't1' }).catch(caught => caught);
    expect(error).toBeInstanceOf(LarkServiceError);
    expect((error as LarkServiceError).details?.upstreamHttpStatus).toBe(429);
    // 取 max(2s, 7s) = 7s，并换算成毫秒。
    expect((error as LarkServiceError).details?.retryAfterMs).toBe(7_000);
  });

  it('omits retryAfterMs when the response carries no rate-limit headers', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockImplementation(async () => response({ code: 99991663, msg: 'invalid param' }, 400));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test', LARK_API_RETRY_MAX_ATTEMPTS: '0' }, fetcher as typeof fetch);
    const error = await service.update({ messageId: 'om_card', state: 'running', taskId: 't1' }).catch(caught => caught);
    expect(error).toBeInstanceOf(LarkServiceError);
    expect((error as LarkServiceError).details).not.toHaveProperty('retryAfterMs');
  });

  it('uploads the original file bytes as multipart and sends the returned file key', async () => {
    const bytes = new Uint8Array([0, 255, 1, 2]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { file_key: 'file_key_1' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { message_id: 'om_file', chat_id: 'oc_dm' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.uploadFile({ data: bytes, filename: 'raw.bin', idempotencyKey: 'artifact-1' })).resolves.toBe('file_key_1');
    const form = fetcher.mock.calls[1]![1].body as FormData;
    const part = form.get('file') as Blob;
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes);
    await expect(service.sendFile({ chatId: 'oc_dm', fileKey: 'file_key_1', idempotencyKey: 'artifact-1' })).resolves.toMatchObject({ messageId: 'om_file', chatId: 'oc_dm' });
    expect(fetcher.mock.calls[2]![0]).toContain('receive_id_type=chat_id');
    expect(JSON.parse(String(fetcher.mock.calls[2]![1].body))).toMatchObject({ msg_type: 'file', content: JSON.stringify({ file_key: 'file_key_1' }), uuid: 'artifact-1' });
  });

  it('rejects external and non-docx wiki URLs before fetching document content', async () => {
    const fetcher = vi.fn(); const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.readDocument('https://example.com/docx/abc')).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_URL' });
    expect(fetcher).not.toHaveBeenCalled();
    const wikiFetcher = vi.fn().mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 })).mockResolvedValueOnce(response({ code: 0, data: { node: { obj_type: 'sheet', obj_token: 'sheet_1' } } }));
    const wiki = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, wikiFetcher as typeof fetch);
    await expect(wiki.readDocument('https://feishu.cn/wiki/wiki_token')).rejects.toMatchObject({ code: 'UNSUPPORTED_DOCUMENT_TYPE' });
    expect(wikiFetcher).toHaveBeenCalledTimes(2);
  });

  it('returns docx block links alongside raw text and reports an incomplete block read', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { content: '根文档正文' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [
        { block_type: 12, bullet: { elements: [{ mention_doc: { title: '子文档', url: 'https://tenant.larkoffice.com/docx/child' } }] } },
        { block_type: 2, text: { elements: [{ text_run: { content: '入口', text_element_style: { link: { url: 'https://tenant.larkoffice.com/wiki/linked' } } } }] } }
      ], has_more: false } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.readDocument('https://tenant.larkoffice.com/docx/root')).resolves.toMatchObject({
      text: '根文档正文',
      links: ['https://tenant.larkoffice.com/docx/child', 'https://tenant.larkoffice.com/wiki/linked'],
      linkTitles: [{ url: 'https://tenant.larkoffice.com/docx/child', title: '子文档' }]
    });
    expect(fetcher.mock.calls[2]![0]).toContain('/open-apis/docx/v1/documents/root/blocks?page_size=500');

    const failed = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { content: '仍可读的正文' } }))
      .mockResolvedValueOnce(response({ code: 99991663, msg: 'permission denied' }, 403));
    const failedService = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, failed as typeof fetch);
    await expect(failedService.readDocument('https://tenant.larkoffice.com/docx/root')).resolves.toMatchObject({
      text: '仍可读的正文', linkError: expect.stringContaining('permission denied')
    });
  });

  it('follows block pagination and flags a continuation that cannot be completed', async () => {
    const first = 'https://tenant.larkoffice.com/docx/first';
    const second = 'https://tenant.larkoffice.com/docx/second';
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { content: '正文' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ text: { elements: [{ mention_doc: { url: first } }] } }], has_more: true, page_token: 'next' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ text: { elements: [{ mention_doc: { url: second } }] } }], has_more: true, page_token: 'next' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.readDocument('https://tenant.larkoffice.com/docx/root')).resolves.toMatchObject({
      text: '正文', links: [first, second], linkError: expect.stringContaining('未完整读取')
    });
    expect(fetcher.mock.calls[3]![0]).toContain('page_token=next');
  });

  it('sends in-app urgent request for a single message to target users', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { invalid_user_id_list: [] } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    const result = await service.urgentApp({
      messageId: 'om_target_msg',
      userIdList: ['ou_user_1', 'ou_user_2'],
      userIdType: 'open_id'
    });
    expect(result).toEqual({ invalidUserIdList: [] });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/messages/om_target_msg/urgent_app?user_id_type=open_id');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      user_id_list: ['ou_user_1', 'ou_user_2']
    });
  });

  it('validates urgentApp inputs and handles API errors', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 230001, msg: 'message not found' }, 400));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);

    await expect(service.urgentApp({ messageId: '', userIdList: ['ou_1'] }))
      .rejects.toMatchObject({ code: 'LARK_NOT_CONFIGURED' });
    await expect(service.urgentApp({ messageId: 'om_1', userIdList: [] }))
      .rejects.toMatchObject({ code: 'INVALID_URGENT_INPUT' });
    await expect(service.urgentApp({ messageId: 'om_not_found', userIdList: ['ou_1'] }))
      .rejects.toBeInstanceOf(LarkServiceError);
  });

  it('safeUrgentApp catches failures and returns undefined without throwing', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 99991663, msg: 'urgent failed' }, 500));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test', LARK_API_RETRY_MAX_ATTEMPTS: '0' }, fetcher as typeof fetch);
    const warn = vi.fn();

    const result = await service.safeUrgentApp(
      { messageId: 'om_card', userIdList: ['ou_target'] },
      { warn }
    );
    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain('加急');
  });

  it('pins, unpins, and lists message pins', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { pin: { message_id: 'om_pin_msg', chat_id: 'oc_pin_chat' } } }))
      .mockResolvedValueOnce(response({ code: 0 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ message_id: 'om_pin_msg', chat_id: 'oc_pin_chat' }], has_more: false } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);

    const pinResult = await service.pin('om_pin_msg');
    expect(pinResult).toEqual({ messageId: 'om_pin_msg', chatId: 'oc_pin_chat' });
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/pins');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ message_id: 'om_pin_msg' });

    await expect(service.unpin('om_pin_msg')).resolves.toBeUndefined();
    expect(fetcher.mock.calls[2]?.[0]).toContain('/open-apis/im/v1/pins/om_pin_msg');
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe('DELETE');

    const listResult = await service.listPins('oc_pin_chat');
    expect(listResult).toEqual({
      items: [{ messageId: 'om_pin_msg', chatId: 'oc_pin_chat' }],
      hasMore: false,
      pageToken: undefined
    });
    expect(fetcher.mock.calls[3]?.[0]).toContain('/open-apis/im/v1/pins?chat_id=oc_pin_chat');
  });

  it('syncs native slash commands with the tenant token, creating and updating only what differs', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [
        { command_id: 'cmd_help', command: 'help', description: { default_value: '旧说明' } },
        { command_id: 'cmd_tasks', command: '/tasks', description: { default_value: '看任务' } },
        { command_id: 'cmd_manual', command: 'manual_command', description: { default_value: '人手工加的' } }
      ] } }))
      .mockResolvedValueOnce(response({ code: 0, data: { command_id: 'cmd_new' } }))
      .mockResolvedValueOnce(response({ code: 0, data: {} }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);

    await expect(service.syncSlashCommands([
      { command: 'help', description: '新说明' },
      { command: 'tasks', description: '看任务' },
      { command: 'repair', description: '一键修复' }
    ])).resolves.toEqual({ created: ['repair'], updated: ['help'] });

    // 列表走 tenant token 的 GET；控制台会话那条路（cookie + CSRF + /developers/v1/*）不再参与。
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://open.feishu.cn/open-apis/application/v7/app_slash_commands');
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET');
    expect((fetcher.mock.calls[1]?.[1]?.headers as any).authorization).toBe('Bearer token');
    // 取值变化用 PUT /:command_id，新增用 POST；远端多出来的 manual_command 一个字都不碰。
    expect(fetcher.mock.calls[2]?.[0]).toBe('https://open.feishu.cn/open-apis/application/v7/app_slash_commands/cmd_help');
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe('PUT');
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ command: 'help', description: { default_value: '新说明' } });
    expect(fetcher.mock.calls[3]?.[0]).toBe('https://open.feishu.cn/open-apis/application/v7/app_slash_commands');
    expect(fetcher.mock.calls[3]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({ command: 'repair', description: { default_value: '一键修复' } });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.some(call => String(call[0]).includes('manual_command'))).toBe(false);
  });

  it('follows the slash command list pagination so later pages are not mistaken for missing commands', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: {
        items: [{ command_id: 'cmd_help', command: 'help', description: { default_value: '看帮助' } }],
        has_more: true, page_token: 'page-2'
      } }))
      .mockResolvedValueOnce(response({ code: 0, data: {
        items: [{ command_id: 'cmd_tasks', command: 'tasks', description: { default_value: '看任务' } }],
        has_more: false
      } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);

    // 第二页里的 tasks 已经存在：把分页当不存在会把它当成缺失去重复创建，逐条撞唯一性失败。
    await expect(service.syncSlashCommands([
      { command: 'help', description: '看帮助' },
      { command: 'tasks', description: '看任务' }
    ])).resolves.toEqual({ created: [], updated: [] });

    expect(fetcher.mock.calls[1]?.[0]).toBe('https://open.feishu.cn/open-apis/application/v7/app_slash_commands');
    expect(fetcher.mock.calls[2]?.[0]).toBe('https://open.feishu.cn/open-apis/application/v7/app_slash_commands?page_token=page-2');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('stops after one slash command list request when the response carries no continuation marker', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      // 没有 has_more / page_token：按全量处理，不再多请求一次。
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ command_id: 'cmd_help', command: 'help', description: { default_value: '看帮助' } }] } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.syncSlashCommands([{ command: 'help', description: '看帮助' }])).resolves.toEqual({ created: [], updated: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops paging when the server keeps echoing the same page token', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }));
    // 每次新建 Response：同一个实例的 body 只能读一次。
    fetcher.mockImplementation(async () => response({ code: 0, data: { items: [], has_more: true, page_token: 'stuck' } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.syncSlashCommands([])).resolves.toEqual({ created: [], updated: [] });
    // token 不再变化就停：同步不会被一个坏响应卡死。
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('reports no slash command writes when the remote list already matches', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 0, data: { items: [{ command_id: 'cmd_help', command: 'help', description: { default_value: '看帮助' } }] } }));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test' }, fetcher as typeof fetch);
    await expect(service.syncSlashCommands([{ command: 'help', description: '看帮助' }])).resolves.toEqual({ created: [], updated: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('surfaces a slash command permission failure as a LarkServiceError instead of swallowing it', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 99991672, msg: 'no permission' }, 403));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test', LARK_API_RETRY_MAX_ATTEMPTS: '0' }, fetcher as typeof fetch);
    await expect(service.syncSlashCommands([{ command: 'help', description: '看帮助' }]))
      .rejects.toMatchObject({ code: 'LARK_OPENAPI_ERROR', details: { upstreamCode: 99991672 } });
  });

  it('safePin and safeUnpin catch failures and do not throw', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(response({ code: 230002, msg: 'pin forbidden' }, 403))
      .mockResolvedValueOnce(response({ code: 230003, msg: 'unpin not found' }, 404));
    const service = createLarkCardService({ LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret_test', LARK_API_RETRY_MAX_ATTEMPTS: '0' }, fetcher as typeof fetch);
    const warn = vi.fn();

    const pinRes = await service.safePin('om_fail_pin', { warn });
    expect(pinRes).toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockClear();
    const unpinRes = await service.safeUnpin('om_fail_unpin', { warn });
    expect(unpinRes).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
