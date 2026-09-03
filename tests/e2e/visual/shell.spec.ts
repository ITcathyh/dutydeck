import { test, expect, BASE_URL, VIEWPORTS, applyTheme, settle, effectiveBackground, type ThemeMode, type ThemePath } from './fixtures';
import { describeColor, luminanceOf } from './color';
import {
  DARK_SIDEBAR_MAX_LUMINANCE, LIGHT_SIDEBAR_MIN_LUMINANCE, SIDEBAR_CARD,
  SIDEBAR_NAV_ENTRIES, SIDEBAR_NAV_MIN_ENTRIES, SIDEBAR_NAV_MIN_GROUPS, SIDEBAR_WIDTH, TOPBAR_HEIGHT
} from './redesign-contract';

/**
 * 骨架验收：顶栏、侧栏宽度与形态、侧栏主题跟随、侧栏分组导航。
 *
 * ## 现在应该红，改完应该绿
 *
 * - 顶栏：整条红。现在 DOM 里唯一的 `<header>` 是总览页内容区里的页头（高 113px，
 *   透明底，随内容滚动），不是应用级顶栏。判据必须能区分二者——所以断言的是
 *   「存在一个横跨主区、贴顶不滚动、高 56px 的 banner」，光找 `<header>` 会被
 *   内容页头蒙混过关。56px 是我们统一后的单值，botmux 实际渲染 60px 是它的
 *   off-by-4 bug，不复刻（见 redesign-contract.ts 的 TOPBAR_HEIGHT 注释）。
 * - 侧栏宽度：红。桌面实测 292px（`md:w-[292px]`）。
 * - 侧栏形态：红。现在是 `fixed inset-y-0 left-0` 贴边通栏，圆角 0、左边距 0；
 *   目标是四周留白的悬浮卡片。
 * - 侧栏主题跟随：浅色红、深色绿。`--sidebar-surface` 在两套主题里都是深色
 *   （#16201f / #0a0f0e），这是 tokens.css 里刻意写的「恒深色导航底盘」，
 *   改版要推翻的正是这条。
 * - 侧栏分组导航：红。四个功能全在「Agent 与设置」一个弹层入口后面，且没有分组。
 */

const sidebar = 'aside[aria-label="Dockmux 工作台导航"]';

test.describe('骨架 · 应用顶栏', () => {
  const cases: { viewport: keyof typeof VIEWPORTS }[] = [{ viewport: 'desktop' }, { viewport: 'mobile' }];
  for (const { viewport } of cases) {
    test(`[红→绿] ${viewport}：存在贴顶的应用顶栏且高 ${TOPBAR_HEIGHT.value}px`, async ({ dock }) => {
      await dock.setViewportSize(VIEWPORTS[viewport]);
      await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await settle(dock);

      // 「应用顶栏」的可执行定义：贴着视口顶部（y ≤ 2）、横跨主内容区（宽度 ≥ 视口的一半）、
      // 高度落在 56±2。内容页头 y=32 且随内容滚动，天然被排除。
      const bar = await dock.evaluate(() => {
        const candidates = [...document.querySelectorAll('header,[role="banner"],[data-app-topbar]')];
        return candidates.map(el => {
          const r = el.getBoundingClientRect();
          return { tag: el.tagName, role: el.getAttribute('role'), y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width), position: getComputedStyle(el).position };
        });
      });
      const vw = VIEWPORTS[viewport].width;
      const topbar = bar.find(b => b.y <= 2 && b.w >= vw * 0.5);
      expect(topbar, `没有找到贴顶的应用顶栏。当前候选：${JSON.stringify(bar)}`).toBeTruthy();
      expect(Math.abs((topbar?.h ?? 0) - TOPBAR_HEIGHT.value),
        `顶栏高度应为 ${TOPBAR_HEIGHT.value}px，实际 ${topbar?.h}px`).toBeLessThanOrEqual(TOPBAR_HEIGHT.tolerance);
    });
  }

  test('[红→绿] 顶栏在内容滚动时保持贴顶', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    // 判据必须同时含「贴顶」和「是顶栏」两半。只判 y <= 2 会被滚上去的内容页头
    // 蒙混过关——它滚到 y=-568 时同样满足 y <= 2（实测这条一开始就是这么假绿的）。
    const topbarAt = () => dock.evaluate(vw =>
      [...document.querySelectorAll('header,[role="banner"],[data-app-topbar]')]
        .map(el => { const r = el.getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) }; })
        .filter(b => b.y >= -2 && b.y <= 2 && b.w >= vw * 0.5), VIEWPORTS.desktop.width);

    const before = await topbarAt();
    expect(before.length, '滚动前就没有贴顶的应用顶栏').toBeGreaterThan(0);
    // 主内容区是内部滚动容器（overflow-y-auto），滚 window 无效。
    await dock.evaluate(() => {
      const scroller = document.querySelector('main .overflow-y-auto') ?? document.scrollingElement;
      scroller?.scrollTo(0, 600);
    });
    await dock.waitForTimeout(400);
    const after = await topbarAt();
    expect(after.length, `滚动后顶栏不再贴顶（滚动前 ${JSON.stringify(before)}，滚动后 ${JSON.stringify(after)}）`).toBeGreaterThan(0);
  });
});

