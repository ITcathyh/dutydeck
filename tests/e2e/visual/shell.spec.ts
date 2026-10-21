import { test, expect, BASE_URL, VIEWPORTS, applyTheme, settle, effectiveBackground, type ThemePath } from './fixtures';
import { luminanceOf } from './color';
import { DARK_SIDEBAR_MAX_LUMINANCE, LIGHT_SIDEBAR_MIN_LUMINANCE, MIN_TOUCH_TARGET, SIDEBAR_NAV_ENTRIES, SIDEBAR_WIDTH, TOPBAR_HEIGHT } from './redesign-contract';

const sidebar = 'aside[aria-label="Dutydeck 工作台导航"]';

for (const viewport of ['desktop', 'mobile'] as const) {
  test(`[红→绿] ${viewport}：应用顶栏贴顶且符合原型高度`, async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS[viewport]);
    await dock.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    const candidates = await dock.getByRole('banner').evaluateAll(nodes => nodes.map(el => {
      const r = el.getBoundingClientRect(); return { y: r.y, h: r.height, w: r.width };
    }));
    expect(candidates).toHaveLength(1);
    expect(Math.abs(candidates[0]!.y)).toBeLessThanOrEqual(2);
    expect(candidates[0]!.w).toBeGreaterThanOrEqual(VIEWPORTS[viewport].width / 2);
    expect(Math.abs(candidates[0]!.h - TOPBAR_HEIGHT[viewport])).toBeLessThanOrEqual(TOPBAR_HEIGHT.tolerance);
    await dock.evaluate(() => document.querySelector('main .overflow-y-auto')?.scrollTo(0, 600));
    expect(Math.abs(await dock.getByRole('banner').evaluate(el => el.getBoundingClientRect().y))).toBeLessThanOrEqual(2);
  });
}

test('[红→绿] 桌面侧栏贴左全高，默认宽度符合原型', async ({ dock }) => {
  await dock.setViewportSize(VIEWPORTS.desktop);
  await dock.goto(BASE_URL, { waitUntil: 'domcontentloaded' }); await settle(dock);
  const shape = await dock.locator(sidebar).evaluate(el => {
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, bottom: r.bottom, height: window.innerHeight };
  });
  expect(Math.abs(shape.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(shape.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(shape.bottom - shape.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(shape.w - SIDEBAR_WIDTH.value)).toBeLessThanOrEqual(2);
});

test('[绿] 移动侧栏默认收起，无页面横向溢出', async ({ dock }) => {
  await dock.setViewportSize(VIEWPORTS.mobile);
  await dock.goto(BASE_URL, { waitUntil: 'domcontentloaded' }); await settle(dock);
  const right = await dock.locator(sidebar).evaluate(el => el.getBoundingClientRect().right);
  expect(right).toBeLessThanOrEqual(1);
  expect(await dock.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
});

for (const path of ['attr', 'media'] as ThemePath[]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`[绿] ${theme}/${path}：侧栏跟随主题`, async ({ dock }) => {
      await dock.goto(BASE_URL, { waitUntil: 'domcontentloaded' }); await settle(dock);
      await applyTheme(dock, theme, path);
      const luminance = luminanceOf(await effectiveBackground(dock.locator(sidebar)));
      if (theme === 'light') expect(luminance).toBeGreaterThanOrEqual(LIGHT_SIDEBAR_MIN_LUMINANCE);
      else expect(luminance).toBeLessThanOrEqual(DARK_SIDEBAR_MAX_LUMINANCE);
    });
  }
}

test('[红→绿] 工作台、全部任务、自动化是独立主导航，项目区有标题', async ({ dock }) => {
  await dock.goto(BASE_URL, { waitUntil: 'domcontentloaded' }); await settle(dock);
  const nav = dock.locator(sidebar);
  for (const name of SIDEBAR_NAV_ENTRIES) await expect(nav.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(nav.getByText(/^项目\s*\d*$/)).toBeVisible();
  const create = nav.getByRole('button', { name: '创建任务', exact: true });
  await expect(create).toBeVisible();
  expect((await create.boundingBox())!.y).toBeLessThan((await nav.getByRole('button', { name: /^工作台/ }).boundingBox())!.y);
});

test('[红→绿] 移动端可见按钮及链接命中区至少44px', async ({ dock }) => {
  await dock.setViewportSize(VIEWPORTS.mobile);
  await dock.goto(BASE_URL, { waitUntil: 'domcontentloaded' }); await settle(dock);
  const small = await dock.evaluate(min => [...document.querySelectorAll('button,a[href]')].flatMap(el => {
    const r = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!r.width || !r.height || r.right <= 0 || r.left >= innerWidth || r.bottom <= 0 || r.top >= innerHeight || style.visibility === 'hidden' || el.closest('[inert],[aria-hidden="true"]')) return [];
    return r.width < min || r.height < min ? [{ name: el.getAttribute('aria-label') || el.textContent?.trim(), w: r.width, h: r.height }] : [];
  }), MIN_TOUCH_TARGET);
  expect(small, JSON.stringify(small)).toEqual([]);
});
