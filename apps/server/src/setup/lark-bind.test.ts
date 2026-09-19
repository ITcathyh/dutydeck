import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliUi, type CliUiTarget } from '../cli-ui.js';
import {
  LARK_COMMON_TENANT_SCOPES,
  LarkOpenPlatformConfigurationError,
  type LarkOpenPlatformClient,
  type LarkOpenPlatformConfigurationResult,
} from '../lark/open-platform-configurator.js';
import type {
  ConnectOpenPlatformSessionOptions,
  ConnectedOpenPlatformSession,
} from '../lark/open-platform-session.js';
import type { Prompter } from './prompts.js';
import { bindLarkApp, type LarkBindResult, type LarkBindStepKey } from './lark-bind.js';

const APP_ID = 'cli_dutydeck_test';

/** 会话里出现过的敏感串。任何一个泄进结果对象都是事故。 */
const SECRETS = {
  userId: 'ou_private_user_id',
  tenantId: 'private_tenant_id',
  cookie: 'session=private-cookie-value',
  token: 'private-login-token',
  appSecret: 'private-app-secret',
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

interface Sink extends CliUiTarget { text: string }
const sink = (): Sink => {
  const target: Sink = { text: '', write(chunk: string) { target.text += chunk; } };
  return target;
};

/**
 * 权限目录 fixture。`granted` 决定哪些必需权限已经 status=5 生效——
 * 这正是 lark-bind 用来区分 ok（本来就齐）与 done（这次补齐）的实测依据。
 */
function catalog(granted: readonly string[] = LARK_COMMON_TENANT_SCOPES): unknown {
  return {
    code: 0,
    data: {
      appScopeList: LARK_COMMON_TENANT_SCOPES.map((name, index) => ({
        scopeId: `tenant-${index + 1}`,
        scopeName: name,
        status: granted.includes(name) ? 5 : 1,
      })),
    },
  };
}

interface ConfigureShape {
  /** 已生效的权限；缺项会让 scopes 变成 done。 */
  grantedScopes?: readonly string[];
  /** 租户权限目录里没有、configurator 本次跳过未申请的 feature 权限。 */
  skippedScopes?: readonly string[];
  /** 事件本来是否已订阅；false 时会走 /event/update/。 */
  eventSubscribed?: boolean;
  /** 回调本来是否已就绪；false 时会走 /callback/switch/ + /callback/update/。 */
  callbackReady?: boolean;
  versionId?: string;
  /** 在这个 path 片段处抛错，模拟中途失败。 */
  failAt?: string;
  failWith?: unknown;
}

/**
 * 一个「模拟 configurator」：它并不真的实现配置逻辑，而是按真实 configurator 的
 * 条件式调用顺序去 POST 同样的 path。lark-bind 的分步结果完全由这些观察到的
 * 调用推导，所以只要 path 序列忠于真实实现，测试就是有效的。
 */
function fakeConfigure(shape: ConfigureShape = {}) {
  const {
    grantedScopes = LARK_COMMON_TENANT_SCOPES,
    skippedScopes = [],
    eventSubscribed = true,
    callbackReady = true,
    versionId = 'version-2',
    failAt,
    failWith,
  } = shape;
  return vi.fn(async (
    client: LarkOpenPlatformClient,
    appId: string,
  ): Promise<LarkOpenPlatformConfigurationResult> => {
    const post = async (path: string, body?: Record<string, unknown>) => {
      if (failAt && path.includes(failAt)) {
        throw failWith ?? new LarkOpenPlatformConfigurationError('scope_update_failed', '配置飞书常用权限失败');
      }
      return await client.postJson(path, body);
    };
    await post(`/developers/v1/scope/all/${appId}`);
    // 真实 configurator 无条件调用 scope/update，所以这里也无条件调用：
    // 「是否真的改了权限」只能靠目录里的 status 判断，不能靠这个 path 是否出现。
    await post(`/developers/v1/scope/update/${appId}`, { clientId: appId });
    await post(`/developers/v1/scope/all/${appId}`);
    await post(`/developers/v1/robot/switch/${appId}`, { enable: true });
    await post(`/developers/v1/event/switch/${appId}`, { eventMode: 4 });
    await post(`/developers/v1/event/${appId}`, { needEventDetail: true });
    if (!eventSubscribed) {
      await post(`/developers/v1/event/update/${appId}`, { appEvents: ['im.message.receive_v1'] });
      await post(`/developers/v1/event/${appId}`, { needEventDetail: true });
    }
    await post(`/developers/v1/callback/${appId}`, {});
    if (!callbackReady) {
      await post(`/developers/v1/callback/switch/${appId}`, { callbackMode: 4 });
      await post(`/developers/v1/callback/${appId}`, {});
      await post(`/developers/v1/callback/update/${appId}`, { callbacks: ['card.action.trigger'] });
      await post(`/developers/v1/callback/${appId}`, {});
    }
    await post(`/developers/v1/visible/online/${appId}`, {});
    await post(`/developers/v1/app_version/list/${appId}`, {});
    await post(`/developers/v1/app_version/create/${appId}`, {});
    await post(`/developers/v1/publish/commit/${appId}/${versionId || 'unknown'}`, { clientId: appId });
    return {
      status: 'ready',
      // 刻意保留真实实现的硬编码值：lark-bind 不许把它们当成实测数据转述。
      scopeCount: LARK_COMMON_TENANT_SCOPES.length - skippedScopes.length,
      skippedScopes: [...skippedScopes],
      eventCount: 1,
      callbackCount: 1,
      versionId,
    };
    void grantedScopes;
  });
}

/** 会话 client：按 path 返回目录/状态 fixture，报错里刻意夹带敏感串。 */
function sessionClient(shape: ConfigureShape = {}) {
  const granted = shape.grantedScopes ?? LARK_COMMON_TENANT_SCOPES;
  const eventSubscribed = shape.eventSubscribed ?? true;
  const callbackReady = shape.callbackReady ?? true;
  let scopeRead = 0;
  let eventRead = 0;
  let callbackRead = 0;
  return {
    apiOrigin: 'https://open.feishu.cn',
    postJson: vi.fn(async (path: string) => {
      if (path.includes('/scope/all/')) {
        // 第一次读的是真实现状，回读时权限已生效。
        return scopeRead++ === 0 ? catalog(granted) : catalog();
      }
      if (/\/event\/cli_[^/]+$/.test(path)) {
        const subscribed = eventSubscribed || eventRead++ > 0;
        return { code: 0, data: { eventMode: 4, appEvents: subscribed ? ['im.message.receive_v1'] : [] } };
      }
      if (/\/callback\/cli_[^/]+$/.test(path)) {
        const ready = callbackReady || callbackRead++ > 0;
        return {
          code: 0,
          data: { callbackMode: ready ? 4 : 1, callbacks: ready ? ['card.action.trigger'] : [] },
        };
      }
      if (path.includes('/app_version/create/')) {
        return { code: 0, data: { versionId: shape.versionId ?? 'version-2' } };
      }
      return { code: 0 };
    }),
  };
}

function connected(options: {
  source?: 'cache' | 'qr_login';
  client?: { apiOrigin: string; postJson: (path: string, body?: unknown) => Promise<unknown> };
} = {}): ConnectedOpenPlatformSession {
  return {
    source: options.source ?? 'cache',
    client: { ...(options.client ?? sessionClient()), postForm: vi.fn(async () => ({ code: 0 })) },
    owner: {
      userId: SECRETS.userId,
      userName: '张三',
      tenantId: SECRETS.tenantId,
      tenantName: '示例科技',
    },
  };
}

interface FakePrompter extends Prompter {
  answers: boolean[];
  questions: string[];
}

/** 按顺序吐出预设答案的 prompter；未预设时默认同意。 */
function fakePrompter(answers: boolean[] = [], interactive = true): FakePrompter {
  const queue = [...answers];
  const prompter: FakePrompter = {
    interactive,
    answers: queue,
    questions: [],
    async ask<T>(): Promise<T> { throw new Error('不应在飞书绑定中使用 ask'); },
    async choose<T>(): Promise<T> { throw new Error('不应在飞书绑定中使用 choose'); },
    async confirm({ question, dangerous = false, defaultValue = false }) {
      prompter.questions.push(question);
      const next = queue.shift();
      if (next !== undefined) return next;
      // 模拟真实 prompter 的 fail-closed 语义。
      if (!interactive) return dangerous ? false : defaultValue;
      return true;
    },
    close() {},
  };
  return prompter;
}

let sessionDir: string;
let sessionFilePath: string;
let stdout: Sink;
let stderr: Sink;

beforeEach(async () => {
  // 绝不碰真实 ~/.dutydeck：每个用例一个临时会话文件路径。
  sessionDir = await mkdtemp(join(tmpdir(), 'dutydeck-lark-bind-'));
  sessionFilePath = join(sessionDir, 'session.json');
  stdout = sink();
  stderr = sink();
});

afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
});

