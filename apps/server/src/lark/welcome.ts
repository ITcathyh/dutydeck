// 飞书欢迎语：bot 入群 / 私聊首次发话时发一次欢迎卡。
//
// 设计约束：
// 1. 卡内容是纯函数，命令简介只读复用 commands.ts 的 registry，不在本文件平行维护命令表。
// 2. 去重复用仓内既有 ConfigRepository（kv）接口，不自建存储；键名对齐 lark.xxx.${appId}.${id}。
//    有 compareAndSet 时用 CAS 认领，防止重复事件并发导致重发；没有时退化为 get/set。
// 3. 先认领后发卡：认领成功才发卡，发卡失败只记日志、不抛异常、不回滚标记——
//    硬约束是「同一 chat 重启/重复事件不重发」，发卡失败的代价（少一次欢迎）小于重发打扰。
// 4. 本模块不 import service.ts（网络层），发送动作由调用方以 send 回调注入。

import type { StoredLarkConfig } from './config.js';

export type WelcomeRouting = Pick<StoredLarkConfig, 'mentionPolicy' | 'p2pMode' | 'groupReplyMode'> & { chatMode?: 'group' | 'topic' | 'p2p'; unavailableReason?: string };

import {
  listLarkCommands,
  type LarkCardElement,
  type LarkCommandCapabilities
} from './commands.js';

/** ConfigRepository 的结构化子集，保持依赖注入最小化。 */
export interface WelcomeKv {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  compareAndSet?(key: string, expected: string | undefined, value: string): Promise<boolean>;
}

export interface WelcomeLog {
  warn(details: unknown, message?: string): void;
}

export interface WelcomeCardContent {
  /** 卡片标题（发送时用作 taskName）。 */
  title: string;
  /** 纯文本兜底。 */
  markdown: string;
  /** schema 2.0 卡片元素，只用 markdown。 */
  elements: LarkCardElement[];
}

/** 欢迎卡上展示的命令顺序；都从 registry 现取摘要，不在这里抄文案。 */
const welcomeCommandOrder = ['help', 'new', 'tasks', 'status', 'cancel', 'retry'] as const;
const maxWelcomeCommands = 6;

/** 去重键：同一应用同一会话只欢迎一次。 */
export function welcomedDedupeKey(appId: string, chatId: string): string {
  return `lark.welcomed.${appId}.${chatId}`;
}

const markdownElement = (elementId: string, content: string): LarkCardElement => ({
  tag: 'markdown',
  element_id: elementId,
  content
});

/**
 * 纯卡内容构建。capabilities 缺省时只展示无能力门的 /help——
 * 绝不能把当前 runtime 支撑不了的命令写进欢迎卡（与 commands.ts 的诚实能力原则一致）。
 */
export function buildWelcomeCardContent(input: {
  chatType: 'group' | 'p2p';
  capabilities?: LarkCommandCapabilities;
  routing?: WelcomeRouting;
}): WelcomeCardContent {
  const available = listLarkCommands(input.capabilities ?? {
    getSession: false, send: false, dispatch: false, interrupt: false, cancelQueued: false,
    stop: false, getTasks: false, listAgents: false, listSessions: false
  });
  const byName = new Map(available.map(command => [command.name, command]));
  const picked = welcomeCommandOrder
    .map(name => byName.get(name))
    .filter((command): command is (typeof available)[number] => Boolean(command))
    .slice(0, maxWelcomeCommands);
  const commandLines = picked.map(command => `**\`/${command.name}\`**　${command.summary}`);

  if (input.chatType === 'group') {
    const intro = '我是 **Dutydeck**，可以在群里帮你跑任务、盯进度并把结果发回本群。';
    const routing = input.routing;
    const policy = routing?.mentionPolicy ?? 'always';
    const direct = policy === 'never' || policy === 'ambient';
    const trigger = direct ? '' : '@我 ';
    const usage = [
      ...(routing?.unavailableReason ? [`当前尚不能执行任务：${routing.unavailableReason} 请管理员确认群配置生效后，再使用下面的示例。`] : []),
      policy === 'always' ? '每条任务消息和续聊都需要 **@我**。'
        : policy === 'topic' ? '新任务先 **@我**；在我已接手的原任务话题内续聊可直接回复。'
        : '本群普通消息也会触发任务；请直接发送完整请求。其他机器人仍需明确 @我。',
      `例如：\`${trigger}帮我查看项目状态\`；帮助：\`${trigger}/help\`。`,
      routing?.chatMode === 'topic' || ['new-topic', 'chat-topic'].includes(routing?.groupReplyMode ?? '')
        ? '继续任务请回原任务话题回复；新任务请另发顶层消息。'
        : routing?.groupReplyMode === 'shared' ? '本群顶层消息共享任务上下文；独立工作请另开话题。'
        : '普通群顶层消息按发送人延续上下文；同一话题内共享上下文。',
      '有多个机器人时，@你要使用的那个机器人。'
    ].join('\n');
    const commands = commandLines.length ? `常用命令：\n${commandLines.join('\n')}` : `发送 \`${trigger}/help\` 查看命令。`;
    const footer = `发送 \`${trigger}/help\` 查看全部命令与用法；明显拼错的控制命令会提示纠正，其他 CLI 命令和路径交给 Agent。`;
    const markdown = [intro, '', usage, '', commands, '', footer].join('\n');
    return {
      title: 'Dutydeck 机器人已入群',
      markdown,
      elements: [
        markdownElement('welcome_intro', `${intro}\n\n${usage}`),
        markdownElement('welcome_commands', commands),
        markdownElement('welcome_footer', footer)
      ]
    };
  }

  const intro = '我是 **Dutydeck**，直接给我发消息就是在派发任务：跑命令、查代码、读写文件都可以。';
  const commands = commandLines.length
    ? `常用命令：\n${commandLines.join('\n')}`
    : '发送 `/help` 可以查看当前能用的全部命令。';
  const footer = `${input.routing?.p2pMode === 'thread' ? '每条顶层消息发起新任务；继续任务请回原任务话题回复，/status 也请在原话题发送。' : '直接继续发消息会沿用当前上下文。'}\n发送 \`/help\` 查看全部命令与用法。`;
  const markdown = [intro, '', commands, '', footer].join('\n');
  return {
    title: '欢迎使用 Dutydeck',
    markdown,
    elements: [
      markdownElement('welcome_intro', intro),
      markdownElement('welcome_commands', commands),
      markdownElement('welcome_footer', footer)
    ]
  };
}

