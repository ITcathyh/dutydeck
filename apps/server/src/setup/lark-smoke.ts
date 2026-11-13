import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRepositories } from '@dutydeck/storage';
import type { StoredLarkConfig } from '@dutydeck/shared';
import { larkConfigBlockingError, readLarkConfig } from '../lark/config.js';
import { createLarkCardService } from '../lark/service.js';
import type { Prompter } from './prompts.js';
import { LarkSmokeCleanupError, startLarkSmokeListener } from './lark-smoke-listener.js';
import { daemonStatus, type DaemonStatusInfo } from '../daemon/command.js';

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
  /** Caller-verified owner for this app; the ou_ check below is only a shape check, not identity proof. */
  ownerOpenId?: string;
  interactive: boolean;
  assumeYes?: boolean;
  json?: boolean;
  prompter: Prompter;
  timeoutMs?: number;
}

interface RuntimeLease {
  close(): void;
}

interface LarkSetupSmokeDependencies {
  loadBot?: (database: string, appId: string) => Promise<StoredLarkConfig | undefined>;
  startListener?: (bot: StoredLarkConfig, onEvent: (event: LarkSmokeEvent) => void) => Promise<() => void | Promise<void>>;
  sendCard?: (bot: StoredLarkConfig, input: { uuid: string; ownerOpenId: string }) => Promise<{ messageId: string; chatId?: string }>;
  daemonStatus?: () => Pick<DaemonStatusInfo, 'processStatus'>;
  acquireRuntime?: (database: string) => RuntimeLease;
  uuid?: () => string;
}

async function loadSavedBot(database: string, appId: string): Promise<StoredLarkConfig | undefined> {
  if (!existsSync(database)) return undefined;
  const repositories = createRepositories(database);
  try { return await readLarkConfig(repositories.config, appId, { readOnly: true }); }
  finally { repositories.close(); }
}

function acquireRuntime(database: string): RuntimeLease {
  return createRepositories(database, { mode: 'runtime' });
}

type SmokeOwnerResolution = { ownerOpenId: string } | { failure: 'read' | 'not_dm_owner' };

async function readSmokeOwnerOpenId(bot: StoredLarkConfig): Promise<SmokeOwnerResolution> {
  const service = createLarkCardService(process.env, undefined, bot);
  try {
    const query = new URLSearchParams({ lang: 'zh_cn', user_id_type: 'open_id' });
    const payload = await service.callOpenApi(
      `/open-apis/application/v6/applications/${encodeURIComponent(bot.appId)}?${query}`,
      { method: 'GET' }
    );
    const app = payload?.data?.app;
    if (!app || typeof app !== 'object') return { failure: 'not_dm_owner' };
    if (app.app_id !== undefined && app.app_id !== bot.appId) return { failure: 'not_dm_owner' };
    const owner = app.owner;
    if (!owner || owner.type !== 2 || typeof owner.owner_id !== 'string') return { failure: 'not_dm_owner' };
    const ownerOpenId = owner.owner_id.trim();
    return ownerOpenId.startsWith('ou_') && ownerOpenId.length > 3 ? { ownerOpenId } : { failure: 'not_dm_owner' };
  } catch {
    return { failure: 'read' };
  } finally {
    service.close();
  }
}