function run(overrides: Parameters<typeof bindLarkApp>[0] extends infer T
  ? Partial<Omit<T & object, 'ui' | 'prompter'>> & { prompter?: FakePrompter }
  : never = {}) {
  const ui = createCliUi({ stdout, stderr, color: false, tty: true, env: {} });
  const prompter = overrides.prompter ?? fakePrompter();
  const connect = overrides.connect ?? vi.fn(async () => connected());
  const configure = overrides.configure ?? fakeConfigure();
  const renderQr = overrides.renderQr ?? vi.fn(async () => 'QR-ART');
  const promise = bindLarkApp({
    appId: overrides.appId ?? APP_ID,
    ui,
    prompter,
    sessionFilePath,
    ...overrides,
    connect,
    configure,
    renderQr,
  });
  return { promise, connect, configure, renderQr, prompter };
}

const levelOf = (result: LarkBindResult, key: LarkBindStepKey) =>
  result.steps.find(step => step.key === key)?.level;

describe('bindLarkApp', () => {
  it('把「本来就满足」的重跑报成 ready，且只留发布确认这一条提醒', async () => {
    const { promise, configure } = run();
    const result = await promise;

    expect(result.outcome).toBe('ready');
    expect(configure).toHaveBeenCalledOnce();
    // 幂等重跑不该变成一堵黄墙：条件式步骤全部是 ok。
    expect(levelOf(result, 'scopes')).toBe('ok');
    expect(levelOf(result, 'events')).toBe('ok');
    expect(levelOf(result, 'callback')).toBe('ok');
    expect(result.steps.some(step => step.level === 'warn')).toBe(false);
    expect(result.steps.some(step => step.level === 'fail')).toBe(false);
    // 唯一允许的 warning 就是「发布只是提交，去管理台确认」。
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('已提交');
    expect(result.versionId).toBe('version-2');
    expect(result.sessionSource).toBe('cache');
  });

  it('真的改了权限/事件/回调时报 done，未改动的步骤仍是 ok', async () => {
    const shape: ConfigureShape = {
      grantedScopes: LARK_COMMON_TENANT_SCOPES.slice(0, 12),
      eventSubscribed: false,
      callbackReady: true,
    };
    const { promise } = run({
      connect: vi.fn(async () => connected({ client: sessionClient(shape) })),
      configure: fakeConfigure(shape),
    });
    const result = await promise;

    expect(levelOf(result, 'scopes')).toBe('done');
    // 20 项里已生效 12 项，实测缺口就是 8 项。
    expect(result.steps.find(step => step.key === 'scopes')?.detail).toContain('本次补齐 8 项');
    expect(levelOf(result, 'events')).toBe('done');
    // 回调本来就好，不能被顺带标成 done。
    expect(levelOf(result, 'callback')).toBe('ok');
    expect(result.outcome).toBe('ready');
  });

  it('回调需要切换模式时才把 callback 标成 done', async () => {
    const shape: ConfigureShape = { callbackReady: false };
    const { promise } = run({
      connect: vi.fn(async () => connected({ client: sessionClient(shape) })),
      configure: fakeConfigure(shape),
    });
    const result = await promise;

    expect(levelOf(result, 'callback')).toBe('done');
    expect(levelOf(result, 'scopes')).toBe('ok');
    expect(levelOf(result, 'events')).toBe('ok');
  });

  it('发布只报「已提交」，绝不声称已发布', async () => {
    const { promise } = run();
    const result = await promise;

    const publish = result.steps.find(step => step.key === 'publish');
    expect(publish?.label).toBe('已提交发布');
    expect(publish?.label).not.toContain('已发布应用');
    expect(publish?.detail).toContain('审核');
    // configurator 对 publish 没有回读，任何「已验证发布」的措辞都是假绿灯。
    expect(JSON.stringify(result)).not.toContain('已发布成功');
    expect(result.warnings.join('\n')).toContain('管理台');
  });

  it('缺 versionId 时降级为 ready_with_warnings，不许是 ready', async () => {
    const { promise } = run({ configure: fakeConfigure({ versionId: '' }) });
    const result = await promise;

    expect(result.outcome).toBe('ready_with_warnings');
    expect(result.versionId).toBeUndefined();
    expect(levelOf(result, 'version')).toBe('warn');
    expect(result.warnings.some(warning => warning.includes('版本号'))).toBe(true);
  });

  it('LarkOpenPlatformConfigurationError → failed，next 复用同一个 app id 且不加 --force-login', async () => {
    const { promise } = run({ configure: fakeConfigure({ failAt: '/app_version/create/' }) });
    const result = await promise;

    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('scope_update_failed');
    expect(result.next).toContain(`dutydeck setup --lark-app-id ${APP_ID}`);
    // 不是会话问题，就不该让用户白扫一次二维码。
    expect(result.next).not.toContain('--force-login');
    expect(result.steps.some(step => step.level === 'fail')).toBe(true);
    // 「本模块不创建应用」必须说清楚，否则用户会以为要删掉重建。
    expect(result.warnings.join('\n')).toContain('未创建任何应用');
  });

  it('会话类失败（二维码过期）→ next 带上 --force-login', async () => {
    const { promise, configure } = run({
      connect: vi.fn(async () => { throw new Error('飞书登录二维码已过期'); }),
    });
    const result = await promise;

    expect(result.outcome).toBe('failed');
    expect(result.next).toContain(`--lark-app-id ${APP_ID}`);
    expect(result.next).toContain('--force-login');
    expect(configure).not.toHaveBeenCalled();
  });

  it('扫码超时同样算会话类失败', async () => {
    const { promise } = run({
      connect: vi.fn(async () => { throw new Error('等待飞书扫码超时'); }),
    });
    const result = await promise;

    expect(result.next).toContain('--force-login');
    expect(result.error?.code).toBe('session_connect_failed');
  });

  it('非会话类的配置失败不加 --force-login', async () => {
    const { promise } = run({
      configure: fakeConfigure({
        failAt: '/visible/online/',
        failWith: new LarkOpenPlatformConfigurationError('visibility_unreadable', '飞书应用可见范围结构不完整，已停止发布以避免覆盖线上范围'),
      }),
    });
    const result = await promise;

    expect(result.outcome).toBe('failed');
    expect(result.error?.code).toBe('visibility_unreadable');
    expect(result.next).not.toContain('--force-login');
  });

  it('--json 需要扫码时立刻返回，不渲染二维码，next 指出补救命令', async () => {
    const never = deferred<ConnectedOpenPlatformSession>();
    const connect = vi.fn(async (options: ConnectOpenPlatformSessionOptions) => {
      // 真实 connect 没有 cancel：它会一直等到 maxWaitMs。
      await options.onQrUpdate?.({ qrPayload: `{"qrlogin":{"token":"${SECRETS.token}"}}`, status: 'waiting_for_scan' });
      return await never.promise;
    });
    const renderQr = vi.fn(async () => 'QR-ART');
    const started = Date.now();
    const { promise, configure } = run({ json: true, assumeYes: true, connect, renderQr, maxWaitMs: 120_000 });
    const result = await promise;

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(renderQr).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(result.outcome).toBe('skipped');
    expect(result.next).toContain(`dutydeck setup --lark-app-id ${APP_ID}`);
    expect(JSON.stringify(result)).not.toContain(SECRETS.token);
    expect(stdout.text).toBe('');
    never.resolve(connected());
  });

  it('--json 命中缓存登录时正常完成，且不渲染二维码', async () => {
    const { promise, renderQr, configure } = run({ json: true, assumeYes: true });
    const result = await promise;

    expect(result.outcome).toBe('ready');
    expect(renderQr).not.toHaveBeenCalled();
    expect(configure).toHaveBeenCalledOnce();
  });

  it('非交互且没有 --yes 时拒绝执行，configure 一次都没被调用', async () => {
    const { promise, configure, connect } = run({ prompter: fakePrompter([], false) });
    const result = await promise;

    expect(result.outcome).toBe('skipped');
    // fail closed 必须发生在任何写操作之前。
    expect(configure).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(result.next).toContain('--yes');
  });

  it('用户拒绝身份确认时不调用 configure', async () => {
    // 第一问：确认账号 → 否；第二问：重新扫码 → 否。
    const prompter = fakePrompter([false, false]);
    const { promise, configure } = run({ prompter });
    const result = await promise;

    expect(configure).not.toHaveBeenCalled();
    expect(result.outcome).toBe('skipped');
    expect(result.account).toEqual({ userName: '张三', tenantName: '示例科技' });
    expect(prompter.questions[0]).toContain(APP_ID);
    expect(result.next).toContain('--force-login');
  });

  it('拒绝身份确认后可以重新扫码一次并继续', async () => {
    const prompter = fakePrompter([false, true, true, true]);
    const connect = vi.fn(async () => connected({ source: 'qr_login' }));
    const { promise, configure } = run({ prompter, connect });
    const result = await promise;

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1]?.[0]).toMatchObject({ forceLogin: true });
    expect(configure).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('ready');
  });

  it('拒绝不可逆的发布确认时停在 configure 之前', async () => {
    // 身份确认通过，发布确认拒绝。
    const { promise, configure } = run({ prompter: fakePrompter([true, false]) });
    const result = await promise;

    expect(configure).not.toHaveBeenCalled();
    expect(result.outcome).toBe('skipped');
    expect(result.next).toContain('--yes');
  });

  it('发布确认的问法必须点明写权限、发布版本和目标企业', async () => {
    const prompter = fakePrompter();
    const { promise } = run({ prompter });
    await promise;

    const publishQuestion = prompter.questions.find(question => question.includes('发布'));
    expect(publishQuestion).toBeDefined();
    expect(publishQuestion).toContain('示例科技');
    expect(publishQuestion).toContain(APP_ID);
    expect(publishQuestion).toContain('不可撤销');
  });

  it('--yes 跳过身份确认，发布确认仍交给 prompter（由 --yes 在那里放行）', async () => {
    const prompter = fakePrompter();
    const { promise, configure } = run({ assumeYes: true, prompter });
    const result = await promise;

    // 身份确认被直接跳过；不可逆的发布确认仍然走 prompter，
    // 这样 --yes 依旧是唯一的放行开关（真实 prompter 在 assumeYes 下返回 true）。
    expect(prompter.questions).toHaveLength(1);
    expect(prompter.questions[0]).toContain('发布');
    expect(configure).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('ready');
  });

  it('无效 app id 直接 skipped，不建立会话', async () => {
    const { promise, connect, configure } = run({ appId: 'not_a_lark_app', assumeYes: true });
    const result = await promise;

    expect(result.outcome).toBe('skipped');
    expect(connect).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(result.next).toContain('cli_');
  });

  it('交互模式下把二维码和扫码确认写到 stderr，stdout 保持干净', async () => {
    const connect = vi.fn(async (options: ConnectOpenPlatformSessionOptions) => {
      await options.onQrUpdate?.({ qrPayload: `{"qrlogin":{"token":"${SECRETS.token}"}}`, status: 'waiting_for_scan' });
      await options.onQrUpdate?.({ qrPayload: `{"qrlogin":{"token":"${SECRETS.token}"}}`, status: 'scan_confirmed' });
      return connected({ source: 'qr_login' });
    });
    const renderQr = vi.fn(async () => 'QR-ART-BLOCK');
    const { promise } = run({ connect, renderQr, assumeYes: true });
    const result = await promise;

    expect(renderQr).toHaveBeenCalledWith(`{"qrlogin":{"token":"${SECRETS.token}"}}`);
    expect(stderr.text).toContain('QR-ART-BLOCK');
    // scan_confirmed 是一条离散进度行，不是 spinner。
    expect(stderr.text).toContain('已确认扫码');
    expect(stdout.text).not.toContain('QR-ART-BLOCK');
    expect(result.sessionSource).toBe('qr_login');
  });

  it('缓存命中时完全不渲染二维码', async () => {
    const { promise, renderQr } = run({ connect: vi.fn(async () => connected({ source: 'cache' })) });
    await promise;

    expect(renderQr).not.toHaveBeenCalled();
    expect(stderr.text).not.toContain('扫描');
  });

  it('结果里只有展示名，不含 cookie/token/secret 和任何身份 ID', async () => {
    const leaky = {
      apiOrigin: 'https://open.feishu.cn',
      postJson: vi.fn(async () => {
        throw new Error(`开放平台请求失败：cookie=${SECRETS.cookie}; app_secret=${SECRETS.appSecret}; user_id=${SECRETS.userId}`);
      }),
    };
    const { promise } = run({
      connect: vi.fn(async () => connected({ client: leaky })),
      configure: vi.fn(async (client: LarkOpenPlatformClient, appId: string) => {
        // 让真实的 transport 错误穿过 lark-bind 的脱敏边界。
        await client.postJson(`/developers/v1/scope/all/${appId}`);
        throw new Error('unreachable');
      }),
    });
    const result = await promise;
    const serialized = JSON.stringify(result);

    expect(result.outcome).toBe('failed');
    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('userId');
    expect(serialized).not.toContain('tenantId');
    expect(result.account).toEqual({ userName: '张三', tenantName: '示例科技' });
  });

  it('成功路径的结果里也不含身份 ID', async () => {
    const { promise } = run({ assumeYes: true });
    const serialized = JSON.stringify(await promise);

    expect(serialized).not.toContain(SECRETS.userId);
    expect(serialized).not.toContain(SECRETS.tenantId);
    expect(serialized).not.toContain('userId');
    expect(serialized).not.toContain('tenantId');
    expect(serialized).toContain('张三');
  });

  it('把 sessionFilePath / forceLogin / maxWaitMs 透传给 connect', async () => {
    const { promise, connect } = run({ assumeYes: true, forceLogin: true, maxWaitMs: 5_000 });
    await promise;

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      sessionFilePath,
      forceLogin: true,
      maxWaitMs: 5_000,
    }));
  });

  it('不把 configurator 硬编码的 eventCount/callbackCount 当成实测数据转述', async () => {
    const shape: ConfigureShape = { grantedScopes: LARK_COMMON_TENANT_SCOPES.slice(0, 10) };
    const { promise } = run({
      assumeYes: true,
      connect: vi.fn(async () => connected({ client: sessionClient(shape) })),
      configure: fakeConfigure(shape),
    });
    const result = await promise;

    // 实测缺 10 项。直接转述 configurator 的 scopeCount（20）就是假绿灯。
    const scopes = result.steps.find(step => step.key === 'scopes');
    expect(scopes?.level).toBe('done');
    expect(scopes?.detail).toContain('本次补齐 10 项');
    expect(JSON.stringify(result)).not.toContain('scopeCount');
    expect(JSON.stringify(result)).not.toContain('eventCount');
  });

  it('目录缺少功能权限时照常完成，跳过项进 detail 与 warnings，且不计入权限缺口', async () => {
    const skippedScopes = ['task:task:write'];
    const shape: ConfigureShape = {
      // 除了被跳过的那一项，其余权限本来就已生效：缺口应当是 0，而不是 1。
      grantedScopes: LARK_COMMON_TENANT_SCOPES.filter(name => !skippedScopes.includes(name)),
      skippedScopes,
    };
    const { promise } = run({
      assumeYes: true,
      connect: vi.fn(async () => connected({ client: sessionClient(shape) })),
      configure: fakeConfigure(shape),
    });
    const result = await promise;

    expect(result.outcome).toBe('ready');
    expect(result.versionId).toBe('version-2');
    const scopes = result.steps.find(step => step.key === 'scopes');
    expect(scopes?.level).toBe('ok');
    expect(scopes?.detail).toContain('19 项权限本来就已生效');
    expect(scopes?.detail).toContain('task:task:write');
    expect(result.warnings.some(warning => warning.includes('task:task:write'))).toBe(true);
  });
});
