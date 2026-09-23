// /repair：一键增量补权并重新发布飞书应用版本。
//
// 不可撤销外部动作的硬约束（docs/feishu-command-ux-optimization-2026-09-13.md P0-6）：
// 1. runOpenPlatformRepair 必须收到显式 confirmed:true 才执行；否则只返回 confirmation_required，
//    不建立开发者会话、不发任何写请求。
// 2. 审核态如实回显：versionStatus 1=审核中、2=已发布；审核中禁止声称已生效。
// 3. 本模块不 import open-platform-session（登录态/网络层），开发者 client 由 deps 注入；
//    测试一律注入 mock client，绝不真实发版。
// 4. 回调 value 形态为 { dutydeck_repair: 'run' }，宽进严出，风格对齐 parseLarkCardActionValue。
// 5. 原生斜杠命令同步走的是另一套凭据（机器人 tenant_access_token），只能在发布确认生效
//    之后跑一次，且失败不阻断——见 syncSlashCommandsAfterPublish。

import {
  configureLarkOpenPlatformApp,
  isValidLarkAppId,
  larkSlashCommandDefinitions,
  LARK_REQUIRED_EVENTS,
  type LarkOpenPlatformClient,
  type LarkOpenPlatformConfigureStep,
  type LarkOpenPlatformConfigureStepDetail,
} from './open-platform-configurator.js';
import { createLarkCardService, LarkServiceError, type LarkCardService } from './service.js';
import type { LarkCardElement } from './commands.js';

/** 原生斜杠命令写在机器人租户凭据下，与开放平台控制台会话无关。 */
export type LarkSlashCommandSyncClient = Pick<LarkCardService, 'syncSlashCommands'>;

/** 同步要用到的那项 feature 权限；目录里没有它时整步跳过，不去撞一个必然 403 的写请求。 */
const SLASH_COMMAND_SCOPE = 'application:app_slash_command:write';

export type RepairSlashCommandOutcome =
  | { status: 'configured' }
  | { status: 'completed'; created: string[]; updated: string[] }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: 'scope_missing' | 'credentials_missing' };

export interface RepairCardContent {
  title: string;
  markdown: string;
  elements: LarkCardElement[];
}

/** 建立开放平台开发者会话由接线方实现（复用 open-platform-session，可能要求重新扫码）。 */
export interface OpenPlatformRepairDeps {
  connectClient(appId: string): Promise<{ client: LarkOpenPlatformClient }>;
  /** 默认走真实 configurator；测试注入替身。 */
  configure?: typeof configureLarkOpenPlatformApp;
  /**
   * 该应用的机器人客户端（LarkCardService 即可直接传）。不注入时按 env 里同一应用的
   * 凭据构造；env 里是别的应用或没有密钥，就如实报「未拿到凭据、本次未同步」，
   * 绝不拿另一个应用的 token 去写斜杠命令。
   */
  slashCommandClient?: LarkSlashCommandSyncClient;
}

export type RepairStepStatus = LarkOpenPlatformConfigureStep | 'slash_command_sync';

export interface RepairStepReport {
  step: RepairStepStatus;
  detail?: LarkOpenPlatformConfigureStepDetail & { slashCommands?: RepairSlashCommandOutcome };
}

export type OpenPlatformRepairResult =
  | { status: 'confirmation_required'; appId: string }
  | { status: 'invalid_app_id'; appId: string }
  | {
      status: 'repaired';
      appId: string;
      versionId: string;
      steps: RepairStepReport[];
    }
  | {
      status: 'pending_review';
      appId: string;
      versionId?: string;
      steps: RepairStepReport[];
    }
  | {
      status: 'failed';
      appId: string;
      failedStep?: RepairStepStatus;
      code: string;
      reason: string;
      hint: string;
      steps: RepairStepReport[];
    };

export interface RunOpenPlatformRepairInput {
  appId: string;
  /** 只有用户在确认卡上二次点击（或接线方拿到等价显式确认）后才允许为 true。 */
  confirmed: boolean;
  creatorUserId?: string;
}

