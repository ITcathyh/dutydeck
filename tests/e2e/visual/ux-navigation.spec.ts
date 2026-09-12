import { expect, test, type Page } from '@playwright/test';

// Same four-Bot/one-approval fixture used by docs/research-evidence/ux-2026-09-12/ui-audit.cjs.
// All API calls are intercepted, including writes; no Agent or Lark credentials are touched.
async function mockWorkspace(page: Page) {
  const now = '2026-09-12T09:00:00.000Z';
  const agents = [{ id: 'codex', name: 'Codex', protocol: 'acp', permissionMode: 'ask' }, { id: 'claude-code', name: 'Claude Code', protocol: 'pty-cli', permissionMode: 'ask' }];
  const session = { id: 'audit', agentId: 'codex', state: 'waiting_for_permission', cwd: '/repo/audit', permissionMode: 'ask', runId: 'audit-run', createdAt: now, updatedAt: now };
  const bots = Array.from({ length: 4 }, (_, i) => ({ configured: true, appId: `cli_audit${i}`, name: `审计机器人${i}`, tabLabel: `审计机器人${i}`, setupComplete: true, workspace: '/repo/audit', defaultAgentId: 'codex', fullTrustConfirmed: true, preInjectPrompt: '', listening: true, activeListening: true, groupToolsEnabled: false, groupToolsAllowSend: false, pushIntervalMs: 1000, hideTraceOnComplete: true, allowedUsers: [], allowedEmails: [], allowedBots: [], peerBotsAllowed: true, highRiskAllowedUsers: [], highRiskAllowedEmails: [], highRiskPattern: '', riskControlMode: 'off' }));
  const summary = { sessionId: 'audit', taskId: 'audit-task', prompt: '修复登录超时并完成验证', status: 'running', queuedCount: 0, updatedAt: now };
  const events = [{ id: 'goal', sequence: 1, type: 'text', timestamp: now, data: { role: 'user', text: summary.prompt } }, { id: 'permission', sequence: 2, type: 'permission_request', timestamp: now, data: { id: 'permission', status: 'pending', title: '运行检查', operation: { source: 'acp_tool_call', cwd: '/repo/audit', command: 'pnpm test' } } }, { id: 'raw', sequence: 3, type: 'raw_terminal', timestamp: now, data: { text: 'audit log' } }];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const missed: string[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown;
    if (route.request().method() !== 'GET') {
      const body = route.request().postDataJSON();
      writes.push({ path, body });
      if (path === '/api/sessions') data = { ...session, id: 'created', agentId: body.agentId, state: 'idle' };
      else if (path === '/api/sessions/created/send') data = { accepted: true, task: { id: 'created-task', sessionId: 'created', prompt: body.prompt, status: 'queued', createdAt: now, updatedAt: now } };
      else if (path === '/api/lark/config') data = { configured: true, bots, listeningDisabled: false };
      else { missed.push(`WRITE ${path}`); return route.fulfill({ status: 403, json: { error: { message: 'Unexpected mocked write' } } }); }
    } else if (path === '/api/auth/status') data = { authenticated: true, required: false };
    else if (path === '/api/agents') data = agents;
    else if (path === '/api/sessions') data = [session];
    else if (path === '/api/sessions/summaries') data = [summary];
    else if (path === '/api/lark/management/groups') data = { groups: [] };
    else if (path === '/api/lark/config') data = { configured: true, bots, listeningDisabled: false };
    else if (path === '/api/system/capabilities') data = { platform: 'linux', directoryPicker: false, filePicker: false };
    else if (path.endsWith('/models')) data = { models: [], reasoningEfforts: [], source: 'acp' };
    else if (path.endsWith('/events')) data = events;
    else if (path.endsWith('/tasks')) data = [{ id: 'audit-task', sessionId: 'audit', prompt: summary.prompt, status: 'running', createdAt: now, updatedAt: now }];
    else if (path.endsWith('/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': audit\n\n' });
    else if (path === '/api/system/skills') data = [];
    else if (path.endsWith('/work-items')) data = { items: [], templates: [] };
    else if (/\/sessions\/[^/]+\/capabilities$/.test(path)) data = { observedAt: now, protocol: 'acp', structuredApproval: 'available', terminal: 'unavailable', turnRecovery: 'unverified', verification: 'available', localFileDelivery: 'available' };
    else if (path.endsWith('/verifications')) data = [{ id: 'verification-audit', sessionId: 'audit', taskId: 'audit-task', command: 'pnpm test', cwd: '/repo/audit', startedAt: now, completedAt: now, status: 'failed', stale: false, output: 'test failure', exitCode: 1 }];
    else if (path.endsWith('/automation')) data = { subscriptions: [], schedules: [], occurrences: [] };
    else if (path.endsWith('/workspace')) data = { cwd: '/repo/audit', mode: 'shared', state: 'ready' };
    else if (path === '/api/foundation/capabilities' || path === '/api/foundation/schedules/capabilities') data = { repositoriesWired: false, runtimeWired: false, executorWired: false, writesEnabled: false, blockers: [] };
    else { missed.push(path); data = []; }
    return route.fulfill({ status: 200, json: data });
  });
  return { writes, missed, bots };
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`four healthy Bots leave the first approval and its entry visible at ${viewport.width}`, async ({ page }, testInfo) => {
    const fixture = await mockWorkspace(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('complementary', { name: '协作入口' }).getByText('4 个机器人 · 监听已启动', { exact: true })).toBeVisible();
    const row = page.locator('[data-task-priority="attention"]').first();
    await expect(row).toBeVisible();
    const bounds = await row.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThan(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    console.log(`APPROVAL_${viewport.width}`, bounds);
    await page.screenshot({ path: testInfo.outputPath(`overview-${viewport.width}.png`) });
    if (viewport.width === 390) await expect(row.getByText('查看审批 →', { exact: true })).toBeVisible();
    await row.click();
    await expect(page.locator('aside[aria-label="权限审批"]')).toBeVisible();
    await page.goto('/');
    await page.getByRole('button', { name: '管理飞书 Bot', exact: true }).click();
    await expect(page.getByRole('heading', { name: '机器人管理', exact: true })).toBeVisible();
    expect(fixture.missed).toEqual([]);
  });
}

for (const [agentName, agentId] of [['Codex', 'codex'], ['Claude Code', 'claude-code']]) {
  test(`creating from ${agentName} submits that Agent`, async ({ page }) => {
    const fixture = await mockWorkspace(page);
    await page.goto('/?panel=settings&section=agents');
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: agentName, exact: true }) });
    await card.getByRole('button', { name: '用它创建任务' }).click();
    const dialog = page.getByRole('dialog', { name: '创建新任务' });
    await expect(dialog.getByRole('button', { name: agentName, exact: true })).toBeVisible();
    await dialog.getByLabel('任务目标').fill('验证指定 Agent');
    await dialog.getByRole('button', { name: '创建并执行' }).click();
    await expect.poll(() => fixture.writes.filter(write => write.path === '/api/sessions').length).toBe(1);
    expect(fixture.writes.find(write => write.path === '/api/sessions')!.body.agentId).toBe(agentId);
    await expect.poll(() => fixture.writes.filter(write => write.path === '/api/sessions/created/send').length).toBe(1);
    expect(fixture.missed).toEqual([]);
  });
}