export interface CreateLarkWelcomeServiceOptions {
  appId: string;
  kv: WelcomeKv;
  /** 发送欢迎卡（由 listener 用 LarkCardService.send 适配），失败不得抛出。 */
  send: (chatId: string, content: WelcomeCardContent) => Promise<void>;
  capabilities?: LarkCommandCapabilities;
  log?: WelcomeLog;
  now?: () => Date;
  routing?: (chatId: string, chatType: 'group' | 'p2p') => Promise<WelcomeRouting>;
}

export interface LarkWelcomeService {
  /** bot 被拉入群：每个群只发一次群欢迎。 */
  welcomeBotAdded(chatId: string): Promise<void>;
  /** 私聊首条消息：每个私聊只发一次私聊欢迎。 */
  welcomeP2pChat(chatId: string): Promise<void>;
}

/**
 * 认领「已欢迎」标记。返回 true 表示本次调用完成了认领、应当发卡。
 */
async function claimWelcomed(kv: WelcomeKv, key: string, marker: string): Promise<boolean> {
  if (kv.compareAndSet) {
    try {
      return await kv.compareAndSet(key, undefined, marker);
    } catch {
      // 部分 kv 实现可能在键已存在时抛错而非返回 false，落到 get/set 兜底。
    }
  }
  if ((await kv.get(key)) !== undefined) return false;
  await kv.set(key, marker);
  return true;
}

export function createLarkWelcomeService(options: CreateLarkWelcomeServiceOptions): LarkWelcomeService {
  const deliver = async (chatId: string, chatType: 'group' | 'p2p') => {
    if (!chatId) return;
    const key = welcomedDedupeKey(options.appId, chatId);
    const marker = JSON.stringify({ at: (options.now ?? (() => new Date()))().toISOString() });
    let claimed = false;
    try {
      claimed = await claimWelcomed(options.kv, key, marker);
    } catch (error) {
      // kv 不可用时 fail-safe：宁可不欢迎也不能因此影响消息主链路。
      options.log?.warn({ error, appId: options.appId, chatId }, '读取飞书欢迎语去重标记失败，跳过本次欢迎');
      return;
    }
    if (!claimed) return;
    try {
      await options.send(chatId, buildWelcomeCardContent({ chatType, routing: await options.routing?.(chatId, chatType), ...(options.capabilities ? { capabilities: options.capabilities } : {}) }));
    } catch (error) {
      // 标记已认领：不重发；只留日志。消息 dispatch 不依赖本调用结果。
      options.log?.warn({ error, appId: options.appId, chatId }, '发送飞书欢迎卡失败，已记录欢迎标记不重发');
    }
  };
  return {
    welcomeBotAdded: chatId => deliver(chatId, 'group'),
    welcomeP2pChat: chatId => deliver(chatId, 'p2p')
  };
}
