/**
 * 飞书聊天内命令层：形状校验（唯一校验器）+ 命令注册表 + 能力/权限判定 + /help 渲染。
 *
 * 设计约束（与 docs/interaction-design-2026-08-30.md 2.1 与第 3 节一致）：
 *
 * 1. **纯模块，零依赖**：本文件不 import 任何东西——不碰 runtime、不发网络请求、不触碰
 *    卡片生命周期。它只返回一个「被描述的意图」（intent），由 coordinator 执行。
 *    这样命令层可以单测，而权限判定与卡片生命周期仍留在 coordinator 里（那里已经有
 *    白名单解析与进度卡/收据的全套机制，不应该被复制一份）。
 *    需要 LarkCardElement 时在本文件本地声明，不从 card-renderer.ts 引入（card-renderer
 *    依赖 service.ts，会把网络层拖进这个纯模块）。
 *
 * 2. **只有一个命令形状校验器**：{@link parseSlashCommand}。路由（{@link routeLarkCommand}）
 *    与权限门（{@link authorizeLarkCommandText}）都通过同一个 {@link evaluateLarkCommand}
 *    调用它，绝不各自再写一份解析。这是本模块最重要的结构性要求：如果路由认得
 *    `/foo:bar`、`/1cmd` 这类畸形输入而权限门不认（或反之），畸形命令就能绕过白名单
 *    执行——那是真实的提权缺口，不是风格问题。
 *
 * 3. **诚实表达能力**：命令只有在 LarkRuntime 真的具备对应能力时才存在。LarkRuntime 里
 *    带 `?` 的方法（stop / dispatch / cancelQueued / getTasks / listAgents / listSessions）
 *    在运行时可能缺失；缺失时对应命令不会出现在 /help，也只会路由成 `unavailable`，
 *    绝不会变成一个执行不了的 intent。Dutydeck 今天支撑不了的命令（/cwd、/model、/agent）
 *    直接不注册，宁可少而诚实。
 *
 * 4. `/help` **渲染只用 markdown**：飞书卡片 schema 2.0 拒绝 `note` 标签（ErrCode 200861），
 *    因此 /help 用 markdown 元素 + 分页渲染，元素数与字节数都有界。
 *
 * 5. **未识别的 /xxx 归一化后透传**：见 {@link normalizeLarkPassthroughPrompt}。归一化后的
 *    文本不再以 `/` 开头，因此无论被谁再解析一次都不可能被认成内建命令——避免用户用
 *    `/status` 之类的字面量在后续环节「影子」掉真正的内建命令。
 */

// ---------------------------------------------------------------------------
// 卡片元素（本地声明，保持零依赖）
// ---------------------------------------------------------------------------

/** 飞书卡片元素。等价于 card-renderer.ts 的同名类型，此处本地声明以保持零依赖。 */
export type LarkCardElement = Record<string, any>;

// ---------------------------------------------------------------------------
// 唯一的命令形状校验器
// ---------------------------------------------------------------------------

export interface ParsedSlashCommand {
  /** 归一化后的命令名，恒为小写。 */
  name: string;
  /** 按空白切分的参数。 */
  args: string[];
  /** 命令名之后的原文，保留内部空格与换行（目录路径、句子等参数需要）。 */
  argsText: string;
  /** trim 后的整条原文，供回执与 passthrough 归一化使用。 */
  raw: string;
}

/**
 * 合法命令名：小写字母、数字、`-`、`_`，且必须以字母开头。
 * 解析前会统一转小写，因此 `/HELP` 与 `/help` 等价。
 */
const commandNamePattern = /^[a-z][a-z0-9_-]*$/;
/** 命令名长度上限；超长输入不是命令，按普通文字透传。 */
const maxCommandNameLength = 32;