test('the third Bot credentials update preserves its target; add explicitly starts empty', async ({ page }) => {
  const fixture = await mockWorkspace(page);
  const firstBot = structuredClone(fixture.bots[0]);
  await page.goto('/?nav=bots&appId=cli_audit2');
  await page.getByRole('button', { name: '重新绑定 / 更新凭据' }).click();
  await expect(page.getByRole('heading', { name: '更新飞书 Bot：审计机器人2', exact: true })).toBeVisible();
  await expect(page.getByLabel('App ID', { exact: true })).toHaveValue('cli_audit2');
  await page.reload();
  await expect(page.getByLabel('App ID', { exact: true })).toHaveValue('cli_audit2');
  await page.getByPlaceholder('已保存', { exact: true }).fill('test-only-replacement');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0]).toMatchObject({ path: '/api/lark/config', body: { originalAppId: 'cli_audit2', appId: 'cli_audit2', appSecret: 'test-only-replacement' } });
  expect(fixture.bots[0]).toEqual(firstBot);
  await page.goto('/?nav=bots&appId=cli_audit2');
  await page.getByRole('button', { name: '添加飞书 Bot', exact: true }).click();
  await expect(page.getByLabel('App ID', { exact: true })).toHaveValue('');
  await expect(page).toHaveURL(/mode=new/);
  expect(fixture.missed).toEqual([]);
});

