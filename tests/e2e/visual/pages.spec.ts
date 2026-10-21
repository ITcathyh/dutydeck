import { test, expect, BASE_URL, VIEWPORTS, applyTheme, settle, firstSessionId, effectiveBackground, computed, type ThemeMode } from './fixtures';
import { describeColor, hslOf, hueWithin, isCalmNeutral, luminanceOf } from './color';
import { BRAND_HUE, FORBIDDEN_TEAL_HUE, TOPBAR_HEIGHT } from './redesign-contract';


async function openSession(dock: import('@playwright/test').Page): Promise<string> {
  const id = await firstSessionId();
  test.skip(!id, '服务里没有任何会话，跳过详情页断言');
  await dock.goto(`${BASE_URL}/sessions/${id}`, { waitUntil: 'domcontentloaded' });
  await settle(dock);
  await dock.waitForSelector('h1', { timeout: 20_000 });
  return id as string;
}

test.describe('任务详情页 /sessions/:id', () => {
  const themes: ThemeMode[] = ['light', 'dark'];
  for (const theme of themes) {
    test(`[红→绿] ${theme}：详情页灰阶为低彩度中性色`, async ({ dock }) => {
      await dock.setViewportSize(VIEWPORTS.desktop);
      await openSession(dock);
      await applyTheme(dock, theme, 'attr');
      const canvas = await effectiveBackground(dock.locator('main'));
      const text = await computed(dock.locator('h1').first(), 'color');
      expect(isCalmNeutral(canvas), `详情页底色彩度过高：${describeColor(canvas)}`).toBe(true);
      expect(isCalmNeutral(text), `详情页标题色彩度过高：${describeColor(text)}`).toBe(true);
    });
  }

  test(`[红→绿] 详情页也有贴顶的应用顶栏（${TOPBAR_HEIGHT.desktop}px）`, async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await openSession(dock);
    const bars = await dock.evaluate(() =>
      [...document.querySelectorAll('header,[role="banner"],[data-app-topbar]')].map(el => {
        const r = el.getBoundingClientRect();
        return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) };
      }));
    const topbar = bars.find(b => b.y <= 2 && b.w >= VIEWPORTS.desktop.width * 0.5);
    expect(topbar, `详情页没有贴顶的应用顶栏。候选：${JSON.stringify(bars)}`).toBeTruthy();
    expect(Math.abs((topbar?.h ?? 0) - TOPBAR_HEIGHT.desktop),
      `详情页顶栏高 ${topbar?.h}px，应为 ${TOPBAR_HEIGHT.desktop}px`).toBeLessThanOrEqual(TOPBAR_HEIGHT.tolerance);
  });

  test('[绿] 详情页在移动端不横向溢出', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.mobile);
    await openSession(dock);
    const overflow = await dock.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `详情页移动端横向溢出 ${overflow}px`).toBeLessThanOrEqual(0);
  });

  test('[红→绿] 对话与改动常驻，终端跟随服务端能力', async ({ dock }) => {
    const id = await openSession(dock);
    const capability = await (await fetch(`${BASE_URL}/api/sessions/${id}/capabilities`)).json() as { terminal: string };
    await expect(dock.getByRole('tab', { name: '对话', exact: true })).toBeVisible();
    await expect(dock.getByRole('tab', { name: '改动', exact: true })).toBeVisible();
    await expect(dock.getByRole('tab', { name: '终端', exact: true })).toHaveCount(capability.terminal === 'available' ? 1 : 0);
  });
});

