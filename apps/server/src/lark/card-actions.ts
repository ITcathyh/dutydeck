// 飞书进度卡操作按钮的唯一事实源。
//
// 为什么要独立成一个模块：渲染端（buildLarkCard）和回调端（coordinator.handleAction）
// 必须共用同一张能力表。历史事故是两端各自硬编码——渲染端按某个 CLI 的能力发按钮，
// 回调端却在另一个 CLI 上无法执行，于是用户看到一整排点了没反应的「死按钮」。
// 本模块把「此刻哪个操作可用」收敛成 isLarkCardActionAvailable 一个判断，
// buildLarkCardActions 只是它的渲染投影，两端不可能给出不同答案。
//
// 本模块必须保持纯函数、无副作用、不发网络请求，也不 import service.ts / card-renderer.ts：
// service.ts 会 import 本模块，而 card-renderer.ts 又 import service.ts，
// 引用它们任何一个都会形成 import 环。
//
// 关于脱敏：本模块所有按钮文案都是静态常量，唯一的动态入参是 taskId（飞书 message_id）、
// webUrl（来自 StoredLarkConfig.webBaseUrl）和定时按钮的 HH:MM（由任务开始时间折算），
// 都不是 Agent / 工具输出，因此不需要 redactTraceText / redactTraceValue。反过来说这也是一条约束：
// 任何时候都不要把 Agent 输出、工具参数或错误原文塞进按钮 label 或 callback value。

/** 与 card-renderer.ts 的 LarkCardElement 结构一致，这里本地定义以避免 import 环。 */
export type LarkCardElement = Record<string, any>;

/**
 * 回调型操作。查看详情平时是直接打开 webUrl 的链接，不是回调；
 * 只有 Web 要求登录时才是回调 detail（服务端给管理员私信一次性登录链接）。
 */
export type LarkCardActionName = 'cancel' | 'interrupt' | 'retry' | 'refresh' | 'verify' | 'run_in_new_session' | 'rerun_in_new_session' | 'ask_plain' | 'ask_reply' | 'ask_detail' | 'schedule_daily' | 'detail';

/** 与 coordinator.ts 的 LarkTaskState 对齐；本地声明避免为了类型而引入模块依赖。 */
export type LarkCardActionState = 'queued' | 'running' | 'interrupting' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'reconcile_required' | 'legacy_unresolved';

/**
 * 能力必须由调用方显式传入，不能在本模块内猜。
 * 「猜」正是死按钮的根因：runtime 是否实现 cancelQueued、task 有没有 sessionId、
 * handleAction 有没有接 refresh 分支，只有调用方知道。任一能力为 false 时，
 * 本模块选择不渲染按钮，而不是渲染一个注定失败的按钮。
 */
export interface LarkCardCapabilities {
  /** runtime.cancelQueued 存在，且 task 同时具备 sessionId + runtimeTaskId。 */
  canCancelQueued: boolean;
  /** runtime.interrupt 存在，且 task 已有 sessionId。 */
  canInterrupt: boolean;
  canRetry: boolean;
  /** handleAction 已支持 refresh，且该任务仍持有 requestUpdate 心跳句柄。 */
  canRefresh: boolean;
  /**
   * 该工作区配置了验证命令、runtime 提供 runVerification、会话还在，且当前没有
   * 一份「能证明当前代码」的验证记录。缺省不声明即为 false：没配验证命令的工作区
   * 绝不能看到这个按钮，那会暗示一个不存在的能力。
   */
  canVerify?: boolean;
  /**
   * 卡住的任务可以转到新会话：排队受阻或需要核对，且 coordinator 能取消排队、持久化认领并重放原请求。
   * 缺省不声明即为 false，其余卡片绝不出现这两个按钮。
   */
  canRelaunch?: boolean;
  /**
   * 结果卡的一键续问（说人话 / 给我对外回复 / 再详细点）。coordinator 确认会话仍可续聊、
   * 去重键能落库时才置位；缺省即不给按钮。
   */
  canFollowUp?: boolean;
  /**
   * 「每天 HH:MM 自动执行」。只有 coordinator 判定为重复请求时才提供；
   * scheduled 为 true 表示计划已由这张卡建好，只渲染一个不可点的「已设为…」。缺省即不给按钮。
   */
  dailySchedule?: { time: string; scheduled: boolean };
  /** 已解析好的深链，仅在配置了 webBaseUrl 时提供。 */
  webUrl?: string;
  /**
   * Web 要求登录、且任务已有会话：「查看详情」改为回调，点击后由服务端给管理员私信一次性登录链接。
   * 缺省即为 false，页脚仍是直接打开 webUrl 的链接。
   */
  detailLogin?: boolean;
}

