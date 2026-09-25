// 飞书卡片快照：把用户在飞书里看到的卡片逐字节钉住，拆分 coordinator.ts 前后必须一致。
//
// 链路尽量贴近线上：飞书 SDK 只替换长连接与事件分发（与 listener.test.ts 同一个替身），入站事件按
// im.message.receive_v1 / card.action.trigger 的真实字段形态构造，内容全部是合成的；之后走真实的
// LarkLongConnectionListener → LarkMessageCoordinator → DutydeckRuntime + SQLite，卡片经真实 LarkCardService
// 组装后发往内存里的飞书开放平台替身，这里截获消息创建与 PATCH 的请求体。
//
// 快照只在静止点取样：每条消息记创建时的请求体，再加上到这个静止点为止的最后一次 PATCH。中间帧受心跳与
// 并发时序影响，不进快照。临时目录、执行身份、随机编号、时间与耗时在序列化后统一换成占位符。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { RelayAskBroker } from '@dutydeck/relay';
import type { AgentConfig, AgentEvent, NormalizedDriverEvent, UsageLedgerEntry } from '@dutydeck/shared';
import { createRelayAskStore } from '../relay-ask-store.js';
import { UsageLedger } from '../usage-ledger.js';
import { larkBotsConfigKey, larkExecutionIdentity, type StoredLarkConfig } from './config.js';
import type { PersistedLarkCardTask } from './coordinator.js';
import { LarkLongConnectionListener } from './listener.js';
import { larkMemoryScope, LarkMemoryStore } from './memory.js';
import { LarkMemoryProjection } from './memory-view.js';

// 注册到 EventDispatcher 的处理函数，就是线上收到事件时调用的那一个。
const larkSdk = vi.hoisted(() => ({ handlers: {} as Record<string, (event: any) => unknown> }));
vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  EventDispatcher: class {
    register(registered: Record<string, (event: any) => unknown>) {
      Object.assign(larkSdk.handlers, registered);
      return this;
    }
  },
  WSClient: class {
    constructor(private readonly options: { onReady: () => void }) {}
    async start() { this.options.onReady(); }
    close() {}
  }
}));

const appId = 'cli_snapshot';
const chatId = 'oc_snapshot_group';
const rootId = 'om_snapshot_root';
const threadId = 'omt_snapshot_topic';
const tenantKey = 'tenant_snapshot';
const bot = { openId: 'ou_snapshot_bot', unionId: 'on_snapshot_bot', name: 'Dock' };
const alice = { openId: 'ou_snapshot_alice', unionId: 'on_snapshot_alice', userId: 'snapshot_alice', name: 'Alice' };
// 限流网关是模块级单例：放宽到本文件的请求不会排队；失败不重试，快照里不该出现重试。
const gateEnv = { LARK_API_QPS: '1000', LARK_API_BURST: '100000', LARK_API_RETRY_MAX_ATTEMPTS: '0' };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
};
const never = () => new Promise<never>(() => {});
const text = (value: string): NormalizedDriverEvent => ({ type: 'text', data: { text: value } });
const tool = (id: string, name: string, input: Record<string, unknown>): NormalizedDriverEvent => ({ type: 'tool_call', data: { id, name, input, status: 'running' } });
const toolDone = (id: string, name: string, output: string): NormalizedDriverEvent => ({ type: 'tool_result', data: { id, name, output, status: 'completed' } });

type FeishuMessage = { id: string; request: 'send' | 'reply'; anchor: string; body: Record<string, any> };