/**
 * **唯一**的命令形状校验器。返回 undefined 表示「这不是一条命令」。
 *
 * 规则（严格且显式）：
 * - 必须在 trim 后的消息最开头出现 `/`。调用方传入的应当是**已经剥离飞书 @机器人 提及**
 *   的纯文本（coordinator 的 parsePrompt 已经做过这件事）。
 * - 命令名只允许 `[a-z][a-z0-9_-]*`，因此 `/1cmd`（数字开头）、`/foo:bar`（含冒号）
 *   都是非法的。
 * - 大小写不敏感，统一归一化为小写。
 * - 裸 `/`、`//`、`/ help` 都不是命令；文本中间出现 `/` 也不是命令。
 * - 路径歧义的处理：`/usr/bin/foo` 的命令名候选是 `usr/bin/foo`，因为含 `/` 不满足字符集
 *   而被拒绝——多段路径天然不会被误认成命令。但**单段路径无法与命令区分**
 *   （`/tmp` 和 `/help` 形状完全一样），所以本模块不把「无法识别的命令」当成错误：
 *   它会被归一化后作为普通文字交给 Agent（见 {@link normalizeLarkPassthroughPrompt}），
 *   用户不会因为发了个路径就收到一条「未知命令」的失败回执。
 * - argsText 保留原文（仅去掉首尾空白），因此 `/cwd /tmp/some dir` 的 argsText 是
 *   `/tmp/some dir`，内部空格不丢。
 */
export function parseSlashCommand(text: unknown): ParsedSlashCommand | undefined {
  if (typeof text !== 'string') return undefined;
  const raw = text.trim();
  if (!raw.startsWith('/')) return undefined;
  const body = raw.slice(1);
  const separator = body.search(/\s/);
  const head = separator < 0 ? body : body.slice(0, separator);
  const rest = separator < 0 ? '' : body.slice(separator);
  const name = head.toLowerCase();
  if (!name || name.length > maxCommandNameLength) return undefined;
  if (!commandNamePattern.test(name)) return undefined;
  const argsText = rest.trim();
  return { name, args: argsText ? argsText.split(/\s+/) : [], argsText, raw };
}

// ---------------------------------------------------------------------------
// 运行时能力
// ---------------------------------------------------------------------------

/**
 * 命令层关心的运行时能力。字段与 listener.ts 的 LarkRuntime 方法一一对应。
 *
 * 注意这里也包含 LarkRuntime 中「必填」的方法（getSession / send / interrupt）：
 * 能力对象是从真实 runtime 对象上探测出来的，测试替身或裁剪过的实现完全可能缺少它们。
 * 把必填方法也纳入门控，可以保证任何缺失都收敛成 `unavailable`，而不是一个执行时才爆的 intent。
 */
export interface LarkCommandCapabilities {
  ci?: boolean;
  schedule?: boolean;
  work?: boolean;
  tasks?: boolean;
  answer?: boolean;
  approval?: boolean;
  getSession: boolean;
  send: boolean;
  dispatch: boolean;
  interrupt: boolean;
  cancelQueued: boolean;
  stop: boolean;
  getTasks: boolean;
  listAgents: boolean;
  listSessions: boolean;
}

const capabilityKeys = [
  'getSession', 'send', 'dispatch', 'interrupt', 'cancelQueued',
  'stop', 'getTasks', 'listAgents', 'listSessions'
] as const satisfies readonly (keyof LarkCommandCapabilities)[];

/** 从真实 runtime 对象探测能力。coordinator 直接传 this.runtime 即可。 */
export function larkCommandCapabilities(runtime: unknown): LarkCommandCapabilities {
  const source = runtime as Record<string, unknown> | null | undefined;
  const capabilities = {} as LarkCommandCapabilities;
  for (const key of capabilityKeys) capabilities[key] = typeof source?.[key] === 'function';
  return capabilities;
}

// ---------------------------------------------------------------------------
// 命令注册表
// ---------------------------------------------------------------------------

export type LarkCommandName = 'work' | 'schedule' | 'ci' | 'help' | 'status' | 'cancel' | 'retry' | 'new' | 'tasks' | 'answer' | 'approve' | 'reject';