export interface LarkCardActionContext {
  state: LarkCardActionState;
  taskId: string;
  turn: number;
  /** 冻结收据：终态卡片转为只读，绝不提供任何操作。 */
  readOnly?: boolean;
  retryable?: boolean;
  capabilities: LarkCardCapabilities;
}

/** 回调 value 一律是字符串字段，解析结果才转回数字。 */
export interface LarkCardActionValue {
  action: LarkCardActionName;
  taskId: string;
  turn?: number;
}

/**
 * 元素预算：飞书整卡上限约 24KB / 180 个组件。
 * 一个按钮记 3 个组件（button 自身 + text.plain_text + icon），
 * 因此操作区最多 4 个按钮 = 12 个组件、数百字节，不可能压爆预算。
 */
export const larkCardActionBudget = { maxButtons: 4, componentsPerButton: 3 } as const;

/** taskId 上限：om_* 消息 ID 约 50 字符；超长说明上游有 bug，拒绝渲染回调按钮以保护 value 体积。 */
const maxTaskIdLength = 256;
const maxWebUrlLength = 512;
/** 定时按钮的时刻只接受 HH:MM，防止任何别的字符串进到按钮文案里。 */
const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** 转到新会话的两个按钮文案。task-recovery.ts 的恢复说明引用同一份常量，正文里提到的按钮名与卡上一致。 */
export const larkRelaunchLabels = { run_in_new_session: '在新会话中执行', rerun_in_new_session: '在新会话中重新执行' } as const;

type LarkCardActionDefinition = {
  action: LarkCardActionName;
  /** 复用既有 element_id，保证历史测试与快照的定位方式不变。 */
  elementId: string;
  /** 按钮文案。飞书按钮列很窄，长文案会折行，所以短标签 + hint 分工。 */
  label: string;
  /** 「动作 + 对象 + 预期结果」的完整说明，供卡片用 markdown 补充（schema 2.0 拒绝 note 标签，ErrCode 200861）。 */
  hint: string;
  /**
   * 操作按钮一律无边框：它们是正文之后的次要控件，带边框或红框会比正文还抢眼。
   * 语义由文案和图标承担；只有失败后的「重试」是这张卡要读者做的下一步，用蓝字点出。
   */
  buttonType: 'text' | 'primary_text';
  /** 飞书图标库 token（https://open.feishu.cn/document/feishu-cards/enumerations-for-icons）。 */
  icon: string;
  /** 允许该操作的状态集合。 */
  states: readonly LarkCardActionState[];
  capable: (capabilities: LarkCardCapabilities) => boolean;
  /** 状态与能力之外的附加约束（例如 retryable === false 的任务不给重试）。 */
  guard?: (context: LarkCardActionContext) => boolean;
  /**
   * 允许出现在只读收据上。只有「不改写已交付结论」的操作才能置位：
   * 验证只在工作目录里跑一条命令并新增一条独立证据，卡上的结论一个字都不动；
   * 续问在同一会话开下一轮、定时新建一个计划，这张卡上的结论同样不变。
   * 取消、中断、重试、刷新都会改变任务状态，必须继续被只读规则挡住。
   */
  readOnlyReceipt?: boolean;
  /**
   * 摆在结果卡正文之后的续问行，而不是顶部操作区：读者看完结论才会想接着问。
   * 两处读同一张表、同一个 isLarkCardActionAvailable，只是位置不同。
   */
  followUpRow?: boolean;
  /** 一键续问提交的固定文本：点击等同于在原话题里回复这段话。 */
  prompt?: string;
  /** 文案要带入能力里的数据时使用（目前只有定时按钮的 HH:MM）。 */
  dynamicLabel?: (capabilities: LarkCardCapabilities) => string;
  /** 是否为该状态的唯一主操作；主操作排在最前，视觉上最突出。 */
  primary: boolean;
  /** 不进操作区，由卡片页脚渲染在原「查看详情」链接的位置（见 buildLarkCardDetailButton）。 */
  footer?: boolean;
};