test.describe('骨架 · 侧栏宽度与形态', () => {
  test(`[红→绿] 桌面侧栏宽 ${SIDEBAR_WIDTH.value}px`, async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    const width = await dock.locator(sidebar).evaluate(el => el.getBoundingClientRect().width);
    expect(Math.abs(width - SIDEBAR_WIDTH.value),
      `侧栏宽度应为 ${SIDEBAR_WIDTH.value}px，实际 ${width}px`).toBeLessThanOrEqual(SIDEBAR_WIDTH.tolerance);
  });

  test('[红→绿] 桌面侧栏是悬浮卡片（四周留白 + 圆角），不是贴边通栏', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    const shape = await dock.locator(sidebar).evaluate(el => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        left: Math.round(r.x), top: Math.round(r.y), bottom: Math.round(window.innerHeight - r.bottom),
        radius: parseFloat(cs.borderTopLeftRadius) || 0
      };
    });
    // 只断宽度会让「292 改成 248 但仍然贴边」蒙混过关，所以形态单独断。
    expect(shape.left, `侧栏左边距 ${shape.left}px，应 ≥ ${SIDEBAR_CARD.minInset}px（现在是贴边通栏）`)
      .toBeGreaterThanOrEqual(SIDEBAR_CARD.minInset);
    expect(shape.top, `侧栏上边距 ${shape.top}px，应 ≥ ${SIDEBAR_CARD.minInset}px`)
      .toBeGreaterThanOrEqual(SIDEBAR_CARD.minInset);
    expect(shape.radius, `侧栏圆角 ${shape.radius}px，应 ≥ ${SIDEBAR_CARD.minRadius}px`)
      .toBeGreaterThanOrEqual(SIDEBAR_CARD.minRadius);
  });

  test('[红→绿] 侧栏顶边与顶栏底边对齐（不复刻 botmux 的 off-by-4）', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    const bars = await dock.evaluate(() =>
      [...document.querySelectorAll('header,[role="banner"],[data-app-topbar]')].map(el => {
        const r = el.getBoundingClientRect();
        return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) };
      }));
    const topbar = bars.find(b => b.y <= 2 && b.w >= VIEWPORTS.desktop.width * 0.5);
    test.skip(!topbar, '还没有应用顶栏，对齐无从谈起（见顶栏那条断言）');
    const sideTop = await dock.locator(sidebar).evaluate(el => Math.round(el.getBoundingClientRect().y));
    // botmux 侧栏 top = --topbar-h(56) + 16，而 topbar 实际 60px，于是差 4px。
    // 我们两处共用同一个 56px，侧栏顶边应恰好落在「顶栏底边 + 留白」上。
    const gap = sideTop - ((topbar?.y ?? 0) + (topbar?.h ?? 0));
    expect(gap, `侧栏顶边比顶栏底边低 ${gap}px，应 ≥ 0（负值即 botmux 那个 off-by-4）`).toBeGreaterThanOrEqual(0);
  });

  test('[绿] 移动端侧栏默认收起、不撑出横向滚动', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.mobile);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    const geo = await dock.locator(sidebar).evaluate(el => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), hidden: el.getAttribute('aria-hidden') };
    });
    expect(geo.x + geo.w, `移动端侧栏应完全移出视口左侧，实际右边缘 x=${geo.x + geo.w}`).toBeLessThanOrEqual(1);
    const overflow = await dock.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `移动端出现横向溢出 ${overflow}px`).toBeLessThanOrEqual(0);
  });
});

