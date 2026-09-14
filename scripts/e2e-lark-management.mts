import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createLarkManagementHarness, createSyntheticTransportState } from './lark-management-harness.mts';
import {
  resolveArtifactDir,
  getGitMetadata,
  ArtifactLogger,
  captureBrowserArtifacts,
  withTimeout,
  installTermination,
} from './lark-e2e-shared.mts';

const apiOnly = process.argv.includes('--api-only');
const startTime = Date.now();
const results: string[] = [];
const passed = (message: string) => { results.push(message); console.log(`PASS ${message}`); };

const waitFor = async (label: string, predicate: () => Promise<unknown>, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checkAborted();
    const value = await predicate();
    if (value) return value;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out: ${label}`);
};

const groupPath = (app: string, chat: string) => `/api/lark/bots/${app}/groups/${chat}`;

const artifactDir = await resolveArtifactDir('e2e-lark-management');
const logger = new ArtifactLogger(artifactDir);
const gitMeta = await getGitMetadata();

let cleanupPromise: Promise<void> | undefined;
let cleanupFailure: Error | undefined;

const doCleanup = async (isFailure: boolean) => {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    try {
      await withTimeout(
        captureBrowserArtifacts(browser, context, artifactDir, { isFailure }),
        10_000,
        'captureBrowserArtifacts'
      );
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    try {
      if (page && !page.isClosed()) await withTimeout(page.close(), 5_000, 'page.close');
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    try {
      if (context) await withTimeout(context.close(), 5_000, 'context.close');
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    try {
      if (browser) await withTimeout(browser.close(), 5_000, 'browser.close');
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    try {
      if (harness) await withTimeout(harness.close(), 10_000, 'harness.close');
    } catch (e: any) {
      if (!cleanupFailure) cleanupFailure = e;
    }
    await logger.flush().catch(() => {});
  })();
  return cleanupPromise;
};

const termination = installTermination('e2e-lark-management', 180_000, async err => {
  await doCleanup(true);
  await writeResultFile(false, err);
  return { cleanupFailed: Boolean(cleanupFailure) };
});

const checkAborted = () => termination.checkAborted();

const transportState = createSyntheticTransportState();
let harness: Awaited<ReturnType<typeof createLarkManagementHarness>> | undefined;
let browser: import('@playwright/test').Browser | undefined;
let context: import('@playwright/test').BrowserContext | undefined;
let page: import('@playwright/test').Page | undefined;

let observedProcesses: any[] = [];

async function writeResultFile(passedFlag: boolean, err?: Error) {
  const resultPayload = {
    scenario: 'e2e-lark-management',
    boundary: 'synthetic_lark' as const,
    testedAt: new Date().toISOString(),
    node: process.version,
    gitCommit: gitMeta.commit,
    gitDirty: gitMeta.dirty,
    passed: passedFlag,
    durationMs: Date.now() - startTime,
    apiOnly,
    results,
    externalBoundaries: 'synthetic Feishu transport and test CLI; real browser/API/SQLite/AcpxAdapter',
    observedProcesses: observedProcesses.length > 0 ? observedProcesses : (harness ? (await harness.observations().catch(() => [])).map(({ agent, pid, cwd, model, turn }) => ({ agent, pid, cwd, model, turn })) : []),
    artifactDir,
    ...(err ? { error: err.stack || err.message } : {})
  };
  await writeFile(resolve(artifactDir, 'result.json'), JSON.stringify(resultPayload, null, 2) + '\n', 'utf8').catch(() => {});
}

async function runTest() {
  harness = await createLarkManagementHarness(apiOnly ? undefined : resolve('apps/web/dist'), undefined, transportState);
  checkAborted();

  const request = async (method: string, path: string, body?: unknown) => {
    checkAborted();
    const response = await fetch(`${harness!.base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert(response.ok, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
  };

  // Browser work uses these same real APIs and SQLite, never route.fulfill mocks.
  if (!apiOnly) {
    const { chromium, expect } = await import('@playwright/test');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const nav = (label: string) => page!.getByRole('navigation', { name: '工作台', exact: true }).getByRole('button', { name: new RegExp(`^${label}`) });
    const groupRow = () => page!.getByRole('button').filter({ has: page!.locator('strong', { hasText: /^项目群$/ }) });
    const binding = async () => (await request('GET', '/api/lark/management/groups')).groups.find((g: any) => g.chatId === 'oc_project').bots.find((b: any) => b.appId === 'cli_one');
    assert.deepEqual((await request('GET', '/api/lark/management/groups')).groups, []);
    const syncRequests: string[] = [];
    page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/sync-groups')) syncRequests.push(new URL(req.url()).pathname); });
    await page.goto(harness.base);
    await nav('群聊').click();
    await expect(page.getByRole('heading', { name: '群聊管理', exact: true })).toBeVisible();
    await waitFor('browser syncs every configured Bot', async () => (await request('GET', '/api/lark/management/groups')).groups.every((g: any) => g.bots.length === 2) && (await request('GET', '/api/lark/management/groups')).groups.length === 2);
    assert.deepEqual(syncRequests, ['/api/lark/bots/cli_one/sync-groups', '/api/lark/bots/cli_two/sync-groups']);
    passed('entering the group page automatically discovers every configured Bot without clicking sync');
    await groupRow().click();
    await expect(page.getByRole('heading', { name: '项目群 / 开发助手', exact: true })).toBeVisible();
    await page.locator('input[name="agentMode"]').nth(1).check();
    await page.getByRole('button', { name: '开发 Agent', exact: true }).click();
    await page.getByRole('option', { name: '开发 Agent', exact: true }).click();
    await page.locator('input[name="workspaceMode"]').nth(1).check();
    await page.getByRole('button', { name: '浏览', exact: true }).click();
    const directory = page.getByRole('dialog', { name: '选择服务器目录', exact: true });
    await directory.getByRole('button', { name: harness.workspaces[0], exact: true }).click();
    await expect(directory.getByText(harness.workspaces[0]!, { exact: true }).first()).toBeVisible();
    await directory.getByRole('button', { name: '选择此目录', exact: true }).click();
    await expect(page.getByTestId('directory-picker').getByRole('textbox')).toHaveValue(harness.workspaces[0]!);
    await expect(page.getByRole('button', { name: '本机选择', exact: true })).toHaveCount(0);
    await page.locator('input[name="modelMode"]').nth(2).check();
    await page.getByRole('button', { name: '选择模型…', exact: true }).click();
    await page.getByRole('option', { name: 'project-model', exact: true }).click();
    // A real navigation unmounts the editor; returning must retain the draft.
    await nav('任务').click(); await nav('群聊').click();
    await groupRow().click();
    await expect(page.getByTestId('directory-picker').getByRole('textbox')).toHaveValue(harness.workspaces[0]!);
    await expect(page.getByRole('button', { name: 'project-model', exact: true })).toBeVisible();
    const saveButton = () => page!.getByRole('button', { name: /^保存.*配置$/ }).last();
    await saveButton().click();
    await waitFor('browser group save persisted', async () => (await binding()).binding?.modelOverride.value === 'project-model');
    await expect(saveButton()).toBeDisabled();
    passed('browser navigation, server directory picker and group overrides persist through real HTTP and SQLite');

    await page.getByRole('button', { name: '配置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '项目群 / 评审助手', exact: true })).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get('appId'), 'cli_two');
    await page.reload();
    await expect(page.getByRole('heading', { name: '项目群 / 评审助手', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '配置', exact: true }).click();
    await page.locator('input[name="modelMode"]').nth(1).check();
    await saveButton().click();
    await waitFor('explicit clear saved from browser', async () => (await binding()).binding.modelOverride.mode === 'clear');
    await expect(saveButton()).toBeDisabled();
    await page.locator('input[name="modelMode"]').nth(0).check();
    await saveButton().click();
    await waitFor('inheritance restored from browser', async () => (await binding()).binding.modelOverride.mode === 'inherit');
    await expect(saveButton()).toBeDisabled();
    passed('browser distinguishes Bot selection, explicit model clear and restore inheritance; refresh preserves the selected Bot');

    const beforeConflict = await binding();
    await page.getByTestId('directory-picker').getByRole('textbox').fill(harness.workspaces[1]!);
    await request('PUT', groupPath('cli_one', 'oc_project'), { expectedRevision: beforeConflict.binding.revision, patch: { oncall: true } });
    const refreshed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/cli_two/sync-groups'));
    await page.getByRole('button', { name: '同步群聊', exact: true }).click();
    assert.equal((await refreshed).status(), 200);
    await expect(page.getByRole('button', { name: '同步群聊', exact: true })).toBeEnabled();
    const conflicted = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(groupPath('cli_one', 'oc_project')));
    await saveButton().click(); assert.equal((await conflicted).status(), 409);
    await expect(page.getByText('别人刚改过这个群的设置', { exact: true })).toBeVisible();
    await expect(page.getByTestId('directory-picker').getByRole('textbox')).toHaveValue(harness.workspaces[1]!);
    assert.equal((await binding()).binding.workspaceOverride.value, harness.workspaces[0]);
    await page.getByRole('button', { name: /放弃.*载入最新/ }).click();
    await expect(page.getByTestId('directory-picker').getByRole('textbox')).toHaveValue(harness.workspaces[0]!);
    passed('browser background refresh cannot overwrite a newer revision; conflict retains the draft and reload restores server values');

    await nav('机器人').click();
    await page.getByRole('button').filter({ has: page.locator('strong', { hasText: /^开发助手$/ }) }).click();
    await page.getByLabel('默认工作目录', { exact: true }).fill(harness.workspaces[1]!);
    await nav('任务').click(); await nav('机器人').click();
    await page.getByRole('button').filter({ has: page.locator('strong', { hasText: /^开发助手$/ }) }).click();
    await expect(page.getByLabel('默认工作目录', { exact: true })).toHaveValue(harness.workspaces[1]!);
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await waitFor('browser Bot defaults save', async () => (await request('GET', '/api/lark/config')).bots.find((bot: any) => bot.appId === 'cli_one').workspace === harness!.workspaces[1]);
    await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
    await page.screenshot({ path: resolve(artifactDir, 'bots-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '返回机器人列表', exact: true }).click();
    await page.getByRole('button').filter({ has: page.locator('strong', { hasText: /^评审助手$/ }) }).click();
    await expect(page.getByRole('heading', { name: '评审助手', exact: true })).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Bot editor overflows viewport');
    await page.goto(`${harness.base}/?nav=groups&chatId=oc_project&appId=cli_one`);
    await expect(page.getByRole('heading', { name: '项目群 / 开发助手', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回群聊列表', exact: true }).click();
    await groupRow().click();
    await expect(page.getByRole('heading', { name: '项目群 / 开发助手', exact: true })).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Group editor overflows viewport');
    const syncBounds = await page.getByRole('button', { name: '同步群聊', exact: true }).boundingBox();
    assert(syncBounds && syncBounds.x >= 0 && syncBounds.x + syncBounds.width <= 390, 'Sync button is clipped on mobile');
    await page.locator('input[name="modelMode"]').nth(1).check();
    await saveButton().click();
    await waitFor('mobile editor saves', async () => (await binding()).binding.modelOverride.mode === 'clear');
    await expect(saveButton()).toBeDisabled();
    const saveBounds = await saveButton().boundingBox();
    assert(saveBounds && saveBounds.x >= 0 && saveBounds.x + saveBounds.width <= 390, 'Save button is clipped on mobile');
    await page.getByRole('heading', { name: '项目群', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(artifactDir, 'groups-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 980 });
    await expect.poll(async () => (await page!.getByRole('complementary', { name: 'Dutydeck 工作台导航' }).boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: resolve(artifactDir, 'groups-desktop.png') });
    assert.deepEqual(errors, []);
    passed('Bot defaults retain drafts and save directly; 390 px Bot/group list-detail navigation works without horizontal overflow');
    // Note: browser is kept alive across the remaining steps to preserve live context and trace!
  }

  checkAborted();
  await request('POST', '/api/lark/bots/cli_one/sync-groups', {});
  await request('POST', '/api/lark/bots/cli_two/sync-groups', {});
  const discovered = await request('GET', '/api/lark/management/groups');
  assert.equal(discovered.groups.length, 2);
  assert(discovered.groups.every((group: any) => group.bots.length === 2));
  passed('two Bots × two groups discovered from the live API');

  const samples = [
    { app: 'cli_one', chat: 'oc_project', agent: 'agent_one', cwd: harness.workspaces[0]!, model: 'project-model' },
    { app: 'cli_one', chat: 'oc_oncall', agent: 'agent_two', cwd: harness.workspaces[1]!, model: 'review-model' },
    { app: 'cli_two', chat: 'oc_project', agent: 'agent_two', cwd: harness.workspaces[1]!, model: 'review-model' },
    { app: 'cli_two', chat: 'oc_oncall', agent: 'agent_one', cwd: harness.workspaces[0]!, model: 'project-model' }
  ];
  const saved = new Map<string, any>();
  const events = [];
  for (const sample of samples) {
    const key = `${sample.app}/${sample.chat}`;
    const before = (await request('GET', '/api/lark/management/groups')).groups.find((g: any) => g.chatId === sample.chat).bots.find((b: any) => b.appId === sample.app);
    saved.set(key, await request('PUT', groupPath(sample.app, sample.chat), { expectedRevision: before.binding?.revision ?? 0, patch: { workspaceOverride: { mode: 'set', value: sample.cwd }, agentOverride: { mode: 'set', value: sample.agent }, modelOverride: { mode: 'set', value: sample.model } } }));
    events.push(await harness.ingress(sample.app, { chatId: sample.chat, content: JSON.stringify({ text: key }) }));
  }
  await waitFor('four real ACP CLI executions', async () => (await harness!.observations()).length === 4);
  const observations = await harness.observations();
  for (const sample of samples) {
    const observed = observations.find(item => item.prompt.includes(`${sample.app}/${sample.chat}`));
    assert(observed, `Missing CLI output for ${sample.app}/${sample.chat}`);
    assert.equal(observed.agent, sample.agent); assert.equal(observed.cwd, sample.cwd); assert.equal(observed.model, sample.model); assert(observed.pid > 0);
  }

  // 1. Await 4 distinct result replies, each carrying final_output
  const resultCards = () => harness!.deliveries.filter(item =>
    item.operation === 'reply' &&
    item.input.state === 'completed' &&
    item.input.elements?.some((el: any) => el.element_id === 'final_output')
  );
  await waitFor('four outbound final result cards', async () => resultCards().length === 4);
  const finalDeliveries = resultCards();

  // 2. Validate content and delivery matching for each task
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    const targetMessageId = events[i]!.messageId;
    const matched = finalDeliveries.find(item =>
      item.appId === sample.app &&
      item.input.messageId === targetMessageId &&
      item.input.elements.some((el: any) => el.element_id === 'final_output' && typeof el.content === 'string' && el.content.includes(`ACCEPTED ${sample.agent} ${sample.model} ${sample.cwd}`))
    );
    assert(matched, `Missing expected final result card for ${sample.app}/${sample.chat}`);
    assert(matched.messageId !== targetMessageId, 'Result reply must return a new message id, not the reply target id');
    assert(typeof matched.input.idempotencyKey === 'string' && matched.input.idempotencyKey.length > 0, 'Result reply must carry an idempotency key');

    // 3. Verify durable channel mappings record final_delivery_state: 'delivered' and progress_frozen: true
    const mappings = await harness!.repositories.channelMappings.list(`lark-card:${sample.app}`);
    const deliveredMapping = mappings.find(m => {
      try {
        const extra = JSON.parse(m.extra ?? '{}');
        return extra.chat_id === sample.chat && extra.state === 'completed' && extra.final_delivery_state === 'delivered' && extra.progress_frozen === true;
      } catch {
        return false;
      }
    });
    assert(deliveredMapping, `Missing delivered and frozen channel mapping for ${sample.app}/${sample.chat}`);

    // 4. Verify process card ID was updated to completed state
    const mappingExtra = JSON.parse(deliveredMapping.extra!);
    assert.equal(mappingExtra.final_message_id, matched.messageId, `Persisted final_message_id must match the delivered result card for ${sample.app}/${sample.chat}`);
    const processCardId = mappingExtra.card_message_id;
    assert(processCardId, `Missing process card ID in mapping for ${sample.app}/${sample.chat}`);
    const processCardUpdate = harness!.deliveries.find(item =>
      item.operation === 'update' &&
      item.messageId === processCardId &&
      item.input.state === 'completed'
    );
    assert(processCardUpdate, `Missing process card freeze update for ${sample.app}/${sample.chat}`);
  }

  // 5. Explicitly trigger and verify an idempotent replay request using the delivery's own app and
  // original request payload (async completion order is not assumed). The replay must return the
  // identical platform message ID and be served from the idempotency cache.
  const sampleToReplay = finalDeliveries[0]!;
  const originalReplayId = sampleToReplay.messageId;
  const replayResponse = await harness!.syntheticClient(sampleToReplay.appId).reply(sampleToReplay.input);
  assert.equal(replayResponse.messageId, originalReplayId, 'Idempotency replay must return the identical message ID');
  const lastRecordedDelivery = harness!.deliveries.at(-1)!;
  assert.equal(lastRecordedDelivery.cached, true, 'Replay request must be served from idempotency cache');
  assert.equal(lastRecordedDelivery.messageId, originalReplayId);

  passed('real AcpxAdapter spawns CLI with independent Agent, model and cwd; results reach outbound cards');

  checkAborted();
  const first = events[0]!;
  const firstSaved = saved.get('cli_one/oc_project');
  const changed = await request('PUT', groupPath('cli_one', 'oc_project'), { expectedRevision: firstSaved.binding.revision, patch: { workspaceOverride: { mode: 'set', value: harness.workspaces[1] }, modelOverride: { mode: 'clear' } } });
  await harness.ingress('cli_one', { rootId: first.messageId, threadId: 'omt_first', mentions: [], content: '{"text":"continue-owned-topic"}' });
  await waitFor('topic continuation', async () => (await harness!.observations()).length === 5);
  const continued = (await harness.observations()).at(-1);
  assert.equal(continued.cwd, harness.workspaces[0]); assert.equal(continued.model, 'project-model'); assert.equal(continued.turn, 2);
  await harness.ingress('cli_two', { rootId: first.messageId, threadId: 'omt_first', mentions: [], content: '{"text":"must-not-wake-other-bot"}' });
  assert.equal((await harness.observations()).length, 5);
  passed('topic continuation retains old execution context and does not wake another Bot');
  await harness.ingress('cli_one', { content: '{"text":"new-default-after-clear"}' });
  await waitFor('new settings execution', async () => (await harness!.observations()).length === 6);
  const fresh = (await harness.observations()).at(-1);
  assert.equal(fresh.cwd, harness.workspaces[1]); assert.equal(fresh.model, 'model-default');
  passed('new topics use updated workspace and explicit model clear uses the Agent default');
  const stale = await fetch(`${harness.base}${groupPath('cli_one', 'oc_project')}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: firstSaved.binding.revision, patch: { oncall: true } }) });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).current.binding.revision, changed.binding.revision);
  passed('stale saves return conflict and the current public configuration');

  checkAborted();
  const persistedDirectory = harness.directory;
  await waitFor('all turns completed before restart', async () => (await harness!.runtime.listSessions()).every(session => session.state === 'completed'));
  await harness.close(true);
  harness = undefined;
  // Recreate harness preserving transportState and database directory across restart
  harness = await createLarkManagementHarness(apiOnly ? undefined : resolve('apps/web/dist'), persistedDirectory, transportState);
  await harness.ingress('cli_one', { rootId: first.messageId, threadId: 'omt_first', mentions: [], content: '{"text":"continue-after-restart"}' });
  await waitFor('persisted session resume', async () => (await harness!.observations()).length === 7);
  const resumed = (await harness.observations()).at(-1);
  assert.equal(resumed.cwd, harness.workspaces[0]); assert.equal(resumed.model, 'project-model'); assert.equal(resumed.turn, 3);
  passed('server restart preserves group settings and resumes the original topic through ACP persistence');

  checkAborted();
  const riskBot = (await request('GET', '/api/lark/config')).bots.find((bot: any) => bot.appId === 'cli_one');
  const nativeHookGate = await fetch(`${harness.base}/api/lark/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ originalAppId: 'cli_one', expectedRevision: riskBot.revision, riskControlMode: 'enforced', highRiskPattern: 'Edit' }) });
  assert.equal(nativeHookGate.status, 409);
  assert.equal((await nativeHookGate.json()).error.code, 'RISK_CONTROL_HOOK_NOT_READY');
  await harness.configureAcpRiskFixture();
  const riskGroup = (await request('GET', '/api/lark/management/groups')).groups.find((g: any) => g.chatId === 'oc_project').bots.find((b: any) => b.appId === 'cli_one');
  const bob = (await request('GET', `${groupPath('cli_one', 'oc_project')}/members`)).members.find((member: any) => member.openId === 'ou_bob');
  await request('PUT', groupPath('cli_one', 'oc_project'), { expectedRevision: riskGroup.binding.revision, patch: {}, roleChanges: [{ kind: 'create', principalId: bob.principalId, role: 'can_operate', operateScope: 'group_runs', actionGates: { terminalWrite: false, highRisk: true, groupToolsSend: false } }] });
  const held = await harness.ingress('cli_one', { content: '{"text":"hold-check-risk from Alice"}' });
  await waitFor('Alice active before Bob queues', async () => (await harness!.observations()).length === 8);
  await harness.ingress('cli_one', { rootId: held.messageId, threadId: 'omt_risk', senderOpenId: 'ou_bob', mentions: [], content: '{"text":"check-risk from Bob"}' });
  const heldSession = (await harness.runtime.listSessions()).find(session => session.sourceId?.includes(held.messageId))!;
  await waitFor('Bob actor persisted with queued task', async () => (await harness!.repositories.tasks.listBySession(heldSession.id)).some(task => task.status === 'queued' && task.executionContext?.actorId === 'ou_bob'));
  assert.equal((await harness.manager.riskPolicy(heldSession.id))?.authorized, false);
  await harness.releasePermission();
  await waitFor('both real ACP permission decisions', async () => (await harness!.permissions()).length === 2);
  assert.deepEqual((await harness.permissions()).map(result => result.optionId), ['deny', 'allow']);
  await waitFor('queued turn completed', async () => (await harness!.runtime.getSession(heldSession.id))?.state === 'completed');
  passed('real ACP permissions keep Alice denied while privileged Bob is queued; Bob gets his own permissions only when his persisted task starts');

  checkAborted();
  const oldSession = (await harness.runtime.listSessions()).find(session => session.sourceId?.includes(first.messageId) && session.sourceId.startsWith('cli_one:'))!;
  assert(oldSession);
  await request('POST', `/api/sessions/${oldSession.id}/send`, { prompt: 'dashboard owner continuation' });
  await waitFor('Dashboard owner continuation', async () => (await harness!.observations()).length === 10);
  const ownerTasks = await harness.repositories.tasks.listBySession(oldSession.id);
  assert(ownerTasks.some(task => task.prompt === 'dashboard owner continuation' && task.executionContext?.actorId === 'installation_owner'));
  passed('Dashboard continuation records its authenticated owner independently of Lark task senders');
  const verifiedExecutions = (await harness.observations()).length;
  const currentGroup = (await request('GET', '/api/lark/management/groups')).groups.find((g: any) => g.chatId === 'oc_project').bots.find((b: any) => b.appId === 'cli_one');
  const disabled = await request('PUT', groupPath('cli_one', 'oc_project'), { expectedRevision: currentGroup.binding.revision, patch: { accessOverride: { mode: 'disabled', principalIds: [] } } });
  const denied = await fetch(`${harness.base}/api/sessions/${oldSession.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'must-not-run-disabled-group' }) });
  assert.equal(denied.status, 403);
  assert.equal((await harness.manager.authorize('cli_one', 'oc_project', 'ou_alice', 'task.create'))?.allowed, false);
  await harness.ingress('cli_one', { content: '{"text":"must-not-run-disabled"}' });
  assert.equal((await harness.observations()).length, verifiedExecutions);
  await request('PUT', groupPath('cli_one', 'oc_project'), { expectedRevision: disabled.binding.revision, patch: { accessOverride: { mode: 'inherit', principalIds: [] }, oncall: false } });
  harness.memberIds.delete('ou_alice');
  assert.equal((await harness.manager.authorize('cli_one', 'oc_project', 'ou_alice', 'turn.append', oldSession.id))?.allowed, false);
  passed('group disablement blocks the real session API and ingress; a removed member loses access to the persisted session');

  observedProcesses = (await harness.observations().catch(() => [])).map(({ agent, pid, cwd, model, turn }) => ({ agent, pid, cwd, model, turn }));
}

try {
  await runTest();
  termination.checkAborted();
  await doCleanup(false);
  if (cleanupFailure) {
    throw new Error(`Cleanup failed after run: ${cleanupFailure.message}`);
  }
  termination.dispose();
  await writeResultFile(true);
  console.log(`RESULT ${resolve(artifactDir, 'result.json')}`);
} catch (error: any) {
  const finalError = termination.error ?? error;
  console.error('e2e-lark-management failure:', finalError);
  await doCleanup(true);
  await writeResultFile(false, finalError);
  process.exit(1);
}