/**
 * 唯一的操作定义表。渲染与鉴权都只读这张表，因此两端不可能出现权限差。
 *
 * 状态收敛（一个状态一个主要下一步）：
 *   queued        → 取消
 *   running       → 中断
 *   interrupting  → 无主操作（停止请求已在途，见下方说明）
 *   completed     → 无主操作（结果已作为 fresh final 送达，验收在 Web）；
 *                   正文之后的续问行（说人话 / 给我对外回复 / 再详细点 / 每天自动执行）都不是主操作
 *   failed        → 重试
 *   interrupted   → 重试
 *
 * interrupting 为什么不给「中断」：该状态表示停止请求已经发出并在等待 runtime 回应。
 * 当前 coordinator.handleAction 的 interrupt 分支要求 state === 'running'，
 * 在 interrupting 上会直接回一个 warning toast——那正是一个死按钮。
 * 逃生通道由「刷新」承担：用户可以立刻拉取停止是否已生效，
 * 而不必销毁会话。若日后 handleAction 允许对 interrupting 幂等地重复中断，
 * 只需把下面 interrupt 的 states 加上 'interrupting'，两端会同时生效。
 */
const larkCardActionDefinitions: readonly LarkCardActionDefinition[] = [
  {
    action: 'cancel',
    elementId: 'cancel',
    label: '取消',
    hint: '取消排队任务，Agent 不会开始执行',
    buttonType: 'text',
    icon: 'close-small_outlined',
    states: ['queued'],
    capable: capabilities => capabilities.canCancelQueued,
    primary: true
  },
  {
    action: 'interrupt',
    elementId: 'interrupt',
    label: '中断',
    hint: '中断当前执行，已完成的步骤会保留',
    buttonType: 'text',
    icon: 'stop_outlined',
    states: ['running'],
    capable: capabilities => capabilities.canInterrupt,
    primary: true
  },
  {
    action: 'retry',
    elementId: 'retry',
    label: '重试',
    hint: '查看失败详情，修正后重新运行',
    buttonType: 'primary_text',
    // 与「刷新」同一个图标：两者的可用状态不相交，不会同时出现在一张卡上。
    icon: 'refresh_outlined',
    states: ['failed', 'interrupted', 'cancelled'],
    capable: capabilities => capabilities.canRetry,
    // 明确标记为不可重试的任务（例如配置错误、权限不足）不提供重试入口。
    guard: context => context.retryable !== false,
    primary: false
  },
  {
    action: 'verify',
    elementId: 'verify',
    label: '运行验证',
    hint: '在工作目录执行已配置的验证命令，记录退出码与代码指纹',
    buttonType: 'text',
    icon: 'safe-pass_outlined',
    // 排队/执行中不给：验证要求会话空闲，runtime 会直接回 SESSION_BUSY。
    // cancelled 也不给：任务没跑过，没有需要验证的改动。
    states: ['completed', 'failed', 'interrupted'],
    capable: capabilities => capabilities.canVerify === true,
    primary: false,
    readOnlyReceipt: true
  },
  {
    action: 'refresh',
    elementId: 'refresh',
    label: '刷新',
    hint: '立即拉取任务最新状态，卡片心跳受频率限制可能滞后',
    buttonType: 'text',
    icon: 'refresh_outlined',
    // 只在非终态提供：终态已经收敛，刷新不会带来新信息。
    states: ['queued', 'running', 'interrupting'],
    capable: capabilities => capabilities.canRefresh,
    primary: false
  },
  {
    action: 'run_in_new_session',
    elementId: 'run_in_new_session',
    label: larkRelaunchLabels.run_in_new_session,
    hint: '取消这条排队请求，在本话题的新会话中执行原文；原会话留给管理员核对',
    buttonType: 'primary_text',
    icon: 'add-chat_outlined',
    // 只给排队受阻的请求：它从未开始执行，换到新会话不会重复任何操作。
    states: ['queued'],
    capable: capabilities => capabilities.canRelaunch === true,
    primary: false
  },
  {
    action: 'rerun_in_new_session',
    elementId: 'rerun_in_new_session',
    label: larkRelaunchLabels.rerun_in_new_session,
    hint: '原执行结果未确认，重新执行可能把已经做过的操作再做一次',
    buttonType: 'primary_text',
    icon: 'repeat_outlined',
    states: ['reconcile_required', 'legacy_unresolved'],
    capable: capabilities => capabilities.canRelaunch === true,
    primary: false
  },
  {
    action: 'ask_plain',
    elementId: 'ask_plain',
    label: '说人话',
    hint: '用大白话重述上面的结论，先说结论再说影响，不重新调查',
    buttonType: 'text',
    icon: 'chat_outlined',
    states: ['completed'],
    capable: capabilities => capabilities.canFollowUp === true,
    primary: false,
    readOnlyReceipt: true,
    followUpRow: true,
    prompt: '用不含术语的大白话重新说一遍上面的结论：先一句话说结论，再说影响和要不要处理。不要重新调查。'
  },
  {
    action: 'ask_reply',
    elementId: 'ask_reply',
    label: '给我对外回复',
    hint: '按上面的结论写一段能直接转发给同事或群里的回复，不重新调查',
    buttonType: 'text',
    icon: 'reply_outlined',
    states: ['completed'],
    capable: capabilities => capabilities.canFollowUp === true,
    primary: false,
    readOnlyReceipt: true,
    followUpRow: true,
    prompt: '根据上面的结论，写一段可以直接转发给同事或群里的回复：三到五句，先说结论和影响，再说需要对方做什么；不含代码路径和命令。不要重新调查。'
  },
  {
    action: 'ask_detail',
    elementId: 'ask_detail',
    label: '再详细点',
    hint: '在上面结论的基础上展开细节和证据，补充不够确定的地方',
    buttonType: 'text',
    icon: 'details_outlined',
    states: ['completed'],
    capable: capabilities => capabilities.canFollowUp === true,
    primary: false,
    readOnlyReceipt: true,
    followUpRow: true,
    prompt: '在上面结论的基础上展开细节和证据，补充你认为不够确定的地方。'
  },
  {
    action: 'schedule_daily',
    elementId: 'schedule_daily',
    label: '每天自动执行',
    hint: '在这个话题里每天同一时间自动执行这条请求，结果回报到这里',
    buttonType: 'text',
    icon: 'time_outlined',
    states: ['completed'],
    capable: capabilities => capabilities.dailySchedule?.scheduled === false && clockTime.test(capabilities.dailySchedule.time),
    primary: false,
    readOnlyReceipt: true,
    followUpRow: true,
    dynamicLabel: capabilities => `每天 ${capabilities.dailySchedule!.time} 自动执行`
  },
  {
    action: 'detail',
    elementId: 'detail',
    label: '查看详情',
    hint: '机器人管理员会收到一条私信，内含 10 分钟内有效的 Web 登录链接',
    buttonType: 'text',
    icon: 'file-link-text_outlined',
    // 与原来的页脚链接一样，任何状态都能看详情。
    states: ['queued', 'running', 'interrupting', 'completed', 'failed', 'interrupted', 'cancelled', 'reconcile_required', 'legacy_unresolved'],
    capable: capabilities => capabilities.detailLogin === true && Boolean(safeLarkWebUrl(capabilities.webUrl)),
    primary: false,
    // 只读不写：打开详情不改卡上的结论。
    readOnlyReceipt: true,
    footer: true
  }
] as const;

