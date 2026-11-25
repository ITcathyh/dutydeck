import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../../service/main.mjs';

export const APP = 'cli_testapp';
export const CHAT = 'oc_dispatch';
export const BOSS = 'ou_boss';
export const OTHER = 'ou_intruder';
export const TOKEN = 'handler-bearer-secret';

const FIXTURE = resolve(fileURLToPath(new URL('.', import.meta.url)), '../fixtures/fake-pairfob.mjs');

export function apiMessage(m: Record<string, any>) {
  return {
    message_id: m.messageId,
    chat_id: m.chatId ?? CHAT,
    thread_id: m.threadId,
    root_id: m.rootId,
    parent_id: m.parentId,
    upper_message_id: m.upperMessageId,
    msg_type: m.messageType ?? 'text',
    create_time: m.createTime ?? '1764000000000',
    body: { content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? { text: m.text ?? '' }) },
    ...(m.rawExtra ?? {}),
  };
}

export interface FakeLark {
  baseUrl: string;
  messages: Map<string, any>;
  replies: any[];
  requests: any[];
  failReplies: number;
  server: Server;
  close: () => Promise<void>;
}

export async function startFakeLark(): Promise<FakeLark> {
  const state: FakeLark = {
    baseUrl: '', messages: new Map(), replies: [], requests: [], failReplies: 0, server: null as unknown as Server,
    close: async () => {},
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const bodyRaw = Buffer.concat(chunks).toString('utf8');
      const body = bodyRaw ? JSON.parse(bodyRaw) : {};
      state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      const json = (code: number, value: any) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };

      if (req.method === 'POST' && url.pathname.endsWith('/auth/v3/tenant_access_token/internal/')) {
        return json(200, { code: 0, tenant_access_token: 't-fake', expire: 7200 });
      }

      const msgMatch = url.pathname.match(/\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/);
      if (req.method === 'POST' && msgMatch) {
        if (state.failReplies > 0) { state.failReplies -= 1; return json(500, { code: 500, msg: 'synthetic 500' }); }
        let parsed: any = {};
        try { parsed = JSON.parse(body.content ?? '{}'); } catch { parsed = { text: body.content }; }
        const reply = { to: decodeURIComponent(msgMatch[1]), uuid: body.uuid, inThread: body.reply_in_thread, text: parsed.text ?? '', at: Date.now() };
        state.replies.push(reply);
        return json(200, { code: 0, data: { message_id: `om_reply_${state.replies.length}` } });
      }

      const oneMatch = url.pathname.match(/\/open-apis\/im\/v1\/messages\/([^/]+)$/);
      if (req.method === 'GET' && oneMatch) {
        const id = decodeURIComponent(oneMatch[1]);
        const target = state.messages.get(id);
        if (!target) return json(200, { code: 230002, msg: 'not found' });
        let items = [target];
        if (target.msg_type === 'merge_forward') {
          const children = [...state.messages.values()].filter((m) => m.upper_message_id === id);
          items = [target, ...children];
        }
        return json(200, { code: 0, data: { items } });
      }

      if (req.method === 'GET' && url.pathname.endsWith('/open-apis/im/v1/messages')) {
        const type = url.searchParams.get('container_id_type');
        const container = url.searchParams.get('container_id');
        let items = [...state.messages.values()];
        if (type === 'thread') items = items.filter((m) => m.thread_id === container);
        else if (type === 'chat') items = items.filter((m) => m.chat_id === container);
        return json(200, { code: 0, data: { items, has_more: false } });
      }

      json(404, { code: 404, msg: `unhandled ${req.method} ${url.pathname}` });
    })().catch((error) => { res.writeHead(500); res.end(String(error)); });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  state.baseUrl = `http://127.0.0.1:${port}`;
  state.server = server;
  state.close = async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return state;
}

