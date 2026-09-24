// 卡片「查看详情」一次性登录链接的浏览器验收：管理员点按钮 → 私信里拿到链接 → 未登录的浏览器打开后直接看到会话页。
// 边界：飞书 transport 与 Agent driver 为进程内合成；Chromium、Fastify HTTP、SQLite、Runtime 与 Web 构建产物都是真实的。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import { buildApp } from '../apps/server/src/app.js';
import { LoginLinkStore } from '../apps/server/src/auth/auth.js';
import { readLarkConfig, saveLarkConfig } from '../apps/server/src/lark/config.js';
import { LarkMessageCoordinator, type LarkMessageEvent, type PersistedLarkCardTask } from '../apps/server/src/lark/listener.js';
import { buildLarkCard } from '../apps/server/src/lark/service.js';
import { ArtifactLogger, captureBrowserArtifacts, getGitMetadata, installTermination, resolveArtifactDir, withTimeout } from './lark-e2e-shared.mts';

const scenario = 'e2e-lark-detail-login';
const startTime = Date.now();
const results: string[] = [];
const passed = (message: string) => { results.push(message); console.log(`PASS ${message}`); };
const artifactDir = await resolveArtifactDir(scenario);
const logger = new ArtifactLogger(artifactDir);
const gitMeta = await getGitMetadata();
const TOKEN = 'e2e-access-token-0123456789abcdefghijklmnop';
const REPLY = '详情页应当显示的这一轮回复';

let directory: string | undefined;
let repos: ReturnType<typeof createRepositories> | undefined;
let runtime: DutydeckRuntime | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let coordinator: LarkMessageCoordinator | undefined;
let browser: import('@playwright/test').Browser | undefined;
let context: import('@playwright/test').BrowserContext | undefined;
let cleanupPromise: Promise<void> | undefined;
let cleanupFailure: Error | undefined;

const doCleanup = async (isFailure: boolean) => {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const step = async (label: string, work: () => Promise<unknown> | unknown) => {
      try { await withTimeout(Promise.resolve().then(work), 10_000, label); }
      catch (error: any) { if (!cleanupFailure) cleanupFailure = error; }
    };
    await step('captureBrowserArtifacts', () => captureBrowserArtifacts(browser, context, artifactDir, { isFailure }));
    await step('browser.close', () => browser?.close());
    await step('coordinator.stop', () => coordinator?.stop());
    await step('app.close', () => app?.close());
    await step('runtime.shutdown', () => runtime?.shutdown());
    await step('repos.close', () => repos?.close());
    await step('rm', () => directory && rm(directory, { recursive: true, force: true }));
    await logger.flush().catch(() => {});
  })();
  return cleanupPromise;
};

async function writeResultFile(passedFlag: boolean, err?: Error) {
  await writeFile(resolve(artifactDir, 'result.json'), JSON.stringify({
    scenario, boundary: 'synthetic_lark', testedAt: new Date().toISOString(), node: process.version,
    gitCommit: gitMeta.commit, gitDirty: gitMeta.dirty, passed: passedFlag, durationMs: Date.now() - startTime, results,
    externalBoundaries: 'synthetic Feishu transport and in-process agent driver; real Chromium/Fastify/SQLite/Runtime/Web build',
    artifactDir, ...(err ? { error: err.stack || err.message } : {})
  }, null, 2) + '\n', 'utf8').catch(() => {});
}

const termination = installTermination(scenario, 150_000, async err => {
  await doCleanup(true);
  await writeResultFile(false, err);
  return { cleanupFailed: Boolean(cleanupFailure) };
});