const definitionFor = (action: LarkCardActionName) =>
  larkCardActionDefinitions.find(definition => definition.action === action);

const normalizedTaskId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const resolved = value.trim();
  if (!resolved || resolved.length > maxTaskIdLength) return undefined;
  return resolved;
};

/** turn 归一化为非负整数；非法值按第 0 轮处理，避免因为轮次脏数据丢掉整个操作。 */
const normalizedTurn = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
};

/**
 * 只接受 http/https 深链，防止把 javascript: 之类的 URL 渲染成可点目标。
 * 页脚的「查看详情」markdown 链接是整卡唯一的 Web 出口，service.ts 复用同一份校验，
 * 不允许两边各写一套判断。校验不通过时页脚不渲染，卡上就没有 Web 出口。
 */
export const safeLarkWebUrl = (value: string | undefined): string | undefined => {
  const resolved = value?.trim();
  if (!resolved || resolved.length > maxWebUrlLength) return undefined;
  try {
    const parsed = new URL(resolved);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? resolved : undefined;
  } catch {
    return undefined;
  }
};

/**
 * 鉴权侧入口：回调到达时判断该操作在当前上下文是否合法。
 * 渲染侧共用同一函数，因此「界面上出现的按钮」与「后端接受的回调」严格等价。
 */
