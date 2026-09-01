import type { Session } from './api';
import { busyStates } from './components/ui';

/**
 * Web Composer 的内建斜杠命令注册表。
 *
 * ## 为什么要有这个文件
 *
 * 这份注册表与 `apps/server/src/lark/commands.ts` 的 `larkCommandRegistry` 是同一套
 * 设计的两端落地：**命令必须对应一个真实的运行时能力，能力缺失时诚实降级，
 * 不隐藏、不假装**。飞书侧那份注册表的文档注释逐条说明了每个命令背后是哪个 runtime
 * 方法；这里同样逐条对齐 Web 已有的 mutation。
 *
 * 之所以是两份而不是共享一份：两端的能力边界本就不同（Web 有模型切换和文件引用，
 * 飞书没有；飞书的 /new 靠 runtime.stop 结束会话绑定，Web 有显式的创建任务入口）。
 * 强行共享一份会让某一端出现永远 unavailable 的命令，那比两份更糟。共享的是
 * **模式**：注册表单一副本 + 能力门控 + unavailableReason 说清缺什么。
 *
 * ## 与飞书命令的对应关系
 *
 * | 飞书 | Web | 说明 |
 * | --- | --- | --- |
 * | `/help`   | `/help`    | 两端都是纯展示，永远可用 |
 * | `/status` | `/status`  | Web 的 RunHeader 常驻显示状态，命令用于滚动后快速回看 |
 * | `/cancel` | `/cancel`  | 别名 `stop` 与飞书一致；对应 interrupt / cancelQueued |
 * | `/retry`  | `/restart` | **刻意不同名**。飞书 retry 是重发同一条 prompt 且保留上下文；
 *                            Web restart 走 driver.start() 起全新进程、上下文清空
 *                            （见 workspace-model.ts:177-179 的注释）。同名会让用户
 *                            以为能接着上次继续——那正是 commit f7a5e10 修过的
 *                            「重启说反话」同类错误。 |
 * | `/new`    | `/new`     | 语义按 Web 重新定义：飞书是「结束当前会话让下条消息开新会话」
 *                            （聊天窗口只有一个），Web 是「打开创建任务」。描述如实写。 |
 *
 * Web 独有：`/file`、`/model`、`/reasoning`（飞书无对应能力）。
 *
 * ## 已删除的命令
 *
 * `/goal`（创建或继续一个 Goal）与 `/fast`（使用快速执行模式）曾在此列，但服务端
 * 全仓 grep 零实现，点击后只是往输入框插一段字符串。它们是空承诺，已移除。
 */

/** 命令被选中后的行为。`insert` 只把文本插入输入框，不产生副作用。 */
export type ComposerCommandAction = 'file' | 'model' | 'reasoning' | 'help' | 'status' | 'cancel' | 'restart' | 'new' | 'insert';

/**
 * Composer 命令可依赖的运行时能力。字段与 App.tsx 里真实存在的 mutation 一一对应。
 *
 * 与飞书那份一样，能力对象从调用点探测而来：缺任何一项都收敛成「有这条命令但当前
 * 用不了」，而不是让命令消失或点了才报错。
 */
export type ComposerCommandCapabilities = {
  /** 有打开的任务，且未归档。所有会话作用域命令的前提。 */
  session: boolean;
  /** 任务处于忙碌态，可中断。 */
  interruptible: boolean;
  /** 有排队中的指令，可取消。 */
  hasQueued: boolean;
  /** 任务处于 failed / stopped，可重新启动。 */
  recoverable: boolean;
  /** Agent 提供了可切换模型。 */
  models: boolean;
  /** 当前模型提供了思考深度选项。 */
  reasoningEfforts: boolean;
};

export type ComposerCommandDefinition = {
  name: string;
  aliases?: string[];
  /** 「动作 + 对象 + 预期结果」，不用「处理」「继续」这类空动词。 */
  description: string;
  action: ComposerCommandAction;
  /** 诚实能力门：返回 false 时命令仍然列出，但标为不可用并给出原因。 */
  requires?: (capabilities: ComposerCommandCapabilities) => boolean;
  /** requires 不满足时的具体原因，必须说清缺的是什么。 */
  unavailableReason?: string;
};

