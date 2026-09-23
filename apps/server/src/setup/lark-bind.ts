/**
 * setup 向导的飞书绑定步骤。
 *
 * 这个模块只做一件事：把一个「已经存在」的飞书应用（cli_*）配置成 Dutydeck 能用的
 * 机器人，并如实汇报每一步到底发生了什么。它自己从不创建应用。
 *
 * 三个必须记住的设计约束（都来自线上事故）：
 *
 * 1. **绝不亮假绿灯。** `configureLarkOpenPlatformApp` 是一次不透明的 await：
 *    它不发任何进度事件，返回值里的 eventCount/callbackCount 是硬编码常量（1/1），
 *    不是实测值。所以我们不能把它的返回值当成「测量结果」转述。真正诚实的做法见下面 (2)。
 *    唯一例外是 skippedScopes：租户权限目录里没有、因此本次根本没申请的 feature 权限，
 *    只有 configurator 知道，观察调用推不出来，必须由它带回来照实说。
 *
 * 2. **包一层 postJson 来观察真实发生的调用。** configurator 的很多步骤是条件式、
 *    幂等的：只有在权限缺失时 `/scope/update/` 才有意义，只有事件缺失时才会
 *    `/event/update/`，只有回调模式不对时才会 `/callback/switch/`。因此我们把
 *    session client 的 `postJson` 包起来，记录实际被 POST 的 path，再由「观察到的
 *    调用集合」反推每一步的等级：写过 = done，只读过没写 = ok。
 *    这样重跑时不会把「本来就满足」渲染成一堆 warn（长期假黄灯同样是 bug）。
 *
 * 3. **发布不可回滚，且 configurator 没有回读。** `/publish/commit/` 返回 code=0
 *    只代表「提交成功」，不代表「已发布」——版本可能还在管理台等审核。所以 publish
 *    步骤一律报「已提交发布」，并附一条让用户去管理台确认的 warning。
 */
import QRCode from 'qrcode';
import type { CliUi } from '../cli-ui.js';
import {
  LARK_COMMON_TENANT_SCOPES,
  LarkOpenPlatformConfigurationError,
  configureLarkOpenPlatformApp,
  isValidLarkAppId,
  type LarkOpenPlatformClient,
  type LarkOpenPlatformConfigurationResult,
} from '../lark/open-platform-configurator.js';
import {
  connectLarkOpenPlatformSession,
  safeOpenPlatformError,
  type ConnectOpenPlatformSessionOptions,
  type ConnectedOpenPlatformSession,
} from '../lark/open-platform-session.js';
import type { Prompter } from './prompts.js';

export type LarkBindOutcome = 'skipped' | 'ready' | 'ready_with_warnings' | 'manual' | 'failed';
export type LarkBindStepKey =
  | 'scopes'
  | 'bot'
  | 'long_connection'
  | 'events'
  | 'callback'
  | 'version'
  | 'publish';

export interface LarkBindStepResult {
  key: LarkBindStepKey;
  label: string;
  /** ok = 本来就满足；done = 本次做了变更。见 cli-ui 里对这两个等级的说明。 */
  level: 'ok' | 'done' | 'warn' | 'fail' | 'skip';
  detail?: string;
}

export interface LarkBindResult {
  outcome: LarkBindOutcome;
  appId: string;
  steps: LarkBindStepResult[];
  /** 只带展示名。userId / tenantId 属于身份 ID，绝不出流。 */
  account?: { userName: string; tenantName: string };
  sessionSource?: 'cache' | 'qr_login';
  versionId?: string;
  /** 终态说明，或一条可以直接粘贴执行的续跑命令。 */
  next: string;
  warnings: string[];
  error?: { code: string; message: string };
}

export interface LarkBindOptions {
  appId: string;
  ui: CliUi;
  prompter: Prompter;
  assumeYes?: boolean;
  json?: boolean;
  forceLogin?: boolean;
  connect?: (options: ConnectOpenPlatformSessionOptions) => Promise<ConnectedOpenPlatformSession>;
  configure?: (
    client: LarkOpenPlatformClient,
    appId: string,
  ) => Promise<LarkOpenPlatformConfigurationResult>;
  renderQr?: (payload: string) => Promise<string>;
  sessionFilePath?: string;
  maxWaitMs?: number;
}