export interface LarkCommandDefinition {
  name: LarkCommandName;
  aliases?: string[];
  /** 简体中文摘要，「动作 + 对象 + 预期结果」，不用「处理」「继续」这类空动词。 */
  summary: string;
  usage: string;
  /** true 表示会改变会话/任务状态，必须过白名单门。 */
  mutating: boolean;
  /** 诚实能力门：返回 false 时该命令不出现在 /help，路由结果只能是 unavailable。 */
  requires?: (capabilities: LarkCommandCapabilities) => boolean;
  /** requires 不满足时给用户的具体原因，必须说清缺的是哪个能力。 */
  unavailableReason?: string;
}

/**
 * 当前**真的**由 Dutydeck 支撑的命令。每条都对应一个已核对过的运行时能力：
 *
 * - `/help`   纯函数，本模块自己渲染，永远可用。
 * - `/status` runtime.getSession（必填）+ 可选 getTasks 补排队口径；coordinator 已持有
 *             group.sessionId 与 config（Agent / 工作区）。
 * - `/cancel` runtime.interrupt（必填，中断运行中的一轮）或 runtime.cancelQueued（可选，
 *             取消排队中的一轮）——与 coordinator.handleAction 的 cancel/interrupt 分支同源。
 * - `/retry`  runtime.dispatch/send 重新下发（与 handleAction 的 retry 分支同源，
 *             由 coordinator 复用内存里的 LarkTask 新建一张进度卡）。
 * - `/new`    runtime.stop（**可选方法**）。清掉 group 的会话绑定并不足以开启新会话：
 *             resolveLarkSession 之后会按 sourceId 在 listSessions 里复用同一个持久化
 *             session，只有 state 为 stopped/failed 的会话才会被排除。因此 /new 必须能
 *             stop 掉旧会话，否则是一条什么都没发生的假命令。带任务内容时，argsText
 *             由 coordinator 当作普通请求走完整建任务链路，命令层不自己派发。
 */
export const larkCommandRegistry: readonly LarkCommandDefinition[] = [
  { name: 'work', summary: '查看目标、分配 Agent、回答步骤问题并复用工作流', usage: '/work；/work research 目标；/work templates', mutating: true, requires: c => c.work === true, unavailableReason: '当前服务未接入目标工作台。' },
  { name: 'schedule', summary: '查看、创建、启用或停用此话题的定时任务', usage: '/schedule；/schedule every 分钟 指令；/schedule enable 编号；/schedule disable 编号', mutating: true, requires: c => c.schedule === true, unavailableReason: '当前服务未接入定时任务。' },
  { name: 'ci', summary: '等待当前提交的 GitHub Actions、查看等待或取消续作', usage: '/ci；/ci wait [工作流]；/ci cancel <等待编号>', mutating: true, requires: c => c.ci === true, unavailableReason: '当前机器人未接入 GitHub Actions 自动续作。' },
  { name: 'tasks', summary: '查看允许访问的待处理任务、运行进度和最近结果', usage: '/tasks [页码]', mutating: false, requires: c => c.tasks === true, unavailableReason: '当前机器人无法查询任务列表，/tasks 已停用。' },
  { name: 'answer', summary: '回答 Agent 的问题并继续原任务', usage: '/answer <问题编号> <回答>', mutating: true, requires: c => c.answer === true, unavailableReason: '当前机器人无法接收问题回答，/answer 已停用。' },
  { name: 'approve', summary: '批准卡片上的本次工具调用', usage: '/approve <请求编号>', mutating: true, requires: c => c.approval === true, unavailableReason: '当前机器人无法处理工具调用审批，/approve 已停用。' },
  { name: 'reject', summary: '拒绝卡片上的本次工具调用', usage: '/reject <请求编号>', mutating: true, requires: c => c.approval === true, unavailableReason: '当前机器人无法处理工具调用审批，/reject 已停用。' },
  {
    name: 'help',
    summary: '列出当前可用的 Dutydeck 命令及其用法',
    usage: '/help [页码]',
    mutating: false
  },
  {
    name: 'status',
    summary: '查看本会话绑定的 Agent、工作区、运行状态与待执行指令数',
    usage: '/status',
    mutating: false,
    requires: capabilities => capabilities.getSession,
    unavailableReason: '当前 Dutydeck 运行时无法读取会话状态（缺少 getSession），/status 给不出真实状态，已停用。'
  },
  {
    name: 'cancel',
    aliases: ['stop'],
    summary: '取消本会话正在执行或排队中的这一轮任务，并把进度卡收敛为取消收据',
    usage: '/cancel',
    mutating: true,
    // 中断运行中的一轮与取消排队中的一轮是两种能力；只要有一种就还能真的停下一些东西。
    // 两种都缺时 /cancel 只能是空承诺，直接停用。
    requires: capabilities => capabilities.interrupt || capabilities.cancelQueued,
    unavailableReason: '当前 Dutydeck 运行时没有可用的停止手段（缺少 interrupt 与 cancelQueued），/cancel 无法真正取消任务，已停用。'
  },
  {
    name: 'retry',
    summary: '重新执行本会话最近一次失败或已取消的任务，并新建一张进度卡',
    usage: '/retry',
    mutating: true,
    requires: capabilities => capabilities.dispatch || capabilities.send,
    unavailableReason: '当前 Dutydeck 运行时无法重新下发任务（缺少 dispatch 与 send），/retry 无法重新执行，已停用。'
  },
  {
    name: 'new',
    summary: '结束当前会话上下文；带上任务内容可以同时开启新会话并立刻派发这个任务',
    usage: '/new 或 /new <任务内容>；指定首轮配置：/new [--cwd 绝对路径] [--workspace shared|worktree] [--model 模型] [--effort 强度] -- 任务内容',
    mutating: true,
    requires: capabilities => capabilities.stop,
    unavailableReason: '当前 Dutydeck 运行时无法结束旧会话（缺少 stop），/new 不能保证下一条消息真的开启新会话，已停用。'
  }
];

