import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchIsolatedTestServer, type TestServerInstance } from './harness.js';

test.describe('Managed workspace browser acceptance', () => {
  let instance: TestServerInstance;
  const PROMPT_ALPHA = 'TASK_ALPHA_WORKSPACE_PROMPT';
  const PROMPT_BETA = 'TASK_BETA_WORKSPACE_PROMPT';

  let sessionA: { id: string; cwd: string; branch: string; prompt: string };
  let sessionB: { id: string; cwd: string; branch: string; prompt: string };

  test.beforeAll(async () => {
    instance = await launchIsolatedTestServer('dutydeck-acc-ws-');

    // 辅助函数：通过真实 API 创建并运行指定 prompt 的 worktree 任务
    const seedSession = async (promptText: string) => {
      const createRes = await instance.request('POST', '/api/sessions', {
        cwd: instance.sourceRepo,
        workspaceMode: 'worktree',
        agentId: 'claude-code'
      });
      expect(createRes.status).toBe(200);
      const session = createRes.json;

      const wsRes = await instance.request('GET', `/api/sessions/${session.id}/workspace`);
      expect(wsRes.status).toBe(200);
      const workspace = wsRes.json;

      const sendRes = await instance.request('POST', `/api/sessions/${session.id}/send`, {
        prompt: promptText,
        mode: 'queue'
      });
      expect(sendRes.status).toBe(202);

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const s = await instance.request('GET', `/api/sessions/${session.id}`);
        if (s.json?.state === 'completed') break;
        await new Promise(r => setTimeout(r, 200));
      }

      const finalCheck = await instance.request('GET', `/api/sessions/${session.id}`);
      expect(finalCheck.json?.state).toBe('completed');

      return {
        id: session.id,
        cwd: workspace.cwd as string,
        branch: workspace.branch as string,
        prompt: promptText
      };
    };

    sessionA = await seedSession(PROMPT_ALPHA);
    sessionB = await seedSession(PROMPT_BETA);

    // 断言两个独立 worktree 目录各不相同，且物理落在本次独占的 fixture 目录内
    expect(sessionA.cwd).not.toBe(sessionB.cwd);
    expect(sessionA.cwd.startsWith(instance.dataDir)).toBe(true);
    expect(sessionB.cwd.startsWith(instance.dataDir)).toBe(true);
    expect(existsSync(sessionA.cwd)).toBe(true);
    expect(existsSync(sessionB.cwd)).toBe(true);
  });

  test.afterEach(async ({}, testInfo) => {
    if (instance?.serverLog?.length) {
      const serverLogPath = testInfo.outputPath('server.log');
      try {
        writeFileSync(serverLogPath, instance.serverLog.join(''), 'utf8');
        await testInfo.attach('workspace-server.log', {
          path: serverLogPath,
          contentType: 'text/plain'
        });
      } catch {}
    }
  });

  test.afterAll(async () => {
    if (instance) {
      await instance.cleanup();
    }
  });

  test('Journey A: same source worktrees group into single project, navigate correctly, and display actual worktree cwd', async ({ page }) => {
    await page.goto(instance.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ state: 'visible', timeout: 20_000 });

    // 定位唯一的工作台导航侧栏，避免匹配到页面主区里的其他 aside
    const sidebar = page.getByRole('complementary', { name: 'Dutydeck 工作台导航' });
    await expect(sidebar).toBeVisible();

    // 侧栏 title=sourceRepo 的项目按钮仅 1 个，任务数量显示为 2
    const projectButton = sidebar.locator(`button[title="${instance.sourceRepo}"]`);
    await expect(projectButton).toHaveCount(1);
    await expect(projectButton.locator('.text-meta')).toHaveText('2');

    // 若当前未展开，点击展开工作区组
    if ((await projectButton.getAttribute('aria-expanded')) !== 'true') {
      await projectButton.click();
    }

    const main = page.getByRole('main');

    // 1. 点击 Session A 任务行
    const rowA = sidebar.getByRole('button', { name: new RegExp(PROMPT_ALPHA) });
    await expect(rowA).toBeVisible();
    await rowA.click();

    // 核对 URL 与 aria-current="true"，且侧栏当前仅有一项处于激活态
    await page.waitForURL(url => url.pathname === `/sessions/${sessionA.id}`, { timeout: 10_000 });
    await expect(rowA).toHaveAttribute('aria-current', 'true');
    await expect(sidebar.locator('[aria-current="true"]')).toHaveCount(1);

    // 核对主区执行记录：用户消息与最终输出 article
    const timelineA = main.getByLabel('执行记录', { exact: true });
    await expect(timelineA.getByText(PROMPT_ALPHA, { exact: true })).toBeVisible();

    const outputArticleA = timelineA.getByRole('article', { name: /最终输出/ });
    await expect(outputArticleA).toBeVisible();
    await expect(outputArticleA).toContainText('MOCK_REPLY:');
    await expect(outputArticleA).toContainText(PROMPT_ALPHA);
    await expect(outputArticleA).not.toContainText(PROMPT_BETA);
    await expect(main.getByText(PROMPT_BETA)).toHaveCount(0);

    // 打开“工作目录、验证与自动化”弹窗核对真实 cwd 与 branch
    await page.getByRole('button', { name: '工作目录、验证与自动化', exact: true }).click();
    const dialogA = page.getByRole('dialog', { name: '工作目录与自动化' });
    await expect(dialogA).toBeVisible();
    await expect(dialogA.getByText(sessionA.cwd, { exact: true })).toBeVisible();
    await expect(dialogA.getByText(sessionA.branch, { exact: false }).first()).toBeVisible();
    await dialogA.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialogA).toBeHidden();

    // 2. 点击 Session B 任务行
    const rowB = sidebar.getByRole('button', { name: new RegExp(PROMPT_BETA) });
    await expect(rowB).toBeVisible();
    await rowB.click();

    // 核对 URL 与 aria-current="true"，且侧栏当前仅有一项处于激活态，rowA 不再为 true
    await page.waitForURL(url => url.pathname === `/sessions/${sessionB.id}`, { timeout: 10_000 });
    await expect(rowB).toHaveAttribute('aria-current', 'true');
    await expect(rowA).not.toHaveAttribute('aria-current', 'true');
    await expect(sidebar.locator('[aria-current="true"]')).toHaveCount(1);

    // 核对主区执行记录：用户消息与最终输出 article
    const timelineB = main.getByLabel('执行记录', { exact: true });
    await expect(timelineB.getByText(PROMPT_BETA, { exact: true })).toBeVisible();

    const outputArticleB = timelineB.getByRole('article', { name: /最终输出/ });
    await expect(outputArticleB).toBeVisible();
    await expect(outputArticleB).toContainText('MOCK_REPLY:');
    await expect(outputArticleB).toContainText(PROMPT_BETA);
    await expect(outputArticleB).not.toContainText(PROMPT_ALPHA);
    await expect(main.getByText(PROMPT_ALPHA)).toHaveCount(0);

    // 打开弹窗核对 Session B 的真实 cwd 与 branch（与 Session A 不同）
    await page.getByRole('button', { name: '工作目录、验证与自动化', exact: true }).click();
    const dialogB = page.getByRole('dialog', { name: '工作目录与自动化' });
    await expect(dialogB).toBeVisible();
    await expect(dialogB.getByText(sessionB.cwd, { exact: true })).toBeVisible();
    await expect(dialogB.getByText(sessionB.branch, { exact: false }).first()).toBeVisible();
    await dialogB.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialogB).toBeHidden();
  });

  test('Journey B: archiving, cleanup blocker defence, race condition defence, full cleanup, and reload persistence', async ({ page }) => {
    // 导航至 Session A 详情页
    await page.goto(`${instance.baseUrl}/sessions/${sessionA.id}`, { waitUntil: 'domcontentloaded' });
    const main = page.getByRole('main');
    const timeline = main.getByLabel('执行记录', { exact: true });
    await expect(timeline.getByRole('article', { name: /最终输出/ })).toBeVisible({ timeout: 20_000 });

    // 1. UI 点击“归档任务”并在 alertdialog 确认
    await page.getByRole('button', { name: '归档任务', exact: true }).click();
    const confirmArchiveDialog = page.getByRole('alertdialog', { name: '归档此任务？' });
    await expect(confirmArchiveDialog).toBeVisible();
    await confirmArchiveDialog.getByRole('button', { name: '确认归档', exact: true }).click();
    await expect(confirmArchiveDialog).toBeHidden();

    // 归档后回到总览页，等待标题“今天需要推进什么？”
    await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ state: 'visible', timeout: 20_000 });

    // 点击任务筛选区域中的“已归档”筛选按钮，断言 aria-pressed="true"
    const filterSection = page.getByRole('region', { name: '任务筛选' });
    const archivedFilterBtn = filterSection.getByRole('button', { name: /^已归档/ });
    await archivedFilterBtn.click();
    await expect(archivedFilterBtn).toHaveAttribute('aria-pressed', 'true');

    // 在已归档的任务列表区域内点击 Session A 任务行进入详情
    const taskListSection = page.getByRole('region', { name: '任务列表' });
    const archivedTaskRow = taskListSection.getByRole('button', { name: new RegExp(PROMPT_ALPHA) });
    await archivedTaskRow.waitFor({ state: 'visible', timeout: 15_000 });
    await archivedTaskRow.click();
    await page.waitForURL(url => url.pathname === `/sessions/${sessionA.id}`, { timeout: 10_000 });

    // 确认已归档只读提示，且磁盘目录与代码历史仍在
    await expect(page.getByText('该任务已归档，只能查看历史记录。')).toBeVisible();
    expect(existsSync(sessionA.cwd)).toBe(true);
    expect(existsSync(join(sessionA.cwd, 'tracked.txt'))).toBe(true);

    // 2. 打开弹窗，点击“检查可否清理”
    await page.getByRole('button', { name: '工作目录、验证与自动化', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '工作目录与自动化' });
    await expect(dialog).toBeVisible();

    const cleanupCheckPromise = page.waitForResponse(
      r => r.url().includes(`/api/sessions/${sessionA.id}/workspace/cleanup`) && r.request().method() === 'GET'
    );
    await dialog.getByRole('button', { name: '检查可否清理', exact: true }).click();
    const checkRes = await cleanupCheckPromise;
    const previewData = await checkRes.json();

    // 真实 GET 接口返回 canClean=false，且存在 UNTRACKED_FILES blocker
    expect(previewData.canClean).toBe(false);
    expect(previewData.blockers.some((b: any) => b.code === 'UNTRACKED_FILES')).toBe(true);

    // 页面展示 blocker 且没有确认按钮
    await expect(dialog.getByText('当前无法清理工作目录：')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '确认清理工作目录' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '重新检查' })).toBeVisible();

    // 验证磁盘上真实 .dutydeck/security/sessions/<id>.json 文件存在且未被删除
    const securityFilePath = join(sessionA.cwd, '.dutydeck/security/sessions', `${sessionA.id}.json`);
    expect(existsSync(securityFilePath)).toBe(true);

    // 3. 夹具准备：仅删除该测试自身拥有的已知策略文件，构造干净条件；最多逐级 rmdir 空父目录，不递归强删整个目录
    // （说明：runtime.send 写入了未被 git 跟踪的会话策略文件，本步骤是纯夹具准备，不修改产品逻辑）
    rmSync(securityFilePath, { force: true });
    try { rmdirSync(join(sessionA.cwd, '.dutydeck/security/sessions')); } catch {}
    try { rmdirSync(join(sessionA.cwd, '.dutydeck/security')); } catch {}
    try { rmdirSync(join(sessionA.cwd, '.dutydeck')); } catch {}

    // 重新检查可清理状态
    const recheckPromise = page.waitForResponse(
      r => r.url().includes(`/api/sessions/${sessionA.id}/workspace/cleanup`) && r.request().method() === 'GET'
    );
    await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
    const recheckRes = await recheckPromise;
    const cleanPreview = await recheckRes.json();
    expect(cleanPreview.canClean).toBe(true);
    expect(typeof cleanPreview.fingerprint).toBe('string');
    await expect(dialog.getByText('工作目录状态干净，无未提交改动或新增未推送提交，可安全清理。')).toBeVisible();
    const confirmButton = dialog.getByRole('button', { name: '确认清理工作目录', exact: true });
    await expect(confirmButton).toBeVisible();

    // 4. 竞态防御：在 worktree 目录写入哨兵文件，再点击原有确认按钮
    const sentinelFile = join(sessionA.cwd, 'sentinel-conflict.txt');
    writeFileSync(sentinelFile, 'sentinel conflict verification\n', 'utf8');

    const conflictPostPromise = page.waitForResponse(
      r => r.url().includes(`/api/sessions/${sessionA.id}/workspace/cleanup`) && r.request().method() === 'POST'
    );
    await confirmButton.click();
    const conflictPostRes = await conflictPostPromise;

    // 严格断言：请求体中的 fingerprint 必须等于先前预览获得的 fingerprint
    expect(conflictPostRes.request().postDataJSON().fingerprint).toBe(cleanPreview.fingerprint);
    // 携带旧 fingerprint 提交，后端检测到目录变化拒绝清理并返回 409
    expect(conflictPostRes.status()).toBe(409);
    const conflictErr = await conflictPostRes.json();
    expect(conflictErr.error.code).toBe('WORKSPACE_FINGERPRINT_MISMATCH');

    // UI 确切提示“工作目录状态已变化，请重新检查”，且哨兵文件与目录在磁盘完整保留
    await expect(dialog.getByText('工作目录状态已变化，请重新检查')).toBeVisible();
    expect(existsSync(sentinelFile)).toBe(true);
    expect(readFileSync(sentinelFile, 'utf8')).toBe('sentinel conflict verification\n');
    expect(existsSync(sessionA.cwd)).toBe(true);

    // 5. 恢复干净条件，重新检查并确认清理
    rmSync(sentinelFile, { force: true });

    const finalCheckPromise = page.waitForResponse(
      r => r.url().includes(`/api/sessions/${sessionA.id}/workspace/cleanup`) && r.request().method() === 'GET'
    );
    await dialog.getByRole('button', { name: '重新检查', exact: true }).click();
    const finalCheckRes = await finalCheckPromise;
    const finalPreview = await finalCheckRes.json();
    expect(finalPreview.canClean).toBe(true);
    await expect(dialog.getByText('工作目录状态干净，无未提交改动或新增未推送提交，可安全清理。')).toBeVisible();

    const finalCleanupPromise = page.waitForResponse(
      r => r.url().includes(`/api/sessions/${sessionA.id}/workspace/cleanup`) && r.request().method() === 'POST'
    );
    await dialog.getByRole('button', { name: '确认清理工作目录', exact: true }).click();
    const finalCleanupRes = await finalCleanupPromise;
    expect(finalCleanupRes.status()).toBe(200);

    // 界面展示已清理说明
    await expect(dialog.getByText(/工作目录已清理，任务历史仍可读/)).toBeVisible();

    // 磁盘验证：真实 worktree 目录已消失，且 git worktree list 中精确包含 source 与 B 的条目，已排除 A
    expect(existsSync(sessionA.cwd)).toBe(false);
    const worktreeList = execFileSync('git', ['-C', instance.sourceRepo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    expect(worktreeList).toContain(`worktree ${instance.sourceRepo}`);
    expect(worktreeList).toContain(`worktree ${sessionB.cwd}`);
    expect(worktreeList).not.toContain(sessionA.cwd);

    // 源仓库、对应分支以及另一个 worktree 保持完好，内容与分支精确验证
    expect(existsSync(instance.sourceRepo)).toBe(true);
    expect(existsSync(join(instance.sourceRepo, 'tracked.txt'))).toBe(true);
    expect(readFileSync(join(instance.sourceRepo, 'tracked.txt'), 'utf8')).toBe('baseline content\n');

    expect(existsSync(sessionB.cwd)).toBe(true);
    expect(existsSync(join(sessionB.cwd, 'tracked.txt'))).toBe(true);
    expect(readFileSync(join(sessionB.cwd, 'tracked.txt'), 'utf8')).toBe('baseline content\n');

    const branchCommit = execFileSync('git', ['-C', instance.sourceRepo, 'rev-parse', '--verify', `refs/heads/${sessionA.branch}^{commit}`], { encoding: 'utf8' }).trim();
    const baselineCommit = execFileSync('git', ['-C', instance.sourceRepo, 'rev-parse', '--verify', 'HEAD^{commit}'], { encoding: 'utf8' }).trim();
    expect(branchCommit).toBe(baselineCommit);

    // 6. 页面刷新后核对历史仍然可读，且只读与已清理状态持久有效，输入框彻底卸载不可用
    await page.reload();
    const reloadedMain = page.getByRole('main');
    const reloadedTimeline = reloadedMain.getByLabel('执行记录', { exact: true });

    await expect(reloadedTimeline.getByText(PROMPT_ALPHA, { exact: true })).toBeVisible({ timeout: 15_000 });
    const reloadedOutputArticle = reloadedTimeline.getByRole('article', { name: /最终输出/ });
    await expect(reloadedOutputArticle).toBeVisible();
    await expect(reloadedOutputArticle).toContainText('MOCK_REPLY:');
    await expect(reloadedOutputArticle).toContainText(PROMPT_ALPHA);
    await expect(reloadedOutputArticle).not.toContainText(PROMPT_BETA);
    await expect(reloadedMain.getByText(PROMPT_BETA)).toHaveCount(0);
    await expect(page.getByText('该任务已归档，只能查看历史记录。')).toBeVisible();
    await expect(reloadedMain.getByRole('textbox', { name: '消息', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '工作目录、验证与自动化', exact: true }).click();
    const reloadedDialog = page.getByRole('dialog', { name: '工作目录与自动化' });
    await expect(reloadedDialog.getByText(/工作目录已清理，任务历史仍可读/)).toBeVisible();
    await reloadedDialog.getByRole('button', { name: '关闭', exact: true }).click();
  });
});