/** 默认二维码渲染：终端字符画，写 stderr。~17 行的 utf8 块，够手机扫。 */
export async function renderQrToTerminal(payload: string): Promise<string> {
  return await QRCode.toString(payload, { type: 'terminal', small: true });
}

const CONFIRM_URL = 'https://open.feishu.cn/app';
const PUBLISH_CONFIRM_WARNING =
  '发布仅为「已提交」，请到开放平台管理台确认版本是否已通过审核并生效：' + CONFIRM_URL;

/** 会话相关的失败才需要重新扫码；其它失败加 --force-login 只会白扫一次。 */
const SESSION_FAILURE_PATTERNS = [
  '二维码已过期',
  '等待飞书扫码超时',
  '开放平台请求超时',
  '会话可能已经过期',
  '未返回当前登录账号',
  '无法建立飞书开放平台会话',
  '初始化扫码登录失败',
  '轮询扫码登录失败',
  '不受信任',
  '重定向次数过多',
  '登录已失效',
  '登录态已失效',
];

function isSessionFailure(message: string): boolean {
  return SESSION_FAILURE_PATTERNS.some(pattern => message.includes(pattern));
}

/** 算出续跑命令：复用同一个 app id，只在会话问题时才追加 --force-login。 */
function resumeCommand(appId: string, needsRelogin: boolean): string {
  return `dutydeck setup --lark-app-id ${appId}${needsRelogin ? ' --force-login' : ''}`;
}

const NOTHING_CREATED =
  '本步骤只配置已存在的飞书应用，未创建任何应用；该应用 ID 可以安全地重复使用。';

/**
 * json 模式下发现需要扫码时抛出。
 *
 * connect 没有 cancel / AbortSignal，唯一的「立刻返回」办法就是在 onQrUpdate 里
 * 用这个错误抢跑（Promise.race），让后台那个 connect 自己去超时。绝不能让 --json
 * 的调用方在管道里干等 120 秒。
 */
class JsonQrRequiredError extends Error {
  constructor() { super('json 模式需要先完成一次交互式扫码登录'); }
}

interface ObservedCall { path: string; payload: unknown }

interface ObservedClient {
  client: LarkOpenPlatformClient;
  /** 实际发生的调用，按顺序记录 path 与响应体。 */
  calls: ObservedCall[];
}

/**
 * 包装 session client 的 postJson，记录真实发生的调用与响应。
 *
 * 这是本模块拿到「诚实的分步结果」的唯一手段：configurator 不报进度，
 * 但它的每一步都对应一个可识别的 path，而条件式写操作只在确有必要时才发生。
 *
 * 为什么连响应体也要记：`/scope/update/` 是**无条件**调用的（见 configurator
 * 源码），单看 path 永远得出「改过权限」，重跑就会一直是 done。真正的判据在第一次
 * `/scope/all/` 的响应里——已生效（status===5）的权限本来就齐，那这一步就是 ok。
 */
function observeClient(client: { postJson(path: string, body?: unknown): Promise<unknown> }): ObservedClient {
  const calls: ObservedCall[] = [];
  return {
    calls,
    client: {
      async postJson(path: string, body?: Record<string, unknown>) {
        const payload = await client.postJson(path, body);
        calls.push({ path, payload });
        return payload;
      },
    },
  };
}

/** 观察到的调用里是否出现过某个 path 片段。 */
function called(calls: readonly ObservedCall[], fragment: string): boolean {
  return calls.some(call => call.path.includes(fragment));
}

/** 第一次权限目录读取的响应；用来判断权限本来是否就齐。 */
function firstCatalog(calls: readonly ObservedCall[]): unknown {
  return calls.find(call => call.path.includes('/scope/all/'))?.payload;
}

/**
 * 统计目录里**尚未生效**、且本次确实申请了的权限数量。
 *
 * 与 configurator 返回的 scopeCount 不同，这是实测值：scopeCount 只说「申请了几项」，
 * 我们要的是「这次到底补了几项」。目录里没有、本次跳过的 feature 权限不参与计数——
 * 它根本没被申请，算成「缺口」就等于报一个永远补不上的假账。
 */
function missingScopeCount(catalog: unknown, applied: readonly string[]): number | undefined {
  if (catalog === undefined) return undefined;
  const granted = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const name = ['scope_name', 'scopeName', 'name', 'key', 'scopeKey']
      .map(key => record[key])
      .find((item): item is string => typeof item === 'string' && item !== '');
    if (name !== undefined && record.status === 5) granted.add(name);
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') walk(child);
    }
  };
  walk(catalog);
  return applied.filter(scope => !granted.has(scope)).length;
}