test('mobile raw logs isolate focus, Escape restores opener, wide screens show a side panel', async ({ page }) => {
  const fixture = await mockWorkspace(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/sessions/audit');
  const opener = page.getByRole('button', { name: '原始日志', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: '原始日志', exact: true });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  expect(await page.locator('main').evaluate(node => Boolean(node.closest('[inert]')))).toBe(true);
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await opener.click();
  await expect(page.getByRole('complementary', { name: '原始日志', exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(await page.locator('main').evaluate(node => Boolean(node.closest('[inert]')))).toBe(false);
  expect(fixture.missed).toEqual([]);
});

test('mobile switches have 44 by 44 hit targets and clickable text labels', async ({ page }) => {
  const fixture = await mockWorkspace(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?panel=lark-setup&targetAppId=cli_audit2');
  await page.getByRole('button', { name: /选择 Agent 并启用/ }).click();
  const listen = page.getByRole('switch', { name: '监听飞书消息', exact: true });
  await expect(listen).toHaveAttribute('aria-checked', 'true');
  await page.locator('label').filter({ hasText: /^监听飞书消息$/ }).click();
  await expect(listen).toHaveAttribute('aria-checked', 'false');
  await page.locator('label').filter({ hasText: /^启用 Agent 群协作工具$/ }).click();
  for (const control of await page.getByRole('switch').all()) {
    const rect = await control.boundingBox();
    expect(rect!.width).toBeGreaterThanOrEqual(44);
    expect(rect!.height).toBeGreaterThanOrEqual(44);
  }
  expect(fixture.writes).toEqual([]);
  expect(fixture.missed).toEqual([]);
});

test('permission facts and platform verification open evidence with focus restored', async ({ page }) => {
  const fixture = await mockWorkspace(page);
  await page.goto('/sessions/audit');
  const permission = page.getByRole('complementary', { name: '权限审批', exact: true });
  await expect(permission.getByRole('button', { name: '允许本次', exact: true })).toBeVisible();
  await permission.getByText('查看命令（已脱敏）', { exact: true }).click();
  await expect(permission.getByText('pnpm test', { exact: true })).toBeVisible();
  await expect(permission.getByText('目录：/repo/audit', { exact: true })).toBeVisible();
  const verification = page.getByRole('complementary', { name: '平台验证', exact: true });
  await expect(verification.getByText('验证失败', { exact: true })).toBeVisible();
  const opener = verification.getByRole('button', { name: '查看验证证据', exact: true });
  await opener.click();
  const evidence = page.getByRole('dialog', { name: '工作目录与自动化', exact: true });
  await expect(evidence.locator('summary').filter({ hasText: '验证失败 · pnpm test' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(evidence).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(fixture.missed).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test('automation opens a task without a delayed Back and keeps drafts in a nested dialog', async ({ page }) => {
  const fixture = await mockWorkspace(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const navigation = page.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
  await navigation.getByText('设置与工具', { exact: true }).click();
  const trigger = navigation.getByRole('button', { name: /^定时任务/ });
  await trigger.click();
  const automation = page.getByRole('dialog', { name: '任务自动化', exact: true });
  await expect(automation.getByRole('heading', { name: '修复登录超时并完成验证', exact: true })).toBeVisible();
  await automation.getByRole('button', { name: '打开任务', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/audit$/);
  await expect(page.getByRole('heading', { name: '修复登录超时并完成验证', exact: true })).toBeVisible();
  // A delayed history.back() used to undo the selection after pushState.
  await page.waitForTimeout(200);
  await expect(page).toHaveURL(/\/sessions\/audit$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(automation).toHaveCount(0);
  await trigger.click();
  const draftsOpener = automation.getByRole('button', { name: '管理草稿', exact: true });
  await draftsOpener.click();
  const drafts = page.getByRole('dialog', { name: '定时任务草稿', exact: true });
  await expect(drafts).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drafts).toHaveCount(0);
  await expect(automation).toBeVisible();
  await expect(draftsOpener).toBeFocused();
  expect(fixture.missed).toEqual([]);
  expect(fixture.writes).toEqual([]);
});
