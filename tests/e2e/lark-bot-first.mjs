#!/usr/bin/env node
/**
 * 飞书 Bot-first 应用边界 E2E。
 *
 * 真实件：LarkMessageCoordinator、createLarkCardService（真实 fetch）、DutydeckRuntime、
 * 磁盘 SQLite、真实 createPtyCliDriver + 真实测试 CLI 进程（PTY）。
 *
 * 替身边界（脚本会打印）：
 *   1. 外部飞书平台 —— 入站用合成 LarkMessageEvent（不连 WS、不发真实消息）；
 *      出站打到本轮 127.0.0.1 随机端口的 fake-Lark HTTP，真实 fetch、真实 JSON。
 *   2. 模型 —— 测试 CLI 是 scripts/e2e-harness.mjs 的 writeMockCli，不调任何 provider。
 *
 * 应用边界，不是生产形态：PTY 用进程内 PtyBackend（不是生产的 tmux 持久后端），
 * 也不起 daemon/HTTP API，因此不验证 daemon 重启与 tmux 复用。
 *
 * ## 测量纪律（这一段决定断言是否真的成立）
 *
 * "卡片里出现 marker" **不能**当作 Agent 跑过：初始进度卡本身就回显用户 prompt，
 * 里面必然含 marker。每一轮改为：
 *   ① 用本轮 runtime task ID 等 task.status === 'completed'；
 *   ② 从 runtime.getEvents(sessionId, 本轮起始 sequence) 里找该轮的 text 事件，
 *      要求内容含测试 CLI 真正生成的 MOCK_REPLY / MOCK_CONTINUED / MOCK_RESUMED 前缀 + marker
 *      （前缀由 writeMockCli 产生，用户 prompt 里没有）；
 *   ③ 再从本轮 channel mapping 的 final_message_id 定位真正的终态卡，要求那张卡含同一
 *      "前缀 + marker"。单卡契约下 final_message_id 必须等于 card_message_id：结论是
 *      原卡被 PATCH 出来的，本轮只应发出一条消息。
 */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeMockCli, mockAgentsJson } from './../../scripts/e2e-harness.mjs';

const require = createRequire(import.meta.url);
const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const WATCHDOG_MS = Number(process.env.LARK_E2E_TIMEOUT_MS ?? '240000') || 240_000;
const VERBOSE = process.argv.includes('--verbose');
/** 测试 CLI 真实输出的前缀，来自 writeMockCli；用户 prompt 中不含这些词。 */
const MOCK_PREFIXES = ['MOCK_REPLY', 'MOCK_CONTINUED', 'MOCK_RESUMED'];

let failures = 0;
let checks = 0;
const debug = (...args) => { if (VERBOSE) console.log('   ·', ...args); };
const step = label => console.log(`\n▶ ${label}`);
function assert(condition, label, detail) {
  checks += 1;
  if (condition) { console.log(`  ✓ ${label}`); return true; }
  failures += 1;
  console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  return false;
}

// ── 清理：LIFO、逐项独立、每项各自限时 ────────────────────────────────────
// 每项单独给预算（而不是共享一个总预算）：否则 runtime.shutdown 挂住就会把后面的
// PTY 停止、DB 关闭、临时目录删除全部"预算耗尽"跳过，真的留下进程和文件。
const cleanups = [];
const onCleanup = (label, fn, budgetMs = 8_000) => cleanups.push({ label, fn, budgetMs });
/*
  缓存同一个 Promise，而不是一个 boolean 旗标。

  竞态是这样的：SIGTERM 时 onSignal 先调 runCleanups()，它把旗标置真后开始逐项清理
  （runtime.shutdown 可能要好几秒）；同时 main 里的 waitFor 看到 aborted 抛错，
  finally 又调一次 runCleanups()，旗标已为真于是**立刻返回**，尾部的 process.exit
  随即把还在跑的第一遍清理打断——于是只留下"停止 coordinator"，PTY/DB/临时目录都没收口。

  改成所有调用者 await 同一个 Promise：谁先进来谁真正执行，后来者等它完成，
  process.exit 一定发生在清理全部结束之后。
*/
let cleanupPromise;
function runCleanups() {
  cleanupPromise ??= (async () => {
    for (const { label, fn, budgetMs } of [...cleanups].reverse()) {
      try {
        await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`清理超时 ${budgetMs}ms`)), budgetMs); timer.unref?.(); }),
        ]);
        debug(`cleanup ok: ${label}`);
      } catch (error) {
        failures += 1;
        console.log(`  ✗ 清理失败：${label} — ${error?.message ?? error}`);
      }
    }
  })();
  return cleanupPromise;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** 看门狗/信号触发后置位：所有 waitFor 立刻放弃，main 不再继续制造资源。 */
let aborted;
/** 判据里主动抛这个类型表示"已经确定失败"，waitFor 不再重试，直接上抛证据。 */
class FatalProbe extends Error {}
async function waitFor(label, predicate, { timeoutMs = 50_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (aborted) throw new Error(`已中止（${aborted}），停止等待：${label}`);
    try { const value = await predicate(); if (value) return value; }
    catch (error) {
      if (error instanceof FatalProbe) throw error;
      debug(`${label} 轮询异常：${error?.message ?? error}`);
    }
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
    await sleep(intervalMs);
  }
}

/**
 * fake-Lark HTTP。只实现真的被调到的端点；未知路径/方法一律拒绝并记账，
 * 绝不兜底 200——否则产品少调一个端点也能"通过"。
 */
