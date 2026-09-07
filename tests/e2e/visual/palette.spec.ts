import { test, expect, BASE_URL, VIEWPORTS, applyTheme, settle, cssVar, effectiveBackground, computed, type ThemeMode, type ThemePath } from './fixtures';
import { hslOf, describeColor, hueWithin, isNeutralNotGreenish, parseRgb } from './color';
import { BRAND_HUE, BRAND_MIN_SATURATION, FORBIDDEN_TEAL_HUE, BRAND_MIN_SATURATION as MIN_SAT } from './redesign-contract';

/**
 * 色板验收：品牌色是靛蓝、灰阶不带绿。
 *
 * ## 现在应该红，改完应该绿
 *
 * 全部 red——`--action-primary` 现在是 `#0f766e`（H≈176 青绿），中性色 `#f5f7f6`
 * / `#17201f` 的 G 通道恒比 B 高。这两条是用户说「太难看」的直接原因：
 * 主色偏医疗/终端绿，灰阶朝黄绿偏所以显脏。
 *
 * ## 为什么断言渲染值而不是 token 字面量
 *
 * 只读 `--action-primary` 变量值，会漏掉「变量改了但按钮没消费到」的情况
 * （Tailwind 映射没更新、被更高优先级的手写类覆盖）。所以每条都取一次真实按钮的
 * `background-color`，token 值只作为辅助信息一起断言。
 */

const themeMatrix: { theme: ThemeMode; path: ThemePath }[] = [
  { theme: 'light', path: 'attr' },
  { theme: 'dark', path: 'attr' },
  { theme: 'light', path: 'media' },
  { theme: 'dark', path: 'media' }
];

test.describe('色板 · 品牌色', () => {
  for (const { theme, path } of themeMatrix) {
    test(`[红→绿] ${theme}/${path}：主操作按钮背景色相落在靛蓝区间`, async ({ dock }) => {
      await dock.setViewportSize(VIEWPORTS.desktop);
      await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await settle(dock);
      await applyTheme(dock, theme, path);

      // 首屏真实主操作是 Bot 概览里的「绑定飞书 Bot」（<Button variant="primary">）。
      // 「创建任务」已降为 variant="secondary"（走 bg-surface），量它只会量到卡片底色，
      // 那会让这条品牌色护栏在实现真的退化时也照样绿——所以必须锚定当前的 primary。
      const primary = dock.locator('main').getByRole('button', { name: /^(绑定|管理)飞书 Bot$/ }).first();
      await expect(primary).toBeVisible();

      const bg = await computed(primary, 'background-color');
      const { h, s } = hslOf(bg);

      expect(hueWithin(h, FORBIDDEN_TEAL_HUE.min, FORBIDDEN_TEAL_HUE.max),
        `主操作按钮仍是青绿系：${describeColor(bg)}`).toBe(false);
      expect(hueWithin(h, BRAND_HUE.min, BRAND_HUE.max),
        `主操作按钮色相应在 ${BRAND_HUE.min}–${BRAND_HUE.max}（靛蓝），实际 ${describeColor(bg)}`).toBe(true);
      expect(s, `主操作按钮饱和度过低，看起来是灰不是品牌色：${describeColor(bg)}`).toBeGreaterThanOrEqual(MIN_SAT);
    });
  }

  test('[红→绿] --action-primary token 本身就是靛蓝（浅色）', async ({ dock }) => {
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    await applyTheme(dock, 'light', 'attr');
    const token = await cssVar(dock, '--action-primary');
    // token 是 hex，浏览器不会归一化 CSS 变量的值，所以自己转 rgb() 形式再解析。
    const rgb = await dock.evaluate(hex => {
      const probe = document.createElement('span');
      probe.style.color = hex; document.body.appendChild(probe);
      const v = getComputedStyle(probe).color; probe.remove(); return v;
    }, token);
    const { h } = hslOf(rgb);
    expect(hueWithin(h, BRAND_HUE.min, BRAND_HUE.max),
      `--action-primary = ${token} → ${describeColor(rgb)}，应为靛蓝`).toBe(true);
  });

  test('[红→绿] 侧栏强调色不再是薄荷绿', async ({ dock }) => {
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    await applyTheme(dock, 'light', 'attr');
    const token = await cssVar(dock, '--sidebar-accent');
    const rgb = await dock.evaluate(hex => {
      const probe = document.createElement('span');
      probe.style.color = hex; document.body.appendChild(probe);
      const v = getComputedStyle(probe).color; probe.remove(); return v;
    }, token);
    const { h } = hslOf(rgb);
    // 现状 #5eead4 → H≈171。侧栏强调色和主操作色必须同族，否则界面出现两个「主色」。
    expect(hueWithin(h, FORBIDDEN_TEAL_HUE.min, FORBIDDEN_TEAL_HUE.max),
      `--sidebar-accent = ${token} → ${describeColor(rgb)} 仍是青绿`).toBe(false);
  });
});

test.describe('色板 · 中性灰不带绿', () => {
  for (const { theme, path } of themeMatrix) {
    test(`[红→绿] ${theme}/${path}：页面底色与正文色满足 B ≥ G`, async ({ dock }) => {
      await dock.setViewportSize(VIEWPORTS.desktop);
      await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      await settle(dock);
      await applyTheme(dock, theme, path);

      const canvas = await effectiveBackground(dock.locator('body'));
      const text = await computed(dock.locator('body'), 'color');

      expect(isNeutralNotGreenish(canvas),
        `页面底色偏绿（G > B）：${describeColor(canvas)}`).toBe(true);
      expect(isNeutralNotGreenish(text),
        `正文色偏绿（G > B）：${describeColor(text)}`).toBe(true);
    });
  }

  test('[绿·护栏] 卡片表面色不偏绿（浅色）', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    await applyTheme(dock, 'light', 'attr');
    // 现在就是绿的：`--surface-default` 是纯白 #ffffff，G == B，本来就中性。
    // 留着是护栏——换色板时很容易顺手把「白」调成带绿的米白。
    const card = dock.locator('aside[aria-label="协作入口"]');
    await expect(card).toBeVisible();
    const bg = await effectiveBackground(card);
    expect(isNeutralNotGreenish(bg), `卡片表面偏绿：${describeColor(bg)}`).toBe(true);
  });

  test('[红→绿] 边框色不偏绿（浅色）', async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    await applyTheme(dock, 'light', 'attr');
    for (const name of ['--border-default', '--border-subtle', '--surface-muted']) {
      const token = await cssVar(dock, name);
      const rgb = await dock.evaluate(hex => {
        const probe = document.createElement('span');
        probe.style.color = hex; document.body.appendChild(probe);
        const v = getComputedStyle(probe).color; probe.remove(); return v;
      }, token);
      const { g, b } = parseRgb(rgb);
      expect(b >= g, `${name} = ${token} 偏绿（G=${g} > B=${b}）`).toBe(true);
    }
  });
});
