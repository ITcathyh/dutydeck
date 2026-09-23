import { describe, expect, it, vi } from 'vitest';
import {
  LarkOpenPlatformConfigurationError,
  larkSlashCommandDefinitions,
  type LarkOpenPlatformClient,
  type LarkOpenPlatformConfigureOptions,
} from './open-platform-configurator.js';
import { LarkServiceError } from './service.js';
import {
  buildRepairConfirmCard,
  parseRepairCardActionValue,
  renderRepairResultCard,
  runOpenPlatformRepair,
} from './repair.js';

const appId = 'cli_repair_test';

/** 构造 configurator 替身：按预设推进 onStep，最后返回成功或抛出指定错误。 */
function configureStub(mode: 'published' | 'review' | 'event_failure' | 'secret_failure' | 'slash_scope_missing') {
  return vi.fn(async (_client: LarkOpenPlatformClient, targetAppId: string, options?: LarkOpenPlatformConfigureOptions) => {
    const onStep = options?.onStep ?? (() => undefined);
    expect(targetAppId).toBe(appId);
    onStep('scope_update');
    onStep('robot_enable');
    onStep('event_mode');
    if (mode === 'event_failure') {
      throw new LarkOpenPlatformConfigurationError('event_update_failed', '订阅飞书消息事件失败');
    }
    onStep('event_subscribe', { addedEvents: ['im.chat.member.bot.added_v1'] });
    onStep('version_create', { versionId: 'v-9' });
    onStep('publish_commit', { versionId: 'v-9' });
    if (mode === 'review') {
      throw new LarkOpenPlatformConfigurationError('publish_pending_review', '应用版本已提交，正在等待飞书管理员审核');
    }
    if (mode === 'secret_failure') {
      // 非 configurator 白名单错误：原始 message 含敏感信息，结果卡不得回显。
      throw new Error('socket reset app-secret-LEAK-cookie=session-LEAK');
    }
    const skippedScopes = mode === 'slash_scope_missing' ? ['application:app_slash_command:write'] : [];
    onStep('publish_verify', { versionId: 'v-9' });
    return { status: 'ready' as const, scopeCount: 16, skippedScopes, eventCount: 2, callbackCount: 1, versionId: 'v-9' };
  });
}

const mockClient: LarkOpenPlatformClient = { postJson: vi.fn(async () => ({ code: 0 })) };

describe('parseRepairCardActionValue', () => {
  it.each([
    ['对象', { dutydeck_repair: 'run', app_id: appId }],
    ['JSON 字符串', JSON.stringify({ dutydeck_repair: 'run', app_id: appId })],
    ['camelCase appId', { dutydeck_repair: 'run', appId }],
  ])('接受%s形态', (_label, value) => {
    expect(parseRepairCardActionValue(value)).toEqual({ action: 'run', appId });
  });

  it.each([
    ['空字符串', ''],
    ['非法 JSON', '{not json'],
    ['null', null],
    ['数组', []],
    ['动作不匹配', { dutydeck_repair: 'cancel', app_id: appId }],
    ['缺少动作', { app_id: appId }],
    ['应用 ID 非法', { dutydeck_repair: 'run', app_id: 'bad-id' }],
    ['缺少应用 ID', { dutydeck_repair: 'run' }],
    ['多余空白应用 ID', { dutydeck_repair: 'run', app_id: ` ${appId} ` }]
  ])('严出：拒绝 %s', (_label, value) => {
    expect(parseRepairCardActionValue(value)).toBeUndefined();
  });

  it('确认卡按钮的 value 能被解析回 run 意图且不串应用', () => {
    const card = buildRepairConfirmCard(appId);
    const button = card.elements.find(element => element.element_id === 'repair_confirm_run');
    expect(parseRepairCardActionValue(button!.behaviors[0]!.value)).toEqual({ action: 'run', appId });
    expect(parseRepairCardActionValue({ ...button!.behaviors[0]!.value, app_id: 'cli_other' })).toEqual({ action: 'run', appId: 'cli_other' });
  });
});

