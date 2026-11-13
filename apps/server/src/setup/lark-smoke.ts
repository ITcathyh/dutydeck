import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRepositories } from '@dutydeck/storage';
import type { StoredLarkConfig } from '@dutydeck/shared';
import { larkConfigBlockingError, readLarkConfig } from '../lark/config.js';
import { createLarkCardService } from '../lark/service.js';
import type { Prompter } from './prompts.js';
import { startLarkSmokeListener } from './lark-smoke-listener.js';

export interface LarkSmokeEvent {
  eventId?: string;
  messageId?: string;
  chatId?: string;
  chatType?: string;
  parentId?: string;
  rootId?: string;
  content?: string;
  senderOpenId?: string;
  senderType?: string;
}

export type LarkSetupSmokeStatus = 'skipped' | 'unavailable' | 'verified' | 'send_failed' | 'inbound_unverified';
export interface LarkSetupSmokeResult {
  status: LarkSetupSmokeStatus;
  message: string;
}

interface LarkSetupSmokeOptions {
  database: string;
  appId: string;
  ownerOpenId?: string;
  interactive: boolean;
  assumeYes?: boolean;
  json?: boolean;
  prompter: Prompter;
  timeoutMs?: number;
}

interface LarkSetupSmokeDependencies {
  loadBot?: (database: string, appId: string) => Promise<StoredLarkConfig | undefined>;
  startListener?: (bot: StoredLarkConfig, onEvent: (event: LarkSmokeEvent) => void) => Promise<() => void | Promise<void>>;
  sendCard?: (bot: StoredLarkConfig, input: { uuid: string; ownerOpenId: string }) => Promise<{ messageId: string; chatId?: string }>;
  uuid?: () => string;
}

async function loadSavedBot(database: string, appId: string): Promise<StoredLarkConfig | undefined> {
  if (!existsSync(database)) return undefined;
  const repositories = createRepositories(database);
  try { return await readLarkConfig(repositories.config, appId, { readOnly: true }); }
  finally { repositories.close(); }
}

async function sendSmokeCard(bot: StoredLarkConfig, input: { uuid: string; ownerOpenId: string }): Promise<{ messageId: string; chatId?: string }> {
  const service = createLarkCardService({}, undefined, bot);
  try {
    return await service.send({
      cardKind: 'result',
      state: 'completed',
      readOnly: true,
      retryable: false,
      taskName: 'Dutydeck 飞书收发验证',
      markdown: `请直接回复这张测试卡，完成一次入站验证。\n\n验证编号：\`${input.uuid}\``,
      receiveId: input.ownerOpenId,
      receiveIdType: 'open_id',
      idempotencyKey: input.uuid
    });
  } finally { service.close(); }
}

/** The only outbound consent surface: an interactive, dedicated default-No question. */
export async function offerLarkSetupSmoke(
  options: LarkSetupSmokeOptions,
  dependencies: LarkSetupSmokeDependencies = {}
): Promise<LarkSetupSmokeResult> {
  if (!options.interactive || !options.prompter.interactive || options.assumeYes === true || options.json === true) {
    return { status: 'skipped', message: '未请求飞书收发验证，未发送测试卡。' };
  }
  if (!options.ownerOpenId?.startsWith('ou_')) {
    return { status: 'unavailable', message: '无法确认机器人所有者在该应用下的 open_id，未提供收发验证，也未发送测试卡。' };
  }
  let bot: StoredLarkConfig | undefined;
  try { bot = await (dependencies.loadBot ?? loadSavedBot)(options.database, options.appId); }
  catch { return { status: 'unavailable', message: '机器人配置读取失败，未提供收发验证，也未发送测试卡。' }; }
  if (!bot?.appSecret || larkConfigBlockingError(bot)) {
    return { status: 'unavailable', message: '机器人配置尚不可用于收发验证，未发送测试卡。' };
  }
  let confirmed: boolean;
  try {
    confirmed = await options.prompter.confirm({
      question: '是否向机器人所有者发送测试卡并等待一次私聊回复？',
      dangerous: true,
      defaultValue: false
    });
  } catch {
    return { status: 'skipped', message: '已跳过飞书收发验证，未发送测试卡。' };
  }
  if (!confirmed) return { status: 'skipped', message: '已跳过飞书收发验证，未发送测试卡。' };

  const uuid = (dependencies.uuid ?? randomUUID)();
  const seenEvents = new Set<string>();
  const seenMessages = new Set<string>();
  let sending = false;
  let accepting = false;
  let settled = false;
  let sentMessage: { messageId: string; chatId?: string } | undefined;
  const queued: LarkSmokeEvent[] = [];
  let reply!: () => void;
  const replied = new Promise<void>(resolve => { reply = resolve; });
  const processEvent = (event: LarkSmokeEvent) => {
    if (!accepting || settled || !sentMessage) return;
    if (sentMessage.chatId && event.chatId !== sentMessage.chatId) return;
    const related = event.parentId === sentMessage.messageId || event.rootId === sentMessage.messageId || event.content?.includes(uuid) === true;
    if (!related) return;
    if (event.eventId && seenEvents.has(event.eventId)) return;
    if (event.messageId && seenMessages.has(event.messageId)) return;
    if (event.eventId) seenEvents.add(event.eventId);
    if (event.messageId) seenMessages.add(event.messageId);
    settled = true;
    reply();
  };
  const onEvent = (event: LarkSmokeEvent) => {
    if (settled || event.chatType !== 'p2p' || event.senderType !== 'user' || event.senderOpenId !== options.ownerOpenId) return;
    // A fast reply may arrive before send() resolves. Queue it, but accept nothing until the send is known successful.
    if (sending && !accepting) {
      if (queued.length < 100) queued.push(event);
      return;
    }
    processEvent(event);
  };

  let stop: (() => void | Promise<void>) | undefined;
  try {
    stop = await (dependencies.startListener ?? startLarkSmokeListener)(bot, onEvent);
  } catch {
    return { status: 'unavailable', message: '飞书临时监听启动失败，未发送测试卡；入站未验证。' };
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    sending = true;
    try { sentMessage = await (dependencies.sendCard ?? sendSmokeCard)(bot, { uuid, ownerOpenId: options.ownerOpenId }); }
    catch {
      return { status: 'send_failed', message: '测试卡发送失败或结果未确认；入站未验证。请用 dutydeck doctor 检查权限与网络。' };
    } finally { sending = false; }
    accepting = true;
    for (const event of queued.splice(0)) processEvent(event);
    if (settled) return { status: 'verified', message: '飞书端到端验证通过：测试卡已发送，并收到机器人所有者针对本次测试的私聊回复。' };
    const timeoutMs = options.timeoutMs ?? 60_000;
    const timedOut = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => { settled = true; resolve('timeout'); }, timeoutMs);
    });
    const outcome = await Promise.race([replied.then(() => 'replied' as const), timedOut]);
    if (outcome === 'replied') {
      return { status: 'verified', message: '飞书端到端验证通过：测试卡已发送，并收到机器人所有者针对本次测试的私聊回复。' };
    }
    return {
      status: 'inbound_unverified',
      message: `测试卡已发送，但 ${Math.ceil(timeoutMs / 1000)} 秒内未收到机器人所有者的私聊回复；入站未验证。`
    };
  } finally {
    sending = false;
    accepting = false;
    queued.length = 0;
    if (timer) clearTimeout(timer);
    await stop();
  }
}