test.describe('设置浮层 /?panel=settings&section=agents', () => {
  const dialog = '[role="dialog"]';

  async function openSettings(dock: import('@playwright/test').Page) {
    await dock.goto(`${BASE_URL}/?panel=settings&section=agents`, { waitUntil: 'domcontentloaded' });
    await dock.waitForSelector(dialog, { timeout: 20_000 });
    await dock.waitForTimeout(900);
  }

  const themes: ThemeMode[] = ['light', 'dark'];
  for (const theme of themes) {
    test(`[${theme === 'light' ? '绿·护栏' : '红→绿'}] ${theme}：设置浮层表面色为低彩度中性色`, async ({ dock }) => {
      await dock.setViewportSize(VIEWPORTS.desktop);
      await openSettings(dock);
      await applyTheme(dock, theme, 'attr');
      const bg = await effectiveBackground(dock.locator(dialog).first());
      expect(isCalmNeutral(bg), `设置浮层表面彩度过高：${describeColor(bg)}`).toBe(true);
    });
  }

    test('[红→绿] 设置浮层里的主操作按钮是橙棕', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await openSettings(dock);
    await applyTheme(dock, 'light', 'attr');
    const target = await dock.locator(`${dialog} button`).evaluateAll(nodes => {
      const brand = getComputedStyle(document.documentElement).getPropertyValue('--action-primary').trim();
      const probe = document.createElement('span');
      probe.style.color = brand; document.body.appendChild(probe);
      const brandRgb = getComputedStyle(probe).color; probe.remove();
      const hit = nodes.find(n => getComputedStyle(n).backgroundColor === brandRgb);
      const palette = [...new Set(nodes.map(n => getComputedStyle(n).backgroundColor))];
      return hit
        ? { text: (hit.textContent ?? '').trim().slice(0, 20), bg: getComputedStyle(hit).backgroundColor }
        : { text: null, bg: null, palette, brandRgb };
    });
    expect(target.bg,
      `设置浮层里没有任何按钮消费 --action-primary（${(target as { brandRgb?: string }).brandRgb}）——` +
      `这个界面没有主操作层级，所有按钮都长一样重。实测底色只有：` +
      `${JSON.stringify((target as { palette?: string[] }).palette)}`).toBeTruthy();
    const { h } = hslOf(target.bg!);
    expect(hueWithin(h, FORBIDDEN_TEAL_HUE.min, FORBIDDEN_TEAL_HUE.max),
      `浮层主操作「${target.text}」仍是青绿：${describeColor(target.bg!)}`).toBe(false);
    expect(hueWithin(h, BRAND_HUE.min, BRAND_HUE.max),
      `浮层主操作「${target.text}」色相应在橙棕区间，实际 ${describeColor(target.bg!)}`).toBe(true);
  });

  test('[绿] 设置浮层是命名的 dialog，且 Escape 可关闭', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await openSettings(dock);
    const panel = dock.locator(dialog).first();
    await expect(panel).toHaveAttribute('aria-label', /设置/);
    await dock.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 5_000 });
  });

  test('[绿] 设置浮层在移动端不横向溢出', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.mobile);
    await openSettings(dock);
    const overflow = await dock.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `设置浮层移动端横向溢出 ${overflow}px`).toBeLessThanOrEqual(0);
  });

  test('[绿·护栏] 浮层遮罩与内容有足够层次（不是纯色贴一块）', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await openSettings(dock);
    await applyTheme(dock, 'light', 'attr');
    const panelLum = luminanceOf(await effectiveBackground(dock.locator(dialog).first()));
    const bodyLum = luminanceOf(await effectiveBackground(dock.locator('body')));
    expect(Math.abs(panelLum - bodyLum) > 0.001 || panelLum > 0.8,
      `浮层与页面底色几乎相同（${panelLum.toFixed(3)} vs ${bodyLum.toFixed(3)}），缺少层次`).toBe(true);
  });
});

test.describe('命令面板', () => {
  async function openPalette(dock: import('@playwright/test').Page) {
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    await dock.keyboard.press('Control+k');
    await dock.waitForSelector('[role="listbox"]', { timeout: 10_000 });
    await dock.waitForTimeout(700);
  }

  const themes: ThemeMode[] = ['light', 'dark'];
  for (const theme of themes) {
    test(`[${theme === 'light' ? '绿·护栏' : '红→绿'}] ${theme}：命令面板表面色为低彩度中性色`, async ({ dock }) => {
      await dock.setViewportSize(VIEWPORTS.desktop);
      await openPalette(dock);
      await applyTheme(dock, theme, 'attr');
      const panel = dock.locator('[role="dialog"]').filter({ has: dock.locator('[role="listbox"]') }).first();
      const bg = await effectiveBackground(panel);
      expect(isCalmNeutral(bg), `命令面板表面彩度过高：${describeColor(bg)}`).toBe(true);
    });
  }

  test('[红→绿] 选中项高亮是橙棕族', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await openPalette(dock);
    await applyTheme(dock, 'light', 'attr');
    const active = dock.locator('[role="option"][aria-selected="true"]').first();
    await expect(active, '命令面板没有 aria-selected 的选中项').toBeVisible();
    const bg = await effectiveBackground(active);
    const { h, s } = hslOf(bg);
    expect(hueWithin(h, FORBIDDEN_TEAL_HUE.min, FORBIDDEN_TEAL_HUE.max) && s > 8,
      `命令面板选中高亮仍是青绿：${describeColor(bg)}`).toBe(false);
  });

  test('[绿] Ctrl+K 打开、Escape 关闭，且有可搜索输入框', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await openPalette(dock);
    const box = dock.locator('[role="listbox"]');
    await expect(box).toBeVisible();
    await expect(dock.getByPlaceholder(/搜索任务目标/)).toBeVisible();
    await dock.keyboard.press('Escape');
    await expect(box).toBeHidden({ timeout: 5_000 });
  });

    test('[绿·护栏] 命令面板在详情页同样可唤起（不许退化成单页面功能）', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    const id = await firstSessionId();
    test.skip(!id, '服务里没有任何会话');
    await dock.goto(`${BASE_URL}/sessions/${id}`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    await dock.keyboard.press('Control+k');
    await expect(dock.locator('[role="listbox"]'),
      '详情页按 Ctrl+K 没有唤起命令面板——命令面板退化成了单页面功能').toBeVisible({ timeout: 10_000 });
  });

  test('[绿] 命令面板在移动端不超出视口宽度', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.mobile);
    await openPalette(dock);
    const panel = dock.locator('[role="dialog"]').filter({ has: dock.locator('[role="listbox"]') }).first();
    const w = await panel.evaluate(el => el.getBoundingClientRect().width);
    expect(w, `命令面板宽 ${w}px，超出 390px 视口`).toBeLessThanOrEqual(VIEWPORTS.mobile.width);
  });
});