describe('buildRepairConfirmCard', () => {
  it('如实列出将补齐的事件，并声明发布不可撤销、审核未过不生效', () => {
    const card = buildRepairConfirmCard(appId);
    const text = JSON.stringify(card);
    expect(text).toContain('im.message.receive_v1');
    expect(text).toContain('im.chat.member.bot.added_v1');
    expect(text).toContain('不可撤销');
    expect(text).toContain('审核');
    expect(text).toContain(appId);
    // 不回显任何 secret 字段位。
    expect(text).not.toContain('appSecret');
  });
});

describe('runOpenPlatformRepair', () => {
  it('未显式确认时直接拒绝：不建立会话、不调用 configurator', async () => {
    const connectClient = vi.fn(async () => ({ client: mockClient }));
    const configure = vi.fn();
    const result = await runOpenPlatformRepair(
      { connectClient, configure },
      { appId, confirmed: false }
    );
    expect(result.status).toBe('confirmation_required');
    expect(connectClient).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
  });

  it('应用 ID 非法时不建立会话直接返回', async () => {
    const connectClient = vi.fn(async () => ({ client: mockClient }));
    const result = await runOpenPlatformRepair(
      { connectClient },
      { appId: 'not-cli', confirmed: true }
    );
    expect(result.status).toBe('invalid_app_id');
    expect(connectClient).not.toHaveBeenCalled();
  });

  it('全流程：增量补权 + 建版 + 发布回读通过，返回已发布结果与步骤', async () => {
    const configure = configureStub('published');
    const result = await runOpenPlatformRepair(
      { connectClient: async () => ({ client: mockClient }), configure },
      { appId, confirmed: true }
    );
    expect(result).toMatchObject({ status: 'repaired', versionId: 'v-9' });
    if (result.status !== 'repaired') throw new Error('expected repaired');
    expect(configure).toHaveBeenCalledWith(mockClient, appId, expect.objectContaining({ onStep: expect.any(Function) }));
    expect(result.steps.map(step => step.step)).toEqual([
      'scope_update', 'robot_enable', 'event_mode', 'event_subscribe',
      'version_create', 'publish_commit', 'publish_verify', 'slash_command_sync'
    ]);
    expect(result.steps.find(step => step.step === 'event_subscribe')?.detail?.addedEvents)
      .toEqual(['im.chat.member.bot.added_v1']);

    const card = renderRepairResultCard(result);
    expect(card.markdown).toContain('已发布');
    expect(card.markdown).toContain('versionStatus=2');
    expect(card.markdown).toContain('v-9');
    expect(card.markdown).toContain('im.chat.member.bot.added_v1');
    // 已发布才允许声称生效。
    expect(card.markdown).toContain('已生效');
  });

  it('审核中：如实回显 pending_review 与版本号，禁止声称已生效', async () => {
    const result = await runOpenPlatformRepair(
      { connectClient: async () => ({ client: mockClient }), configure: configureStub('review') },
      { appId, confirmed: true }
    );
    expect(result).toMatchObject({ status: 'pending_review', versionId: 'v-9' });
    const card = renderRepairResultCard(result);
    expect(card.markdown).toContain('审核中');
    expect(card.markdown).toContain('versionStatus=1');
    expect(card.markdown).toContain('不会生效');
    expect(card.markdown).not.toContain('已生效');
  });

  it('失败：返回中断步骤、可操作原因与建议，且不声称发布', async () => {
    const result = await runOpenPlatformRepair(
      { connectClient: async () => ({ client: mockClient }), configure: configureStub('event_failure') },
      { appId, confirmed: true }
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.failedStep).toBe('event_mode');
    expect(result.code).toBe('event_update_failed');
    expect(result.reason).toContain('事件');
    expect(result.hint).toContain('事件与回调');
    const card = renderRepairResultCard(result);
    expect(card.markdown).toContain('未生效');
    expect(card.markdown).not.toContain('已发布并通过审核');
  });

  it('登录态半失效：透传 session_expired 与重新扫码文案，不换成固定的读取失败', async () => {
    const configure = vi.fn(async () => {
      throw new LarkOpenPlatformConfigurationError('session_expired', '飞书开放平台登录已失效，请重新扫码。');
    });
    const result = await runOpenPlatformRepair(
      { connectClient: async () => ({ client: mockClient }), configure },
      { appId, confirmed: true }
    );
    expect(result).toMatchObject({
      status: 'failed',
      code: 'session_expired',
      reason: '飞书开放平台登录已失效，请重新扫码。',
    });
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.hint).toContain('重新完成扫码登录');
    expect(result.reason).not.toContain('权限目录');
  });

  it('非白名单异常不回显内部诊断（凭据/票据不进结果文案）', async () => {
    const result = await runOpenPlatformRepair(
      { connectClient: async () => ({ client: mockClient }), configure: configureStub('secret_failure') },
      { appId, confirmed: true }
    );
    expect(result.status).toBe('failed');
    const text = JSON.stringify(result) + JSON.stringify(renderRepairResultCard(result));
    expect(text).not.toContain('LEAK');
    expect(text).not.toContain('cookie');
  });

  it('建立开发者会话失败时给出重新扫码建议，不触碰 configurator', async () => {
    const configure = vi.fn();
    const result = await runOpenPlatformRepair(
      // 连接错误即便带敏感串也不得回显。
      { connectClient: async () => { throw new Error('cookie=session-LEAK'); }, configure },
      { appId, confirmed: true }
    );
    expect(result).toMatchObject({ status: 'failed', code: 'connect_failed' });
    expect(JSON.stringify(result)).not.toContain('LEAK');
    expect(configure).not.toHaveBeenCalled();
  });

  it('发布确认生效后才同步斜杠命令，本次真改按「已完成」如实回显', async () => {
    const syncSlashCommands = vi.fn(async () => ({ created: ['work'], updated: ['help'] }));
    const result = await runOpenPlatformRepair(
      { connectClient: async () => ({ client: mockClient }), configure: configureStub('published'), slashCommandClient: { syncSlashCommands } },
      { appId, confirmed: true }
    );
    expect(result.status).toBe('repaired');
    if (result.status !== 'repaired') throw new Error('expected repaired');
    // 权限是本次刚补进草稿的，发布确认之前写必然 403：同步只能排在 publish_verify 之后。
    expect(result.steps.at(-1)?.step).toBe('slash_command_sync');
    expect(result.steps.findIndex(step => step.step === 'publish_verify'))
      .toBeLessThan(result.steps.findIndex(step => step.step === 'slash_command_sync'));
    expect(syncSlashCommands).toHaveBeenCalledWith(larkSlashCommandDefinitions());
    const card = renderRepairResultCard(result);
    expect(card.markdown).toContain('同步原生斜杠命令');
    expect(card.markdown).toContain('已完成：新增 work；更新 help');
  });

  it('远端已与当前命令一致时报「已配置」，不谎称本次改过', async () => {
    const result = await runOpenPlatformRepair(
      { connectClient: async () => ({ client: mockClient }), configure: configureStub('published'),
        slashCommandClient: { syncSlashCommands: async () => ({ created: [], updated: [] }) } },
      { appId, confirmed: true }
    );
    expect(renderRepairResultCard(result).markdown).toContain('已配置：飞书上的命令与当前版本一致');
  });

  it('同步失败：卡上如实报失败，但不阻断修复结论，也不回显内部诊断', async () => {
    const result = await runOpenPlatformRepair(
      { connectClient: async () => ({ client: mockClient }), configure: configureStub('published'),
        slashCommandClient: { syncSlashCommands: async () => { throw new LarkServiceError('LARK_OPENAPI_ERROR', 'no permission cookie=session-LEAK', 502, { upstreamCode: 99991672 }); } } },
      { appId, confirmed: true }
    );
    // 命令菜单只是输入便利：同步失败不能把已发布的修复判成失败。
    expect(result.status).toBe('repaired');
    const card = renderRepairResultCard(result);
    expect(card.markdown).toContain('同步原生斜杠命令（**失败**：飞书返回错误码 99991672');
    expect(card.markdown).not.toContain('已配置：飞书上的命令');
    expect(JSON.stringify(result) + card.markdown).not.toContain('LEAK');
  });

  it('权限目录缺少 application:app_slash_command:write 时整步跳过，不发写请求', async () => {
    const syncSlashCommands = vi.fn();
    const result = await runOpenPlatformRepair(
      { connectClient: async () => ({ client: mockClient }), configure: configureStub('slash_scope_missing'), slashCommandClient: { syncSlashCommands } },
      { appId, confirmed: true }
    );
    expect(syncSlashCommands).not.toHaveBeenCalled();
    expect(renderRepairResultCard(result).markdown).toContain('本企业权限目录缺少 application:app_slash_command:write，已跳过');
  });

  it('审核中不同步：权限尚未生效，绝不去写命令菜单', async () => {
    const syncSlashCommands = vi.fn();
    const result = await runOpenPlatformRepair(
      { connectClient: async () => ({ client: mockClient }), configure: configureStub('review'), slashCommandClient: { syncSlashCommands } },
      { appId, confirmed: true }
    );
    expect(result.status).toBe('pending_review');
    expect(syncSlashCommands).not.toHaveBeenCalled();
    expect(renderRepairResultCard(result).markdown).not.toContain('同步原生斜杠命令');
  });

  it('没注入客户端时按 env 里同一应用的凭据走 tenant token 同步', async () => {
    vi.stubEnv('LARK_APP_ID', appId);
    vi.stubEnv('LARK_APP_SECRET', 'secret_test');
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ code: 0, tenant_access_token: 'token', expire: 7200 }))
      .mockResolvedValueOnce(json({ code: 0, data: { items: larkSlashCommandDefinitions().map((definition, index) => ({
        command_id: `cmd-${index}`, command: definition.command, description: { default_value: definition.description }
      })) } }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const result = await runOpenPlatformRepair(
        { connectClient: async () => ({ client: mockClient }), configure: configureStub('published') },
        { appId, confirmed: true }
      );
      expect(renderRepairResultCard(result).markdown).toContain('已配置：飞书上的命令与当前版本一致');
      expect(String(fetcher.mock.calls[1]?.[0])).toContain('/open-apis/application/v7/app_slash_commands');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('env 里是另一个应用的凭据时不同步，也绝不拿它去写别的应用', async () => {
    vi.stubEnv('LARK_APP_ID', 'cli_another_app');
    vi.stubEnv('LARK_APP_SECRET', 'secret_test');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    try {
      const result = await runOpenPlatformRepair(
        { connectClient: async () => ({ client: mockClient }), configure: configureStub('published') },
        { appId, confirmed: true }
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(renderRepairResultCard(result).markdown).toContain('**未同步**：本次没有拿到该应用的机器人凭据');
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('三态文案各自包含正确的状态结论', () => {
    const repaired = renderRepairResultCard({ status: 'repaired', appId, versionId: 'v-1', steps: [] });
    const review = renderRepairResultCard({ status: 'pending_review', appId, steps: [] });
    const failed = renderRepairResultCard({ status: 'failed', appId, code: 'x', reason: 'r', hint: 'h', steps: [] });
    expect(repaired.title).toContain('完成');
    expect(review.title).toContain('等待审核');
    expect(failed.title).toContain('失败');
    expect(failed.markdown).toContain('r');
    expect(failed.markdown).toContain('h');
  });
});
