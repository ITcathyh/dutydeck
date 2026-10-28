import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchIsolatedTestServer, writeMockCli, REPO_ROOT, type TestServerInstance } from './harness.js';

// Synthetic ACP/PTY CLIs; real Chromium, HTTP, SQLite, workspace snapshots and permission decisions.
test.describe('Calm Workbench browser acceptance', () => {
  let instance: TestServerInstance;
  let alpha: string, beta: string, approval: string, pty: string, alphaTurn: string;
  const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
  const message = (page: Page) => page.getByRole('textbox', { name: '消息', exact: true });
  const open = async (page: Page, id: string) => {
    await page.goto(`${instance.baseUrl}/sessions/${id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('tab', { name: '对话', exact: true })).toBeVisible();
  };
  const noOverflow = async (page: Page) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  };
  const create = async (agentId: string, prompt?: string) => {
    const response = await instance.request('POST', '/api/sessions', { agentId, cwd: instance.sourceRepo, workspaceMode: 'worktree' });
    expect(response.status, response.text).toBe(200);
    const id = response.json.id as string;
    if (prompt) {
      const sent = await instance.request('POST', `/api/sessions/${id}/send`, { prompt, mode: 'queue' });
      expect(sent.status, sent.text).toBe(202);
      if (prompt.includes('permission')) {
        await expect.poll(async () => (await instance.request('GET', `/api/sessions/${id}`)).json.state, { timeout: 30_000 }).toBe('waiting_for_permission');
      } else {
        await expect.poll(async () => (await instance.request('GET', `/api/sessions/${id}/tasks`)).json[0]?.status, { timeout: 30_000 }).toBe('completed');
      }
    }
    return id;
  };

  test.beforeAll(async () => {
    instance = await launchIsolatedTestServer({ prefix: 'dutydeck-calm-browser-', beforeLaunch: ({ binDir, claudeDataDir, sourceRepo }) => {
      const acp = join(binDir, 'calm-acp.mjs');
      const original = readFileSync(join(REPO_ROOT, 'tests/fixtures/mock-acp-agent.mjs'), 'utf8');
      // The CLI changes a real tracked file inside its isolated worktree, so the diff has real server evidence.
      const fixture = "import { writeFileSync } from 'node:fs';\n" + original.replace(
        "const prompt = (params.prompt ?? []).map(p => p.text ?? '').join('');",
        "const prompt = (params.prompt ?? []).map(p => p.text ?? '').join(''); if (prompt.includes('CALM_CHANGE_FILE')) writeFileSync('tracked.txt', 'Calm workbench fixture change\\n');"
      );
      writeFileSync(acp, fixture);
      return { agents: [
        { id: 'calm-acp', name: 'Calm ACP fixture', command: process.execPath, args: [acp], protocol: 'acp', cwd: sourceRepo, permissionMode: 'ask', timeout: 60, builtin: false },
        { id: 'claude-code', name: 'Calm PTY fixture', command: writeMockCli(binDir, claudeDataDir), args: [], protocol: 'pty-cli', cwd: sourceRepo,
          permissionMode: 'full-trust', timeout: 60, builtin: false, env: { CLAUDE_CONFIG_DIR: claudeDataDir, MOCK_CLAUDE_DATA_DIR: claudeDataDir } }
      ] };
    } });
    alpha = await create('calm-acp', 'Calm Alpha CALM_CHANGE_FILE');
    alphaTurn = (await instance.request('GET', `/api/sessions/${alpha}/tasks`)).json[0].id;
    beta = await create('calm-acp', 'Calm Beta');
    approval = await create('calm-acp', 'Calm mobile permission');
    pty = await create('claude-code');
  });
  test.afterAll(async () => { await instance?.cleanup(); });
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) await info.attach('isolated-server.log', { body: instance.serverLog.join(''), contentType: 'text/plain' });
  });

  test('draft text and file references survive task switches, refresh and delayed send acknowledgement', async ({ page }) => {
    await open(page, alpha);
    await message(page).fill('/file');
    await page.getByRole('button', { name: /\/file/ }).click();
    await page.getByRole('textbox', { name: '本地文件路径' }).fill(join(instance.sourceRepo, 'tracked.txt'));
    await page.getByRole('button', { name: '引用', exact: true }).click();
    await message(page).fill('Alpha 未发送草稿');
    await sidebar(page).getByRole('button', { name: /Calm Beta/ }).click();
    await expect(message(page)).toHaveValue('');
    await message(page).fill('Beta 独立草稿');
    await sidebar(page).getByRole('button', { name: /Calm Alpha/ }).click();
    await expect(message(page)).toHaveValue('Alpha 未发送草稿');
    await expect(page.getByRole('button', { name: '移除引用 tracked.txt', exact: true })).toBeVisible();
    await page.reload();
    await expect(message(page)).toHaveValue('Alpha 未发送草稿');
    await expect(page.getByRole('button', { name: '移除引用 tracked.txt', exact: true })).toBeVisible();

    let acknowledge!: () => void;
    const held = new Promise<void>(resolve => { acknowledge = resolve; });
    let received!: () => void;
    const forwarded = new Promise<void>(resolve => { received = resolve; });
    await page.route(`**/api/sessions/${alpha}/send`, async route => {
      const response = await route.fetch(); received(); await held; await route.fulfill({ response });
    });
    const sendReceipt = page.waitForResponse(response => new URL(response.url()).pathname === `/api/sessions/${alpha}/send`);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await forwarded;
    await message(page).fill('发送回执之前写下的新草稿');
    acknowledge();
    await sendReceipt;
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await expect.poll(async () => (await instance.request('GET', `/api/sessions/${alpha}/tasks`)).json.length).toBe(2);
    await expect(message(page)).toHaveValue('发送回执之前写下的新草稿');
    await page.reload();
    await expect(message(page)).toHaveValue('发送回执之前写下的新草稿');
    await sidebar(page).getByRole('button', { name: /Calm Beta/ }).click();
    await expect(message(page)).toHaveValue('Beta 独立草稿');
  });

  test('global search opens a filtered-out task with a unique sidebar location and restores the list filter', async ({ page }) => {
    await page.goto(instance.baseUrl);
    await sidebar(page).getByRole('button', { name: /^全部任务/ }).click();
    const filters = page.getByRole('region', { name: '任务筛选' });
    await filters.getByRole('button', { name: /^待你处理/ }).click();
    const listQuery = page.getByRole('textbox', { name: '筛选当前任务列表', exact: true });
    const projectFilter = page.getByRole('combobox', { name: '筛选项目', exact: true });
    await projectFilter.selectOption({ index: 1 });
    const project = await projectFilter.inputValue();
    await listQuery.fill('Calm Alpha');
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder(/搜索任务目标/).fill('Calm Beta');
    await page.getByRole('option').filter({ hasText: 'Calm Beta' }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${beta}$`));
    await expect(sidebar(page).locator('[aria-current="true"]')).toHaveCount(1);
    await expect(sidebar(page).locator('[aria-current="true"]')).toContainText('Calm Beta');
    await page.goBack();
    await expect(page.getByRole('heading', { name: '全部任务', exact: true })).toBeVisible();
    await expect(filters.getByRole('button', { name: /^待你处理/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(listQuery).toHaveValue('Calm Alpha');
    await expect(projectFilter).toHaveValue(project);
  });

  test('sidebar supports keyboard resizing, persisted width and collapse without losing current task', async ({ page }) => {
    await open(page, alpha);
    const resize = page.getByRole('separator', { name: '调整侧栏宽度' });
    const aligned = async () => {
      const right = (await sidebar(page).boundingBox())!.x + (await sidebar(page).boundingBox())!.width;
      expect(Math.abs((await page.getByRole('main').boundingBox())!.x - right)).toBeLessThanOrEqual(1);
      expect(Math.abs((await page.getByRole('banner').boundingBox())!.x - right)).toBeLessThanOrEqual(1);
    };
    await resize.focus(); await page.keyboard.press('Home');
    await expect(resize).toHaveAttribute('aria-valuenow', '208');
    await page.keyboard.press('ArrowRight'); await expect(resize).toHaveAttribute('aria-valuenow', '216');
    await page.keyboard.press('End'); await expect(resize).toHaveAttribute('aria-valuenow', '320');
    await page.reload(); await expect(resize).toHaveAttribute('aria-valuenow', '320');
    expect((await sidebar(page).boundingBox())!.width).toBe(320);
    await aligned();
    await sidebar(page).getByRole('button', { name: '收起侧栏', exact: true }).click();
    await expect.poll(async () => (await sidebar(page).boundingBox())!.width).toBe(68);
    await aligned();
    await sidebar(page).getByRole('button', { name: '展开侧栏', exact: true }).click();
    await expect(resize).toHaveAttribute('aria-valuenow', '320');
    await expect(sidebar(page).locator('[aria-current="true"]')).toContainText('Calm Alpha');
  });

  test('390px supports approval, input, real diff and modal inspector; PTY gates the terminal', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, approval);
    const permission = page.getByRole('complementary', { name: '权限审批', exact: true });
    await permission.getByRole('button', { name: '允许本次', exact: true }).click();
    await expect.poll(async () => (await instance.request('GET', `/api/sessions/${approval}/tasks`)).json[0]?.status).toBe('completed');
    await message(page).fill('手机端继续补充'); await noOverflow(page);
    await open(page, alpha);
    await expect(page.getByRole('tab', { name: '终端', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: '改动', exact: true }).click();
    await page.getByRole('combobox', { name: '改动轮次', exact: true }).selectOption(alphaTurn);
    await expect(page.getByText('tracked.txt', { exact: true }).first()).toBeVisible();
    await noOverflow(page);
    const opener = page.getByRole('button', { name: '结果检视', exact: true });
    await opener.click();
    const inspector = page.getByRole('dialog', { name: '结果检视', exact: true });
    await expect(inspector).toHaveAttribute('aria-modal', 'true');
    await expect.poll(() => inspector.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab'); expect(await inspector.evaluate(el => el.contains(document.activeElement))).toBe(true);
    expect(await page.locator('main').evaluate(el => Boolean(el.closest('[inert]')))).toBe(true);
    await noOverflow(page); await page.keyboard.press('Escape'); await expect(inspector).toHaveCount(0); await expect(opener).toBeFocused();
    await open(page, pty);
    await expect(page.getByRole('tab', { name: '终端', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '终端', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible(); await noOverflow(page);
  });

  test('a saved schedule stays disabled until its complete activation confirmation is accepted', async ({ page }) => {
    await open(page, beta);
    await page.getByRole('button', { name: '结果检视', exact: true }).click();
    const inspector = page.getByRole('complementary', { name: '结果检视', exact: true });
    await inspector.locator('summary').filter({ hasText: '任务自动化' }).click();
    await inspector.getByText('为此任务创建计划', { exact: true }).click();
    await inspector.getByLabel('计划名称', { exact: true }).fill('Calm explicit activation');
    await inspector.getByLabel('执行指令', { exact: true }).fill('CALM_SCHEDULE_MUST_NOT_RUN');
    await inspector.getByLabel('触发方式', { exact: true }).selectOption('interval');
    await inspector.getByLabel('间隔分钟数', { exact: true }).fill('1440');
    await inspector.getByRole('button', { name: '保存计划', exact: true }).click();
    const path = `/api/sessions/${beta}/automation`;
    await expect.poll(async () => (await instance.request('GET', path)).json.schedules.length).toBe(1);
    expect((await instance.request('GET', path)).json.schedules[0].enabled).toBe(false);
    const writes: string[] = [];
    page.on('request', request => { if (request.method() === 'PATCH' && new URL(request.url()).pathname.startsWith(`${path}/schedules/`)) writes.push(request.postData() ?? ''); });
    await inspector.getByRole('button', { name: '启用', exact: true }).click();
    const confirmation = page.getByRole('alertdialog', { name: '确认启用计划', exact: true });
    await expect(confirmation).toContainText('CALM_SCHEDULE_MUST_NOT_RUN');
    await expect(confirmation).toContainText('1440');
    expect(writes).toEqual([]);
    expect((await instance.request('GET', path)).json.schedules[0].enabled).toBe(false);
    await confirmation.getByRole('button', { name: '暂不启用', exact: true }).click();
    expect(writes).toEqual([]);
    await inspector.getByRole('button', { name: '启用', exact: true }).click();
    await confirmation.getByRole('button', { name: '确认启用', exact: true }).click();
    await expect.poll(async () => (await instance.request('GET', path)).json.schedules[0].enabled).toBe(true);
    expect(writes).toHaveLength(1);
    await inspector.getByRole('button', { name: '停用', exact: true }).click();
    await expect.poll(async () => (await instance.request('GET', path)).json.schedules[0].enabled).toBe(false);
    expect((await instance.request('GET', `/api/sessions/${beta}/tasks`)).json).toHaveLength(1);
  });

  test('a hidden PTY tab sends no resize frames and refits when visible again', async ({ page }) => {
    const resizes: Array<{ cols: number; rows: number }> = [];
    page.on('websocket', socket => {
      if (!socket.url().includes(`/api/terminal/${pty}`)) return;
      socket.on('framesent', frame => {
        const payload = JSON.parse(String(frame.payload));
        if (payload.type === 'resize') resizes.push({ cols: payload.cols, rows: payload.rows });
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, pty);
    await page.getByRole('tab', { name: '终端', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible();
    await expect.poll(() => resizes.at(-1)?.cols ?? 0).toBeGreaterThan(80);
    await expect.poll(() => resizes.at(-1)?.rows ?? 0).toBeGreaterThan(10);
    const visibleCount = resizes.length;
    await page.getByRole('tab', { name: '对话', exact: true }).click();
    await expect(page.locator('.xterm')).toBeHidden();
    // Observe the real ResizeObserver/WS path across a paint and a viewport change while hidden.
    await page.waitForTimeout(200);
    expect(resizes).toHaveLength(visibleCount);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(200);
    expect(resizes).toHaveLength(visibleCount);
    await page.getByRole('tab', { name: '终端', exact: true }).click();
    await expect.poll(() => resizes.length).toBeGreaterThan(visibleCount);
    expect(resizes.at(-1)!.cols).toBeGreaterThan(80);
    expect(resizes.at(-1)!.rows).toBeGreaterThan(10);
    await noOverflow(page);
  });

  test('a 384px result inspector keeps real context and quota labels readable', async ({ page }, info) => {
    const id = await create('calm-acp', 'report usage rate limits');
    const usageResponse = await instance.request('GET', `/api/sessions/${id}/usage`);
    expect(usageResponse.json.snapshot.rateLimits.fiveHour.usedPercent).toBe(42);
    expect(usageResponse.json.snapshot.rateLimits.sevenDay.usedPercent).toBe(75);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, id);
    await page.getByRole('button', { name: '结果检视', exact: true }).click();
    const inspector = page.getByRole('complementary', { name: '结果检视', exact: true });
    expect((await inspector.boundingBox())!.width).toBe(384);
    await inspector.locator('summary').filter({ hasText: '详细用量与后台状态' }).click();
    const usage = inspector.getByRole('region', { name: '任务用量', exact: true });
    await expect(usage).toContainText('0.6%');
    await expect(usage).toContainText('42%');
    await expect(usage).toContainText('75%');
    await expect(usage).toContainText('155');
    for (const name of ['上下文', '5h额度', '7天额度', '累计 token']) {
      const label = usage.getByText(name, { exact: true });
      await expect(label).toBeVisible();
      expect(await label.evaluate(el => el.clientWidth >= el.scrollWidth && el.getBoundingClientRect().width > 0), `${name} must not truncate`).toBe(true);
    }
    expect(await usage.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await noOverflow(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await usage.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('usage-inspector-1440-light.png') });
  });

  test('captures isolated workbench, task, changes and inspector in light/dark and mobile', async ({ page }, info) => {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.goto(instance.baseUrl);
        await page.evaluate(value => { document.documentElement.setAttribute('data-theme', value); localStorage.setItem('dutydeck.theme', value); }, theme);
        await expect(page.getByRole('heading', { name: '工作台', level: 1, exact: true })).toBeVisible();
        await page.screenshot({ animations: 'disabled', path: info.outputPath(`workbench-${width}-${theme}.png`) });
        await open(page, alpha);
        const closeInspector = page.getByRole('button', { name: '关闭结果检视', exact: true });
        if (await closeInspector.isVisible()) await closeInspector.click();
        await page.getByRole('tab', { name: '对话', exact: true }).click();
        const historyToggle = page.getByRole('button', { name: /^(展开|收起)完整记录$/ }).first();
        await expect(historyToggle).toBeVisible();
        if (await historyToggle.getAttribute('aria-expanded') === 'false') await historyToggle.click();
        await expect(page.getByRole('article', { name: /最终输出/ }).first()).toBeVisible();
        await page.screenshot({ animations: 'disabled', path: info.outputPath(`conversation-${width}-${theme}.png`) });
        await page.getByRole('tab', { name: '改动', exact: true }).click();
        await page.getByRole('combobox', { name: '改动轮次', exact: true }).selectOption(alphaTurn);
        await expect(page.getByText('tracked.txt', { exact: true }).first()).toBeVisible();
        await page.screenshot({ animations: 'disabled', path: info.outputPath(`changes-${width}-${theme}.png`) });
        await page.getByRole('button', { name: '结果检视', exact: true }).click();
        await expect(page.getByRole(width >= 1280 ? 'complementary' : 'dialog', { name: '结果检视', exact: true })).toBeVisible();
        await page.screenshot({ animations: 'disabled', path: info.outputPath(`inspector-${width}-${theme}.png`) });
        await page.getByRole('button', { name: '关闭结果检视', exact: true }).click();
      }
    }
  });
});