export function isLarkCardActionAvailable(action: LarkCardActionName, context: LarkCardActionContext): boolean {
  const definition = definitionFor(action);
  if (!definition) return false;
  // 只读收据不接受改写结论的操作：卡片一旦冻结就是历史凭证，
  // 在上面执行取消/中断/重试等于改写已经交付给用户的结论。
  // readOnlyReceipt 是唯一例外，含义见该字段说明。
  if (context.readOnly && !definition.readOnlyReceipt) return false;
  // 没有可用 taskId 时任何回调都无法被 coordinator 定位到任务，等于死按钮。
  if (!normalizedTaskId(context.taskId)) return false;
  if (!definition.states.includes(context.state)) return false;
  if (!definition.capable(context.capabilities)) return false;
  return definition.guard ? definition.guard(context) : true;
}

/** 当前状态下可用的回调操作，按主操作优先排序。 */
export function availableLarkCardActions(context: LarkCardActionContext): LarkCardActionName[] {
  return larkCardActionDefinitions
    .filter(definition => isLarkCardActionAvailable(definition.action, context))
    .sort((left, right) => Number(right.primary) - Number(left.primary))
    .map(definition => definition.action);
}

/** 供卡片正文补充「动作 + 对象 + 预期结果」的完整说明，禁止只靠颜色或短标签表意。 */
export function larkCardActionHint(action: LarkCardActionName): string | undefined {
  return definitionFor(action)?.hint;
}

/** 一键续问提交的固定文本；不是续问操作时返回 undefined。 */
export function larkCardFollowUpPrompt(action: LarkCardActionName): string | undefined {
  return definitionFor(action)?.prompt;
}

/** 这段请求是不是某个续问按钮代发的固定文本（重复请求判定要把它们排除在外）。 */
export function isLarkCardFollowUpPrompt(text: string): boolean {
  const resolved = text.trim();
  return larkCardActionDefinitions.some(definition => definition.prompt === resolved);
}

/** 按钮文案：带时刻的定时按钮用动态文案，其余一律是静态常量。 */
export function larkCardActionLabel(action: LarkCardActionName, capabilities: LarkCardCapabilities): string | undefined {
  const definition = definitionFor(action);
  return definition && (definition.dynamicLabel?.(capabilities) ?? definition.label);
}

/**
 * callback value 一律使用字符串字段。
 * 原因有两条：飞书只能稳定保留 value 对象里的字符串（数字/布尔可能被吞或被改写类型）；
 * 更重要的是 value 必须自带状态——daemon 重启后内存里的任务上下文全丢了，
 * 只有 value 里的 action / task_id / turn 能让重启后的进程独立解释这次点击，
 * 从而让操作在重启前后保持幂等。
 */
const callbackValue = (action: LarkCardActionName, taskId: string, turn: number) => ({
  action,
  task_id: taskId,
  turn: String(turn)
});

const callbackButton = (definition: LarkCardActionDefinition, taskId: string, turn: number, capabilities: LarkCardCapabilities): LarkCardElement => ({
  tag: 'button',
  text: { tag: 'plain_text', content: definition.dynamicLabel?.(capabilities) ?? definition.label },
  type: definition.buttonType,
  icon: { tag: 'standard_icon', token: definition.icon, color: definition.buttonType === 'primary_text' ? 'blue' : 'grey' },
  behaviors: [{ type: 'callback', value: callbackValue(definition.action, taskId, turn) }],
  margin: '0px',
  element_id: definition.elementId
});

/**
 * 渲染侧入口：返回当前状态下应该出现的按钮，没有可用操作时返回空数组。
 *
 * 只读卡片只保留 readOnlyReceipt 操作：只读卡是已交付的历史凭证，
 * 任何会改写结论的按钮都是「假操作」——点了要么被拒绝，要么改写已交付的结论。
 * 验证是唯一例外，它只新增一条独立证据，卡上的结论一个字都不动。
 * 配置了合法 webBaseUrl 时，页脚的 [查看详情] 链接是收据的 Web 出口；
 * 未配置或深链非法时页脚整行不渲染，此时只读卡确实没有任何出口——
 * 那是缺配置的后果，不能靠在这里补一个注定失败的按钮来掩盖。
 *
 * 这里刻意**不**渲染「查看详情」按钮：页脚已经有同一个链接，顶部再放一个
 * 就是同一去向的两个入口。
 *
 * 注意：这里返回的是扁平按钮列表，不含 column_set 包装，
 * 由调用方决定放进哪一行；按钮带图标，所在列必须是自适应宽度，固定窄列会把文案挤折行。
 */