function startFakeLark() {
  const calls = [];
  const cards = new Map();   // messageId → { content, patches: [] }
  const uploads = [];        // 通过校验的图片上传
  const rejected = [];
  let messageSeq = 0;

  const json = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rawBuffer = Buffer.concat(chunks);
      const raw = rawBuffer.toString('utf8');
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      const method = req.method ?? 'GET';
      calls.push({ method, path, body: typeof body === 'string' ? '(non-json body)' : body });
      debug(`fake-Lark ${method} ${path}`);

      if (method === 'POST' && path === '/open-apis/auth/v3/tenant_access_token/internal/') {
        return json(res, 200, { code: 0, msg: 'ok', tenant_access_token: 'fake-tenant-token', expire: 7200 });
      }
      /*
        图片上传（service.ts:585-591）：multipart/form-data，字段 image_type=message +
        文件字段 image。用 Request().formData() 真正解出各部分，校验文件非空且是 WebP
        （RIFF....WEBP 魔数）——只看整个 body 长度是假通过，光请求头就超过 64 字节。
        缺文件/空文件/伪 multipart 一律拒绝并记账。
      */
      if (path === '/open-apis/im/v1/images') {
        if (method !== 'POST') { rejected.push(`${method} ${path} (method not allowed)`); return json(res, 405, { code: 99, msg: 'fake-Lark: method not allowed' }); }
        const contentType = String(req.headers['content-type'] ?? '');
        if (!contentType.startsWith('multipart/form-data')) {
          rejected.push(`${method} ${path} (not multipart)`);
          return json(res, 400, { code: 99, msg: 'fake-Lark: expected multipart/form-data' });
        }
        void new Request('http://127.0.0.1/upload', { method: 'POST', headers: { 'content-type': contentType }, body: rawBuffer })
          .formData()
          .then(async form => {
            const imageType = form.get('image_type');
            const file = form.get('image');
            if (imageType !== 'message' || typeof file === 'string' || !file) {
              rejected.push(`${method} ${path} (missing image_type=message or file part)`);
              return json(res, 400, { code: 99, msg: 'fake-Lark: invalid image upload fields' });
            }
            const bytes = Buffer.from(await file.arrayBuffer());
            const isWebp = bytes.length > 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
            if (bytes.length === 0 || !isWebp) {
              rejected.push(`${method} ${path} (empty or non-WebP file: ${bytes.length}B)`);
              return json(res, 400, { code: 99, msg: 'fake-Lark: image must be a non-empty WebP' });
            }
            uploads.push({ filename: file.name, bytes: bytes.length, webp: true });
            return json(res, 200, { code: 0, msg: 'ok', data: { image_key: 'img_v3_fake_e2e' } });
          })
          .catch(error => {
            rejected.push(`${method} ${path} (multipart parse failed: ${error?.message ?? error})`);
            return json(res, 400, { code: 99, msg: 'fake-Lark: multipart parse failed' });
          });
        return;
      }
      if (method === 'POST' && path === '/open-apis/im/v1/messages') {
        messageSeq += 1;
        const messageId = `om_fake_${messageSeq}`;
        cards.set(messageId, { content: body?.content ?? '', patches: [] });
        return json(res, 200, { code: 0, msg: 'ok', data: { message_id: messageId, chat_id: body?.receive_id ?? 'oc_fake' } });
      }
      const replyMatch = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(path);
      if (method === 'POST' && replyMatch) {
        messageSeq += 1;
        const messageId = `om_fake_${messageSeq}`;
        cards.set(messageId, { content: body?.content ?? '', patches: [], replyTo: decodeURIComponent(replyMatch[1]) });
        return json(res, 200, { code: 0, msg: 'ok', data: { message_id: messageId, chat_id: 'oc_fake' } });
      }
      if (method === 'POST' && /^\/open-apis\/im\/v1\/messages\/[^/]+\/reactions$/.test(path)) {
        return json(res, 200, { code: 0, msg: 'ok', data: { reaction_id: `re_fake_${calls.length}` } });
      }
      if (method === 'DELETE' && /^\/open-apis\/im\/v1\/messages\/[^/]+\/reactions\/[^/]+$/.test(path)) {
        return json(res, 200, { code: 0, msg: 'ok', data: {} });
      }
      const patchMatch = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(path);
      if (method === 'PATCH' && patchMatch) {
        const messageId = decodeURIComponent(patchMatch[1]);
        const card = cards.get(messageId);
        if (!card) { rejected.push(`${method} ${path} (unknown message)`); return json(res, 404, { code: 1, msg: 'message not found' }); }
        card.patches.push(body?.content ?? '');
        card.content = body?.content ?? card.content;
        return json(res, 200, { code: 0, msg: 'ok', data: { message_id: messageId, chat_id: 'oc_fake' } });
      }
      if (method === 'GET' && path === '/open-apis/bot/v3/info') {
        return json(res, 200, { code: 0, msg: 'ok', bot: { open_id: 'ou_fake_bot', app_name: 'Fake Dutydeck Bot' } });
      }
      rejected.push(`${method} ${path}`);
      return json(res, 404, { code: 99, msg: 'fake-Lark: endpoint not implemented' });
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        calls, cards, uploads, rejected,
        close: () => new Promise((done, fail) => server.close(error => error ? fail(error) : done())),
      });
    });
  });
}

const cardText = card => (typeof card?.content === 'string' ? card.content : JSON.stringify(card?.content ?? ''));

/**
 * 取卡片里 element_id === 'final_output' 那个元素的正文（card-renderer.ts:456）。
 *
 * 断言必须落在这个元素上：整卡文本里到处都可能出现 marker（用户 prompt 回显、trace
 * 摘要），拿整卡含词当"模型输出进了卡"是假通过。
 */