/**  configurator 错误码 → 可操作建议。错误本身的 message 已是中文原因，这里只补下一步动作。 */
function repairFailureHint(code: string): string {
  switch (code) {
    case 'session_expired':
      return '开放平台登录态已失效，请重新完成扫码登录后再执行 /repair。';
    case 'scope_catalog_read_failed':
    case 'scope_catalog_incomplete':
      return '开放平台登录态可能已过期或该应用不属于当前登录企业，请重新完成扫码登录后再执行 /repair。';
    case 'scope_update_failed':
    case 'scope_verification_failed':
    case 'scope_verification_read_failed':
      return '请到飞书开放平台「权限管理」核对权限草稿是否保存、是否有需要管理员开通的权限，处理后重新执行 /repair。';
    case 'robot_enable_failed':
      return '请到开放平台确认「机器人」能力是否可启用（应用类型/企业管控可能限制），处理后重新执行 /repair。';
    case 'event_mode_failed':
    case 'event_read_failed':
    case 'event_update_failed':
    case 'event_verification_failed':
      return '请到开放平台「事件与回调」核对长连接模式与事件订阅状态，处理后重新执行 /repair。';
    case 'callback_mode_failed':
    case 'callback_read_failed':
    case 'callback_update_failed':
    case 'callback_verification_failed':
      return '请到开放平台核对卡片回调（card.action.trigger）订阅与长连接回调模式，处理后重新执行 /repair。';
    case 'version_list_failed':
    case 'version_list_unreadable':
    case 'version_create_failed':
    case 'version_verification_failed':
    case 'visibility_read_failed':
    case 'visibility_unreadable':
      return '请到开放平台核对版本列表与应用可见范围（白名单/黑名单）配置是否完整，处理后重新执行 /repair。';
    case 'publish_failed':
      return '版本已创建但提交发布失败，请到开放平台版本管理页核对该版本状态后重试；切勿在状态不明时重复创建版本。';
    case 'publish_verification_read_failed':
    case 'publish_verification_failed':
      return '发布请求已提交但无法确认发布结果，请到开放平台版本管理页核对 versionStatus，确认前不要重复执行 /repair。';
    default:
      return '请稍后重试；若持续失败，请到飞书开放平台核对该应用的权限、事件订阅与版本状态。';
  }
}

const stepLabels: Record<RepairStepStatus, string> = {
  scope_update: '补齐应用权限',
  robot_enable: '启用机器人能力',
  event_mode: '切换长连接事件模式',
  event_subscribe: '增量订阅缺失事件',
  callback_mode: '切换长连接回调模式',
  callback_subscribe: '订阅卡片回调',
  version_create: '创建应用版本',
  publish_commit: '提交版本发布',
  publish_verify: '回读发布审核状态',
  slash_command_sync: '同步原生斜杠命令'
};

/** 已完成步骤的中文清单（审核态回显的一部分）。 */
function formatSteps(steps: RepairStepReport[]): string {
  if (steps.length === 0) return '本次没有成功完成任何步骤。';
  return steps.map((report, index) => {
    const suffix = report.detail?.slashCommands
      ? formatSlashCommandOutcome(report.detail.slashCommands)
      : report.detail?.addedEvents?.length
        ? `（新增 ${report.detail.addedEvents.join('、')}）`
        // 跳过的功能权限必须出现在回显里，否则用户会以为对应功能已经开通。
        : report.detail?.skippedScopes?.length
          ? `（本企业权限目录缺少 ${report.detail.skippedScopes.join('、')}，已跳过，对应功能不可用）`
          : report.step === 'version_create' || report.step === 'publish_commit'
            ? report.detail?.versionId ? `（版本 ${report.detail.versionId}）` : ''
            : '';
    return `${index + 1}. ${stepLabels[report.step]}${suffix}`;
  }).join('\n');
}

/** 口径与其它步骤一致：已满足报「已配置」，本次真改报「已完成」，失败如实报失败。 */
function formatSlashCommandOutcome(outcome: RepairSlashCommandOutcome): string {
  switch (outcome.status) {
    case 'configured':
      return '（已配置：飞书上的命令与当前版本一致，未改动）';
    case 'completed': {
      const parts = [
        ...(outcome.created.length ? [`新增 ${outcome.created.join('、')}`] : []),
        ...(outcome.updated.length ? [`更新 ${outcome.updated.join('、')}`] : []),
      ];
      return `（已完成：${parts.join('；')}）`;
    }
    case 'failed':
      return `（**失败**：${outcome.reason}。输入框里的 \`/\` 命令菜单未更新，命令本身仍可直接输入使用）`;
    case 'skipped':
      return outcome.reason === 'scope_missing'
        ? `（本企业权限目录缺少 ${SLASH_COMMAND_SCOPE}，已跳过，命令菜单不可用）`
        : '（**未同步**：本次没有拿到该应用的机器人凭据，命令菜单未更新）';
  }
}

/**
 * /repair 唯一执行入口。confirmed 不为 true 时直接拒绝，不做任何网络动作。
 */