/**
 * 由「观察到的 postJson 调用」反推分步结果。
 *
 * 映射关系（本次写过 → done，本来就满足 → ok）：
 *   scopes           首次 /scope/all/ 里缺项数 > 0 → done，缺 0 项 → ok
 *   bot              /robot/switch/             → 无条件写入，无回读，报「已启用」
 *   long_connection  /event/switch/             → 同上
 *   events           /event/update/ 出现         → done，只读 /event/ → ok
 *   callback         /callback/switch|update/   → done，只读 /callback/ → ok
 *   version          /app_version/create/ + versionId → done，否则 warn
 *   publish          /publish/commit/           → 只报「已提交」，永不报「已发布」
 */
function deriveSteps(
  calls: readonly ObservedCall[],
  versionId: string | undefined,
  skippedScopes: readonly string[] = [],
): LarkBindStepResult[] {
  const steps: LarkBindStepResult[] = [];

  const applied = LARK_COMMON_TENANT_SCOPES.filter(scope => !skippedScopes.includes(scope));
  const missing = missingScopeCount(firstCatalog(calls), applied);
  // 跳过项要出现在这一步的 detail 里：不说等于让用户以为功能已经开了。
  const skippedNote = skippedScopes.length
    ? `；本企业权限目录里没有 ${skippedScopes.length} 项功能权限（${skippedScopes.join('、')}），已跳过，对应功能不可用`
    : '';
  if (!called(calls, '/scope/all/')) {
    steps.push({ key: 'scopes', label: '未读取权限目录', level: 'skip', detail: '未执行' });
  } else if (missing === undefined || missing > 0) {
    steps.push({
      key: 'scopes',
      label: '已补齐机器人所需权限',
      level: 'done',
      detail: (missing === undefined
        ? '已写入必需权限并回读校验'
        : `本次补齐 ${missing} 项（共申请 ${applied.length} 项）`) + skippedNote,
    });
  } else {
    steps.push({
      key: 'scopes',
      label: '机器人所需权限已齐备',
      level: 'ok',
      detail: `${applied.length} 项权限本来就已生效，本次无需改动` + skippedNote,
    });
  }

  // /robot/switch/ 与 /event/switch/ 是幂等的无条件写入，configurator 不回读，
  // 所以只能说「已请求启用」——用 done 是准确的（我们确实发了写请求）。
  steps.push({
    key: 'bot',
    label: called(calls, '/robot/switch/') ? '已启用机器人能力' : '未执行机器人能力开关',
    level: called(calls, '/robot/switch/') ? 'done' : 'skip',
  });
  steps.push({
    key: 'long_connection',
    label: called(calls, '/event/switch/') ? '已启用长连接事件模式' : '未执行长连接事件开关',
    level: called(calls, '/event/switch/') ? 'done' : 'skip',
  });

  const eventWritten = called(calls, '/event/update/');
  if (!called(calls, '/event/')) {
    steps.push({ key: 'events', label: '未检查消息事件订阅', level: 'skip', detail: '未执行' });
  } else {
    steps.push({
      key: 'events',
      label: eventWritten ? '已订阅消息接收事件' : '消息接收事件已订阅',
      level: eventWritten ? 'done' : 'ok',
      detail: eventWritten ? '本次新增 im.message.receive_v1' : '本次无需改动',
    });
  }

  const callbackWritten = called(calls, '/callback/switch/') || called(calls, '/callback/update/');
  if (!called(calls, '/callback/')) {
    steps.push({ key: 'callback', label: '未检查卡片回调', level: 'skip', detail: '未执行' });
  } else {
    steps.push({
      key: 'callback',
      label: callbackWritten ? '已配置卡片回调' : '卡片回调已配置',
      level: callbackWritten ? 'done' : 'ok',
      detail: callbackWritten ? '本次调整了回调模式或订阅' : '本次无需改动',
    });
  }

  const versionCreated = called(calls, '/app_version/create/');
  steps.push(versionId
    ? { key: 'version', label: '已创建新版本', level: 'done', detail: `版本 ${versionId}` }
    : {
      key: 'version',
      label: versionCreated ? '版本创建未返回版本号' : '未创建新版本',
      level: 'warn',
      detail: '缺少版本号，无法确认发布对象',
    });

  // 关键：configurator 对 /publish/commit/ 没有任何回读，code=0 只说明「提交成功」。
  steps.push(called(calls, '/publish/commit/')
    ? {
      key: 'publish',
      label: '已提交发布',
      level: 'done',
      detail: '仅为提交成功；版本可能仍需在管理台审核后才真正生效',
    }
    : { key: 'publish', label: '未提交发布', level: 'warn', detail: '未观察到发布提交请求' });

  return steps;
}

