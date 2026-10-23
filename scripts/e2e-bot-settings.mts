import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { botFields, runSettingsCli, type SettingsAction, type SettingsCliInput } from '../apps/server/src/settings-cli.js';
import { readLarkConfig } from '../apps/server/src/lark/config.js';
import type { LarkListenerPool } from '../apps/server/src/lark/listener.js';
import { createLarkManagementHarness } from './lark-management-harness.mts';
import { ArtifactLogger, captureBrowserArtifacts, getGitMetadata, installTermination, resolveArtifactDir, withTimeout } from './lark-e2e-shared.mts';

// This tests configuration delivery, not provider behavior or Feishu rendering.
// Platform HTTP, listener, ACP executable and native trust RPC are substitutes.
// Chromium, settings CLI, routes, validation, hook files and SQLite are real.
const apiOnly = process.argv.includes('--api-only');
const webRootIndex = process.argv.indexOf('--web-root');
const webRoot = resolve(webRootIndex < 0 ? 'apps/web/dist' : process.argv[webRootIndex + 1]!);
const artifactDir = await resolveArtifactDir('e2e-bot-settings');
const probeHome = await mkdtemp(join(tmpdir(), 'dutydeck-settings-codex-'));
const nativeTrust = (trusted: boolean) => writeFile(join(probeHome, 'hooks-probe-state.json'), JSON.stringify({ projectTrusted: true, hookTrustStatus: trusted ? 'trusted' : 'untrusted', report: resolve(artifactDir, 'native-probes.jsonl') }));
const logger = new ArtifactLogger(artifactDir);
const git = await getGitMetadata();
const startedAt = Date.now();
const results: string[] = [];
const coveredKeys: string[] = [];
const platformRequests: string[] = [];
const passed = (message: string) => { results.push(message); console.log(`PASS ${message}`); };
let harness: Awaited<ReturnType<typeof createLarkManagementHarness>> | undefined;
let browser: import('@playwright/test').Browser | undefined;
let context: import('@playwright/test').BrowserContext | undefined;
let page: import('@playwright/test').Page | undefined;
let cleanupPromise: Promise<void> | undefined;
const appId = 'cli_one';

async function cleanup(failed: boolean) {
  cleanupPromise ??= (async () => {
    try { await captureBrowserArtifacts(browser, context, artifactDir, { isFailure: failed }); }
    finally {
      try { await browser?.close(); }
      finally { await harness?.close(); await rm(probeHome, { recursive: true, force: true }); await logger.flush(); }
    }
  })();
  return withTimeout(cleanupPromise, 25_000, 'settings E2E cleanup');
}
async function report(ok: boolean, error?: unknown) {
  await writeFile(resolve(artifactDir, 'result.json'), JSON.stringify({
    scenario: 'e2e-bot-settings', boundary: 'synthetic_lark', passed: ok,
    testedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
    node: process.version, gitCommit: git.commit, gitDirty: git.dirty, apiOnly,
    externalBoundaries: 'synthetic Feishu HTTP, in-memory listener, fixture ACP executable and native Codex trust RPC; real Chromium, settings CLI, Fastify, hook files and disk SQLite',
    unverified: ['real provider/model execution', 'real Feishu delivery and card callbacks', 'runtime effect of saved settings'],
    configuredKeyCount: Object.keys(botFields).length, coveredKeys, platformRequests, results,
    ...(error ? { error: error instanceof Error ? error.stack : String(error) } : {})
  }, null, 2) + '\n');
}
const termination = installTermination('e2e-bot-settings', 180_000, async error => {
  await cleanup(true); await report(false, error); return {};
});

