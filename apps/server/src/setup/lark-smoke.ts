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
  messageId?: string;
  chatType?: string;
  content?: string;
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
  interactive: boolean;
  assumeYes?: boolean;
  json?: boolean;
  prompter: Prompter;
  timeoutMs?: number;
  /** Called only after the temporary listener is ready and before inbound events are accepted. */
  onVerificationCode?: (uuid: string) => void;
}

interface RuntimeLease {
  close(): void;
}

interface LarkSetupSmokeDependencies {
  loadBot?: (database: string, appId: string) => Promise<StoredLarkConfig | undefined>;
  startListener?: (bot: StoredLarkConfig, onEvent: (event: LarkSmokeEvent) => void) => Promise<() => void | Promise<void>>;
  reply?: (bot: StoredLarkConfig, input: { messageId: string; uuid: string }) => Promise<{ messageId: string }>;
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

async function replySmokeMessage(bot: StoredLarkConfig, input: { messageId: string; uuid: string }): Promise<{ messageId: string }> {
  const service = createLarkCardService(process.env, undefined, bot);
  try {
    return await service.replyText({
      messageId: input.messageId,
      text: `Dutydeck 飞书收发验证验证码：${input.uuid}`,
      idempotencyKey: input.uuid
    });
  } finally { service.close(); }
}

const SERVICE_CONFLICT_MESSAGE = '同库服务正在运行或同库 runtime 占用无法获取；为避免分流正常消息，不启动临时监听、不发送消息；停止同库服务后再试。';
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
    return { status: 'skipped', message: '未请求飞书收发验证，未发送任何消息。' };
  }
  if (serviceConflict(options, dependencies)) return { status: 'unavailable', message: SERVICE_CONFLICT_MESSAGE };
  let bot: StoredLarkConfig | undefined;
  try { bot = await (dependencies.loadBot ?? loadSavedBot)(options.database, options.appId); }
  catch { return { status: 'unavailable', message: '机器人配置读取失败，未提供收发验证，也未发送任何消息。' }; }
  if (!bot?.appSecret || larkConfigBlockingError(bot)) {
    return { status: 'unavailable', message: '机器人配置尚不可用于收发验证，未发送任何消息。' };
  }
  let confirmed: boolean;
  try {
    confirmed = await options.prompter.confirm({
      question: '是否进行飞书收发验证？同意后请在飞书里私聊机器人发送终端显示的一次性验证码。',
      dangerous: true,
      defaultValue: false
    });
  } catch {
    return { status: 'skipped', message: '已跳过飞书收发验证，未发送任何消息。' };
  }
  if (!confirmed) return { status: 'skipped', message: '已跳过飞书收发验证，未发送任何消息。' };
  let runtime: RuntimeLease;
  try { runtime = (dependencies.acquireRuntime ?? acquireRuntime)(options.database); }
  catch { return { status: 'unavailable', message: SERVICE_CONFLICT_MESSAGE }; }

  const uuid = (dependencies.uuid ?? randomUUID)();
  let accepting = false;
  let settled = false;
  let stop: (() => void | Promise<void>) | undefined;
  let retainRuntime = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveOutcome!: (result: LarkSetupSmokeResult) => void;
  const outcome = new Promise<LarkSetupSmokeResult>(resolve => { resolveOutcome = resolve; });
  const onEvent = (event: LarkSmokeEvent) => {
    const messageId = event.messageId?.trim();
    if (!accepting || settled || event.chatType !== 'p2p' || event.senderType !== 'user'
      || !messageId || event.content?.includes(uuid) !== true) return;
    // Settle synchronously before the first reply: redelivered events and message IDs cannot reply twice.
    settled = true;
    accepting = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
    void (dependencies.reply ?? replySmokeMessage)(bot, { messageId, uuid }).then(
      () => resolveOutcome({
        status: 'verified',
        message: '飞书入站验证通过；出站已发送（飞书已接受回复），请在飞书确认收到同一验证码。'
      }),
      () => resolveOutcome({
        status: 'send_failed',
        message: '入站验证已通过；出站回复发送失败或结果未知，出站未验证。未另行发送主动消息。'
      })
    );
  };

  try {
    try {
      stop = await (dependencies.startListener ?? startLarkSmokeListener)(bot, onEvent);
    } catch (error) {
      if (error instanceof LarkSmokeCleanupError) {
        retainRuntime = true;
        return { status: 'unavailable', message: CLEANUP_CONFLICT_MESSAGE };
      }
      return { status: 'unavailable', message: '飞书临时监听启动失败，未发送任何消息；入站未验证。' };
    }
    options.onVerificationCode?.(uuid);
    const timeoutMs = options.timeoutMs ?? 60_000;
    timer = setTimeout(() => {
      settled = true;
      accepting = false;
      resolveOutcome({
        status: 'inbound_unverified',
        message: `${Math.ceil(timeoutMs / 1000)} 秒内未收到有效私聊（用户私聊且包含本次验证码）；入站未验证，未发送任何消息。`
      });
    }, timeoutMs);
    accepting = true;
    return await outcome;
  } finally {
    accepting = false;
    settled = true;
    if (timer) clearTimeout(timer);
    try { if (stop) await stop(); }
    catch {
      retainRuntime = true;
      return { status: 'unavailable', message: CLEANUP_CONFLICT_MESSAGE };
    }
    finally { if (!retainRuntime) runtime.close(); }
  }
}