/**
 * 诚实的 outcome 判定：
 *   有 warn 步骤，或缺 versionId → ready_with_warnings
 *   全部 ok/done 且创建了版本、提交了发布 → ready
 * 「什么都不需要做」的干净重跑必须是 ready，不是 ready_with_warnings。
 */
function classify(steps: readonly LarkBindStepResult[], versionId: string | undefined): LarkBindOutcome {
  if (steps.some(step => step.level === 'fail')) return 'failed';
  if (!versionId) return 'ready_with_warnings';
  if (steps.some(step => step.level === 'warn' || step.level === 'skip')) return 'ready_with_warnings';
  return 'ready';
}

function skipped(appId: string, next: string, warnings: string[] = []): LarkBindResult {
  return { outcome: 'skipped', appId, steps: [], next, warnings };
}

export async function bindLarkApp(options: LarkBindOptions): Promise<LarkBindResult> {
  const {
    ui,
    prompter,
    assumeYes = false,
    json = false,
    forceLogin = false,
    connect = connectLarkOpenPlatformSession,
    configure = configureLarkOpenPlatformApp,
    renderQr = renderQrToTerminal,
    sessionFilePath,
    maxWaitMs,
  } = options;
  const appId = options.appId.trim();
  const warnings: string[] = [];

  if (!appId || !isValidLarkAppId(appId)) {
    return skipped(
      appId,
      '未提供有效的飞书应用 ID（应为 cli_*），已跳过飞书绑定。'
      + `补齐后重跑：${resumeCommand(appId || 'cli_xxx', false)}`,
      ['飞书应用 ID 缺失或格式无效，未做任何配置。'],
    );
  }

  // --json 是行为契约：绝不提问、绝不渲染二维码。非交互又没有 --yes 时，
  // 危险确认必然 fail closed，所以在动手之前就先拒绝，别把用户吊在那儿。
  if (!assumeYes && (json || !prompter.interactive)) {
    return skipped(
      appId,
      `非交互环境需要显式授权才会写权限并发布版本：${resumeCommand(appId, false)} --yes`,
      [`未获得发布确认，未对 ${appId} 做任何配置。${NOTHING_CREATED}`],
    );
  }

  let session: ConnectedOpenPlatformSession;
  let usedForceLogin = forceLogin;
  try {
    session = await connectSession({
      connect, renderQr, ui, json, forceLogin, sessionFilePath, maxWaitMs,
    });
  } catch (error) {
    return connectFailure(appId, error, warnings);
  }

  // 身份确认必须在第一个写操作之前：配错企业不是能干净回滚的事。
  const confirmed = await confirmIdentity({
    session, appId, ui, prompter, assumeYes, json,
  });
  if (confirmed === 'declined') {
    return {
      ...skipped(
        appId,
        `已取消，未做任何配置。换账号后重跑：${resumeCommand(appId, true)}`,
        [`未确认登录账号所属企业，未对 ${appId} 做任何配置。${NOTHING_CREATED}`],
      ),
      account: displayAccount(session),
      sessionSource: session.source,
    };
  }
  if (confirmed === 'relogin') {
    // 交互下只给一次重新登录的机会：再失败就让用户自己决定。
    try {
      session = await connectSession({
        connect, renderQr, ui, json, forceLogin: true, sessionFilePath, maxWaitMs,
      });
      usedForceLogin = true;
    } catch (error) {
      return connectFailure(appId, error, warnings);
    }
    const again = await confirmIdentity({
      session, appId, ui, prompter, assumeYes, json, allowRelogin: false,
    });
    if (again !== 'accepted') {
      return {
        ...skipped(
          appId,
          `已取消，未做任何配置。换账号后重跑：${resumeCommand(appId, true)}`,
          [`未确认登录账号所属企业，未对 ${appId} 做任何配置。${NOTHING_CREATED}`],
        ),
        account: displayAccount(session),
        sessionSource: session.source,
      };
    }
  }

  // 不可逆动作的显式确认。--yes 是唯一的放行方式（prompter.confirm 内部保证）。
  const tenantName = session.owner.tenantName;
  const publishApproved = await prompter.confirm({
    question:
      `即将为企业「${tenantName}」的应用 ${appId} 写入权限范围并发布一个新版本（发布对外可见且不可撤销），继续？`,
    dangerous: true,
  });
  if (!publishApproved) {
    return {
      ...skipped(
        appId,
        `已取消，未做任何配置。确认无误后重跑：${resumeCommand(appId, false)} --yes`,
        [`未获得发布确认，未对 ${appId} 做任何配置。${NOTHING_CREATED}`],
      ),
      account: displayAccount(session),
      sessionSource: session.source,
    };
  }

  const observed = observeClient(session.client);
  ui.progress(`正在配置飞书应用 ${appId}…`);
  let configured: LarkOpenPlatformConfigurationResult;
  try {
    configured = await configure(observed.client, appId);
  } catch (error) {
    return configureFailure({
      appId, error, calls: observed.calls, session, warnings,
    });
  }

  const versionId = configured.versionId || undefined;
  const skippedScopes = configured.skippedScopes ?? [];
  const steps = deriveSteps(observed.calls, versionId, skippedScopes);
  if (skippedScopes.length) {
    warnings.push(`本企业权限目录里没有以下功能权限，已跳过未申请，对应功能不可用：${skippedScopes.join('、')}。`);
  }
  warnings.push(PUBLISH_CONFIRM_WARNING);
  if (!versionId) warnings.push('未获得新版本号，无法确认发布对象，请到管理台检查应用版本。');

  const outcome = classify(steps, versionId);
  return {
    outcome,
    appId,
    steps,
    account: displayAccount(session),
    sessionSource: session.source,
    ...(versionId ? { versionId } : {}),
    next: outcome === 'ready'
      ? `飞书应用 ${appId} 已配置完成，发布已提交；请到管理台确认版本状态：${CONFIRM_URL}`
      : `部分步骤未能确认，请到管理台核对后按需重跑：${resumeCommand(appId, false)}`,
    warnings,
  };
}