async function runTest() {
  directory = await mkdtemp(join(tmpdir(), 'dutydeck-detail-login-e2e-'));
  const workspace = join(directory, 'project');
  await mkdir(workspace, { recursive: true });
  repos = createRepositories(join(directory, 'state.sqlite'), { mode: 'runtime', newDatabaseAuthority: 'ledger_v1' });
  runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, emit) => {
      const driver: AgentDriver = {
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
        send: async () => {
          emit({ type: 'text', data: { text: REPLY } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        }
      };
      return driver;
    }
  });
  // driver 由 driverFactory 合成；命令只会被 Web 的模型探测调用，必须立即退出，否则子进程会一直挂着。
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: ['-e', 'process.exit(0)'], protocol: 'acp', cwd: workspace, env: {}, permissionMode: 'ask', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false };
  await repos.agents.save(agent);
  await runtime.initialize([agent]);

  const loginLinks = new LoginLinkStore();
  app = await buildApp(runtime, {
    webRoot: resolve('apps/web/dist'),
    auth: { mode: 'token', getToken: async () => TOKEN, localOnly: false, loginLinks },
    lark: { config: repos.config, agents: repos.agents, runtime, listeningDisabled: true }
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing acceptance server address');
  const base = `http://127.0.0.1:${address.port}`;

  await saveLarkConfig(repos.config, repos.agents, {
    appId: 'cli_detail', appSecret: 'synthetic_cli_detail', name: '详情助手', defaultAgentId: agent.id, workspace,
    fullTrustConfirmed: true, listening: true, webBaseUrl: base, allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }]
  });
  const config = (await readLarkConfig(repos.config, 'cli_detail'))!;

  const deliveries: Array<{ operation: string; input: any; messageId: string }> = [];
  let sequence = 0;
  const deliver = (operation: string) => async (input: any) => {
    const messageId = operation === 'update' ? input.messageId : `om_card_${++sequence}`;
    deliveries.push({ operation, input, messageId });
    return { messageId, chatId: input.chatId };
  };
  const members = async () => ({ items: [{ memberId: 'ou_alice', openId: 'ou_alice', name: 'Alice', memberType: 'user' }], hasMore: false, securityLimited: false });
  const client: any = {
    send: deliver('send'), reply: deliver('reply'), update: deliver('update'),
    addReaction: async () => ({ reactionId: 'reaction' }), deleteReaction: async () => {}, getUserEmails: async () => [],
    listChatMembers: members, listChatMessages: async () => ({ items: [], hasMore: false }), getMessageItems: async () => []
  };
  const failures: unknown[] = [];
  const log = { info() {}, warn(details: unknown) { failures.push(details); }, error(details: unknown) { failures.push(details); } };
  coordinator = new LarkMessageCoordinator(runtime, client, log, Math.random, 'ou_bot', undefined, repos.channelMappings, async () => 'group', undefined, undefined,
    { store: repos.config, loginLinks });
  await coordinator.initializeWorkflows(config);

  const event: LarkMessageEvent = { messageId: 'om_task', chatId: 'oc_project', chatType: 'group', messageType: 'text', content: JSON.stringify({ text: '检查构建并汇报' }),
    senderOpenId: 'ou_alice', senderType: 'user', mentions: [{ key: '@bot', name: 'Bot', openId: 'ou_bot', mentionedType: 'bot' }] };
  await coordinator.handle(event, config);
  const deadline = Date.now() + 30_000;
  let mapping: { sessionId: string; extra: PersistedLarkCardTask } | undefined;
  while (Date.now() < deadline) {
    termination.checkAborted();
    const [row] = await repos.channelMappings.list('lark-card:cli_detail');
    const extra = row?.extra ? JSON.parse(row.extra) as PersistedLarkCardTask : undefined;
    if (row && extra?.final_delivery_state === 'delivered') { mapping = { sessionId: row.sessionId, extra }; break; }
    await new Promise(r => setTimeout(r, 100));
  }
  assert(mapping, 'task result was not delivered');
  const resultInput = deliveries.filter(item => item.messageId === mapping!.extra.final_message_id).at(-1)!.input;
  const button = JSON.stringify(buildLarkCard(resultInput)).includes('"element_id":"detail"');
  assert(button, 'result card must render 查看详情 as a callback button');
  assert(!JSON.stringify(buildLarkCard(resultInput)).includes(`/sessions/${mapping.sessionId}`), 'result card must not carry the session URL');
  passed('token 模式下结果卡的「查看详情」是回调按钮，卡上不带会话链接');

  const groupBefore = deliveries.filter(item => item.operation !== 'send' || item.input.chatId).length;
  const toast = await coordinator.handleAction({ action: 'detail', task_id: 'om_task', turn: String(mapping.extra.turn) }, 'ou_alice',
    { messageId: mapping.extra.final_message_id, chatId: 'oc_project' });
  assert.deepEqual(toast, { type: 'success', content: '已私信你一个 10 分钟内有效的登录链接' });
  assert.equal(deliveries.filter(item => item.operation !== 'send' || item.input.chatId).length, groupBefore, 'no group message after the click');
  const dm = deliveries.filter(item => item.operation === 'send' && item.input.receiveId === 'ou_alice');
  assert.equal(dm.length, 1);
  const url = /"default_url":"([^"]+)"/.exec(JSON.stringify(buildLarkCard(dm[0]!.input)))?.[1];
  assert(url?.startsWith(`${base}/api/auth/link?code=`), `unexpected login link: ${url}`);
  passed('管理员点击后只收到一条私信，里面是一次性登录链接');

  const { chromium } = await import('@playwright/test');
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  await page.goto(`${base}/sessions/${encodeURIComponent(mapping.sessionId)}`);
  await page.getByLabel('访问令牌').waitFor({ timeout: 15_000 });
  passed('未登录的浏览器直接打开会话页只看到登录门');

  // 从另一个来源点链接（模拟从飞书跳出），检验 SameSite=Strict cookie 在跨站跳转后仍能让会话页取到数据。
  await page.goto('about:blank');
  await page.setContent(`<a id="open" href="${url}">打开任务详情</a>`);
  await page.click('#open');
  await page.waitForURL(`${base}/sessions/${encodeURIComponent(mapping.sessionId)}`, { timeout: 15_000 });
  await page.getByText(REPLY).first().waitFor({ timeout: 15_000 });
  assert.equal(await page.getByLabel('访问令牌').count(), 0, 'login gate must be gone after redeeming the link');
  const cookie = (await context.cookies(base)).find(item => item.name === 'dutydeck_access');
  assert(cookie?.httpOnly && cookie.sameSite === 'Strict' && cookie.value === TOKEN, 'redeemed cookie must match /api/auth/login');
  passed('打开链接后跳到该会话页并直接显示内容，cookie 与 /api/auth/login 相同');

  const replay = await (await browser.newContext()).newPage();
  const response = await replay.goto(url!);
  assert.equal(response?.status(), 400);
  await replay.getByText('登录链接已失效').waitFor({ timeout: 5_000 });
  assert.equal((await replay.context().cookies(base)).length, 0);
  passed('同一链接第二次打开只看到失效页，不再发 cookie');
  assert.equal(failures.length, 0, `unexpected warnings: ${JSON.stringify(failures)}`);
}

try {
  await runTest();
  termination.checkAborted();
  await doCleanup(false);
  if (cleanupFailure) throw new Error(`Cleanup failed after run: ${cleanupFailure.message}`);
  termination.dispose();
  await writeResultFile(true);
  console.log(`RESULT ${resolve(artifactDir, 'result.json')}`);
} catch (error: any) {
  const finalError = termination.error ?? error;
  console.error(`${scenario} failure:`, finalError);
  await doCleanup(true);
  await writeResultFile(false, finalError);
  process.exit(1);
}