function finalOutputContent(card) {
  const raw = cardText(card);
  if (!raw) return undefined;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  let found;
  const walk = node => {
    if (found !== undefined || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (node.element_id === 'final_output') { found = typeof node.content === 'string' ? node.content : JSON.stringify(node.content ?? ''); return; }
    for (const value of Object.values(node)) walk(value);
  };
  walk(parsed);
  return found;
}

async function main() {
  console.log('飞书 Bot-first 应用边界 E2E');
  console.log('替身边界：① 外部飞书平台（入站合成事件 / 出站 fake-Lark HTTP，不发真实消息）');
  console.log('           ② 模型（测试 PTY CLI，不调任何 provider）');
  console.log('真实件：LarkMessageCoordinator · createLarkCardService(真实 fetch) · DutydeckRuntime · 磁盘 SQLite · 真实 PTY 驱动与进程');
  console.log('范围说明：应用边界 E2E。PTY 用进程内 PtyBackend（非生产 tmux 持久后端），不起 daemon/HTTP API，因此不覆盖 daemon 重启与 tmux 复用。');

  const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
  const unregister = register();
  onCleanup('注销 tsx loader', () => { try { unregister(); } catch { /* 已注销 */ } });

  // ── 隔离目录 ──
  const dataDir = mkdtempSync(join(tmpdir(), 'dutydeck-lark-e2e-'));
  onCleanup(`删除临时目录 ${dataDir}`, () => rmSync(dataDir, { recursive: true, force: true }));
  const binDir = join(dataDir, 'bin');
  const claudeDir = join(dataDir, 'claude');
  const workspace = join(dataDir, 'workspace');
  for (const dir of [binDir, claudeDir, workspace]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(workspace, 'README.md'), '# lark e2e workspace\n', 'utf8');

  const mockPath = writeMockCli(binDir);
  // mockAgentsJson 返回 agent 对象数组，并读 dirs.claudeDataDir。它同时给出快轮次
  // claude-code 与每轮 8s 的慢速 seed；慢速那只专供"执行中取消"（改 env 对已启动进程无效）。
  const agents = mockAgentsJson({ mockPath, dirs: { workspace, claudeDataDir: claudeDir } });
  /*
    打开测试 CLI 的可中断模式（默认关闭，只影响本脚本）：真实交互式 CLI 收到 Ctrl-C
    会取消当轮并回到提示符、进程继续活着。默认模式下 PTY 的 \x03 触发 SIGINT 默认行为
    直接杀掉假 CLI，driver 随即 stopped，/retry 会撞上 "send() called after stop()"。
  */
  for (const agent of agents) agent.env = { ...agent.env, MOCK_INTERRUPTIBLE: '1' };
  const fastAgent = agents.find(agent => agent.id === 'claude-code');
  const slowAgent = agents.find(agent => agent.id === 'seed');
  if (!fastAgent || !slowAgent) throw new Error(`mockAgentsJson 未给出预期 agent：${agents.map(a => a.id).join(',')}`);
  debug(`测试 agent: 快=${fastAgent.id} 慢=${slowAgent.id} → ${mockPath}`);

  const fake = await startFakeLark();
  onCleanup('关闭 fake-Lark HTTP', () => fake.close());
  debug(`fake-Lark: ${fake.baseUrl}`);

  /*
    出网闸门：只允许打到本轮 fake-Lark。产品里任何一处读到真实 open.feishu.cn
    （env 残留或错误代码路径）都会在这里硬失败，而不是静默出网。
  */
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const raw = String(typeof input === 'string' ? input : input?.url ?? input);
    let origin;
    try { origin = new URL(raw).origin; } catch { origin = undefined; }
    if (origin !== fake.origin) {
      failures += 1;
      // 只报固定阶段名，不回显外部 origin/URL（可能带真实主机或凭据参数）。
      console.log('  ✗ E2E 出网闸门拦截：本轮只允许打到 fake-Lark，出现了非 fake-Lark 的出网请求');
      return Promise.reject(new Error('E2E 出网闸门拦截：非 fake-Lark 目标'));
    }
    return realFetch(input, init);
  };
  onCleanup('恢复 globalThis.fetch', () => { globalThis.fetch = realFetch; });

  // ── 产品模块 ──
  const [{ createRepositories }, { DutydeckRuntime }, { createPtyCliDriver }, { createCliAdapter }, backends, coordinatorMod, serviceMod, rendererMod, configMod] = await Promise.all([
    import(pathToFileURL(join(REPO, 'packages/storage/src/index.ts')).href),
    import(pathToFileURL(join(REPO, 'packages/agent-runtime/src/index.ts')).href),
    import(pathToFileURL(join(REPO, 'packages/pty-driver/src/index.ts')).href),
    import(pathToFileURL(join(REPO, 'packages/cli-adapters/src/index.ts')).href),
    import(pathToFileURL(join(REPO, 'packages/session-backends/src/index.ts')).href),
    import(pathToFileURL(join(REPO, 'apps/server/src/lark/coordinator.ts')).href),
    import(pathToFileURL(join(REPO, 'apps/server/src/lark/service.ts')).href),
    import(pathToFileURL(join(REPO, 'apps/server/src/lark/card-renderer.ts')).href),
    import(pathToFileURL(join(REPO, 'apps/server/src/lark/config.ts')).href),
  ]);
  const { LarkMessageCoordinator } = coordinatorMod;
  const { createLarkCardService } = serviceMod;
  const { saveLarkConfig, readLarkConfig } = configMod;
  if (typeof saveLarkConfig !== 'function' || typeof readLarkConfig !== 'function') {
    throw new Error('lark/config 未导出 saveLarkConfig/readLarkConfig');
  }
  // 任务边界复用产品自己的切片函数，避免测试另写一套"哪些事件属于这一轮"。
  const { eventsForRuntimeTask } = rendererMod;
  if (typeof eventsForRuntimeTask !== 'function') throw new Error('card-renderer 未导出 eventsForRuntimeTask');
  // 进程内 PtyBackend（生产是 createDutydeckPersistentBackend/tmux）——见顶部范围说明。
  const PtyBackendCtor = backends.PtyBackend;
  if (!PtyBackendCtor) throw new Error(`@dutydeck/session-backends 未导出 PtyBackend：${Object.keys(backends).join(',')}`);

  // createRepositories 把路径原样交给 better-sqlite3，不支持 file: URI（storage/src/index.ts:94）。
  const dbPath = join(dataDir, 'dutydeck.db');
  const repos = createRepositories(dbPath);
  onCleanup('关闭 SQLite', () => repos.close());

  const livePtyDrivers = new Set();
  const ptyDriverFactory = (agent, _protocol, onEvent, onExit, sessionId) => {
    let driver;
    driver = createPtyCliDriver({
      agent,
      adapter: createCliAdapter(agent.id),
      backend: new PtyBackendCtor(),
      onEvent,
      onExit: code => { livePtyDrivers.delete(driver); onExit(code); },
      onStopped: () => livePtyDrivers.delete(driver),
      sessionId,
    });
    livePtyDrivers.add(driver);
    return driver;
  };
  onCleanup('停止本轮残留 PTY 驱动', async () => {
    for (const driver of [...livePtyDrivers]) {
      try { await driver.stop?.({ discardSession: true }); } catch { /* 已退出 */ }
    }
    livePtyDrivers.clear();
  });

  const runtime = new DutydeckRuntime(repos, { ptyDriverFactory });
  onCleanup('runtime.shutdown', () => runtime.shutdown?.());
  // 真实 agent 注册走 runtime.initialize（agent-runtime/src/index.ts:176），它自己写 repos.agents。
  await runtime.initialize(agents);
  const registeredAgents = await repos.agents.list();
  assert(agents.every(agent => registeredAgents.some(item => item.id === agent.id)),
    'runtime.initialize 已把测试 agent 注册进真实 DB',
    `注册=${registeredAgents.map(a => a.id).join(',')}`);
  assert(existsSync(dbPath), `磁盘 SQLite 建在本轮临时目录内：${dbPath}`);

  /*
    配置必须走真实的 saveLarkConfig → readLarkConfig 归一化，不能手写残缺对象：
    StoredLarkConfig 的 pushIntervalMs 等字段有真实默认值（saveLarkConfig 用
    defaultLarkPushIntervalMs 填充），手写 fixture 漏掉它会让 coordinator.ts:1264
    的 `Math.max(config.pushIntervalMs, …)` 变成 Math.max(undefined, …) → NaN，
    心跳退化成约 1ms 一次，卡片被无休止 PATCH。
  */
  const appId = 'cli_fake_e2e';
  const saveConfigFor = async agentId => {
    await saveLarkConfig(repos.config, repos.agents, {
      ...(await readLarkConfig(repos.config, appId) ? { originalAppId: appId } : {}),
      appId,
      appSecret: 'fake-secret-not-real',
      name: 'E2E Bot',
      workspace,
      defaultAgentId: agentId,
      fullTrustConfirmed: true,
      listening: true,
      p2pMode: 'chat',
    });
    const stored = await readLarkConfig(repos.config, appId);
    if (!stored) throw new Error('saveLarkConfig 之后读不回配置');
    return stored;
  };
  const fastConfig = await saveConfigFor(fastAgent.id);
  assert(Number.isFinite(fastConfig.pushIntervalMs) && fastConfig.pushIntervalMs > 0,
    '配置经真实 saveLarkConfig/readLarkConfig 归一化，pushIntervalMs 是有效值（不会退化成 1ms 心跳）',
    `pushIntervalMs=${fastConfig.pushIntervalMs}`);
  assert(fastConfig.defaultAgentId === fastAgent.id, '归一化后的配置指向快速测试 agent',
    `defaultAgentId=${fastConfig.defaultAgentId}`);

  const log = { info: (_d, m) => debug('log.info', m ?? ''), warn: (_d, m) => debug('log.warn', m ?? ''), error: (_d, m) => debug('log.error', m ?? '') };
  const cardService = createLarkCardService(
    { LARK_OPEN_API_BASE_URL: fake.baseUrl },
    globalThis.fetch,
    { appId, appSecret: 'fake-secret-not-real', baseUrl: fake.baseUrl },
  );

  // 慢速轮次同样走真实归一化（切换 defaultAgentId，其余字段由产品填默认值）。
  let slowConfig;

  const newCoordinator = () => new LarkMessageCoordinator(runtime, cardService, log, Math.random, 'ou_fake_bot', undefined, repos.channelMappings);
  let coordinator = newCoordinator();
  onCleanup('停止 coordinator', () => coordinator.stop?.());

  const chatId = 'oc_e2e_chat';
  let inboundSeq = 0;
  const inbound = text => {
    inboundSeq += 1;
    return {
      messageId: `om_in_${inboundSeq}`, chatId, chatType: 'p2p', messageType: 'text',
      content: JSON.stringify({ text }), senderOpenId: 'ou_e2e_user', senderType: 'user', mentions: [],
    };
  };

  const channel = `lark-card:${appId}`;
  const mappings = async () => {
    const list = await repos.channelMappings.list(channel);
    return list.map(mapping => {
      let extra;
      try { extra = mapping.extra ? JSON.parse(mapping.extra) : undefined; } catch { extra = undefined; }
      return { ...mapping, parsed: extra };
    });
  };
  /** 本轮 mapping：按 runtime_task_id 精确定位，不靠"最后一条"。 */
  const mappingForTask = async runtimeTaskId => (await mappings()).find(m => m.parsed?.runtime_task_id === runtimeTaskId);

  const sessionsNewest = async () => (await runtime.listSessions()).slice().sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  /**
   * 一轮的完整验证：task 完成 → runtime 事件里有测试 CLI 真实输出 → 终态新卡含同一输出。
   * 返回 { task, outputText, mapping, finalCard }。
   */
  async function verifyRound({ label, sessionId, marker, afterSequence, knownTaskIds, cardsBefore }) {
    /*
      等 completed，但一旦落到真正的终态失败（failed/interrupted/cancelled）就立刻
      带证据报错——不再盲等 90s 只报"未 completed"。completed 门槛本身不放宽。
    */
    const terminalFailures = new Set(['failed', 'interrupted', 'cancelled', 'canceled']);
    const task = await waitFor(`${label}：本轮 task 完成`, async () => {
      const all = await runtime.getTasks(sessionId);
      const mine = all.find(item => !knownTaskIds.has(item.id) && item.prompt?.includes(marker));
      if (!mine) return undefined;
      if (mine.status === 'completed') return mine;
      if (terminalFailures.has(mine.status)) {
        const events = await runtime.getEvents(sessionId, afterSequence).catch(() => []);
        const errorSummary = events
          .filter(event => event.type === 'error')
          .slice(-2)
          .map(event => String(event.data?.message ?? '').slice(0, 160))
          .join(' | ');
        throw new FatalProbe(`${label}：task ${mine.id} 落到非预期终态 status=${mine.status}` + (errorSummary ? `；error 事件：${errorSummary}` : '；无 error 事件'));
      }
      return undefined;
    }, { timeoutMs: 50_000 });
    assert(task.status === 'completed', `${label}：runtime task 到达 completed`, `taskId=${task.id} status=${task.status}`);

    /*
      任务边界按产品的 eventsForRuntimeTask（card-renderer.ts:121）取：起始锚点是
      `type=text && data.role==='user' && data.taskId===task.id`。

      必须先硬断言这个起始事件存在——该 helper 找不到锚点时会 `return events`（返回全部），
      那样切片就等于"整条会话历史"，本轮断言会被历史输出蒙对。assistant 的 text 事件
      本身不带 taskId，所以只能靠这个用户侧锚点划边界，不能对 assistant 事件要求 taskId。
    */
    const allEvents = await waitFor(`${label}：本轮任务起始事件（role=user + data.taskId）落库`, async () => {
      const events = await runtime.getEvents(sessionId, afterSequence);
      const start = events.find(event => event.type === 'text' && event.data?.role === 'user' && event.data?.taskId === task.id);
      return start ? events : undefined;
    }, { timeoutMs: 50_000 });
    const startEvent = allEvents.find(event => event.type === 'text' && event.data?.role === 'user' && event.data?.taskId === task.id);
    assert(Boolean(startEvent), `${label}：存在本轮 task 的起始事件（否则任务切片会退化成整条历史）`,
      `taskId=${task.id}`);
    assert((startEvent.sequence ?? 0) > afterSequence, `${label}：起始事件的 sequence 属于本轮（> ${afterSequence}）`,
      `startSequence=${startEvent.sequence}`);

    // 真实 CLI 输出：只在本轮任务切片里找，且必须带 MOCK_* 前缀 + 本轮 marker。
    const outputEvent = await waitFor(`${label}：本轮任务切片内含测试 CLI 真实输出`, async () => {
      const events = await runtime.getEvents(sessionId, afterSequence);
      const slice = eventsForRuntimeTask(events, task.id);
      // helper 找不到锚点会返回全部；上面已断言锚点存在，这里再兜一层，避免退化匹配。
      if (slice.length === events.length && !events.some(e => e.type === 'text' && e.data?.role === 'user' && e.data?.taskId === task.id)) return undefined;
      return slice.find(event => {
        if (event.type !== 'text' || event.data?.role === 'user') return false;
        const text = typeof event.data?.text === 'string' ? event.data.text : JSON.stringify(event.data ?? '');
        return text.includes(marker) && MOCK_PREFIXES.some(prefix => text.includes(prefix));
      });
    }, { timeoutMs: 50_000 });
    const outputText = typeof outputEvent.data?.text === 'string' ? outputEvent.data.text : JSON.stringify(outputEvent.data);
    const prefix = MOCK_PREFIXES.find(item => outputText.includes(item));
    assert(Boolean(prefix), `${label}：输出带测试 CLI 生成的前缀（证明 Agent 真跑过，不是回显 prompt）`,
      `前缀=${prefix ?? '(无)'}`);

    // 终态卡：从本轮 mapping 的 final_message_id 定位，不用"任意含 marker 的卡"。
    const mapping = await waitFor(`${label}：mapping 落库并带 final_message_id`, async () => {
      const found = await mappingForTask(task.id);
      return found?.parsed?.final_message_id ? found : undefined;
    }, { timeoutMs: 50_000 });
    const finalId = mapping.parsed.final_message_id;
    const finalCard = fake.cards.get(finalId);
    assert(Boolean(finalCard), `${label}：final_message_id 指向真实发出过的卡片`, `final_message_id=${finalId}`);
    // 断言落在 element_id=final_output 上：整卡含词可能只是回显 prompt 或 trace 摘要。
    const finalOutput = finalOutputContent(finalCard);
    assert(Boolean(finalOutput) && finalOutput.includes(marker) && MOCK_PREFIXES.some(item => finalOutput.includes(item)),
      `${label}：终态卡的 final_output 元素含"${prefix} + marker"（真实模型输出，不是 prompt 回显或 trace）`,
      `final=${finalId} final_output=${finalOutput === undefined ? '(元素缺失)' : JSON.stringify(finalOutput.slice(0, 120))}`);
    /*
      单卡契约的核心断言：正常一轮的结论是**原卡自己被 PATCH 成了终态**，
      不是另发一条消息。final_message_id 必须就等于 card_message_id。
    */
    assert(mapping.parsed.card_message_id === finalId,
      `${label}：终态就地写回原卡，final_message_id === card_message_id（单卡）`,
      `progress=${mapping.parsed.card_message_id} final=${finalId}`);
    assert(mapping.parsed.progress_frozen === true && mapping.parsed.final_delivery_state === 'delivered',
      `${label}：终态交付如实落库（progress_frozen + delivered）`,
      `frozen=${mapping.parsed.progress_frozen} delivery=${mapping.parsed.final_delivery_state}`);
    // 这张卡确实是被 PATCH 出来的终态，而不是一条新发的消息冒充"就地更新"。
    assert((finalCard.patches?.length ?? 0) > 0,
      `${label}：终态是对原卡的 PATCH，卡片上留下了更新记录`,
      `patches=${finalCard.patches?.length ?? 0}`);
    // 收据文案必须彻底消失：它正是这次要删掉的第二条消息的产物。
    assert(!JSON.stringify(finalCard.content ?? '').includes('已作为新消息发送'),
      `${label}：终态卡里没有"结果已作为新消息发送"的收据文案`);
    if (cardsBefore !== undefined) {
      /*
        正常一轮只允许**一次**初始 send/reply。fake-Lark 每次 POST messages / reply
        都新建一张卡，所以本轮新增卡片数就是新消息条数。终态若还另发一条，这里会是 2。
      */
      const newCards = fake.cards.size - cardsBefore;
      assert(newCards === 1, `${label}：本轮只发出一条消息（终态是 PATCH，不是第二条卡）`,
        `本轮新增卡片=${newCards}`);
    }
    return { task, outputText, mapping, finalCard, finalId, progressId: mapping.parsed.card_message_id };
  }

  const seqOf = async sessionId => {
    const events = await runtime.getEvents(sessionId).catch(() => []);
    return events.reduce((max, event) => Math.max(max, event.sequence ?? 0), 0);
  };

  // ── 1. 合成消息 → 真实 task → 真实 CLI 输出 → 原卡就地收敛为终态 ──
  step('1. 合成入站消息 → runtime task → 真实 CLI 输出 → 原卡就地收敛为终态');
  const marker1 = `E2EMARK${Date.now()}ONE`;
  const cardsBeforeRound1 = fake.cards.size;
  await coordinator.handle(inbound(`请回显 ${marker1}`), fastConfig);
  const session1 = await waitFor('第一轮 session 建立', async () => (await sessionsNewest())[0]);
  assert(Boolean(session1?.id), '合成消息建立了真实 runtime session', `session=${session1?.id}`);
  assert(session1.source === 'lark', 'session.source 标记为 lark', `source=${session1.source}`);
  const round1 = await verifyRound({ label: '第一轮', sessionId: session1.id, marker: marker1, afterSequence: 0, knownTaskIds: new Set(), cardsBefore: cardsBeforeRound1 });

  // ── 2. /status 定位已有会话（产品卡含完整 session ID，coordinator.ts:630） ──
  step('2. /status 定位已有会话');
  const statusCardsBefore = fake.cards.size;
  const tasksBeforeStatus = (await runtime.getTasks(session1.id)).length;
  await coordinator.handle(inbound('/status'), fastConfig);
  const statusCard = await waitFor('/status 回执卡片', async () => {
    const fresh = [...fake.cards.entries()].slice(statusCardsBefore);
    return fresh.find(([, card]) => cardText(card).includes(session1.id)) ?? undefined;
  }, { timeoutMs: 30_000 }).catch(() => undefined);
  assert(Boolean(statusCard), '/status 回执含完整 session ID', statusCard ? undefined : `session=${session1.id}`);
  const statusText = statusCard ? cardText(statusCard[1]) : '';
  const liveSession1 = await runtime.getSession(session1.id);
  assert(statusText.includes(liveSession1.state), '/status 回执含该会话真实的运行状态',
    `state=${liveSession1.state}`);
  const tasksAfterStatus = (await runtime.getTasks(session1.id)).length;
  assert(tasksAfterStatus === tasksBeforeStatus, '/status 是只读命令：没有新建任何 runtime task',
    `before=${tasksBeforeStatus} after=${tasksAfterStatus}`);

  // ── 3. coordinator.stop() 后重建，/status 仍能定位（走 DB 而非内存） ──
  step('3. 重建 coordinator 后 /status 仍定位同一会话');
  const mappingsBeforeRebuild = await mappings();
  assert(mappingsBeforeRebuild.some(m => m.sessionId === session1.id),
    '重建前该会话已有持久化 channel mapping', `mappings=${mappingsBeforeRebuild.length}`);
  coordinator.stop?.();
  coordinator = newCoordinator();
  const cardsBeforeStatus2 = fake.cards.size;
  const tasksBeforeStatus2 = (await runtime.getTasks(session1.id)).length;
  await coordinator.handle(inbound('/status'), fastConfig);
  const statusCard2 = await waitFor('重建后 /status 回执', async () => {
    const fresh = [...fake.cards.entries()].slice(cardsBeforeStatus2);
    return fresh.find(([, card]) => cardText(card).includes(session1.id)) ?? undefined;
  }, { timeoutMs: 30_000 }).catch(() => undefined);
  assert(Boolean(statusCard2), '重建 coordinator 后 /status 仍用完整 session ID 定位到同一会话（从持久化恢复）',
    statusCard2 ? undefined : `session=${session1.id}`);
  assert((await runtime.getTasks(session1.id)).length === tasksBeforeStatus2,
    '重建后的 /status 同样没有副作用', `before=${tasksBeforeStatus2}`);

  // ── 4. /new <目标>：旧会话严格 stopped、新会话完成且输出来自新 session、只执行一次 ──
  step('4. /new <目标> 停旧会话并只执行一次');
  const marker2 = `E2EMARK${Date.now()}NEW`;
  const cardsBeforeRound2 = fake.cards.size;
  await coordinator.handle(inbound(`/new 请回显 ${marker2}`), fastConfig);
  const session2 = await waitFor('/new 建立了不同的 session', async () => {
    const all = await sessionsNewest();
    return all.find(s => s.id !== session1.id);
  });
  assert(session2.id !== session1.id, '/new 开出新 session', `old=${session1.id} new=${session2.id}`);
  const oldSession = await waitFor('旧会话进入 stopped', async () => {
    const current = await runtime.getSession(session1.id);
    return current?.state === 'stopped' ? current : undefined;
  }, { timeoutMs: 50_000 }).catch(() => runtime.getSession(session1.id));
  assert(oldSession?.state === 'stopped', '/new 之后旧会话严格 state === stopped（真的调了 stop）',
    `实际 state=${oldSession?.state}`);
  const round2 = await verifyRound({ label: '/new 轮次', sessionId: session2.id, marker: marker2, afterSequence: 0, knownTaskIds: new Set(), cardsBefore: cardsBeforeRound2 });
  const marker2Tasks = (await runtime.getTasks(session2.id)).filter(task => task.prompt?.includes(marker2));
  assert(marker2Tasks.length === 1, '/new 的目标只派发一次（新 session 内恰好一个匹配 task）',
    `匹配=${marker2Tasks.length}：${marker2Tasks.map(t => t.id).join(',')}`);
  const round1Tasks = (await runtime.getTasks(session1.id)).filter(task => task.prompt?.includes(marker2));
  assert(round1Tasks.length === 0, '/new 的目标没有落到旧 session 上', `旧 session 匹配=${round1Tasks.length}`);
  assert(round2.finalId !== round1.finalId && round2.progressId !== round1.progressId,
    '/new 轮次用自己的进度卡与终态卡，不复用第一轮的',
    `r1=${round1.progressId}/${round1.finalId} r2=${round2.progressId}/${round2.finalId}`);

  // ── 5. 慢速 agent 执行中重建 coordinator → /cancel 严格 interrupted ──
  step('5. 执行中重建 coordinator → /cancel 严格 interrupted');
  const marker3 = `E2EMARK${Date.now()}SLOW`;
  slowConfig = await saveConfigFor(slowAgent.id);
  assert(slowConfig.defaultAgentId === slowAgent.id && Number.isFinite(slowConfig.pushIntervalMs),
    '慢速轮次配置同样经真实归一化', `agent=${slowConfig.defaultAgentId} pushIntervalMs=${slowConfig.pushIntervalMs}`);
  await coordinator.handle(inbound(`/new 请慢慢回显 ${marker3}`), slowConfig);
  const session3 = await waitFor('慢速轮次的 session', async () => {
    const all = await sessionsNewest();
    return all.find(s => s.id !== session1.id && s.id !== session2.id);
  });
  assert(session3.agentId === slowAgent.id, '第三轮用的是慢速测试 agent（8s 轮次，留出中断窗口）',
    `agentId=${session3.agentId}`);
  // 运行态以 runtime task.status === 'running' 判定，不用 session 的 starting。
  const runningTask = await waitFor('慢速 task 进入 running', async () => {
    const all = await runtime.getTasks(session3.id);
    return all.find(task => task.prompt?.includes(marker3) && task.status === 'running');
  }, { timeoutMs: 50_000 });
  debug(`running task=${runningTask.id}`);
  /*
    只等 task.status === 'running' 不够：runtime.runTask 在 driver.send 真正把 prompt
    交给 CLI 之前就把 task 存成 running，所以这一刻可能还落在 PTY 启动窗口里——那时发
    /cancel，Ctrl-C 打在还没开始这一轮的进程上，本轮自然不会 interrupted。

    改为等这一轮真实 raw_terminal 里出现测试 CLI 的 `working`（writeMockCli 在
    submitPrompt 里输出），确认 CLI 已经开始这一轮，再重建 coordinator 并 /cancel。
    这里只读事件，不制造也不修改 runtime 事件。
  */
  const workingEvent = await waitFor('测试 CLI 已开始这一轮（raw_terminal 出现 working）', async () => {
    const events = await runtime.getEvents(session3.id);
    return events.find(event => {
      if (event.type !== 'raw_terminal') return false;
      const text = event.raw ?? (typeof event.data?.text === 'string' ? event.data.text : '');
      return text.includes('working');
    });
  }, { timeoutMs: 50_000 });
  assert(Boolean(workingEvent), '取消前确认测试 CLI 真的在执行这一轮（不是仍在 PTY 启动窗口）',
    `sequence=${workingEvent?.sequence}`);
  // 重建前确认 mapping 已带确切 runtime_task_id，否则重建后无从定位。
  const mappingBeforeCancel = await waitFor('取消前 mapping 已带 runtime_task_id', () => mappingForTask(runningTask.id), { timeoutMs: 30_000 });
  assert(Boolean(mappingBeforeCancel), '执行中的这一轮已持久化 runtime_task_id', `taskId=${runningTask.id}`);
  const cancelProgressId = mappingBeforeCancel.parsed.card_message_id;

  coordinator.stop?.();
  coordinator = newCoordinator();
  // 旧 coordinator 停掉后不会自行推进终态，重建后显式起对账。
  await coordinator.startReconciliation(slowConfig, 500);
  onCleanup('停止对账定时器', () => coordinator.stop?.());
  await coordinator.handle(inbound('/cancel'), slowConfig);

  const cancelledTask = await waitFor('/cancel 后该 task 严格 interrupted', async () => {
    const all = await runtime.getTasks(session3.id);
    const mine = all.find(task => task.id === runningTask.id);
    return mine && mine.status === 'interrupted' ? mine : undefined;
  }, { timeoutMs: 50_000 }).catch(async () => (await runtime.getTasks(session3.id)).find(task => task.id === runningTask.id));
  assert(cancelledTask?.status === 'interrupted', '/cancel 让执行中的 task 严格 interrupted',
    `taskId=${runningTask.id} 实际 status=${cancelledTask?.status}；若不是 interrupted 需修测试驱动而非放宽断言`);

  /*
    进入 /retry 之前，被取消那一轮必须已经收敛：单卡契约下这意味着
    mapping.state === 'interrupted' + progress_frozen + final_delivery_state === 'delivered'
    + final_message_id === card_message_id（终态就地写回原卡，没有第二条收据消息）。
    这几项缺任何一项都要失败——不能用 if (finalId) 跳过旧终态检查，否则"旧卡不被改写"
    就退化成一条恒真断言（没有旧卡自然不会被改写）。
  */
  const frozenMapping = await waitFor('被取消轮次就地收敛（interrupted + frozen + delivered + final === card）', async () => {
    const current = await mappingForTask(runningTask.id);
    const parsed = current?.parsed;
    return parsed?.state === 'interrupted' && parsed?.progress_frozen === true
      && parsed?.final_delivery_state === 'delivered' && parsed?.final_message_id ? current : undefined;
  }, { timeoutMs: 50_000 }).catch(async () => await mappingForTask(runningTask.id));
  const frozenParsed = frozenMapping?.parsed ?? {};
  assert(frozenParsed.state === 'interrupted' && frozenParsed.progress_frozen === true
    && frozenParsed.final_delivery_state === 'delivered' && Boolean(frozenParsed.final_message_id),
    '取消轮次的 mapping 收敛为 interrupted + 冻结 + 已交付终态',
    `state=${frozenParsed.state} frozen=${frozenParsed.progress_frozen} delivery=${frozenParsed.final_delivery_state} final=${frozenParsed.final_message_id ?? '(无)'}`);
  assert(frozenParsed.final_message_id === cancelProgressId,
    '被取消轮次的终态也是就地写回原卡，没有另发一条收据消息',
    `progress=${cancelProgressId} final=${frozenParsed.final_message_id}`);
  const cancelFinalId = frozenParsed.final_message_id;
  const cancelCardPatchCount = fake.cards.get(cancelProgressId)?.patches.length ?? 0;
  const cardsBeforeRetry = fake.cards.size;
  const seqBeforeRetry = await seqOf(session3.id);

  // ── 6. /retry：按旧 task mapping 定位，新 task/新卡，旧卡不被改写 ──
  step('6. /retry 新建 task 与新卡，且不改写上一轮的卡');
  const knownTaskIds = new Set((await runtime.getTasks(session3.id)).map(task => task.id));
  await coordinator.handle(inbound('/retry'), slowConfig);
  const retryTask = await waitFor('/retry 新建了 task', async () => {
    const all = await runtime.getTasks(session3.id);
    return all.find(task => !knownTaskIds.has(task.id));
  }, { timeoutMs: 50_000 });
  assert(retryTask.id !== runningTask.id, '/retry 新建 task，不复用被取消的那个',
    `old=${runningTask.id} retry=${retryTask.id}`);
  assert(retryTask.prompt === runningTask.prompt, '/retry 重发的 prompt 与被取消那轮逐字相同',
    `equal=${retryTask.prompt === runningTask.prompt}`);
  // 复用同一套严格验证：completed + 本轮 sequence + data.taskId + MOCK 前缀 + marker + 终态新卡。
  const retryRound = await verifyRound({
    label: '/retry 轮次', sessionId: session3.id, marker: marker3,
    afterSequence: seqBeforeRetry, knownTaskIds, cardsBefore: cardsBeforeRetry,
  });
  assert(retryRound.task.id === retryTask.id, '/retry 验证的是新建的那个 task',
    `retryTask=${retryTask.id} verified=${retryRound.task.id}`);
  assert(retryRound.progressId !== cancelProgressId, '/retry 用新的进度卡，不覆写被取消那轮的卡',
    `oldCard=${cancelProgressId} newCard=${retryRound.progressId}`);
  assert(retryRound.finalId !== cancelFinalId, '/retry 的终态落在新卡上，不是上一轮那张卡',
    `cancelFinal=${cancelFinalId} retryFinal=${retryRound.finalId}`);
  /*
    防串轮：可中断的测试 CLI 保持同一进程，被取消的是它的第 1 轮，所以 /retry 是
    第 2 轮 → MOCK_CONTINUED。若这里出现 MOCK_REPLY，说明 Ctrl-C 没清掉旧定时器，
    是被取消那一轮 8 秒后迟到的输出冒充了重试成功。
  */
  assert(retryRound.outputText.includes('MOCK_CONTINUED'),
    '/retry 的输出是测试 CLI 新的一轮（MOCK_CONTINUED），不是被取消那轮迟到的回复',
    `outputText=${JSON.stringify(retryRound.outputText.slice(0, 120))}`);
  const slowSessionEvents = await runtime.getEvents(session3.id);
  const staleReply = slowSessionEvents.find(event => {
    if (event.type !== 'text' || event.data?.role === 'user') return false;
    const text = typeof event.data?.text === 'string' ? event.data.text : '';
    return text.includes('MOCK_REPLY') && text.includes(marker3);
  });
  assert(!staleReply, '被取消的第 1 轮没有产出 MOCK_REPLY 输出（Ctrl-C 真的清掉了旧定时器）',
    staleReply ? `残留事件 sequence=${staleReply.sequence}` : undefined);
  const retryFinalOutput = finalOutputContent(fake.cards.get(retryRound.finalId));
  assert(Boolean(retryFinalOutput) && retryFinalOutput.includes('MOCK_CONTINUED'),
    '/retry 终态卡的 final_output 是新一轮输出（MOCK_CONTINUED）',
    `final_output=${retryFinalOutput === undefined ? '(元素缺失)' : JSON.stringify(retryFinalOutput.slice(0, 120))}`);
  // 上一轮那张已收敛的卡：从 retry 开始不得再被 PATCH；旧 mapping 仍指向旧 task 与旧卡。
  const cancelCardAfter = fake.cards.get(cancelProgressId)?.patches.length ?? 0;
  assert(cancelCardAfter === cancelCardPatchCount,
    '被取消那轮的卡在 /retry 之后没有再被 PATCH',
    `before=${cancelCardPatchCount} after=${cancelCardAfter}`);
  const cancelMappingAfter = await mappingForTask(runningTask.id);
  assert(cancelMappingAfter?.parsed?.runtime_task_id === runningTask.id
    && cancelMappingAfter?.parsed?.card_message_id === cancelProgressId
    && cancelMappingAfter?.parsed?.final_message_id === cancelFinalId,
    '旧 mapping 仍指向旧 task 与旧卡（retry 没有改写它）',
    `task=${cancelMappingAfter?.parsed?.runtime_task_id} card=${cancelMappingAfter?.parsed?.card_message_id} final=${cancelMappingAfter?.parsed?.final_message_id}`);

  // ── 7. fake API 边界 ──
  step('7. fake-Lark 端点边界');
  assert(fake.rejected.length === 0, 'fake-Lark 未收到任何未实现端点的调用',
    fake.rejected.length ? fake.rejected.join(' | ') : undefined);
  assert(fake.calls.length > 0, '出站回执确实经过真实 HTTP', `calls=${fake.calls.length}`);
  // 图片上传是产品真的会调的端点（进度卡的 loading 图）；只接受合规 multipart。
  assert(fake.uploads.length > 0, '进度卡的图片上传经过 fake-Lark 的 multipart 校验后成功',
    `uploads=${fake.uploads.length}`);
  assert(fake.uploads.every(upload => upload.webp === true && upload.bytes > 0),
    '上传的确实是非空 WebP 文件部分（按 RIFF/WEBP 魔数校验，不是只看整个 body 长度）',
    fake.uploads.map(u => `${u.filename}:${u.bytes}B webp=${u.webp}`).join(', '));
  /*
    心跳风暴护栏：pushIntervalMs 若退化（例如残缺 config 让 Math.max 得到 NaN），
    单张卡会被上千次 PATCH。给一个宽松但能抓住数量级问题的上限。
  */
  const worstCard = [...fake.cards.entries()].reduce((worst, [id, card]) =>
    card.patches.length > worst.count ? { id, count: card.patches.length } : worst, { id: '(无)', count: 0 });
  assert(worstCard.count <= 60, '没有出现心跳风暴（单张卡 PATCH 次数在合理范围）',
    `最多的卡=${worstCard.id} patches=${worstCard.count}`);
  console.log(`   回执序列共 ${fake.calls.length} 次，卡片 ${fake.cards.size} 张，单卡最多 PATCH ${worstCard.count} 次`);
}