/** 建立会话；只在交互且非 json 时渲染二维码。 */
async function connectSession(input: {
  connect: (options: ConnectOpenPlatformSessionOptions) => Promise<ConnectedOpenPlatformSession>;
  renderQr: (payload: string) => Promise<string>;
  ui: CliUi;
  json: boolean;
  forceLogin: boolean;
  sessionFilePath?: string;
  maxWaitMs?: number;
}): Promise<ConnectedOpenPlatformSession> {
  const { connect, renderQr, ui, json, forceLogin, sessionFilePath, maxWaitMs } = input;
  let rendered = false;
  let qrRequired!: (error: JsonQrRequiredError) => void;
  const abortedByJson = new Promise<never>((_resolve, reject) => { qrRequired = reject; });
  const connectOptions: ConnectOpenPlatformSessionOptions = {
    forceLogin,
    ...(sessionFilePath === undefined ? {} : { sessionFilePath }),
    ...(maxWaitMs === undefined ? {} : { maxWaitMs }),
    async onQrUpdate(update) {
      // json 模式绝不渲染二维码，也绝不等待：立刻抢跑返回。
      if (json) {
        qrRequired(new JsonQrRequiredError());
        return;
      }
      if (update.status === 'scan_confirmed') {
        // 刻意用离散进度行而不是 spinner。
        ui.progress('已确认扫码，正在建立开放平台会话…');
        return;
      }
      if (rendered) return;
      rendered = true;
      ui.notice('请用飞书 App 扫描下方二维码登录开放平台（默认等待 120 秒）：');
      ui.progress(await renderQr(update.qrPayload));
    },
  };
  const connecting = connect(connectOptions);
  // 让后台 connect 的失败不变成 unhandled rejection——它会自己按 maxWaitMs 超时。
  connecting.catch(() => {});
  return await Promise.race([connecting, abortedByJson]);
}

function displayAccount(session: ConnectedOpenPlatformSession): { userName: string; tenantName: string } {
  // 只取展示名。userId / tenantId 是身份 ID，绝不进入结果对象。
  return { userName: session.owner.userName, tenantName: session.owner.tenantName };
}

