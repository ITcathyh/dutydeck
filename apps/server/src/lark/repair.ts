// /repair：一键增量补权并重新发布飞书应用版本。
//
// 不可撤销外部动作的硬约束（docs/feishu-command-ux-optimization-2026-09-13.md P0-6）：
// 1. runOpenPlatformRepair 必须收到显式 confirmed:true 才执行；否则只返回 confirmation_required，
//    不建立开发者会话、不发任何写请求。
// 2. 审核态如实回显：versionStatus 1=审核中、2=已发布；审核中禁止声称已生效。
// 3. 本模块不 import open-platform-session（登录态/网络层），开发者 client 由 deps 注入；
//    测试一律注入 mock client，绝不真实发版。
// 4. 回调 value 形态为 { dutydeck_repair: 'run' }，宽进严出，风格对齐 parseLarkCardActionValue。

import {
  configureLarkOpenPlatformApp,
  isValidLarkAppId,
  LARK_REQUIRED_EVENTS,
  type LarkOpenPlatformClient,
  type LarkOpenPlatformConfigureStep,
  type LarkOpenPlatformConfigureStepDetail,
} from './open-platform-configurator.js';
import type { LarkCardElement } from './commands.js';

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
}

export type RepairStepStatus = Extract<LarkOpenPlatformConfigureStep, string>;

export interface RepairStepReport {
  step: RepairStepStatus;
  detail?: LarkOpenPlatformConfigureStepDetail;
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
  publish_verify: '回读发布审核状态'
};

/** 已完成步骤的中文清单（审核态回显的一部分）。 */
function formatSteps(steps: RepairStepReport[]): string {
  if (steps.length === 0) return '本次没有成功完成任何步骤。';
  return steps.map((report, index) => {
    const suffix = report.detail?.addedEvents?.length
      ? `（新增 ${report.detail.addedEvents.join('、')}）`
      : report.step === 'version_create' || report.step === 'publish_commit'
        ? report.detail?.versionId ? `（版本 ${report.detail.versionId}）` : ''
        : '';
    return `${index + 1}. ${stepLabels[report.step]}${suffix}`;
  }).join('\n');
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