const platformFetch: typeof fetch = async input => {
  const url = new URL(String(input));
  assert(['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname), 'unexpected platform host');
  platformRequests.push(url.pathname);
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal/') return json({ code: 0, tenant_access_token: 'synthetic-settings-token', expire: 7200 });
  if (url.pathname === '/open-apis/bot/v3/info') return json({ code: 0, bot: { app_name: '开发助手', open_id: 'ou_bot_cli_one', activate_status: 2 } });
  if (url.pathname === '/open-apis/im/v1/chats') return json({ code: 0, data: { items: [{ chat_id: 'oc_project', name: '项目群' }], has_more: false } });
  if (url.pathname === '/open-apis/im/v1/chats/oc_project/members/list') return json({ code: 0, data: {
    users: url.searchParams.get('member_types') === 'bot' ? [] : [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_bob', name: 'Bob' }],
    bots: url.searchParams.get('member_types') === 'user' ? [] : [{ member_id: 'ou_peer', name: 'Peer', app_id: 'cli_peer' }], has_more: false
  } });
  if (url.pathname.startsWith('/open-apis/contact/v3/users/')) {
    const id = url.pathname.split('/').at(-1)!;
    return json({ code: 0, data: id === 'ou_foreign' ? {} : { user: { open_id: id, union_id: `on_${id.slice(3)}`, name: id === 'ou_bob' ? 'Bob' : 'Alice', email: 'alice@example.test' } } });
  }
  if (url.pathname === '/open-apis/contact/v3/scopes') return json({ code: 0, data: { user_ids: ['ou_alice'], has_more: false } });
  throw new Error(`Unimplemented synthetic Feishu endpoint: ${url.pathname}`);
};
function listenerFixture(): LarkListenerPool {
  let active: string[] = [];
  return { get listening() { return active.length > 0; }, get activeAppIds() { return active; },
    async sync(configs) { active = configs.filter(bot => bot.listening).map(bot => bot.appId); }, stop() { active = []; } };
}
async function boot(directory?: string) {
  return createLarkManagementHarness(apiOnly ? undefined : webRoot, directory, undefined,
    { fetcher: platformFetch, listener: listenerFixture(), listeningDisabled: false, agentAliases: ['codex', 'codex-acp', 'claude'], agentEnv: { CODEX_PATH: resolve('tests/fixtures/mock-codex-hooks.mjs'), CODEX_HOME: probeHome } });
}
async function request(method: string, path: string, body?: unknown) {
  termination.checkAborted();
  const response = await fetch(`${harness!.base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert(response.ok, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
async function bot() { return (await request('GET', '/api/lark/config')).bots.find((item: any) => item.appId === appId); }
async function cli(action: SettingsAction, input: SettingsCliInput = {}) {
  return runSettingsCli(action, { url: harness!.base, database: harness!.database, appId, ...input }, { readToken: () => undefined });
}
async function patch(fields: Record<string, unknown>) {
  return request('PUT', '/api/lark/config', { stage: 'agent', originalAppId: appId, expectedRevision: (await bot()).revision, ...fields });
}
const pair = (key: string, value: unknown) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`;
async function set(fields: Record<string, unknown>) { return cli('bot-set', { pairs: Object.entries(fields).map(([key, value]) => pair(key, value)) }); }
async function rejected(fields: Record<string, unknown>, code: string, status: number) {
  const before = await readLarkConfig(harness!.repositories.config, appId);
  const response = await fetch(`${harness!.base}/api/lark/config`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage: 'agent', originalAppId: appId, expectedRevision: before!.revision, ...fields }) });
  assert.equal(response.status, status, `must reject ${JSON.stringify(fields)}`);
  assert.equal((await response.json()).error.code, code);
  assert.deepEqual(await readLarkConfig(harness!.repositories.config, appId), before, 'failed save must be atomic');
}

type Case = { value: unknown; expected?: unknown; key?: string };
async function configurationMatrix() {
  const otherBotBefore = await readLarkConfig(harness!.repositories.config, 'cli_two');
  const fixture = (await harness!.repositories.agents.get('agent_one'))!;
  await harness!.repositories.agents.save({ ...fixture, id: 'terminal', name: 'Terminal fixture', protocol: 'pty-cli', adapterId: 'codex' });
  await set({ permissionMode: 'ask', fullTrustConfirmed: false, groupToolsEnabled: false });
  const workspace = harness!.workspaces[1]!;
  const alice = [{ openId: 'ou_alice', name: 'Alice' }];
  const bob = [{ openId: 'ou_bob', name: 'Bob' }];
  const peer = [{ openId: 'ou_peer', name: 'Peer' }];
  // Explicit cases, not generated from the implementation. New settings fail the
  // key equality assertion until their persistence/normalization is specified.
  const cases = {
    eventHandlers: { value: [{ id: 'settings', eventTypes: ['im.message.receive_v1'], url: 'http://127.0.0.1:14432/events', token: 'synthetic-handler-secret' }], expected: [{ id: 'settings', eventTypes: ['im.message.receive_v1'], url: 'http://127.0.0.1:14432/events' }] },
    cardActionForwarding: { value: { owner: 'settings-fixture', url: 'http://127.0.0.1:14432/cards', token: 'synthetic-forward-secret', legacyActions: ['ack'] }, expected: { owner: 'settings-fixture', url: 'http://127.0.0.1:14432/cards', legacyActions: ['ack'] } },
    welcomeEnabled: { value: false }, workspace: { value: workspace }, workspaceAliases: { value: { review: workspace } },
    webBaseUrl: { value: ' https://deck.example.test/ ', expected: 'https://deck.example.test' }, webMobileReachable: { value: false }, displayName: { value: ' 设置验收 ', expected: '设置验收' }, brand: { value: 'lark' },
    defaultAgentId: { value: 'codex' }, fallbackAgentId: { value: 'codex-acp' }, fallbackModel: { value: ' gpt-6.1-sol ', expected: 'gpt-6.1-sol' }, defaultAgentWeights: { value: [{ agentId: 'codex', weight: 3 }, { agentId: 'claude', weight: 7 }] }, defaultModel: { value: 'project-model' }, defaultReasoningEffort: { value: 'high' },
    permissionMode: { value: 'approve-reads' }, fullTrustConfirmed: { value: true }, roleTitle: { value: ' 值班 ', expected: '值班' }, roleScope: { value: ' 配置验收 ', expected: '配置验收' }, preInjectPrompt: { value: ' 先核对证据 ', expected: '先核对证据' }, verificationCommand: { value: ' node --version ', expected: 'node --version' }, listening: { value: true },
    mentionPolicy: { value: 'always' }, defaultGroupParticipation: { value: 'observe' }, p2pMode: { value: 'thread' }, groupReplyMode: { value: 'chat-topic' }, idleCompactEnabled: { value: false }, idleCompactHours: { value: 48 }, groupToolsEnabled: { value: true }, groupToolsAllowSend: { value: true },
    memoryEnabled: { value: true }, memoryAutoExtract: { value: false }, groupMemoryScope: { value: 'per-group' }, memoryAgentId: { value: 'agent_two' }, memoryModel: { value: 'review-model' }, busyTriage: { value: true }, decisionAgentId: { value: 'agent_two' }, decisionModel: { value: 'review-model' }, responseAgentId: { value: 'agent_one' }, responseModel: { value: 'project-model' },
    leaderAgentId: { value: 'agent_two' }, workerAgentIds: { value: ['agent_one'] }, executionMode: { value: 'layered' },
    structuredAskCards: { value: false }, groupCardMention: { value: false }, pushIntervalMs: { value: 1700 }, traceLimit: { value: 17 }, hideTraceOnComplete: { value: false }, compactTrace: { value: false }, showAgentName: { value: true }, completionReactionOnly: { value: true }, silentProgress: { value: true }, adhdMode: { value: true },
    urgentEnabled: { value: true }, urgentThresholdMs: { value: 120000 }, urgentMaxPerHourPerChat: { value: 2 }, notifyMentionAction: { value: false }, notifyMentionDone: { value: false }, notifyQuietHours: { value: '23:00-07:00' }, pinLongTasks: { value: true }, pinAfterMs: { value: 90000 },
    allowedUsers: { value: alice }, allowedUserNames: { value: ['Alice'], key: 'allowedUsers', expected: alice }, allowedEmails: { value: ['ALICE@EXAMPLE.TEST'], expected: ['alice@example.test'] }, allowedBots: { value: peer }, allowedBotNames: { value: ['Peer'], key: 'allowedBots', expected: peer }, peerBotsAllowed: { value: false },
    highRiskAllowedUsers: { value: bob }, highRiskAllowedUserNames: { value: ['Bob'], key: 'highRiskAllowedUsers', expected: bob }, highRiskAllowedEmails: { value: ['BOB@EXAMPLE.TEST'], expected: ['bob@example.test'] }, highRiskPattern: { value: 'DUTYDECK_RISK_CANARY' }, riskControlMode: { value: 'enforced' }
  } satisfies Record<keyof typeof botFields, Case>;
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(botFields).sort());
  for (const [key, scenario] of Object.entries(cases) as [string, Case][]) {
    // Names are input aliases. Clear the canonical list first so ignoring the
    // alias cannot pass merely because the preceding raw-ID case saved it.
    if (scenario.key) await set({ [scenario.key]: [] });
    if (key === 'cardActionForwarding' || key === 'webMobileReachable') {
      // Forwarding cannot coexist with handlers; unreachable mobile deliberately
      // clears the URL. Check their predecessors across a restart first.
      const before = await bot();
      const storedBefore = await readLarkConfig(harness!.repositories.config, appId);
      const directory = harness!.directory;
      await harness!.close(true); harness = await boot(directory);
      assert.deepEqual(await bot(), before);
      assert.deepEqual(await readLarkConfig(harness.repositories.config, appId), storedBefore);
      if (key === 'cardActionForwarding') await set({ eventHandlers: null });
    }
    if (key === 'riskControlMode') {
      const before = await bot();
      await nativeTrust(true);
      await cli('bot-install-hook', { prepare: true });
      assert.deepEqual(await bot(), before, 'hook preparation must not save the draft');
    }
    const saved = (await set({ [key]: scenario.value }) as { bot: Record<string, unknown> }).bot;
    const expected = Object.hasOwn(scenario, 'expected') ? scenario.expected : scenario.value;
    assert.deepEqual(saved[scenario.key ?? key], expected, `public ${key}`);
    const stored = await readLarkConfig(harness!.repositories.config, appId);
    // Tokens are intentionally absent from public results, but must remain in storage.
    assert.deepEqual((stored as any)[scenario.key ?? key], ['eventHandlers', 'cardActionForwarding'].includes(key) ? scenario.value : expected, `stored ${key}`);
    assert(!JSON.stringify(saved).includes('synthetic-handler-secret'));
    assert(!JSON.stringify(saved).includes('synthetic-forward-secret'));
    coveredKeys.push(key);
  }
  assert.equal((await bot()).webBaseUrl, undefined, 'mobile-unreachable explicitly clears the earlier URL');
  const stored = await readLarkConfig(harness!.repositories.config, appId);
  const publicBefore = await bot();
  await set({ preInjectPrompt: '无关字段保存后仍保留全部设置' });
  const publicAfter = await bot();
  assert.deepEqual({ ...publicAfter, revision: publicBefore.revision, preInjectPrompt: publicBefore.preInjectPrompt }, publicBefore);
  const directory = harness!.directory;
  await harness!.close(true);
  harness = await boot(directory);
  assert.deepEqual(await bot(), publicAfter, 'public configuration must survive server/runtime/repository recreation');
  assert.deepEqual(await readLarkConfig(harness.repositories.config, appId), { ...stored, revision: publicAfter.revision, preInjectPrompt: publicAfter.preInjectPrompt });
  assert.deepEqual(await readLarkConfig(harness.repositories.config, 'cli_two'), otherBotBefore, 'bot-scoped routing/models must not change another bot');
  const probes = (await readFile(resolve(artifactDir, 'native-probes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  for (const method of ['initialize', 'config/read', 'hooks/list']) assert(probes.some(probe => probe.method === method), `native readiness must perform ${method}`);
  assert(probes.every(probe => probe.codexHome === probeHome), 'native probes must use the isolated Codex home');
  passed(`${coveredKeys.length} explicit CLI → HTTP → public/storage cases survive partial saves and server recreation`);

  await set({ fallbackAgentId: 'claude' });
  assert.equal((await bot()).fallbackModel, undefined, 'changing fallback must clear the old fallback model');
  assert.equal((await bot()).defaultModel, 'project-model', 'fallback changes must preserve the primary model');
  await set({ fallbackAgentId: 'codex-acp', fallbackModel: 'gpt-6.1-sol' });

  await rejected({ fallbackAgentId: 'codex' }, 'INVALID_LARK_CONFIG', 400);
  await rejected({ defaultAgentWeights: [{ agentId: 'codex', weight: 0 }] }, 'INVALID_LARK_CONFIG', 400);
  await rejected({ defaultAgentWeights: [{ agentId: 'missing', weight: 1 }] }, 'RISK_CONTROL_HOOK_NOT_READY', 409);
  await rejected({ idleCompactHours: 0 }, 'INVALID_LARK_CONFIG', 400);
  await rejected({ pushIntervalMs: 499 }, 'INVALID_LARK_CONFIG', 400);
  await rejected({ traceLimit: 0 }, 'INVALID_LARK_CONFIG', 400);
  await rejected({ highRiskPattern: '[' }, 'INVALID_HIGH_RISK_PATTERN', 400);
  await rejected({ permissionMode: 'full-trust', fullTrustConfirmed: false }, 'LARK_FULL_TRUST_CONFIRMATION_REQUIRED', 409);
  await rejected({ permissionMode: 'sudo' }, 'INVALID_LARK_CONFIG', 400);
  await rejected({ riskControlMode: 'off', fallbackAgentId: 'terminal' }, 'LARK_APPROVAL_UNSUPPORTED', 422);
  await rejected({ executionMode: 'layered', workerAgentIds: [] }, 'INVALID_LARK_CONFIG', 400);
  await rejected({ executionMode: 'layered', groupToolsEnabled: false }, 'INVALID_LARK_CONFIG', 400);
  await assert.rejects(set({ allowedUsers: [], roleTitle: 'mixed stages' }), { code: 'SETTINGS_KEYS_CONFLICT' });
  const beforeConflict = await bot();
  await set({ roleTitle: 'new revision' });
  const conflict = await fetch(`${harness.base}/api/lark/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ originalAppId: appId, expectedRevision: beforeConflict.revision, roleTitle: 'stale' }) });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'LARK_CONFIG_REVISION_CONFLICT');
  assert.equal((await bot()).roleTitle, 'new revision');
  passed('invalid routing, full-trust consent, unsupported approval, layered prerequisites, ranges, regex and stale saves are rejected atomically');

  // Explicit clearing is different from omitting a field or submitting a default.
  await set({ riskControlMode: 'off', executionMode: 'single', fallbackAgentId: '', defaultAgentWeights: [], roleTitle: '', roleScope: '', memoryAgentId: '', memoryModel: '', decisionAgentId: '', decisionModel: '', responseAgentId: '', responseModel: '', workerAgentIds: [], workspaceAliases: {}, urgentThresholdMs: null, urgentMaxPerHourPerChat: null, pinAfterMs: null });
  const cleared = await bot();
  for (const key of ['fallbackAgentId', 'fallbackModel', 'defaultAgentWeights', 'roleTitle', 'roleScope', 'memoryAgentId', 'memoryModel', 'decisionAgentId', 'decisionModel', 'responseAgentId', 'responseModel', 'workspaceAliases', 'urgentThresholdMs', 'urgentMaxPerHourPerChat', 'pinAfterMs']) assert.equal(cleared[key], undefined, `clear ${key}`);
  assert.deepEqual(cleared.workerAgentIds, []);
  await set({ permissionMode: 'ask', fullTrustConfirmed: false });
  assert.equal((await bot()).fullTrustConfirmed, false, 'explicit false revokes saved full-trust consent');
  assert.equal((await bot()).permissionMode, 'ask');
  await set({ groupToolsEnabled: false });
  assert.equal((await bot()).groupToolsAllowSend, false, 'disabling group tools also disables send permission');
  await set({ groupToolsEnabled: true, groupToolsAllowSend: true });
  passed('explicit clears remove optional overrides, thresholds, aliases and stale fallback models');
}

async function browserChecks() {
  const { chromium, expect } = await import('@playwright/test');
  // Start the UI with ordinary defaults; all preceding matrix assertions remain recorded.
  await set({ permissionMode: 'ask', defaultAgentId: 'codex', listening: false, riskControlMode: 'off', memoryEnabled: false, adhdMode: false, busyTriage: false });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const nav = (label: string) => page!.getByRole('navigation', { name: '工作台', exact: true }).getByRole('button', { name: new RegExp(`^${label}`) });
  const openBot = async () => { await nav('机器人').click(); await page!.getByRole('button').filter({ has: page!.locator('strong', { hasText: /^开发助手$/ }) }).click(); };
  const save = () => page!.getByRole('button', { name: '保存配置', exact: true });
  const saveToApi = async () => {
    const response = page!.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/api/lark/config'));
    await save().click(); const result = await response; assert.equal(result.status(), 200); await expect(save()).toBeDisabled();
  };
  await page.goto(harness!.base);
  await openBot();
  await page.getByLabel('角色名称', { exact: true }).fill('浏览器角色');
  await page.getByLabel('负责范围', { exact: true }).fill('浏览器负责范围');
  await page.getByLabel('做法', { exact: true }).fill('浏览器证据要求');
  await page.getByLabel('默认工作目录', { exact: true }).fill(harness!.workspaces[0]!);
  await page.locator('#bot-fallback-agent').selectOption('codex-acp');
  await page.locator('#bot-fallback-model').fill('gpt-6.1-sol');
  await page.locator('#bot-p2p-mode').selectOption('chat');
  await page.getByRole('checkbox', { name: 'ADHD 友好输出', exact: true }).check();
  await page.getByRole('checkbox', { name: '忙时先判断', exact: true }).check();
  await page.getByRole('checkbox', { name: '启用会话记忆', exact: true }).check();
  await page.getByLabel('群记忆范围', { exact: true }).selectOption('shared');
  await page.locator('#bot-memory-agent').selectOption('agent_two');
  await page.getByLabel('整理模型', { exact: true }).fill('review-model');
  await page.getByRole('checkbox', { name: '空闲后自动压缩上下文', exact: true }).check();
  await page.getByRole('spinbutton', { name: '空闲时长（小时）', exact: true }).fill('72');
  await nav('全部任务').click(); await openBot();
  await expect(page.getByLabel('角色名称', { exact: true })).toHaveValue('浏览器角色');
  await expect(page.locator('#bot-fallback-model')).toHaveValue('gpt-6.1-sol');
  await saveToApi();
  const saved = await bot();
  const expected = { roleTitle: '浏览器角色', roleScope: '浏览器负责范围', preInjectPrompt: '浏览器证据要求', workspace: harness!.workspaces[0], fallbackAgentId: 'codex-acp', fallbackModel: 'gpt-6.1-sol', p2pMode: 'chat', adhdMode: true, busyTriage: true, idleCompactEnabled: true, idleCompactHours: 72, memoryEnabled: true, groupMemoryScope: 'shared', memoryAgentId: 'agent_two', memoryModel: 'review-model' };
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, saved[key]])), expected);
  passed('browser detail saves role, workspace, fallback, routing and presentation drafts through real HTTP');

  await page.getByLabel('角色名称', { exact: true }).fill('冲突草稿');
  await patch({ roleTitle: '并发服务端值' });
  const conflict = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/api/lark/config'));
  await save().click(); assert.equal((await conflict).status(), 409);
  await expect(page.getByText('别人刚改过这个机器人的配置', { exact: true })).toBeVisible();
  await expect(page.getByLabel('角色名称', { exact: true })).toHaveValue('冲突草稿');
  await page.getByRole('button', { name: /放弃.*载入最新/ }).click();
  await expect(page.getByLabel('角色名称', { exact: true })).toHaveValue('并发服务端值');
  passed('real API revision conflict preserves the browser draft and explicit reload restores current values');

  const draftWorkspace = resolve(harness!.directory, 'hook-draft');
  await mkdir(draftWorkspace);
  await nativeTrust(false);
  await page.getByLabel('默认工作目录', { exact: true }).fill(draftWorkspace);
  await page.getByRole('button', { name: '权限与风险控制', exact: true }).click();
  await page.locator('#bot-risk-mode').selectOption('enforced');
  const beforeHook = await bot();
  const failedSave = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/api/lark/config'));
  await save().click(); assert.equal((await failedSave).status(), 409);
  await expect(page.getByLabel('默认工作目录', { exact: true })).toHaveValue(draftWorkspace);
  await expect(page.getByText('别人刚改过这个机器人的配置', { exact: true })).toHaveCount(0);
  const hookResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/lark/hooks/install'));
  await page.getByRole('button', { name: '配置拦截 Hook', exact: true }).click(); assert.equal((await hookResponse).status(), 200);
  assert.deepEqual(await bot(), beforeHook, 'browser hook preparation must preserve saved config/revision');
  assert((await readFile(resolve(draftWorkspace, '.codex/hooks.json'), 'utf8')).includes('dutydeck-lark-high-risk-guard-codex.mjs'));
  assert.equal((await request('GET', `/api/lark/hooks/status?appId=${appId}&agentId=codex-acp&workspace=${encodeURIComponent(draftWorkspace)}`)).nativeReady, false);
  const untrustedSave = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/api/lark/config'));
  await save().click();
  assert.equal((await untrustedSave).status(), 409, 'installed but untrusted native hook must still prevent save');
  assert.deepEqual(await bot(), beforeHook);
  await expect(page.getByLabel('默认工作目录', { exact: true })).toHaveValue(draftWorkspace);
  await nativeTrust(true);
  const rechecked = page.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/api/lark/hooks/status'));
  await page.getByRole('button', { name: '重新检查 Hook', exact: true }).click();
  assert.equal((await rechecked).status(), 200);
  await expect(page.getByText('已为 codex、codex-acp 配置拦截 Hook。', { exact: true })).toBeVisible();
  await saveToApi();
  assert.equal((await bot()).workspace, draftWorkspace); assert.equal((await bot()).riskControlMode, 'enforced');
  passed('missing and installed-but-untrusted hooks keep drafts and saved revisions; native trust recheck permits enforced save');

  await page.getByRole('button', { name: '重新绑定 / 更新凭据', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('summary').filter({ hasText: '访问范围与高级设置' }).click();
  await dialog.getByLabel('验证命令（可选）', { exact: true }).fill('node -p 42');
  await dialog.getByLabel('免打扰时段（可选）', { exact: true }).fill('21:00-06:00');
  await dialog.locator('#lark-switch-agent-name').click();
  await dialog.locator('#lark-switch-compact-trace').click();
  const wizardSave = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/api/lark/config'));
  await dialog.getByRole('button', { name: '下一步', exact: true }).click(); assert.equal((await wizardSave).status(), 200);
  assert.equal((await bot()).verificationCommand, 'node -p 42'); assert.equal((await bot()).notifyQuietHours, '21:00-06:00');
  assert.equal((await bot()).showAgentName, false); assert.equal((await bot()).compactTrace, true);
  await dialog.getByRole('button', { name: '完成配置', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload(); await openBot();
  await expect(page.getByLabel('角色名称', { exact: true })).toHaveValue('并发服务端值');
  assert.equal((await bot()).workspace, draftWorkspace);
  assert.deepEqual(errors, []);
  passed('setup wizard saves advanced notification, verification and card settings without losing detail settings');
}

try {
  harness = await boot();
  await configurationMatrix();
  if (!apiOnly) await browserChecks();
  await rejected({ groupReplyMode: 'reply' }, 'INVALID_LARK_CONFIG', 400);
  await rejected({ p2pMode: 'reply' }, 'INVALID_LARK_CONFIG', 400);
  passed('invalid direct-API routing enums are rejected without clearing saved routing');
  termination.checkAborted();
  await cleanup(false); termination.dispose(); await report(true);
  console.log(`RESULT ${resolve(artifactDir, 'result.json')}`);
} catch (error) {
  console.error(error);
  try { await cleanup(true); } catch (cleanupError) { console.error(cleanupError); }
  termination.dispose(); await report(false, error); process.exitCode = 1;
} finally { logger.uninstall(); }