test.describe('骨架 · 侧栏跟随主题', () => {
  const paths: ThemePath[] = ['attr', 'media'];
  for (const path of paths) {
    test(`[红→绿] 浅色主题（${path}）下侧栏是浅底`, async ({ dock }) => {
      await dock.setViewportSize(VIEWPORTS.desktop);
      await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await settle(dock);
      await applyTheme(dock, 'light', path);
      const bg = await effectiveBackground(dock.locator(sidebar));
      const lum = luminanceOf(bg);
      expect(lum, `浅色主题下侧栏仍是深底：${describeColor(bg)}，相对亮度 ${lum.toFixed(3)}`)
        .toBeGreaterThanOrEqual(LIGHT_SIDEBAR_MIN_LUMINANCE);
    });

    test(`[绿] 深色主题（${path}）下侧栏仍是深底`, async ({ dock }) => {
      await dock.setViewportSize(VIEWPORTS.desktop);
      await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await settle(dock);
      await applyTheme(dock, 'dark', path);
      const bg = await effectiveBackground(dock.locator(sidebar));
      const lum = luminanceOf(bg);
      expect(lum, `深色主题下侧栏不该是浅底：${describeColor(bg)}，相对亮度 ${lum.toFixed(3)}`)
        .toBeLessThanOrEqual(DARK_SIDEBAR_MAX_LUMINANCE);
    });
  }

  test('[红→绿] 浅色主题下侧栏与画布底色亮度接近（不再割裂）', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    await applyTheme(dock, 'light', 'attr');
    const side = luminanceOf(await effectiveBackground(dock.locator(sidebar)));
    const canvas = luminanceOf(await effectiveBackground(dock.locator('body')));
    // 侧栏与画布可以有层次差，但不该是「一深一浅」两个世界。0.35 是宽松上限：
    // 白 vs 极浅灰约 0.05，白 vs 墨绿约 0.89。
    expect(Math.abs(side - canvas),
      `侧栏(${side.toFixed(3)}) 与画布(${canvas.toFixed(3)}) 亮度相差过大，视觉上像两个应用`).toBeLessThanOrEqual(0.35);
  });
});

