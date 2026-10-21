import { test, expect, BASE_URL, VIEWPORTS, applyTheme, settle, cssVar, effectiveBackground, computed, type ThemeMode, type ThemePath } from './fixtures';
import { hslOf, describeColor, hueWithin, isCalmNeutral, parseRgb, contrastRatio } from './color';
import { BRAND_HUE, BRAND_MIN_SATURATION } from './redesign-contract';

const themeMatrix: { theme: ThemeMode; path: ThemePath }[] = [
  { theme: 'light', path: 'attr' }, { theme: 'dark', path: 'attr' },
  { theme: 'light', path: 'media' }, { theme: 'dark', path: 'media' }
];

for (const { theme, path } of themeMatrix) {
  test(`[红→绿] ${theme}/${path}：真实主操作使用橙棕强调色`, async ({ dock }) => {
    await dock.setViewportSize(VIEWPORTS.desktop);
    await dock.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    await applyTheme(dock, theme, path);
    const primary = dock.locator('main').getByRole('button', { name: /^(绑定|管理)飞书 Bot$/ }).first();
    await expect(primary).toBeVisible();
    const bg = await computed(primary, 'background-color');
    const { h, s } = hslOf(bg);
    expect(hueWithin(h, BRAND_HUE.min, BRAND_HUE.max), describeColor(bg)).toBe(true);
    expect(s, describeColor(bg)).toBeGreaterThanOrEqual(BRAND_MIN_SATURATION);
    expect(contrastRatio(await computed(primary, 'color'), bg), '主操作文本对比度').toBeGreaterThanOrEqual(4.5);
    for (const name of ['--action-primary', '--sidebar-accent']) {
      const token = await cssVar(dock, name);
      const rgb = await dock.evaluate(color => {
        const probe = document.createElement('span'); probe.style.color = color; document.body.append(probe);
        const resolved = getComputedStyle(probe).color; probe.remove(); return resolved;
      }, token);
      expect(hueWithin(hslOf(rgb).h, BRAND_HUE.min, BRAND_HUE.max), `${name}: ${describeColor(rgb)}`).toBe(true);
    }
  });

  test(`[红→绿] ${theme}/${path}：低彩度底色与可读正文`, async ({ dock }) => {
    await dock.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await settle(dock);
    await applyTheme(dock, theme, path);
    const canvas = await effectiveBackground(dock.locator('body'));
    const text = await computed(dock.locator('body'), 'color');
    expect(isCalmNeutral(canvas), describeColor(canvas)).toBe(true);
    expect(isCalmNeutral(text), describeColor(text)).toBe(true);
    expect(contrastRatio(text, canvas), '正文与画布对比度').toBeGreaterThanOrEqual(7);
    if (theme === 'light') {
      const { r, g, b } = parseRgb(canvas);
      expect(r >= g && g >= b, `浅色画布应为暖白：${canvas}`).toBe(true);
    }
    for (const name of ['--border-default', '--border-subtle', '--surface-muted']) {
      const rgb = await dock.evaluate(variable => {
        const probe = document.createElement('span'); probe.style.color = `var(${variable})`; document.body.append(probe);
        const result = getComputedStyle(probe).color; probe.remove(); return result;
      }, name);
      expect(isCalmNeutral(rgb), `${name}: ${describeColor(rgb)}`).toBe(true);
    }
  });
}