/** name/alias → 定义。重复注册是开发期错误，构建时直接抛出，避免两条命令抢同一个名字。 */
const commandLookup = (() => {
  const lookup = new Map<string, LarkCommandDefinition>();
  for (const definition of larkCommandRegistry) {
    for (const key of [definition.name, ...(definition.aliases ?? [])]) {
      if (!commandNamePattern.test(key)) {
        throw new Error(`Lark 命令名不符合命令形状规则：${key}`);
      }
      if (lookup.has(key)) throw new Error(`Lark 命令名重复注册：${key}`);
      lookup.set(key, definition);
    }
  }
  return lookup;
})();

/** 命令是否被当前运行时能力支撑。 */
export function isLarkCommandAvailable(definition: LarkCommandDefinition, capabilities: LarkCommandCapabilities): boolean {
  return definition.requires ? definition.requires(capabilities) === true : true;
}

/** 当前上下文中真正可用的命令，/help 与路由共用同一份过滤逻辑。 */
export function listLarkCommands(capabilities: LarkCommandCapabilities): LarkCommandDefinition[] {
  return larkCommandRegistry.filter(definition => isLarkCommandAvailable(definition, capabilities));
}

/**
 * 按命令名/别名查注册表。**不做能力门控**：调用方必须能区分「没这条命令」（透传给
 * Agent）与「有这条命令但当前运行时支撑不了」（诚实告知 unavailable）；把能力门塞进
 * 这里会把后者压成前者，恰好毁掉诚实表达能力这条要求。能力门见
 * {@link isLarkCommandAvailable}。
 */
export function resolveLarkCommand(parsed: ParsedSlashCommand): LarkCommandDefinition | undefined {
  return commandLookup.get(parsed.name);
}

// ---------------------------------------------------------------------------
// 未识别命令的透传归一化
// ---------------------------------------------------------------------------

/** 透传标记，与 coordinator 既有的 `[Dutydeck …]` 系统上下文标记风格一致。 */
export const larkPassthroughMarker = '[Dutydeck 非命令原文]';

/**
 * 把未识别的 `/xxx` 归一化成给 Agent 的普通请求文本。
 *
 * 归一化后的文本以 `[` 开头，因此再次经过 {@link parseSlashCommand} 一定返回 undefined：
 * 无论这段文本后续被谁重新解析（重试、对账、日志回灌），都不可能被认成内建命令，
 * 也就无法用字面量「影子」掉真正的 Dutydeck 命令。已带标记的文本不会被重复包裹。
 */