test.describe('骨架 · 侧栏分组导航区', () => {
  test(`[红→绿] 侧栏直接可见至少 ${SIDEBAR_NAV_MIN_ENTRIES} 个功能入口`, async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    const nav = dock.locator(sidebar);
    const found: string[] = [];
    for (const name of SIDEBAR_NAV_ENTRIES) {
      // 用可见性而不是存在性：藏在弹层里的同名节点不算「侧栏直达」。
      if (await nav.getByText(name, { exact: false }).first().isVisible().catch(() => false)) found.push(name);
    }
    expect(found.length,
      `侧栏只直达了 ${found.length} 个功能入口（${found.join('、') || '无'}），期望至少 ${SIDEBAR_NAV_MIN_ENTRIES} 个；` +
      `当前四个功能全部藏在「Agent 与设置」弹层后面`).toBeGreaterThanOrEqual(SIDEBAR_NAV_MIN_ENTRIES);
  });

  test('[红→绿] 「飞书接入」在侧栏里可直接点到', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    const entry = dock.locator(sidebar).getByText(/飞书/).first();
    await expect(entry, '侧栏里找不到飞书相关的直达入口').toBeVisible();
  });

  test(`[红→绿] 侧栏导航是分组结构（至少 ${SIDEBAR_NAV_MIN_GROUPS} 组带标题）`, async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);

    // botmux 侧栏是 19 项分 5 组（概览/协作/数字员工/分析/管理，anatomy §A2 的 NAV_GROUPS）。
    // 只把功能链接平铺出来不算改对——平铺是不可读的，分组才是这块导航的价值。
    //
    // 「一组」的可执行定义：一个 <nav>/role=group/<section>/<ul> 容器，里面有一个
    // 组标题（非交互的文字节点）+ 至少一个可点条目。刻意不认「只有条目没标题」的
    // 容器，那是平铺不是分组。
    const groups = await dock.locator(sidebar).evaluate(el => {
      const containers = [...el.querySelectorAll('nav,[role="group"],section,ul')];
      return containers.map(c => {
        const items = c.querySelectorAll('a,button,[role="menuitem"],[role="listitem"],li').length;
        const heading = [...c.querySelectorAll('h2,h3,h4,[role="heading"],legend,.nav-group-title,[data-nav-group-title]')]
          .map(h => (h.textContent ?? '').trim()).filter(Boolean);
        return { items, heading: heading[0] ?? null };
      }).filter(g => g.items > 0 && g.heading);
    });

    expect(groups.length,
      `侧栏导航只有 ${groups.length} 个带标题的分组，期望至少 ${SIDEBAR_NAV_MIN_GROUPS} 个。` +
      `当前侧栏只有一个任务列表 + 底部一颗「Agent 与设置」按钮，没有分组导航。` +
      `实测容器：${JSON.stringify(groups)}`).toBeGreaterThanOrEqual(SIDEBAR_NAV_MIN_GROUPS);
  });

  test('[红→绿] 侧栏顶部有创建操作区，与导航项在形态上分开', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    // botmux 的 `.sidebar-create-actions` 在**顶部**、用虚线边框 + 6% accent 底
    // 与实线导航项区分（anatomy §A2）。dockmux 现在只有一颗实心「创建任务」，
    // 与下方列表没有形态区隔。这里断言「创建操作位于所有导航条目之上」。
    const layout = await dock.locator(sidebar).evaluate(el => {
      const create = [...el.querySelectorAll('button,a')].find(b => /创建/.test(b.textContent ?? ''));
      const navish = [...el.querySelectorAll('nav a,nav button,[role="group"] a,[role="group"] button')];
      if (!create || !navish.length) return null;
      return {
        createY: Math.round(create.getBoundingClientRect().y),
        firstNavY: Math.round(Math.min(...navish.map(n => n.getBoundingClientRect().y)))
      };
    });
    expect(layout, '侧栏里找不到「创建」操作与分组导航条目的组合（分组导航尚未存在）').toBeTruthy();
    expect(layout!.createY, `创建操作 y=${layout!.createY} 应在导航区 y=${layout!.firstNavY} 之上`)
      .toBeLessThan(layout!.firstNavY);
  });
});

test.describe('骨架 · 触控目标（契约 §9）', () => {
  /**
   * [红] 移动端主题切换的三颗按钮宽 34px，低于契约 §9 的 40px 命中区下限。
   *
   * 这条不在改版目标清单里，是我打开浏览器量出来的。桌面端它们带文字所以够宽，
   * 移动端塌成纯图标后宽度掉到 34px——**高度 40px 是达标的，只有宽度不够**，
   * 所以只看 min-h 的检查发现不了。契约 §9 写的是「命中区 ≥40px」，指两个方向。
   *
   * 三颗紧挨着排（gap 很小），点错一颗的代价是整个界面换主题，不算无害。
   */
  test('[红→绿] 移动端所有可点按钮的命中区两个方向都 ≥40px', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.mobile);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    const small = await dock.evaluate(() =>
      [...document.querySelectorAll('button,a[href]')]
        .filter(el => {
          const r = el.getBoundingClientRect();
          // 只看真正可见、在视口内的；隐藏在收起侧栏里的不算。
          return r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0 && r.y < window.innerHeight;
        })
        .map(el => {
          const r = el.getBoundingClientRect();
          return { label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 22), w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter(b => b.w < 40 || b.h < 40));
    expect(small, `以下按钮命中区小于 40×40（契约 §9）：${JSON.stringify(small)}`).toEqual([]);
  });
});
