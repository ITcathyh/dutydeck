// 验收截图：桌面 1440x900 + 移动 390x844。
// 服务绑外部主机名而非 loopback，127.0.0.1 会 ERR_CONNECTION_REFUSED。
import { chromium } from '@playwright/test';

const URL = 'http://n37-033-049.byted.org:4310/';
const tag = process.argv[2] ?? 'after';

const browser = await chromium.launch();
for (const [width, height, name] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `/tmp/dm-${tag}-${name}.png`, fullPage: false });

  if (name === 'desktop') {
    // 三处「待你处理」的数字必须同源：页首副标题、筛选芯片、分区标题。
    const subtitle = await page.locator('#workspace-overview-title + p').textContent().catch(() => null);
    const chip = await page.getByRole('button', { pressed: false }).filter({ hasText: '待你处理' }).first().textContent().catch(() => null);
    const sectionCount = await page.locator('h2:has-text("待你处理")').locator('xpath=../../..').locator('text=/\\d+ 个/').first().textContent().catch(() => null);
    console.log('页首副标题 :', subtitle?.trim());
    console.log('筛选芯片   :', chip?.replace(/\s+/g, ' ').trim());
    console.log('分区计数   :', sectionCount?.trim());

    const filterGroups = await page.getByRole('button', { name: /^总览/ }).count();
    console.log('「总览」按钮数（应为 1，两套导航时为 2）:', filterGroups);
    console.log('侧栏是否还有任务视图标题:', await page.getByText('任务视图').count());
  } else {
    // 移动端首屏（不滚动）必须能看到至少一条真实任务内容。
    const firstTask = page.locator('[data-task-priority]').first();
    const box = await firstTask.boundingBox().catch(() => null);
    console.log('移动端首条任务 top =', box?.y, box && box.y < height ? '✓ 在首屏内' : '✗ 被挤出折叠线');
  }
  await page.close();
}
await browser.close();