export function normalizeLarkPassthroughPrompt(raw: unknown): string {
  const body = typeof raw === 'string' ? raw.trim() : '';
  if (body.startsWith(larkPassthroughMarker)) return body;
  return `${larkPassthroughMarker}\n以下内容不是 Dutydeck 命令，请按普通用户请求处理：\n${body}`;
}

// ---------------------------------------------------------------------------
// 操作人与共享判定
// ---------------------------------------------------------------------------

export interface LarkCommandOperator {
  /**
   * 操作人类型。'bot' 表示消息来自机器人（event.senderType 为 app/bot）。
   * 协作机器人可以创建任务，但不允许驱动会话生命周期（见下方 mutating 规则）。
   */
  kind: 'user' | 'bot';
  /**
   * 是否在机器人白名单内。**必须**由 coordinator 用既有的白名单逻辑填充
   * （isOperatorAllowed / runTurn 那一套 allowedUsers + allowedEmails + allowedBots +
   * peerBotsAllowed），本模块不自己解析身份，也不新造一套权限系统。
   */
  allowlisted: boolean;
}

export interface LarkCommandContext {
  capabilities: LarkCommandCapabilities;
  operator: LarkCommandOperator;
  /** /help 每页条数，默认 6，最终会被夹到 [1, 20]。 */
  helpPageSize?: number;
}

const denyNotAllowlisted = (name: string) =>
  `当前账号不在机器人白名单中，无法执行 /${name}。请联系机器人管理员把你加入白名单后重试。`;

const denyBotOperator = (name: string) =>
  `协作机器人不能执行 /${name}：改变会话状态的命令仅限白名单内的人类成员操作。请改由人工在飞书中发送该命令。`;

const defaultUnavailable = (name: string) =>
  `当前 Dutydeck 运行时不支持 /${name}，已停用。`;

/** {@link evaluateLarkCommand} 的判定结果，路由与权限门共享同一份。 */
export type LarkCommandVerdict =
  | { verdict: 'not_a_command' }
  | { verdict: 'unknown'; parsed: ParsedSlashCommand }
  | { verdict: 'unavailable'; parsed: ParsedSlashCommand; definition: LarkCommandDefinition; reason: string }
  | { verdict: 'denied'; parsed: ParsedSlashCommand; definition: LarkCommandDefinition; reason: string }
  | { verdict: 'allowed'; parsed: ParsedSlashCommand; definition: LarkCommandDefinition };

/**
 * 命令层的**唯一**判定入口：形状校验 → 注册表 → 白名单 → 能力门 → 机器人限制。
 *
 * {@link routeLarkCommand}（路由）与 {@link authorizeLarkCommandText}（权限门）都只是这个
 * 函数的包装，因此两条路径不可能对同一个输入给出不同的「是不是命令」或「允不允许」判断。
 *
 * 判定顺序是有意的：白名单先于能力门——不在白名单里的账号连运行时缺哪个能力都不该知道，
 * 这与 coordinator 对非白名单发送人一律回「访问被拒绝」的现状一致。
 */
export function evaluateLarkCommand(text: unknown, context: LarkCommandContext): LarkCommandVerdict {
  const parsed = parseSlashCommand(text);
  if (!parsed) return { verdict: 'not_a_command' };
  const definition = resolveLarkCommand(parsed);
  if (!definition) return { verdict: 'unknown', parsed };
  if (!context.operator.allowlisted) {
    return { verdict: 'denied', parsed, definition, reason: denyNotAllowlisted(definition.name) };
  }
  if (!isLarkCommandAvailable(definition, context.capabilities)) {
    return {
      verdict: 'unavailable', parsed, definition,
      reason: definition.unavailableReason ?? defaultUnavailable(definition.name)
    };
  }
  if (definition.mutating && context.operator.kind === 'bot') {
    return { verdict: 'denied', parsed, definition, reason: denyBotOperator(definition.name) };
  }
  return { verdict: 'allowed', parsed, definition };
}

// ---------------------------------------------------------------------------
// 权限门（与路由共享 evaluateLarkCommand）
// ---------------------------------------------------------------------------

