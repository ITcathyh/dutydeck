import { test, expect, BASE_URL, VIEWPORTS, applyTheme, settle, firstSessionId, effectiveBackground, computed, type ThemeMode } from './fixtures';
import { describeColor, hslOf, hueWithin, isNeutralNotGreenish, luminanceOf } from './color';
import { BRAND_HUE, FORBIDDEN_TEAL_HUE, TOPBAR_HEIGHT } from './redesign-contract';

/**
 * 逐页验收：任务详情、设置浮层、命令面板。
 *
 * 总览页（`/`）的断言在 palette.spec.ts / shell.spec.ts 里，这里补齐另外三个界面——
 * 它们各自有独立的表面层级（详情页有自己的页头、浮层是 portal 到 body 的 dialog、
 * 命令面板是 640px 的 listbox），色板改造漏掉任何一个都会在这里现形。
 *
 * ## 现在应该红，改完应该绿
 *
 * - 详情页顶栏：红（同 shell，详情页目前也没有应用顶栏，只有一个 176px 高的内容页头）。
 * - 详情页/浮层/面板的灰阶：全红（继承全局 token 的 G>B）。
 * - 浮层内主操作按钮色相：红。
 * - 结构性断言（浮层有 dialog role、面板有 listbox、Escape 能关）：绿，属于
 *   「改版不许弄坏」的护栏。
 */

/** 详情页开着 SSE，networkidle 永不触发，必须走 domcontentloaded + 锚点。 */
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
    test(`[红→绿] ${theme}：详情页灰阶不带绿`, async ({ dock }) => {
      await dock.setViewportSize(VIEWPORTS.desktop);
      await openSession(dock);
      await applyTheme(dock, theme, 'attr');
      const canvas = await effectiveBackground(dock.locator('main'));
      const text = await computed(dock.locator('h1').first(), 'color');
      expect(isNeutralNotGreenish(canvas), `详情页底色偏绿：${describeColor(canvas)}`).toBe(true);
      expect(isNeutralNotGreenish(text), `详情页标题色偏绿：${describeColor(text)}`).toBe(true);
    });
  }

  test(`[红→绿] 详情页也有贴顶的应用顶栏（${TOPBAR_HEIGHT.value}px）`, async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await openSession(dock);
    const bars = await dock.evaluate(() =>
      [...document.querySelectorAll('header,[role="banner"],[data-app-topbar]')].map(el => {
        const r = el.getBoundingClientRect();
        return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) };
      }));
    const topbar = bars.find(b => b.y <= 2 && b.w >= VIEWPORTS.desktop.width * 0.5);
    expect(topbar, `详情页没有贴顶的应用顶栏。候选：${JSON.stringify(bars)}`).toBeTruthy();
    expect(Math.abs((topbar?.h ?? 0) - TOPBAR_HEIGHT.value),
      `详情页顶栏高 ${topbar?.h}px，应为 ${TOPBAR_HEIGHT.value}px`).toBeLessThanOrEqual(TOPBAR_HEIGHT.tolerance);
  });

  test('[绿] 详情页在移动端不横向溢出', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.mobile);
    await openSession(dock);
    const overflow = await dock.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `详情页移动端横向溢出 ${overflow}px`).toBeLessThanOrEqual(0);
  });

  test('[绿] 详情页保留「执行记录 / 终端」两个页签', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await openSession(dock);
    const tabs = dock.getByRole('tab');
    await expect(tabs).toHaveCount(2);
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
    // light 现在是绿的（--surface-default 纯白 G==B），dark 是红的（#151c1b G>B）。
    test(`[${theme === 'light' ? '绿·护栏' : '红→绿'}] ${theme}：设置浮层表面色不带绿`, async ({ dock }) => {
      await dock.setViewportSize(VIEWPORTS.desktop);
      await openSettings(dock);
      await applyTheme(dock, theme, 'attr');
      const bg = await effectiveBackground(dock.locator(dialog).first());
      expect(isNeutralNotGreenish(bg), `设置浮层表面偏绿：${describeColor(bg)}`).toBe(true);
    });
  }

  /**
   * [红] 设置浮层里一个品牌色按钮都没有。
   *
   * 实测：浮层里 18 颗按钮只有三种底色——透明（4）、`#1a2233` 反色底（7）、
   * 纯白次要底（7）。`--action-primary`（#4f56e8）在这个界面上**完全没有出现**。
   * 每张 Agent 卡的主操作「用它创建任务」用的是 `tone="inverse"`
   * （ControlCenterModal.tsx:173），那是深藏青，不是品牌色。
   *
   * 于是换了色板之后，总览页是靛蓝的、设置页仍然是一片深藏青+白，两个界面看起来
   * 不像同一个产品。这不是色板没换到位，是这个界面**从来没有主操作层级**——
   * 所有操作都长一样重。改版应该让这里的主操作用上品牌色。
   */
  test('[红→绿] 设置浮层里的主操作按钮是靛蓝', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await openSettings(dock);
    await applyTheme(dock, 'light', 'attr');
    // 找 variant="primary" 那一颗，不能按文案取。
    //
    // 本来这里取的是「用它创建任务」，它是 `tone="inverse"`，底色走
    // `--surface-inverse` 深藏青——那是刻意的反色底，不是品牌色，断它「必须是靛蓝」
    // 是断错了对象。改成按真实渲染色筛：浮层里所有按钮中，取那颗底色等于
    // --action-primary 的。筛不到本身就是结论（见上面的注释）。
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
      `浮层主操作「${target.text}」色相应在靛蓝区间，实际 ${describeColor(target.bg!)}`).toBe(true);
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
    // 同上：light 纯白已绿，dark 仍偏绿。
    test(`[${theme === 'light' ? '绿·护栏' : '红→绿'}] ${theme}：命令面板表面色不带绿`, async ({ dock }) => {
      await dock.setViewportSize(VIEWPORTS.desktop);
      await openPalette(dock);
      await applyTheme(dock, theme, 'attr');
      const panel = dock.locator('[role="dialog"]').filter({ has: dock.locator('[role="listbox"]') }).first();
      const bg = await effectiveBackground(panel);
      expect(isNeutralNotGreenish(bg), `命令面板表面偏绿：${describeColor(bg)}`).toBe(true);
    });
  }

  test('[红→绿] 选中项高亮是靛蓝族', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await openPalette(dock);
    await applyTheme(dock, 'light', 'attr');
    const active = dock.locator('[role="option"][aria-selected="true"]').first();
    await expect(active, '命令面板没有 aria-selected 的选中项').toBeVisible();
    const bg = await effectiveBackground(active);
    const { h, s } = hslOf(bg);
    // 高亮可以是很淡的底（低饱和），只要求「不是绿的」；有明显色相时必须落在靛蓝。
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

  /**
   * 护栏：命令面板必须在**每条路由**上都能唤起。
   *
   * dutydeck 的命令面板是全局的，不应退化为仅单页面有效。改版设计不包括把这个能力对齐掉，
   * 所以钉一条断言在这里：改版期间任何人把面板挂载点从 App 根挪进某个页面组件，这条会红。
   */
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