// ── 看门狗、信号、退出码 ──────────────────────────────────────────────────
let watchdog;
/** 仅信号路径置位：它自己 await 同一个 cleanup Promise 后 exit(1)，尾部不要抢先退出。 */
let signalExiting = false;
const onSignal = name => {
  aborted = name;                 // 先让 main 停止推进，再收口资源
  signalExiting = true;
  failures += 1;
  console.log(`\n✗ 收到 ${name}，中止并清理`);
  runCleanups().finally(() => process.exit(1));
};
process.once('SIGINT', () => onSignal('SIGINT'));
process.once('SIGTERM', () => onSignal('SIGTERM'));

const watchdogPromise = new Promise((_, reject) => {
  watchdog = setTimeout(() => {
    aborted = 'watchdog';         // main 里的 waitFor 立刻放弃，不再继续起会话
    reject(new Error(`总看门狗超时（${WATCHDOG_MS}ms）`));
  }, WATCHDOG_MS);
  watchdog.unref?.();
});

try {
  await Promise.race([main(), watchdogPromise]);
} catch (error) {
  failures += 1;
  console.log(`\n✗ 运行中止：${error?.message ?? error}`);
  if (VERBOSE && error?.stack) console.log(error.stack);
} finally {
  clearTimeout(watchdog);
  console.log('\n清理临时资源…');
  await runCleanups();
}

console.log(`\n断言 ${checks} 条，失败 ${failures} 条`);
console.log(failures === 0 ? '整体：PASS' : '整体：FAIL');
// 信号路径已经在 await 同一个 cleanup Promise 并会自己 exit(1)，这里不抢先退出，
// 免得把它的收尾打断（清理本身已在上面 await 完成）。看门狗超时不走这条分支，
// 它没有自己的 exit，必须由这里给出非零码。
if (!signalExiting) process.exit(failures === 0 ? 0 : 1);
