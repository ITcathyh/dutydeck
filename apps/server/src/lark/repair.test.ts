import { describe, expect, it, vi } from 'vitest';
import {
  LarkOpenPlatformConfigurationError,
  type LarkOpenPlatformClient,
  type LarkOpenPlatformConfigureOptions,
} from './open-platform-configurator.js';
import {
  buildRepairConfirmCard,
  parseRepairCardActionValue,
  renderRepairResultCard,
  runOpenPlatformRepair,
} from './repair.js';

const appId = 'cli_repair_test';

/** 构造 configurator 替身：按预设推进 onStep，最后返回成功或抛出指定错误。 */
function configureStub(mode: 'published' | 'review' | 'event_failure' | 'secret_failure') {
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
    onStep('publish_verify', { versionId: 'v-9' });
    return { status: 'ready' as const, scopeCount: 16, eventCount: 2, callbackCount: 1, versionId: 'v-9' };
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
      'version_create', 'publish_commit', 'publish_verify'
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
