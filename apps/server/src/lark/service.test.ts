import { describe, expect, it, vi } from 'vitest';
import { boundLarkCardElements, buildLarkCard, createLarkCardService, larkCardSafeLimits, larkCardSnapshotLimits, larkConfigurationStatus, larkIdentityPermissionHelp, LarkServiceError, loadLarkBotConfig } from './service.js';

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
    expect(JSON.stringify(bounded)).toContain('dockmux_snapshot_omission');
    expect(bounded.length).toBeLessThan(elements.length);
  });
  const components = (value: any): any[] => {
    if (Array.isArray(value)) return value.flatMap(components);
    if (!value || typeof value !== 'object') return [];
    return [...(typeof value.tag === 'string' ? [value] : []), ...Object.values(value).flatMap(components)];
  };
  const byId = (card: any, elementId: string) => components(card).find(element => element.element_id === elementId);
  it('renders a completed Card 2.0 with a clear task header, status, and compact footer', () => {
    const card = buildLarkCard({ agentName: 'Business Agent', permissionMode: 'full-trust', state: 'completed', taskName: 'Release', taskId: '42', elapsedSeconds: 65, markdown: '**done**' });
    expect(card.schema).toBe('2.0');
    expect(card.config.style.color).toMatchObject({
      trace_success: { light_mode: expect.stringContaining('92,184,119') },
      trace_failure: { light_mode: expect.stringContaining('208,180,92') },
      trace_running: { light_mode: expect.stringContaining('96,184,232') }
    });
    expect(card.header).toMatchObject({
      title: { tag: 'plain_text', content: 'Release' },
      subtitle: { tag: 'plain_text', content: 'Business Agent · Agent 任务' },
      template: 'green'
    });
    expect(card.body.elements[0].text.content).toContain('已完成');
    expect(card.body.elements[0].text.content).toContain('已用时 1m 5s');
    expect(card.body.elements[0].text.text_size).toBe('small');
    expect(card.body.elements[1].content).toBe('**done**');
    const footer: any = card.body.elements.at(-1);
    expect(footer.columns[0].elements[0].content).toContain('Business Agent · 任务 #42');
    expect(footer.columns[0].elements[0].content).toContain('完全信任');
    expect(footer.columns[0].elements[0].text_size).toBe('x-small');
    expect(footer.columns).toHaveLength(1);
  });

  it('keeps state-specific actions in the top prompt row', () => {
    const queued: any = buildLarkCard({ state: 'queued', taskId: 'queued' });
    const running: any = buildLarkCard({ state: 'running', taskId: 'running' });
    const failed: any = buildLarkCard({ state: 'failed', taskId: 'failed' });
    const interrupted: any = buildLarkCard({ state: 'interrupted', taskId: 'interrupted' });
    expect(byId(queued, 'cancel')).toMatchObject({ text: { content: '取消' }, behaviors: [{ value: { action: 'cancel', task_id: 'queued' } }] });
    expect(byId(queued, 'interrupt')).toBeUndefined();
    expect(byId(queued, 'task_status').text.content).toContain('排队中');
    expect(queued.config).toMatchObject({ streaming_mode: false, summary: { content: expect.stringContaining('排队中') } });
    expect(byId(running, 'interrupt')).toMatchObject({ text: { content: '中断' }, behaviors: [{ value: { action: 'interrupt', task_id: 'running' } }] });
    expect(byId(failed, 'retry')).toMatchObject({ text: { content: '重试' }, behaviors: [{ value: { action: 'retry', task_id: 'failed' } }] });
    expect(byId(failed, 'task_status').text.content).toContain("<text_tag color='red'>已失败</text_tag>");
    expect(byId(interrupted, 'task_status').text.content).toContain('已取消');
    expect(byId(interrupted, 'retry')).toMatchObject({ behaviors: [{ value: { action: 'retry', task_id: 'interrupted' } }] });
    expect(byId(running, 'task_action_row')).toBe(running.body.elements[0]);
    expect(running.body.elements.at(-1).columns).toHaveLength(1);
    expect(running.config).toMatchObject({ streaming_mode: true, summary: { content: expect.stringContaining('执行中') } });
    const loading0: any = buildLarkCard({ state: 'running', elapsedSeconds: 0 });
    const loading1: any = buildLarkCard({ state: 'running', elapsedSeconds: 1 });
    expect(loading0.header).toMatchObject({ template: 'blue', title: { content: 'Dockmux' } });
    expect(byId(loading0, 'task_status')).toMatchObject({ tag: 'div', icon: { tag: 'standard_icon', token: 'loading_outlined', color: 'grey' } });
    expect(byId(loading0, 'task_status').text.content).toContain('执行中');
    expect(byId(loading0, 'task_status').text.text_size).toBe('small');
    expect(buildLarkCard({ state: 'running', taskName: '任务摘要' }).header.title).toMatchObject({ tag: 'plain_text', content: '任务摘要' });
    expect(byId(loading1, 'task_status').icon.token).toBe('loading_outlined');
    const animated: any = buildLarkCard({ state: 'running', loadingImageKey: 'img_loading' });
    expect(byId(animated, 'task_status').icon).toMatchObject({ tag: 'custom_icon', img_key: 'img_loading', size: '20px 20px' });
    expect(failed.config.streaming_mode).toBe(false);
    expect(interrupted.config.streaming_mode).toBe(false);
  });

  it('pins interrupt above an expanded full-width trace overview', () => {
    const card: any = buildLarkCard({ state: 'running', taskId: 'trace-running', elements: [
      { tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false, header: { title: { tag: 'markdown', content: '步骤' } }, elements: [] }
    ] });
    expect(card.body.elements[0]).toMatchObject({ tag: 'column_set', element_id: 'task_action_row' });
    expect(components(card.body.elements[0]).some(element => element.element_id === 'trace_overview')).toBe(false);
    expect(card.body.elements[1]).toMatchObject({ tag: 'collapsible_panel', element_id: 'trace_overview', expanded: true });
    expect(byId(card, 'trace_overview')).toMatchObject({ expanded: true, header: { title: { icon: { tag: 'standard_icon', token: 'loading_outlined', color: 'grey' } } } });
    expect(byId(card, 'task_status').text.content).toContain('执行中');
    expect(byId(card, 'trace_overview').header.title.content).toContain('执行轨迹');
    expect(byId(card, 'trace_overview').header.title.content).toContain('1 个阶段');
    expect(byId(card, 'interrupt')).toMatchObject({ behaviors: [{ value: { action: 'interrupt', task_id: 'trace-running' } }] });
    expect(card.body.elements.at(-1).columns).toHaveLength(1);
    const animated: any = buildLarkCard({ state: 'running', taskId: 'trace-animated', loadingImageKey: 'img_bouncing', elements: [
      { tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false, header: { title: { tag: 'markdown', content: '步骤' } }, elements: [] }
    ] });
    expect(byId(animated, 'trace_overview').header.title.icon).toMatchObject({ tag: 'custom_icon', img_key: 'img_bouncing' });
  });

  it('omits all action buttons from read-only cards', () => {
    for (const state of ['queued', 'running', 'failed', 'interrupted'] as const) {
      const card: any = buildLarkCard({ state, taskId: state, readOnly: true });
      expect(card.config.update_multi).toBe(true);
      expect(card.body.elements[2].columns).toHaveLength(1);
    }
  });

  it('passes CLI Markdown through unchanged for every state', () => {
    const markdown = `### 自定义阶段\n\n${'very-long-command '.repeat(8)}\n\n🟢 业务自行决定展示数量`;
    const card: any = buildLarkCard({ state: 'running', markdown });
    expect(card.header).toMatchObject({ template: 'blue', title: { content: 'Dockmux' } });
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
      webBaseUrl: `https://dockmux.example/${huge}`,
      loadingImageKey: huge,
      markdown: huge
    });
    const serialized = JSON.stringify(card);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    expect(componentCount(card)).toBeLessThanOrEqual(larkCardSafeLimits.components);
    expect(Array.from(card.header.title.content).length).toBeLessThanOrEqual(160);
    expect(Array.from(card.header.subtitle.content.replace(' · Agent 任务', '')).length).toBeLessThanOrEqual(64);
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
    expect(statusIndex).toBe(0);
    expect(card.body.elements[overviewIndex]).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(byId(card, 'task_status').text.content).toContain('已用时 1m 37s');
    expect(byId(card, 'task_status').text.content).toContain('已完成');
    expect(card.body.elements[overviewIndex].header.title.content).toContain('1 个阶段');
    expect(card.body.elements[overviewIndex].header.title.text_size).toBe('notation');
    expect(card.body.elements[overviewIndex].header.title.icon).toBeUndefined();
    expect(finalIndex).toBeGreaterThan(statusIndex);
    expect(finalIndex).toBeLessThan(overviewIndex);
  });

  it('shows only the actual task terminal state in the dedicated status row', () => {
    const trace = [{ tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false, header: { title: { tag: 'markdown', content: "步骤 <font color='orange'>● 部分失败</font>" } }, elements: [] }];
    expect(byId(buildLarkCard({ state: 'completed', elements: trace }), 'task_status').text.content).toContain('已完成');
    expect(byId(buildLarkCard({ state: 'completed', elements: trace }), 'trace_overview').header.title.content).not.toContain('部分失败');
    expect(byId(buildLarkCard({ state: 'failed', elements: trace }), 'task_status').text.content).toContain('已失败');
    expect(byId(buildLarkCard({ state: 'interrupted', elements: trace }), 'task_status').text.content).toContain('已取消');
  });

  it('reports missing bot configuration without exposing secrets', () => {
    expect(larkConfigurationStatus({ LARK_APP_ID: 'cli_test' })).toMatchObject({ configured: false, listening: false, missing: ['LARK_APP_SECRET'], defaultAgentName: 'Dockmux' });
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
    await expect(service.send({ state: 'running', taskId: '42', markdown: '业务传入的运行态正文', idempotencyKey: 'task-42' })).resolves.toEqual({ messageId: 'om_sent', chatId: 'oc_chat' });
    await expect(service.update({ messageId: 'om_sent', state: 'completed', taskId: '42', markdown: '完成' })).resolves.toEqual({ messageId: 'om_sent', chatId: undefined });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[1]?.[0]).toContain('/open-apis/im/v1/images');
    const send = fetcher.mock.calls[2];
    expect(send?.[0]).toContain('receive_id_type=email');
    const sendBody = JSON.parse(String(send?.[1]?.body));
    expect(sendBody.receive_id).toBe('user@example.com');
    expect(sendBody.uuid).toBe('task-42');
    const sentCard = JSON.parse(sendBody.content);
    expect(sentCard.header).toMatchObject({ template: 'blue', subtitle: { content: 'Business Agent · Agent 任务' } });
    expect(byId(sentCard, 'task_status').text.content).toContain('执行中');
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
    expect(byId(JSON.parse(body.content), 'task_status').text.content).toContain('已完成');
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
});