export async function runOpenPlatformRepair(
  deps: OpenPlatformRepairDeps,
  input: RunOpenPlatformRepairInput,
): Promise<OpenPlatformRepairResult> {
  const appId = input.appId.trim();
  if (!input.confirmed) return { status: 'confirmation_required', appId };
  if (!isValidLarkAppId(appId)) return { status: 'invalid_app_id', appId };

  const steps: RepairStepReport[] = [];
  const recordStep = (step: LarkOpenPlatformConfigureStep, detail?: LarkOpenPlatformConfigureStepDetail) => {
    steps.push({ step, ...(detail ? { detail } : {}) });
  };

  let client: LarkOpenPlatformClient;
  try {
    ({ client } = await deps.connectClient(appId));
  } catch {
    // 连接层错误可能携带 cookie / 会话票据，绝不回显原文（对齐 safeOpenPlatformError 的脱敏原则）。
    return {
      status: 'failed', appId, code: 'connect_failed',
      reason: '建立开放平台开发者会话失败（登录态可能已过期）。',
      hint: '请重新完成开放平台扫码登录后再执行 /repair。',
      steps
    };
  }

  const configure = deps.configure ?? configureLarkOpenPlatformApp;
  try {
    const result = await configure(client, appId, {
      ...(input.creatorUserId ? { creatorUserId: input.creatorUserId } : {}),
      onStep: recordStep
    });
    // 只在这里同步：application:app_slash_command:write 是本次刚补进草稿的权限，
    // 要等版本确认发布（publish_verify 通过）之后才对 tenant_access_token 生效；
    // 发布之前写必然 403。审核中（pending_review）走下面的 catch，同样不会同步。
    steps.push({ step: 'slash_command_sync', detail: { slashCommands: await syncSlashCommandsAfterPublish(deps, appId, result.skippedScopes) } });
    return { status: 'repaired', appId, versionId: result.versionId, steps };
  } catch (error) {
    // configurator 的错误码与中文 message 都是静态白名单（post() 已剥掉传输层细节）；
    // 只有带 code 的 LarkOpenPlatformConfigurationError 才允许回显 message，
    // 其它异常一律换成通用文案，避免把内部诊断/凭据写进群聊卡片。
    const code = typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : 'repair_failed';
    const reason = code === 'repair_failed'
      ? '修复流程发生未预期错误，未完成发布。'
      : error instanceof Error ? error.message : '修复流程失败，未完成发布。';
    if (code === 'publish_pending_review') {
      const versionId = [...steps].reverse().find(step => step.detail?.versionId)?.detail?.versionId;
      return { status: 'pending_review', appId, ...(versionId ? { versionId } : {}), steps };
    }
    return {
      status: 'failed', appId,
      ...(steps.length ? { failedStep: steps[steps.length - 1]!.step } : {}),
      code, reason, hint: repairFailureHint(code), steps
    };
  }
}

/**
 * 发布确认生效后同步一次原生斜杠命令。任何失败都收敛成 outcome，绝不抛出——
 * 命令菜单只是输入便利，机器人本身照常收发消息，不能让它把 /repair 判成失败。
 */
async function syncSlashCommandsAfterPublish(
  deps: OpenPlatformRepairDeps,
  appId: string,
  skippedScopes: readonly string[],
): Promise<RepairSlashCommandOutcome> {
  if (skippedScopes.includes(SLASH_COMMAND_SCOPE)) return { status: 'skipped', reason: 'scope_missing' };
  let client: LarkSlashCommandSyncClient;
  try {
    client = deps.slashCommandClient ?? envSlashCommandClient(appId);
  } catch {
    return { status: 'skipped', reason: 'credentials_missing' };
  }
  try {
    const { created, updated } = await client.syncSlashCommands(larkSlashCommandDefinitions());
    return created.length || updated.length ? { status: 'completed', created, updated } : { status: 'configured' };
  } catch (error) {
    return { status: 'failed', reason: slashCommandFailureReason(error) };
  }
}

/** env 里必须正好是同一个应用的凭据；否则宁可不同步，也不拿别的应用的 token 去写。 */
function envSlashCommandClient(appId: string): LarkSlashCommandSyncClient {
  if (process.env.LARK_APP_ID?.trim() !== appId) throw new Error('credentials_missing');
  return createLarkCardService(process.env, undefined, { appId });
}

/**
 * 与本模块既有口径一致：外部错误原文可能带凭据，不进群聊卡片。
 * 飞书的业务码是可定位的，允许回显；其余一律换成通用文案。
 */
function slashCommandFailureReason(error: unknown): string {
  const upstreamCode = error instanceof LarkServiceError ? error.details?.upstreamCode : undefined;
  return typeof upstreamCode === 'number' ? `飞书返回错误码 ${upstreamCode}` : '请求未成功';
}

// ---------------------------------------------------------------------------
// 确认卡（纯函数）
// ---------------------------------------------------------------------------

const repairCallbackValue = (appId: string) => ({ dutydeck_repair: 'run', app_id: appId });

/**
 * 解析 /repair 确认卡回调 value。宽进严出：
 * - 接受 JSON 字符串或对象（listener 透传的 event.action.value 两种形态都出现过）；
 * - dutydeck_repair 必须恰好为字符串 'run'；
 * - app_id / appId 必须是合法 cli_* 应用 ID，防止回调串应用；
 * - 任何畸形输入返回 undefined，绝不抛异常。
 */