async function sendSmokeCard(bot: StoredLarkConfig, input: { uuid: string; ownerOpenId: string }): Promise<{ messageId: string; chatId?: string }> {
  const service = createLarkCardService(process.env, undefined, bot);
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

const SERVICE_CONFLICT_MESSAGE = '同库服务正在运行或同库 runtime 占用无法获取；为避免分流正常消息，不启动临时监听、不发卡；停止同库服务后再试。';
const CLEANUP_CONFLICT_MESSAGE = '飞书临时监听无法确认已关闭；为避免同库服务分流，已保留 runtime 占用和本地接收端口。请检查网络并结束当前 setup 进程后再试。';

function daemonConflict(dependencies: LarkSetupSmokeDependencies): boolean {
  try { return (dependencies.daemonStatus ?? daemonStatus)().processStatus !== 'stale'; }
  catch { return true; }
}

function runtimeConflict(database: string, dependencies: LarkSetupSmokeDependencies): boolean {
  let runtime: RuntimeLease;
  try { runtime = (dependencies.acquireRuntime ?? acquireRuntime)(database); }
  catch { return true; }
  try { runtime.close(); }
  catch { return true; }
  return false;
}

function serviceConflict(options: LarkSetupSmokeOptions, dependencies: LarkSetupSmokeDependencies): boolean {
  return daemonConflict(dependencies) || runtimeConflict(options.database, dependencies);
}

/** The only outbound consent surface: an interactive, dedicated default-No question. */
export async function offerLarkSetupSmoke(
  options: LarkSetupSmokeOptions,
  dependencies: LarkSetupSmokeDependencies = {}
): Promise<LarkSetupSmokeResult> {
  if (!options.interactive || !options.prompter.interactive || options.assumeYes === true || options.json === true) {
    return { status: 'skipped', message: '未请求飞书收发验证，未发送测试卡。' };
  }
  if (serviceConflict(options, dependencies)) return { status: 'unavailable', message: SERVICE_CONFLICT_MESSAGE };
  let bot: StoredLarkConfig | undefined;
  try { bot = await (dependencies.loadBot ?? loadSavedBot)(options.database, options.appId); }
  catch { return { status: 'unavailable', message: '机器人配置读取失败，未提供收发验证，也未发送测试卡。' }; }
  if (!bot?.appSecret || larkConfigBlockingError(bot)) {
    return { status: 'unavailable', message: '机器人配置尚不可用于收发验证，未发送测试卡。' };
  }
  let ownerOpenId = options.ownerOpenId;
  let ownerReadFailure: 'read' | 'not_dm_owner' | undefined;
  if (ownerOpenId === undefined) {
    const resolved = await readSmokeOwnerOpenId(bot);
    if ('ownerOpenId' in resolved) ownerOpenId = resolved.ownerOpenId;
    else ownerReadFailure = resolved.failure;
  }
  if (!ownerOpenId?.startsWith('ou_')) {
    return {
      status: 'unavailable',
      message: options.ownerOpenId !== undefined
        ? '无法确认机器人所有者在该应用下的 open_id，未提供收发验证，也未发送测试卡。'
        : ownerReadFailure === 'read'
          ? `读取机器人应用信息失败，无法确认所有者；请重跑 dutydeck setup --lark-app-id ${options.appId}，在既有确认流程中开通并发布 application:application:self_manage 权限；网络错误也可修复后重试。未询问、未监听、未发送测试卡。`
          : '目标应用信息未返回可私聊的企业内成员所有者及其在该应用下匹配的 open_id，未询问、未监听、未发送测试卡。'
    };
  }
  const recipientOpenId = ownerOpenId;
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
  let runtime: RuntimeLease;
  try { runtime = (dependencies.acquireRuntime ?? acquireRuntime)(options.database); }
  catch { return { status: 'unavailable', message: SERVICE_CONFLICT_MESSAGE }; }

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
    if (settled || event.chatType !== 'p2p' || event.senderType !== 'user' || event.senderOpenId !== recipientOpenId) return;
    // A fast reply may arrive before send() resolves. Queue it, but accept nothing until the send is known successful.
    if (sending && !accepting) {
      if (queued.length < 100) queued.push(event);
      return;
    }
    processEvent(event);
  };

  let stop: (() => void | Promise<void>) | undefined;
  let retainRuntime = false;
  let timer: NodeJS.Timeout | undefined;
  try {
    try {
      stop = await (dependencies.startListener ?? startLarkSmokeListener)(bot, onEvent);
    } catch (error) {
      if (error instanceof LarkSmokeCleanupError) {
        retainRuntime = true;
        return { status: 'unavailable', message: CLEANUP_CONFLICT_MESSAGE };
      }
      return { status: 'unavailable', message: '飞书临时监听启动失败，未发送测试卡；入站未验证。' };
    }
    sending = true;
    try { sentMessage = await (dependencies.sendCard ?? sendSmokeCard)(bot, { uuid, ownerOpenId: recipientOpenId }); }
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
    try { if (stop) await stop(); }
    catch {
      retainRuntime = true;
      return { status: 'unavailable', message: CLEANUP_CONFLICT_MESSAGE };
    }
    finally { if (!retainRuntime) runtime.close(); }
  }
}