export type LarkCommandAuthorization =
  | { recognized: false }
  | { recognized: true; command: LarkCommandName; mutating: boolean; decision: 'allowed' | 'denied' | 'unavailable'; reason?: string };

/**
 * 权限门入口。与 {@link routeLarkCommand} 共用 {@link evaluateLarkCommand}，因此不存在
 * 「路由认得但权限门不认」的畸形命令——那正是提权缺口的来源。
 */
export function authorizeLarkCommandText(text: unknown, context: LarkCommandContext): LarkCommandAuthorization {
  const evaluated = evaluateLarkCommand(text, context);
  if (evaluated.verdict === 'not_a_command' || evaluated.verdict === 'unknown') return { recognized: false };
  const base = { recognized: true as const, command: evaluated.definition.name, mutating: evaluated.definition.mutating };
  if (evaluated.verdict === 'allowed') return { ...base, decision: 'allowed' };
  return { ...base, decision: evaluated.verdict === 'denied' ? 'denied' : 'unavailable', reason: evaluated.reason };
}

// ---------------------------------------------------------------------------
// /help 渲染（只用 markdown，绝不用 note）
// ---------------------------------------------------------------------------

export interface LarkCommandHelpOptions {
  page?: number;
  pageSize?: number;
}

export interface LarkCommandHelp {
  elements: LarkCardElement[];
  /** 纯文本兜底（私聊可直接发文本消息）。 */
  text: string;
  page: number;
  totalPages: number;
}

const defaultHelpPageSize = 6;
/** 单个 markdown 元素的内容上限；飞书卡片整体约 24KB / 180 元素，分页后远在限额内。 */
const maxHelpContentLength = 2_000;

const clampNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const clampText = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;

const markdownElement = (elementId: string, content: string, textSize: 'normal' | 'small' = 'normal'): LarkCardElement => ({
  // 只用 markdown：卡片 schema 2.0 会以 ErrCode 200861 拒绝 note 标签。
  tag: 'markdown',
  element_id: elementId,
  content: clampText(content, maxHelpContentLength),
  text_size: textSize,
  margin: textSize === 'small' ? '4px 0px' : '0px'
});

/**
 * 渲染 /help。只列出当前上下文中**真的可用**的命令；分页保证元素数与字节数有界，
 * 不会撞上飞书 ~24KB / 180 元素的限制。
 */
export function renderLarkCommandHelp(
  capabilities: LarkCommandCapabilities,
  options: LarkCommandHelpOptions = {}
): LarkCommandHelp {
  const commands = listLarkCommands(capabilities);
  const pageSize = clampNumber(Math.trunc(options.pageSize ?? defaultHelpPageSize) || defaultHelpPageSize, 1, 20);
  const totalPages = Math.max(1, Math.ceil(commands.length / pageSize));
  const page = clampNumber(Math.trunc(options.page ?? 1) || 1, 1, totalPages);
  const slice = commands.slice((page - 1) * pageSize, page * pageSize);

  const header = `**Dutydeck 飞书命令**\n当前可用 ${commands.length} 条，第 ${page}/${totalPages} 页。`;
  const rows = slice.map(definition => {
    const aliases = definition.aliases?.length
      ? `（别名 ${definition.aliases.map(alias => `\`/${alias}\``).join('、')}）`
      : '';
    const mutatingNote = definition.mutating ? ' · 需白名单权限' : '';
    return `**\`/${definition.name}\`**${aliases}${mutatingNote}\n${definition.summary}\n用法：\`${definition.usage}\``;
  });
  const body = rows.length ? rows.join('\n\n') : '当前运行时没有可用命令，请直接用普通消息下达任务。';
  const footerLines = [
    ...(totalPages > 1 ? [`发送 \`/help ${page < totalPages ? page + 1 : 1}\` 查看${page < totalPages ? '下一页' : '第 1 页'}。`] : []),
    '未列出的 `/xxx` 会作为普通文字交给 Agent 处理，不会被当作 Dutydeck 命令。'
  ];

  return {
    elements: [
      markdownElement('command_help_header', header),
      markdownElement('command_help_body', body),
      markdownElement('command_help_footer', footerLines.join('\n'), 'small')
    ],
    text: [header, body, footerLines.join('\n')].join('\n\n'),
    page,
    totalPages
  };
}