export function parseRepairCardActionValue(value: unknown): { action: 'run'; appId: string } | undefined {
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    const text = parsed.trim();
    if (!text) return undefined;
    try { parsed = JSON.parse(text); } catch { return undefined; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.dutydeck_repair !== 'run') return undefined;
  const rawAppId = typeof record.app_id === 'string' ? record.app_id
    : typeof record.appId === 'string' ? record.appId : '';
  // 回调 value 由确认卡生成，不做 trim 等宽容处理，任何夹带空白的输入直接拒绝。
  if (!isValidLarkAppId(rawAppId)) return undefined;
  return { action: 'run', appId: rawAppId };
}

const markdownElement = (elementId: string, content: string): LarkCardElement => ({
  tag: 'markdown', element_id: elementId, content
});

/** /repair 第一次回复的二次确认卡：如实说明将发生什么、发布不可撤销、审核未过不生效。 */
export function buildRepairConfirmCard(appId: string): RepairCardContent {
  const markdown = [
    '**将对飞书应用执行一键修复（增量补权并发布新版本）**',
    '',
    `- 目标应用：\`${appId}\``,
    `- 校验并补齐必需权限，增量订阅缺失事件（不重复添加已有项）：${LARK_REQUIRED_EVENTS.join('、')}`,
    '- 校验长连接模式与卡片回调（card.action.trigger）。',
    '- 创建新应用版本并**提交发布**。',
    '- 发布确认生效后，同步一次输入框里的 `/` 命令菜单（只新增或更新本机器人的命令，不删除任何已有命令）。',
    '',
    '注意：提交版本发布是不可撤销操作；企业自建应用需飞书管理员审核，**审核通过前新事件不会生效**。',
    '确认无误后点击下方按钮执行；取消则不要点击，本卡不会触发任何改动。'
  ].join('\n');
  return {
    title: '/repair 需要确认',
    markdown,
    elements: [
      markdownElement('repair_confirm_body', markdown),
      {
        tag: 'button',
        element_id: 'repair_confirm_run',
        text: { tag: 'plain_text', content: '确认执行修复并发布' },
        type: 'primary',
        behaviors: [{ type: 'callback', value: repairCallbackValue(appId) }],
        margin: '0px'
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// 结果回显（纯函数）：已发布 / 审核中 / 失败三态文案
// ---------------------------------------------------------------------------

export function renderRepairResultCard(result: OpenPlatformRepairResult): RepairCardContent {
  switch (result.status) {
    case 'confirmation_required':
      return {
        title: '/repair 需要确认',
        markdown: '修复操作必须显式确认后才会执行，请重新发送 /repair 并在确认卡上点击按钮。',
        elements: [markdownElement('repair_result_body', '修复操作必须显式确认后才会执行，请重新发送 /repair 并在确认卡上点击按钮。')]
      };
    case 'invalid_app_id':
      return {
        title: '/repair 未执行',
        markdown: `飞书应用 ID 格式无效（收到：\`${result.appId || '空'}\`），应为 \`cli_*\`。未做任何改动。`,
        elements: [markdownElement('repair_result_body', `飞书应用 ID 格式无效（收到：\`${result.appId || '空'}\`），应为 \`cli_*\`。未做任何改动。`)]
      };
    case 'repaired':
      return {
        title: '/repair 修复完成',
        markdown: [
          '**权限、事件订阅与卡片回调已全部补齐，新版本已发布并通过审核（versionStatus=2，已发布）。**',
          '',
          formatSteps(result.steps),
          '',
          `新版本：${result.versionId}。欢迎语（bot 入群事件）等能力已生效；若机器人此前已在群内，需被重新邀请或新消息触发私聊欢迎。`
        ].join('\n'),
        elements: []
      };
    case 'pending_review':
      return {
        title: '/repair 已提交，等待审核',
        markdown: [
          '**修复内容已提交发布，新版本正在等待飞书管理员审核（versionStatus=1，审核中）。**',
          '',
          formatSteps(result.steps),
          '',
          `${result.versionId ? `新版本：${result.versionId}。` : ''}审核通过前，新增事件与权限**不会生效**，请勿重复执行 /repair；审核通过后无需再次操作。`
        ].join('\n'),
        elements: []
      };
    case 'failed':
      return {
        title: '/repair 修复失败',
        markdown: [
          '**修复未完成，未产生已发布版本，配置未生效。**',
          '',
          ...(result.failedStep ? [`中断步骤：${stepLabels[result.failedStep]}`] : []),
          `原因：${result.reason}`,
          `建议：${result.hint}`,
          '',
          '已完成的步骤：',
          formatSteps(result.steps)
        ].join('\n'),
        elements: []
      };
  }
}