export function buildLarkCardActions(context: LarkCardActionContext): LarkCardElement[] {
  const taskId = normalizedTaskId(context.taskId);
  const turn = normalizedTurn(context.turn);
  const elements: LarkCardElement[] = [];
  if (taskId) {
    for (const action of availableLarkCardActions(context)) {
      const definition = definitionFor(action);
      if (definition && !definition.followUpRow && !definition.footer) elements.push(callbackButton(definition, taskId, turn, context.capabilities));
    }
  }
  // 预算兜底：正常路径最多 3 个按钮（排队受阻：取消、刷新、在新会话中执行），这里的截断是防御性上限。
  return elements.slice(0, larkCardActionBudget.maxButtons);
}

/**
 * 结果卡正文之后的续问行：一键续问与「每天 HH:MM 自动执行」。
 * 与 buildLarkCardActions 一样只是 isLarkCardActionAvailable 的渲染投影，两行合起来
 * 正好等于 availableLarkCardActions。已建好的定时只渲染一个不可点的状态按钮：
 * 它不带回调，不是操作，所以不在能力表里。
 */
export function buildLarkCardFollowUpActions(context: LarkCardActionContext): LarkCardElement[] {
  const taskId = normalizedTaskId(context.taskId);
  if (!taskId) return [];
  const turn = normalizedTurn(context.turn);
  const elements = availableLarkCardActions(context)
    .map(definitionFor)
    .filter((definition): definition is LarkCardActionDefinition => Boolean(definition?.followUpRow))
    .map(definition => callbackButton(definition, taskId, turn, context.capabilities));
  const schedule = context.capabilities.dailySchedule;
  if (schedule?.scheduled && clockTime.test(schedule.time) && context.state === 'completed') {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `已设为每天 ${schedule.time} 自动执行` },
      type: 'text',
      disabled: true,
      icon: { tag: 'standard_icon', token: 'calendar-done_outlined', color: 'grey' },
      margin: '0px',
      element_id: 'schedule_daily'
    });
  }
  return elements.slice(0, larkCardActionBudget.maxButtons);
}

/**
 * 页脚「查看详情」的回调按钮；detail 不可用时返回 undefined，调用方照旧渲染直接打开 webUrl 的链接。
 * 按钮本身不带 URL：服务端按平台给出的消息 ID 查账本、核对管理员后，才把登录链接私信给点击人。
 */
export function buildLarkCardDetailButton(context: LarkCardActionContext): LarkCardElement | undefined {
  const taskId = normalizedTaskId(context.taskId);
  const definition = definitionFor('detail');
  if (!taskId || !definition || !isLarkCardActionAvailable('detail', context)) return undefined;
  // 页脚是一行 x-small 灰字，按钮取小号，不把这一行撑高。
  return { ...callbackButton(definition, taskId, normalizedTurn(context.turn), context.capabilities), size: 'small' };
}

/**
 * 解析回调 value。宽进严出：
 * - 接受 JSON 字符串和对象（listener 直接透传 event.action.value，两种形态都出现过）
 * - 兼容线上遗留形态 {action, task_id}（不带 turn）：已经发给用户的老卡片必须继续可用
 * - 同时接受 task_id 与 taskId 两种键名
 * - 任何畸形输入返回 undefined，绝不抛异常（回调路径抛异常会让用户只看到一个失败 toast）
 */
export function parseLarkCardActionValue(value: unknown): LarkCardActionValue | undefined {
  let parsed: unknown = value;
  if (typeof parsed === 'string') {
    const text = parsed.trim();
    if (!text) return undefined;
    try { parsed = JSON.parse(text); } catch { return undefined; }
  }
  // 数组也是 object，必须显式排除，否则 ['cancel'] 之类的输入会走到属性读取。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const action = typeof record.action === 'string' ? record.action.trim() : '';
  const definition = larkCardActionDefinitions.find(item => item.action === action);
  if (!definition) return undefined;
  const taskId = normalizedTaskId(record.task_id) ?? normalizedTaskId(record.taskId);
  if (!taskId) return undefined;
  // turn 是字符串写入的，这里转回数字；遗留卡片没有 turn，保持 undefined 由调用方决定是否校验轮次。
  const rawTurn = record.turn;
  const turnNumber = typeof rawTurn === 'string' && rawTurn.trim()
    ? Number(rawTurn)
    : typeof rawTurn === 'number'
      ? rawTurn
      : undefined;
  const turn = turnNumber !== undefined && Number.isFinite(turnNumber) && turnNumber >= 0
    ? Math.floor(turnNumber)
    : undefined;
  return { action: definition.action, taskId, ...(turn === undefined ? {} : { turn }) };
}