export const composerCommandRegistry: readonly ComposerCommandDefinition[] = [
  {
    name: 'file',
    description: '引用本地文件路径，让 Agent 从本机工作区读取',
    action: 'file'
  },
  {
    name: 'model',
    description: '切换当前任务使用的模型',
    action: 'model',
    requires: capabilities => capabilities.models,
    unavailableReason: '当前 Agent 没有提供可切换的模型'
  },
  {
    name: 'reasoning',
    description: '调整当前任务的思考深度',
    action: 'reasoning',
    requires: capabilities => capabilities.reasoningEfforts,
    unavailableReason: '当前模型没有提供思考深度选项'
  },
  {
    name: 'status',
    description: '查看当前任务的 Agent、工作区与执行状态',
    action: 'status',
    requires: capabilities => capabilities.session,
    unavailableReason: '还没有打开任务，没有可查看的状态'
  },
  {
    name: 'cancel',
    aliases: ['stop'],
    description: '停止正在执行的这一步，或取消排队中的指令',
    action: 'cancel',
    requires: capabilities => capabilities.interruptible || capabilities.hasQueued,
    unavailableReason: '当前任务没有正在执行的步骤，也没有排队中的指令'
  },
  {
    name: 'restart',
    // 必须说清「空白上下文」：这是与飞书 /retry 的根本差异，也是用户最容易误解的一点。
    description: '重新启动任务，用全新的 Agent 进程从空白上下文开始',
    action: 'restart',
    requires: capabilities => capabilities.recoverable,
    unavailableReason: '只有失败或已停止的任务可以重新启动'
  },
  {
    name: 'new',
    description: '创建一个新任务',
    action: 'new'
  },
  {
    name: 'help',
    // 面板目前只列快捷键，不列命令。描述不得承诺「可用命令」——命令清单就在这个
    // 面板本身（斜杠面板），说成两样东西会让用户点开后觉得少了内容。
    description: '查看键盘快捷键',
    action: 'help'
  }
];

/** name/alias → 定义。重复注册是开发期错误，构建时直接抛出。 */
const commandLookup = (() => {
  const lookup = new Map<string, ComposerCommandDefinition>();
  for (const definition of composerCommandRegistry) {
    for (const key of [definition.name, ...(definition.aliases ?? [])]) {
      if (lookup.has(key)) throw new Error(`Composer 命令名重复注册：${key}`);
      lookup.set(key, definition);
    }
  }
  return lookup;
})();

export function resolveComposerCommand(name: string): ComposerCommandDefinition | undefined {
  return commandLookup.get(name.toLowerCase());
}

export function isComposerCommandAvailable(definition: ComposerCommandDefinition, capabilities: ComposerCommandCapabilities): boolean {
  return definition.requires ? definition.requires(capabilities) === true : true;
}

/**
 * 从当前会话与 Composer 的 props 推导能力。
 *
 * 归档任务只读：所有会话作用域能力一律为 false，与 `ui.tsx:effectiveStatus`
 * 「归档优先」的判据一致，不在这里另写一套状态判断。
 */
export function composerCapabilities({ session, queuedCount, models, reasoningEfforts }: {
  session?: Pick<Session, 'state' | 'archivedAt'>;
  queuedCount: number;
  models: number;
  reasoningEfforts: number;
}): ComposerCommandCapabilities {
  const archived = Boolean(session?.archivedAt);
  const state = session?.state ?? '';
  const live = Boolean(session) && !archived;
  return {
    session: live,
    interruptible: live && busyStates.has(state),
    hasQueued: live && queuedCount > 0,
    recoverable: live && (state === 'failed' || state === 'stopped'),
    models: live && models > 0,
    reasoningEfforts: live && reasoningEfforts > 0
  };
}

/**
 * 内建命令 + Agent 自己声明的命令，合并为面板要展示的列表。
 *
 * 内建命令优先：Agent 声明了同名命令时不覆盖内建实现（内建的有能力门控和真实动作，
 * Agent 声明的只能插文本）。
 */
export function mergeComposerCommands(
  advertised: Array<{ name: string; description: string }>,
  capabilities: ComposerCommandCapabilities
): Array<ComposerCommandDefinition & { available: boolean; aliases: string[] }> {
  const builtinNames = new Set(composerCommandRegistry.flatMap(definition => [definition.name, ...(definition.aliases ?? [])]));
  return [
    ...composerCommandRegistry.map(definition => ({ ...definition, aliases: definition.aliases ?? [], available: isComposerCommandAvailable(definition, capabilities) })),
    ...advertised
      .filter(command => !builtinNames.has(command.name))
      .map(command => ({
        name: command.name,
        description: command.description || 'Agent 提供的命令',
        action: 'insert' as const,
        aliases: [] as string[],
        available: true
      }))
  ];
}