let seq = 0;
export function makeEnvelope(o: Record<string, any> = {}) {
  seq += 1;
  const eventId = o.eventId ?? `ev_${seq}`;
  const messageId = o.messageId ?? `om_cmd_${seq}`;
  const text = o.text ?? '/job rovetap 修复草稿丢失';
  const message: Record<string, any> = {
    message_id: messageId,
    chat_id: o.chatId ?? CHAT,
    chat_type: o.chatType ?? 'group',
    message_type: o.messageType ?? 'text',
    content: o.content ?? JSON.stringify({ text }),
    ...(o.threadId !== undefined ? { thread_id: o.threadId } : {}),
    ...(o.rootId !== undefined ? { root_id: o.rootId } : {}),
    ...(o.parentId !== undefined ? { parent_id: o.parentId } : {}),
    ...(o.mentions !== undefined ? { mentions: o.mentions } : {}),
  };
  return {
    version: 1, app_id: o.outerAppId ?? APP, handler_id: 'h1', event_type: 'im.message.receive_v1',
    event: {
      event_id: eventId, event_type: 'im.message.receive_v1', app_id: APP,
      sender: { sender_type: o.senderType ?? 'user', sender_id: { open_id: o.openId ?? BOSS } },
      message,
    },
  };
}

export async function waitFor(predicate: () => unknown | Promise<unknown>, opts: { timeout?: number; interval?: number; label?: string } = {}) {
  const timeout = opts.timeout ?? 5_000;
  const interval = opts.interval ?? 10;
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeout) {
    try { if (await predicate()) return; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor 超时：${opts.label ?? ''} ${last instanceof Error ? last.message : ''}`);
}

export interface Harness {
  dir: string; config: any; svc: any; lark: FakeLark; hubPath: string;
  post: (envelope?: any, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
  hub: () => any;
  updateHub: (fn: (hub: any) => void) => void;
  cleanup: () => Promise<void>;
}

export async function setupHarness(opts: { mode?: string; config?: Record<string, any> } = {}): Promise<Harness> {
  await chmod(FIXTURE, 0o755).catch(() => {});
  const dir = await mkdtemp(join(tmpdir(), 'rvj-test-'));
  const hubPath = join(dir, 'hub.json');
  const fakeEnv = { FAKE_PAIRFOB_HUB: hubPath, FAKE_PAIRFOB_MODE: opts.mode ?? 'ok' };
  const tokenFile = join(dir, 'project.token');
  await writeFile(tokenFile, 'fake-project-token\n', { mode: 0o600 });

  const lark = await startFakeLark();
  const config: any = {
    dataDir: dir,
    appId: APP,
    selfOpenId: 'ou_bot',
    handlerToken: TOKEN,
    allowedChatIds: new Set([CHAT]),
    commanderOpenIds: new Set([BOSS]),
    projectAliases: new Set(['rovetap']),
    webBaseUrl: 'https://rove.example.com',
    listen: { host: '127.0.0.1', port: 0, path: '/lark/events' },
    lark: { appId: APP, appSecret: 'secret', baseUrl: lark.baseUrl, timeoutMs: 4_000 },
    reply: { mode: 'lark-api', dutydeckBin: 'dutydeck', database: '', app: APP, timeoutMs: 4_000 },
    pairfob: { bin: FIXTURE, project: 'rovetap', socket: join(dir, 'hub.sock'), tokenFile, timeoutMs: 4_000, env: fakeEnv },
    limits: { maxInstructionChars: 4_000, maxMaterialChars: 20_000, threadScan: 30 },
    pollMs: 8, phasePollMs: 12, retryBaseMs: 2, httpMaxBodyBytes: 1_048_576,
    ...opts.config,
  };
  // Sets can be overridden via opts.config plain arrays; normalize.
  if (Array.isArray(config.allowedChatIds)) config.allowedChatIds = new Set(config.allowedChatIds);
  if (Array.isArray(config.commanderOpenIds)) config.commanderOpenIds = new Set(config.commanderOpenIds);
  if (Array.isArray(config.projectAliases)) config.projectAliases = new Set(config.projectAliases);

  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const svc = await createService(config, { logger: silent });

  const post: Harness['post'] = async (envelope = makeEnvelope(), headers = {}) => {
    const res = await fetch(svc.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
      body: JSON.stringify(envelope),
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* noop */ }
    return { status: res.status, body };
  };

  return {
    dir, config, svc, lark, hubPath, post,
    hub: () => { try { return JSON.parse(readFileSync(hubPath, 'utf8')); } catch { return null; } },
    updateHub: (fn) => {
      const hub = JSON.parse(readFileSync(hubPath, 'utf8'));
      fn(hub);
      writeFileSync(hubPath, JSON.stringify(hub, null, 2));
    },
    async cleanup() {
      await svc.stop().catch(() => {});
      await lark.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}