type IdentityDecision = 'accepted' | 'declined' | 'relogin';

/**
 * 缓存登录的身份确认。configure 是第一个写操作，必须在它之前问清楚
 * 「这个会话属于谁、属于哪个企业」。--yes 跳过。
 */
async function confirmIdentity(input: {
  session: ConnectedOpenPlatformSession;
  appId: string;
  ui: CliUi;
  prompter: Prompter;
  assumeYes: boolean;
  json: boolean;
  allowRelogin?: boolean;
}): Promise<IdentityDecision> {
  const { session, appId, ui, prompter, assumeYes, json, allowRelogin = true } = input;
  const account = displayAccount(session);
  if (assumeYes) return 'accepted';
  if (!json) {
    ui.notice(
      `当前开放平台会话属于「${account.userName}」@「${account.tenantName}」`
      + `（${session.source === 'cache' ? '沿用本地缓存登录' : '本次扫码登录'}）。`,
    );
  }
  const accepted = await prompter.confirm({
    question: `确认用该账号配置应用 ${appId}？`,
    dangerous: true,
  });
  if (accepted) return 'accepted';
  if (!allowRelogin || json || !prompter.interactive) return 'declined';
  const retry = await prompter.confirm({
    question: '需要重新扫码切换账号吗？',
    defaultValue: true,
  });
  return retry ? 'relogin' : 'declined';
}

function connectFailure(appId: string, error: unknown, warnings: string[]): LarkBindResult {
  // json 模式撞上扫码：这不是错误，是「缺一次交互式登录」。给出确切的补救命令。
  if (error instanceof JsonQrRequiredError) {
    return skipped(
      appId,
      `本地没有可用的飞书登录缓存，--json 模式不会渲染二维码。请先交互执行：${resumeCommand(appId, false)}`,
      [
        '缓存登录不可用且 --json 禁止扫码，已立即返回，未做任何配置。',
        `${NOTHING_CREATED}`,
      ],
    );
  }
  // 一切错误都过一遍 safeOpenPlatformError：飞书会把 cookie / token 回显在报错里。
  const message = safeOpenPlatformError(error);
  const needsRelogin = isSessionFailure(message);
  return {
    outcome: 'failed',
    appId,
    steps: [],
    next: `登录飞书开放平台失败，请重跑：${resumeCommand(appId, needsRelogin)}`,
    warnings: [...warnings, `${NOTHING_CREATED}本次未写入任何配置。`],
    error: { code: 'session_connect_failed', message },
  };
}

function configureFailure(input: {
  appId: string;
  error: unknown;
  calls: readonly ObservedCall[];
  session: ConnectedOpenPlatformSession;
  warnings: string[];
}): LarkBindResult {
  const { appId, error, calls, session, warnings } = input;
  const code = error instanceof LarkOpenPlatformConfigurationError ? error.code : 'configure_failed';
  const message = safeOpenPlatformError(error);
  // 已经跑过的步骤照实保留，失败点标 fail：用户需要知道停在哪一步。
  const steps = deriveSteps(calls, undefined).map<LarkBindStepResult>(step =>
    step.level === 'warn' ? { ...step, level: 'skip', detail: '未执行' } : step);
  steps.push({ key: 'publish', label: '配置中断，未完成发布', level: 'fail', detail: code });
  const needsRelogin = isSessionFailure(message);
  return {
    outcome: 'failed',
    appId,
    steps,
    account: displayAccount(session),
    sessionSource: session.source,
    next: `配置在第 ${calls.length} 个请求后中断，修复后重跑：${resumeCommand(appId, needsRelogin)}`,
    warnings: [...warnings, `${NOTHING_CREATED}部分配置可能已写入，重跑是幂等的。`],
    error: { code, message },
  };
}

/** 把结果渲染到 stdout。json 模式由调用方决定，这里只管人类可读输出。 */
export function renderLarkBindResult(ui: CliUi, result: LarkBindResult): void {
  ui.section('飞书绑定');
  if (result.account) {
    ui.keyValues([
      ['账号', result.account.userName],
      ['企业', result.account.tenantName],
      ['应用', result.appId],
    ]);
  }
  for (const step of result.steps) ui.status(step.level, step.label, step.detail);
  for (const warning of result.warnings) ui.hint(warning);
  if (result.error) ui.status('fail', result.error.message, result.error.code);
  ui.summary('接下来', [{ text: result.next }]);
}