// ---------------------------------------------------------------------------
// 路由（与权限门共享 evaluateLarkCommand）
// ---------------------------------------------------------------------------

export type LarkCommandRoute =
  /** 不是命令：coordinator 按今天的流程正常建任务。 */
  | { kind: 'not_a_command' }
  /** 未识别的 /xxx：promptText 已归一化，可直接当普通请求交给 Agent。 */
  | { kind: 'unknown_command'; parsed: ParsedSlashCommand; promptText: string }
  /** 命令层已自己产出回执（目前只有 /help），coordinator 直接发只读卡片或文本。 */
  | { kind: 'reply'; command: LarkCommandName; parsed: ParsedSlashCommand; elements: LarkCardElement[]; text: string }
  /** 命令存在但当前运行时支撑不了：回执 reason，绝不产生 intent。 */
  | { kind: 'unavailable'; command: LarkCommandName; parsed: ParsedSlashCommand; reason: string }
  /** 权限不足：回执 reason。 */
  | { kind: 'denied'; command: LarkCommandName; parsed: ParsedSlashCommand; reason: string }
  /** 被描述的意图，由 coordinator 执行。 */
  | {
      kind: 'intent';
      command: LarkCommandName;
      parsed: ParsedSlashCommand;
      definition: LarkCommandDefinition;
      args: string[];
      argsText: string;
    };

/**
 * 聊天内命令路由。返回的是「被描述的意图」，不碰 runtime、不发卡片——执行留在
 * coordinator（那里才有白名单解析、进度卡与终态收据的完整机制）。
 */
export function routeLarkCommand(text: unknown, context: LarkCommandContext): LarkCommandRoute {
  const evaluated = evaluateLarkCommand(text, context);
  switch (evaluated.verdict) {
    case 'not_a_command':
      return { kind: 'not_a_command' };
    case 'unknown':
      return { kind: 'unknown_command', parsed: evaluated.parsed, promptText: normalizeLarkPassthroughPrompt(evaluated.parsed.raw) };
    case 'unavailable':
      return { kind: 'unavailable', command: evaluated.definition.name, parsed: evaluated.parsed, reason: evaluated.reason };
    case 'denied':
      return { kind: 'denied', command: evaluated.definition.name, parsed: evaluated.parsed, reason: evaluated.reason };
    case 'allowed': {
      const { parsed, definition } = evaluated;
      // /help 是纯函数，命令层自己渲染回执，不必绕一趟 coordinator。
      if (definition.name === 'help') {
        const page = Number.parseInt(parsed.args[0] ?? '', 10);
        const help = renderLarkCommandHelp(context.capabilities, {
          ...(Number.isFinite(page) ? { page } : {}),
          ...(context.helpPageSize === undefined ? {} : { pageSize: context.helpPageSize })
        });
        return { kind: 'reply', command: 'help', parsed, elements: help.elements, text: help.text };
      }
      return { kind: 'intent', command: definition.name, parsed, definition, args: parsed.args, argsText: parsed.argsText };
    }
  }
}

// ---------------------------------------------------------------------------
// 回显安全
// ---------------------------------------------------------------------------

/**
 * 回显用户输入前的安全处理：去掉控制字符、折叠空白、限长。
 *
 * 本模块不 import card-renderer.ts 的 redactTraceText（那会把 service.ts 整条网络层
 * 拖进这个纯模块），因此**不回显任何 Agent / 工具输出**——只回显用户自己输入的参数，
 * 并且必须限长。命令名本身已被 {@link parseSlashCommand} 的字符集约束，天然安全。
 */
export function larkCommandEcho(value: unknown, limit = 120): string {
  const text = (typeof value === 'string' ? value : '')
    // 控制字符会破坏卡片渲染，先统一换成空格再折叠。
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clampText(text, clampNumber(Math.trunc(limit) || 1, 1, 512));
}