/** 内存里的飞书开放平台：只实现这条链路会调用的接口，其余请求记进 unexpected。 */
function fakeFeishu() {
  const messages: FeishuMessage[] = [];
  const patches = new Map<string, Record<string, any>>();
  const byUuid = new Map<string, string>();
  // 消息详情接口能回读的消息：入站消息、话题根、机器人自己发的消息。
  const known = new Map<string, Record<string, unknown>>();
  const unexpected: string[] = [];
  let requests = 0;
  let reactions = 0;
  const ok = (payload: Record<string, unknown>) => new Response(JSON.stringify({ code: 0, msg: 'success', ...payload }), { status: 200, headers: { 'content-type': 'application/json' } });
  const remember = (item: Record<string, unknown> & { message_id: string }) => known.set(item.message_id, item);
  remember({
    message_id: rootId, root_id: '', parent_id: '', thread_id: threadId, msg_type: 'text', create_time: '1767225600000', update_time: '1767225600000',
    deleted: false, updated: false, chat_id: chatId, sender: { id: alice.openId, id_type: 'open_id', sender_type: 'user', tenant_key: tenantKey },
    body: { content: JSON.stringify({ text: '登录页改版的讨论放在这个话题里' }) }, mentions: []
  });
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    requests++;
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const path = url.pathname;
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, any> : undefined;
    if (path === '/open-apis/auth/v3/tenant_access_token/internal/') return ok({ tenant_access_token: 't-snapshot', expire: 7200 });
    if (path === '/open-apis/bot/v3/info') return ok({ bot: { open_id: bot.openId, app_name: bot.name, activate_status: 2 } });
    if (path === '/open-apis/im/v1/images' && method === 'POST') return ok({ data: { image_key: 'img_snapshot_loading' } });
    const reply = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(path);
    if (method === 'POST' && body && (path === '/open-apis/im/v1/messages' || reply)) {
      // 飞书按 uuid 幂等：同一个 uuid 重发返回原消息，不产生新消息。
      const existing = body.uuid ? byUuid.get(body.uuid) : undefined;
      const id = existing ?? `om_msg_${messages.length + 1}`;
      if (!existing) {
        messages.push({ id, request: reply ? 'reply' : 'send', anchor: reply ? decodeURIComponent(reply[1]!) : String(body.receive_id), body });
        if (body.uuid) byUuid.set(body.uuid, id);
        remember({
          message_id: id, root_id: reply ? rootId : '', parent_id: reply ? decodeURIComponent(reply[1]!) : '', thread_id: reply && body.reply_in_thread ? threadId : '',
          msg_type: body.msg_type, create_time: String(Date.now()), update_time: String(Date.now()), deleted: false, updated: false, chat_id: chatId,
          sender: { id: appId, id_type: 'app_id', sender_type: 'app', tenant_key: tenantKey }, body: { content: body.content }, mentions: []
        });
      }
      return ok({ data: known.get(id) });
    }
    const message = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(path);
    if (message && method === 'PATCH' && body) {
      const id = decodeURIComponent(message[1]!);
      if (!messages.some(item => item.id === id)) unexpected.push(`PATCH 未知消息 ${id}`);
      patches.set(id, body);
      return ok({ data: {} });
    }
    if (message && method === 'GET') {
      const item = known.get(decodeURIComponent(message[1]!));
      return item ? ok({ data: { items: [item] } }) : new Response(JSON.stringify({ code: 230011, msg: 'message not found' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    if (/^\/open-apis\/im\/v1\/messages\/[^/]+\/reactions$/.test(path) && method === 'POST') {
      return ok({ data: { reaction_id: `reaction_snapshot_${++reactions}`, operator: { operator_id: appId, operator_type: 'app' }, reaction_type: { emoji_type: body?.reaction_type?.emoji_type } } });
    }
    if (/^\/open-apis\/im\/v1\/messages\/[^/]+\/reactions\/[^/]+$/.test(path) && method === 'DELETE') return ok({ data: {} });
    if (path === '/open-apis/im/v1/messages' && method === 'GET') return ok({ data: { items: [], has_more: false } });
    if (path === `/open-apis/im/v1/chats/${chatId}/members/list` && method === 'GET') {
      return ok({ data: { items: [{ member_id: alice.openId, member_id_type: 'open_id', name: alice.name, tenant_key: tenantKey }], has_more: false, member_total: 1 } });
    }
    if (path === `/open-apis/contact/v3/users/${alice.openId}` && method === 'GET') {
      return ok({ data: { user: { open_id: alice.openId, union_id: alice.unionId, user_id: alice.userId, name: alice.name, email: 'alice@example.com' } } });
    }
    if (path === '/open-apis/im/v1/pins' && method === 'GET') return ok({ data: { items: [], has_more: false } });
    unexpected.push(`${method} ${path}`);
    return ok({ data: {} });
  };
  /** 这条消息此刻在飞书里的样子：最后一次 PATCH，没有 PATCH 过就是创建时的内容。 */
  const latest = (id: string) => {
    const created = messages.find(item => item.id === id);
    if (!created) throw new Error(`飞书里没有消息 ${id}`);
    return JSON.parse(patches.get(id)?.content ?? created.body.content) as Record<string, unknown>;
  };
  return { messages, patches, unexpected, fetcher, remember, latest, get requests() { return requests; } };
}

/** 卡片上带回调的控件：显示文字与回调 value。 */
const callbacks = (node: unknown, out: Array<{ label?: string; value: Record<string, unknown> }> = []) => {
  if (Array.isArray(node)) for (const item of node) callbacks(item, out);
  else if (node && typeof node === 'object') {
    const item = node as Record<string, any>;
    for (const behavior of item.behaviors ?? []) if (behavior?.type === 'callback' && behavior.value) out.push({ label: item.text?.content, value: behavior.value });
    for (const value of Object.values(item)) if (value && typeof value === 'object') callbacks(value, out);
  }
  return out;
};

/**
 * 序列化后的占位替换。同一个随机值在整份快照里映射到同一个编号，按首次出现排序，
 * 所以「这张卡的按钮指向哪条审批」这类关联在快照里仍然看得出来。
 */
function normalize(serialized: string, root: string) {
  const ids = new Map<string, string>();
  const id = (value: string) => {
    if (!ids.has(value)) ids.set(value, `<id:${ids.size + 1}>`);
    return ids.get(value)!;
  };
  return serialized
    .split(root).join('<tmp>')
    .split(larkExecutionIdentity()).join('<执行身份>')
    .replace(/代码指纹 [0-9a-f]{12}/g, '代码指纹 <指纹>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, id)
    .replace(/(?<![0-9a-zA-Z])[0-9a-f]{16,}(?![0-9a-zA-Z])/g, id)
    .replace(/(?<=(?:^|[^0-9a-zA-Z])(?:mem|ign)_)[0-9a-f]{8}(?![0-9a-zA-Z])/g, id)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<时间>')
    .replace(/\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}（北京时间）/g, '<北京时间>')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, '<UTC 时间>')
    .replace(/(?<!\d)1\d{12}(?!\d)/g, '<毫秒时间戳>')
    .replace(/(已用时|用时|排队等待|已运行) \d+(?:m \d+s|m|s)/g, '$1 <耗时>');
}

/**
 * 一轮 Agent 执行的脚本。返回即本轮正常结束（驱动补发 completed），抛错即本轮失败；
 * 挂起的轮次只能被中断或服务重启切断。
 */
type Turn = (turn: {
  /** Agent 的工作目录。 */
  workspace: string;
  emit: (event: NormalizedDriverEvent) => void;
  /** 发出一条待审批请求，等到裁决：批准为 true，拒绝或超时为 false。 */
  permission: (id: string, title: string) => Promise<boolean>;
  /** 经 relay 向用户提问（与 Agent 调用 dutydeck ask 同一条路），等到回答。 */
  ask: (question: string) => Promise<string>;
}) => Promise<void>;

/** 本月早些时候本群的一笔用量。 */
const earlierUsage = (costUsd: number): UsageLedgerEntry => ({
  id: 'usage_snapshot_earlier', recordedAt: new Date().toISOString(), appId, chatId, sessionId: 'ses_snapshot_earlier', taskId: 'task_snapshot_earlier',
  attemptId: 'attempt_snapshot_earlier', category: 'explicit', origin: 'lark_group', agentId: 'mock', costUsd, costEstimated: false, dataStatus: 'reported'
});

const permissionOptions = [{ id: 'allow_once', label: '允许一次', kind: 'allow_once' }, { id: 'reject_once', label: '拒绝', kind: 'reject_once' }];

async function harness(options: { config?: Partial<StoredLarkConfig>; turns?: Turn[]; git?: boolean; memory?: boolean; steer?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-card-snapshots-'));
  // 状态库与记忆投影放在工作区外面：它们一直在写，放进工作区会让验证的代码指纹对不上。
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  if (options.git) {
    const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(workspace, 'README.md'), 'baseline\n');
    git('add', '.');
    git('-c', 'user.email=snapshot@example.com', '-c', 'user.name=Dutydeck Snapshot', 'commit', '-qm', 'baseline');
  }
  const feishu = fakeFeishu();
  const turns = [...options.turns ?? []];
  const prompts: string[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config: StoredLarkConfig = {
    appId, appSecret: 'snapshot-secret', name: bot.name, workspace, webBaseUrl: 'https://dutydeck.example.com', defaultAgentId: 'mock',
    permissionMode: 'ask', fullTrustConfirmed: true, listening: true, preInjectPrompt: '',
    structuredAskCards: true, groupCardMention: true, groupToolsEnabled: false, groupToolsAllowSend: false,
    pushIntervalMs: 20_000, hideTraceOnComplete: false,
    allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: false,
    highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: 'dangerous', riskControlMode: 'off',
    ...options.config
  };
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: workspace, env: {},
    permissionMode: 'ask', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };

  /** 在同一个状态库上起一套服务；重启时飞书那一侧（消息、卡片）原样保留。 */
  const boot = async (first: boolean) => {
    for (const key of Object.keys(larkSdk.handlers)) delete larkSdk.handlers[key];
    const repos = createRepositories(join(root, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
    if (first) await repos.config.set(larkBotsConfigKey, JSON.stringify([config]));
    const ledger = new UsageLedger({ repositories: repos });
    let broker!: RelayAskBroker;
    const runtime = new DutydeckRuntime(repos, {
      driverIdleTimeoutMs: 0,
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      admitTask: (session, request) => ledger.admit(session, request),
      recordUsage: (session, attempt, reading) => ledger.record(session, attempt, reading),
      driverFactory: (_agent, _protocol, emit, _exit, sessionId) => {
        const permissions = new Map<string, { title: string; decide: (approved: boolean) => void }>();
        let abort: (() => void) | undefined;
        // 中断：待决审批按拒绝收口，本轮以 cancelled 结束。重启：只放开 send，本轮没有结果。
        const cut = (cancelled: boolean) => {
          if (cancelled) {
            for (const [id, pending] of permissions) emit({ type: 'permission_request', data: { id, title: pending.title, status: 'rejected', options: permissionOptions } });
            permissions.clear();
            emit({ type: 'completed', data: { stopReason: 'cancelled' } });
          }
          abort?.();
          abort = undefined;
        };
        const driver: AgentDriver = {
          start: async () => {}, resume: async () => {}, isStopped: async () => true,
          stop: async () => cut(false),
          interrupt: async () => cut(true),
          send: async input => {
            const prompt = typeof input === 'string' ? input : input.prompt;
            prompts.push(prompt);
            const turn = turns.shift() ?? (async ({ emit: send }) => { send(text('工作已完成。')); });
            const aborted = new Promise<'aborted'>(resolve => { abort = () => resolve('aborted'); });
            const outcome = await Promise.race([turn({
              workspace, emit,
              permission: (id, title) => new Promise<boolean>(decide => {
                permissions.set(id, { title, decide });
                emit({ type: 'permission_request', data: { id, title, status: 'pending', options: permissionOptions } });
              }),
              ask: async question => {
                const outcome = await broker.register({ sessionId, question });
                return outcome.status === 'answered' ? outcome.answer : `（${outcome.status}）`;
              }
            }).then(() => 'done' as const), aborted]);
            abort = undefined;
            if (outcome === 'done') emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          },
          resolvePermission: async (id, approved) => {
            const pending = permissions.get(id);
            if (!pending) return false;
            permissions.delete(id);
            emit({ type: 'permission_request', data: { id, title: pending.title, status: approved ? 'approved' : 'rejected', options: permissionOptions } });
            pending.decide(approved);
            return true;
          },
          ...(options.steer ? { steer: async () => 'injected' as const } : {})
        };
        return driver;
      }
    });
    broker = new RelayAskBroker({ publish: async (sessionId, input) => {
      await runtime.publishSessionEvent(sessionId, 'text', { text: input.text, relay: input.kind, askId: input.askId });
    } }, createRelayAskStore(repos.config));
    await broker.initialize();
    await runtime.initialize([agent]);
    const memoryStore = options.memory ? new LarkMemoryStore(repos.config) : undefined;
    const listener = new LarkLongConnectionListener(log, {
      fetcher: feishu.fetcher as typeof fetch, env: gateEnv, runtime, cardMappings: repos.channelMappings, workflowStore: repos.config,
      relayBroker: broker, usage: ledger, chatModeResolver: async () => 'group',
      ...(memoryStore ? { memory: { store: memoryStore, projection: new LarkMemoryProjection(memoryStore, join(root, 'memory'), log), command: 'dutydeck' } } : {})
    });
    await listener.start(config);
    // 与服务关闭同一组动作：停飞书监听、关提问通道、停运行时、关库。
    const close = async () => {
      listener.stop();
      broker.close();
      await runtime.shutdown();
      await broker.flush().catch(() => undefined);
      repos.close();
    };
    return { repos, runtime, ledger, listener, memoryStore, close };
  };
  let current = await boot(true);
  cleanups.push(async () => { await current.close(); await rm(root, { recursive: true, force: true }); });
  const restart = async () => { await current.close(); current = await boot(false); };

  const until = (check: () => unknown, timeout = 20_000) => vi.waitFor(async () => {
    if (!await check()) throw new Error('条件未满足');
  }, { timeout, interval: 25 });
  /** 飞书那一侧连续一段时间没有新请求：这一步引起的卡片发送与 PATCH 都已落定。 */
  const settle = async () => {
    for (let seen = -1; seen !== feishu.requests;) { seen = feishu.requests; await pause(400); }
  };
  const textOf = (messageId: string) => JSON.stringify(feishu.latest(messageId));
  const findMessage = (needle: string) => feishu.messages.find(item => textOf(item.id).includes(needle))?.id;
  const persisted = async (taskId: string) => {
    const mapping = await current.repos.channelMappings.get(`lark-card:${appId}`, taskId);
    return mapping?.extra ? JSON.parse(mapping.extra) as PersistedLarkCardTask : undefined;
  };
  /** 这条请求的结果卡已发出：终态 PATCH 在结果卡之前，所以过程卡也已冻结。 */
  const delivered = async (taskId: string) => {
    await until(async () => (await persisted(taskId))?.final_message_id);
    await settle();
  };
  /** 运行时已记下这一类事件：运行时会给工具调用换上自己的编号，所以按内容认。 */
  const agentEvent = (type: AgentEvent['type'], marker: string) => until(async () => {
    for (const session of await current.runtime.listSessions()) {
      if ((await current.runtime.getEvents(session.id)).some(event => event.type === type && JSON.stringify(event.data).includes(marker))) return true;
    }
    return false;
  });

  const timeline: unknown[] = [];
  let inbound = 0;
  /** Alice 在话题里 @ 机器人发一条文字消息。 */
  const say = (words: string) => {
    const messageId = `om_in_${++inbound}`;
    const now = String(Date.now());
    const message = {
      message_id: messageId, root_id: rootId, parent_id: rootId, create_time: now, update_time: now, chat_id: chatId, thread_id: threadId,
      chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: `@_user_1 ${words}` }),
      mentions: [{ key: '@_user_1', id: { union_id: bot.unionId, open_id: bot.openId }, name: bot.name, tenant_key: tenantKey }]
    };
    feishu.remember({
      message_id: messageId, root_id: rootId, parent_id: rootId, thread_id: threadId, msg_type: 'text', create_time: now, update_time: now,
      deleted: false, updated: false, chat_id: chatId, sender: { id: alice.openId, id_type: 'open_id', sender_type: 'user', tenant_key: tenantKey },
      body: { content: message.content }, mentions: [{ key: '@_user_1', id: bot.openId, id_type: 'open_id', name: bot.name, tenant_key: tenantKey }]
    });
    timeline.push({ say: words, message: messageId });
    void larkSdk.handlers['im.message.receive_v1']!({
      schema: '2.0', event_id: `evt_snapshot_message_${inbound}`, token: '', create_time: now, event_type: 'im.message.receive_v1', tenant_key: tenantKey, app_id: appId,
      sender: { sender_id: { union_id: alice.unionId, user_id: alice.userId, open_id: alice.openId }, sender_type: 'user', tenant_key: tenantKey },
      message
    });
    return messageId;
  };
  const button = (messageId: string, match: string | ((value: Record<string, unknown>) => boolean)) => {
    const found = callbacks(feishu.latest(messageId)).find(item => typeof match === 'string' ? item.label === match : match(item.value));
    if (!found) throw new Error(`消息 ${messageId} 上没有这个按钮，现有：${callbacks(feishu.latest(messageId)).map(item => item.label).join('、')}`);
    return found;
  };
  let actions = 0;
  /** Alice 点卡片上的按钮；表单提交时平台把填写的值放在 form_value。 */
  const click = async (messageId: string, match: string | ((value: Record<string, unknown>) => boolean), options: { formValue?: Record<string, unknown>; record?: boolean } = {}) => {
    const { label, value } = button(messageId, match);
    actions++;
    const result = await larkSdk.handlers['card.action.trigger']!({
      schema: '2.0', event_id: `evt_snapshot_card_${actions}`, token: `c-snapshot-${actions}`, create_time: String(Date.now() * 1000),
      event_type: 'card.action.trigger', tenant_key: tenantKey, app_id: appId,
      operator: { tenant_key: tenantKey, user_id: alice.userId, open_id: alice.openId, union_id: alice.unionId },
      action: { value, tag: 'button', ...(options.formValue ? { form_value: options.formValue } : {}) },
      host: 'im_message', context: { open_message_id: messageId, open_chat_id: chatId }
    }) as { toast?: unknown } | undefined;
    if (options.record !== false) timeline.push({ click: label, message: messageId, ...(options.formValue ? { form_value: options.formValue } : {}), toast: result?.toast });
    return result?.toast;
  };
  /** 心跳间隔拉满，执行中的卡靠点「刷新」重绘到当前状态，取样不依赖心跳时机。 */
  const refresh = async (taskId: string) => {
    await settle();
    const cardId = (await persisted(taskId))?.card_message_id;
    expect(cardId).toBeTruthy();
    expect(await click(cardId!, '刷新', { record: false })).toMatchObject({ type: 'success' });
    await settle();
  };
  const emitted = new Map<string, string>();
  /** 静止点：新消息记创建请求体与最后一次 PATCH；已记过的消息只在内容变了时记最后一次 PATCH。 */
  const checkpoint = (name: string) => {
    const requests: unknown[] = [];
    for (const message of feishu.messages) {
      const created = JSON.stringify(JSON.parse(message.body.content));
      if (!emitted.has(message.id)) {
        requests.push({
          message: message.id, request: message.request, anchor: message.anchor,
          ...(message.body.reply_in_thread ? { reply_in_thread: true } : {}), msg_type: message.body.msg_type,
          ...(message.body.uuid ? { uuid: message.body.uuid } : {}), content: JSON.parse(message.body.content)
        });
        emitted.set(message.id, created);
      }
      const patched = feishu.patches.get(message.id);
      if (patched && JSON.stringify(JSON.parse(patched.content)) !== emitted.get(message.id)) {
        requests.push({ message: message.id, request: 'patch', content: JSON.parse(patched.content) });
        emitted.set(message.id, JSON.stringify(JSON.parse(patched.content)));
      }
    }
    timeline.push({ checkpoint: name, requests });
  };
  const snapshot = async (name: string) => {
    expect(feishu.unexpected).toEqual([]);
    await expect(`${normalize(JSON.stringify(timeline, null, 2), root)}\n`).toMatchFileSnapshot(`./__snapshots__/card-snapshots/${name}.json`);
  };
  return {
    config, feishu, prompts, restart, until, settle, textOf, findMessage, persisted, delivered, agentEvent,
    say, click, refresh, checkpoint, snapshot,
    get repos() { return current.repos; }, get runtime() { return current.runtime; }, get ledger() { return current.ledger; },
    get listener() { return current.listener; }, get memoryStore() { return current.memoryStore; }
  };
}

describe('飞书卡片快照（入站事件驱动真实链路）', () => {
  it('执行中卡片与运行完成的结果卡', async () => {
    const edit = deferred();
    const h = await harness({ turns: [async ({ emit }) => {
      emit(text('先看一下登录页现在的错误提示。'));
      emit(tool('call_read', 'Read', { file_path: 'src/login/errors.ts' }));
      emit(toolDone('call_read', 'Read', 'export const messages = { invalid: "Invalid password" };'));
      emit(tool('call_edit', 'Edit', { file_path: 'src/login/errors.ts', old_string: 'Invalid password', new_string: '密码错误' }));
      await edit.wait;
      emit(toolDone('call_edit', 'Edit', 'ok'));
      emit(text('已把登录页的错误提示改成中文：密码错误时显示「密码错误」。'));
    }] });
    const task = h.say('把登录页的错误提示改成中文');
    await h.agentEvent('tool_call', '密码错误');
    await h.refresh(task);
    h.checkpoint('执行中');
    edit.release();
    await h.delivered(task);
    h.checkpoint('运行完成');
    await h.snapshot('running-and-completed');
  }, 60_000);

  it('执行失败的结果卡', async () => {
    const h = await harness({ turns: [async ({ emit }) => {
      emit(text('开始检查发布流水线。'));
      emit({ type: 'error', data: { message: '模型服务返回 529：当前负载过高，请稍后重试' } });
    }] });
    const task = h.say('看一下今天的发布流水线为什么卡住了');
    await h.delivered(task);
    h.checkpoint('执行失败');
    await h.snapshot('failed');
  }, 60_000);

  it('点「中断」后的结果卡', async () => {
    const h = await harness({ turns: [async ({ emit }) => {
      emit(text('开始排查今天的告警。'));
      emit(tool('call_logs', 'Bash', { command: 'tail -n 200 logs/alert.log', description: 'Read alert log' }));
      await never();
    }] });
    const task = h.say('排查一下今天的告警');
    await h.agentEvent('tool_call', 'logs/alert.log');
    await h.refresh(task);
    h.checkpoint('执行中');
    await h.click((await h.persisted(task))!.card_message_id!, '中断');
    await h.delivered(task);
    h.checkpoint('已中断');
    await h.snapshot('interrupted');
  }, 60_000);

  it('重启切断、执行过 git push 的一轮：结果未知并给「重新执行」「放弃」，点放弃', async () => {
    const h = await harness({ turns: [async ({ emit }) => {
      emit(text('先把修复推到远端。'));
      emit(tool('call_push', 'Bash', { command: 'git push origin main', description: 'Push fix' }));
      await never();
    }] });
    const task = h.say('把登录修复推上去');
    await h.agentEvent('tool_call', 'git push origin main');
    await h.settle();
    await h.restart();
    const cardId = (await h.persisted(task))!.card_message_id!;
    await h.until(() => h.textOf(cardId).includes('结果未知'));
    await h.settle();
    h.checkpoint('重启后结果未知');
    await h.click(cardId, '放弃');
    await h.until(() => h.textOf(cardId).includes('已放弃'));
    await h.settle();
    h.checkpoint('放弃后');
    expect(h.prompts).toHaveLength(1);
    await h.snapshot('restart-result-unknown');
  }, 60_000);

  it('等待审批时后续消息排队，/status 给出拒绝入口，从状态卡拒绝审批', async () => {
    const h = await harness({ turns: [
      async ({ emit, permission }) => {
        emit(text('要改一下 config/app.yaml 里的超时配置。'));
        const approved = await permission('perm_config', '修改 config/app.yaml');
        emit(text(approved ? '已把请求超时改成 30 秒。' : '审批被拒绝，没有修改 config/app.yaml。'));
      },
      async ({ emit }) => { emit(text('补了一条超时配置的单元测试。')); }
    ] });
    await h.repos.usage.append(earlierUsage(0.35));
    const first = h.say('把请求超时改成 30 秒');
    await h.until(() => h.findMessage('确认本次操作'));
    await h.settle();
    const second = h.say('顺便补一条单元测试');
    await h.until(async () => (await h.persisted(second))?.runtime_task_id);
    await h.refresh(first);
    h.checkpoint('等待审批且有排队');
    h.say('/status');
    // 现状：状态卡带「拒绝这条审批」按钮时，buildLarkCard 用 elements 取代 markdown，
    // 状态正文（含被审批阻塞、本月用量）不会出现在发往飞书的卡片里。快照按现状记录。
    await h.until(() => h.findMessage('拒绝这条审批'));
    await h.settle();
    h.checkpoint('/status');
    await h.click(h.findMessage('拒绝这条审批')!, '拒绝这条审批');
    await h.delivered(first);
    await h.delivered(second);
    h.checkpoint('拒绝审批后');
    await h.snapshot('approval-queue-status');
  }, 60_000);

  it('审批超过截止时间：审批卡改成已过期，任务按拒绝继续', async () => {
    const h = await harness({ turns: [async ({ emit, permission }) => {
      emit(text('需要删除旧的构建缓存目录。'));
      const approved = await permission('perm_cache', '删除 build/cache 目录');
      emit(text(approved ? '已删除构建缓存。' : '审批没有通过，保留了构建缓存目录。'));
    }] });
    const task = h.say('清理一下构建缓存');
    await h.until(() => h.findMessage('确认本次操作'));
    await h.refresh(task);
    h.checkpoint('等待审批');
    const approvalCard = h.findMessage('确认本次操作')!;
    // 审批时限 30 分钟：把时钟拨到 31 分钟后，再让监听按同一份配置重新对账（与配置刷新走同一条路）。
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + 31 * 60_000);
    try {
      await h.listener.start(h.config);
      await h.until(() => h.textOf(approvalCard).includes('已过期'));
    } finally { clock.mockRestore(); }
    await h.delivered(task);
    h.checkpoint('审批过期');
    await h.snapshot('approval-expired');
  }, 60_000);

  it('提问卡：问题里的 Markdown 链接保留为链接，表单提交回答', async () => {
    const h = await harness({ turns: [async ({ emit, ask }) => {
      emit(text('发布前需要跟你确认一件事。'));
      const answer = await ask('部署前请先看 [发布手册](https://docs.example.com/release#window) 第 3 节。今晚 22:00 的发布窗口可以用吗？');
      emit(text(`收到回答「${answer}」，按今晚 22:00 的窗口发布。`));
    }] });
    const task = h.say('今晚把登录修复发布上线');
    await h.until(() => h.findMessage('提交回答'));
    await h.refresh(task);
    h.checkpoint('等待回答');
    await h.click(h.findMessage('提交回答')!, '提交回答', { formValue: { answer: '可以，按手册第 3 节执行' } });
    await h.delivered(task);
    h.checkpoint('回答后');
    await h.snapshot('ask-markdown-link');
  }, 60_000);

  it('自动验证通过', async () => {
    const h = await harness({ git: true, config: { verificationCommand: 'test -f work.txt' }, turns: [async ({ workspace, emit }) => {
      writeFileSync(join(workspace, 'work.txt'), 'done\n');
      emit(text('已新增 work.txt。'));
    }] });
    const task = h.say('加一个 work.txt');
    await h.delivered(task);
    const resultCard = (await h.persisted(task))!.final_message_id!;
    await h.until(() => h.textOf(resultCard).includes('验证通过'));
    await h.settle();
    h.checkpoint('验证通过');
    await h.snapshot('verification-passed');
  }, 60_000);

  it('自动验证未通过：返修一轮后通过', async () => {
    const h = await harness({ git: true, config: { verificationCommand: 'test -f fixed.txt || { echo "缺少 fixed.txt"; exit 1; }' }, turns: [
      async ({ workspace, emit }) => { writeFileSync(join(workspace, 'work.txt'), 'round 1\n'); emit(text('第一轮改好了。')); },
      async ({ workspace, emit }) => { writeFileSync(join(workspace, 'fixed.txt'), 'round 2\n'); emit(text('补上了 fixed.txt。')); }
    ] });
    const task = h.say('把登录逻辑修一下');
    await h.delivered(task);
    await h.until(() => h.prompts.length === 2);
    await h.until(() => h.feishu.messages.filter(item => h.textOf(item.id).includes('验证通过')).length === 1);
    await h.settle();
    h.checkpoint('返修后验证通过');
    await h.snapshot('verification-failed-repaired');
  }, 60_000);

  it('自动验证执行中服务重启：验证被中断', async () => {
    const h = await harness({ git: true, config: { verificationCommand: 'sleep 20' }, turns: [async ({ workspace, emit }) => {
      writeFileSync(join(workspace, 'work.txt'), 'done\n');
      emit(text('已新增 work.txt。'));
    }] });
    const task = h.say('加一个 work.txt');
    await h.delivered(task);
    const resultCard = (await h.persisted(task))!.final_message_id!;
    await h.until(() => h.textOf(resultCard).includes('验证执行中'));
    await h.until(async () => {
      for (const session of await h.runtime.listSessions()) if ((await h.runtime.getVerifications(session.id))[0]?.status === 'running') return true;
      return false;
    });
    await h.settle();
    h.checkpoint('验证执行中');
    await h.restart();
    await h.until(() => h.textOf(resultCard).includes('验证被中断'));
    await h.settle();
    h.checkpoint('重启后验证被中断');
    await h.snapshot('verification-interrupted');
  }, 60_000);

  it('结果卡的本轮记忆区：列出注入的记忆，点删除后重绘', async () => {
    const h = await harness({ memory: true });
    const pool = larkMemoryScope(appId, chatId, 'group');
    await h.memoryStore!.add(pool, { content: '回复统一用中文', source: 'user', chatId });
    await h.memoryStore!.add(pool, { content: '先给一句话结论', source: 'user', chatId });
    const task = h.say('总结一下这周的发布情况');
    await h.delivered(task);
    h.checkpoint('本轮记忆');
    const resultCard = (await h.persisted(task))!.final_message_id!;
    const before = h.textOf(resultCard);
    await h.click(resultCard, value => typeof value.dutydeck_memory_forget === 'string');
    await h.until(() => h.textOf(resultCard) !== before);
    await h.settle();
    h.checkpoint('删除一条记忆后');
    await h.snapshot('turn-memory');
  }, 60_000);

  it('/steer 插话送进正在执行的这一轮', async () => {
    const finish = deferred();
    const h = await harness({ steer: true, turns: [async ({ emit }) => {
      emit(text('正在整理本周的报警。'));
      await finish.wait;
      emit(text('本周报警整理完成，按插话只列了 P0 级别。'));
    }] });
    const first = h.say('整理本周报警');
    await h.until(() => h.prompts.length === 1);
    const steer = h.say('/steer 只看 P0 级别的报警');
    await h.delivered(steer);
    await h.refresh(first);
    h.checkpoint('插话送达');
    finish.release();
    await h.delivered(first);
    h.checkpoint('原任务完成');
    expect(h.prompts).toHaveLength(1);
    await h.snapshot('steer-injected');
  }, 60_000);

  it('本群月度成本用满：新任务在派发前被拒绝，/status 显示本月用量', async () => {
    const h = await harness();
    await h.ledger.setCap({ scope: 'group', appId, chatId, monthlyCostUsd: 1 });
    await h.repos.usage.append(earlierUsage(1.5));
    h.say('再跑一次登录回归');
    await h.until(() => h.findMessage('本群本月成本已达上限'));
    await h.settle();
    h.checkpoint('月度上限拒绝');
    h.say('/status');
    await h.until(() => h.findMessage('本月用量'));
    await h.settle();
    h.checkpoint('/status');
    expect(h.prompts).toHaveLength(0);
    await h.snapshot('usage-cap');
  }, 60_000);
});
