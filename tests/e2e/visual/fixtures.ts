import { test as base, type Page, type Locator } from '@playwright/test';

/**
 * 视觉 e2e 的页面装配层。
 *
 * ## 为什么不用 `waitUntil: 'networkidle'`
 *
 * 任务详情页开着 SSE 长连接，networkidle 永远不会触发（实测 30s 超时）。
 * 所以统一走 `domcontentloaded` + 等一个真实的 DOM 锚点，锚点用侧栏（每页都有、
 * 在 React 挂载后才出现），再加一小段静默期让 Tailwind 的过渡结束——过渡期间
 * 取 computed background-color 会拿到插值中的中间色。
 *
 * ## 为什么主题要两条路径都测
 *
 * 契约里主题有三层覆盖（裸 :root / prefers-color-scheme / [data-theme]）。
 * 只测 data-theme 会漏掉「系统深色但没写属性」这条分支——那是默认「跟随系统」的
 * 用户走的路径，也是最容易在重构中被漏掉一层的地方。
 */

export const BASE_URL = process.env.DUTYDECK_E2E_BASE_URL ?? 'http://10.37.33.49:4310';

export type ThemeMode = 'light' | 'dark';
/** attr = 显式 data-theme；media = 不写属性，靠 prefers-color-scheme。 */
export type ThemePath = 'attr' | 'media';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 }
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

/** 等页面「稳定」：React 挂载完 + 过渡结束。侧栏在移动端是 translate 出屏的，但节点仍在。 */
export async function settle(page: Page): Promise<void> {
  await page.waitForSelector('aside', { state: 'attached', timeout: 20_000 });
  await page.waitForFunction(() => document.querySelectorAll('button').length > 2, undefined, { timeout: 20_000 })
    .catch(() => { /* 空数据环境下按钮可能确实很少，不因此判失败 */ });
  await page.waitForTimeout(900);
}

/**
 * 主题落地。`attr` 直接写 documentElement，`media` 由 context 的 colorScheme 提供，
 * 此时必须确保没有残留的 data-theme（localStorage 里可能存着上次的显式选择）。
 */
export async function applyTheme(page: Page, theme: ThemeMode, path: ThemePath): Promise<void> {
  if (path === 'attr') {
    await page.evaluate(t => {
      document.documentElement.setAttribute('data-theme', t);
      try { window.localStorage.setItem('dutydeck.theme', t); } catch { /* 隐私模式忽略 */ }
    }, theme);
  } else {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
      try { window.localStorage.removeItem('dutydeck.theme'); } catch { /* 同上 */ }
    });
  }
  await page.waitForTimeout(400);
}

/** 取一个元素的 computed 属性值。分开成函数是为了让断言里只剩「取值 + 判定」两件事。 */
export const computed = (locator: Locator, prop: string): Promise<string> =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

/** 取 :root 上的 CSS 变量真实解析值——token 是否被定义、被哪一层覆盖，只能这样看。 */
export const cssVar = (page: Page, name: string): Promise<string> =>
  page.evaluate(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/**
 * 沿祖先链找到第一个不透明的背景色。
 *
 * 大量元素的 background-color 是 `rgba(0,0,0,0)`，肉眼看到的是祖先透出来的颜色。
 * 直接断言元素自身的背景会在「透明」上误判，所以统一取「实际看到的那个色」。
 */
export function effectiveBackground(locator: Locator): Promise<string> {
  return locator.evaluate(el => {
    let node: Element | null = el;
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      const alpha = bg.match(/[\d.]+/g)?.[3];
      if (bg && bg !== 'transparent' && alpha !== '0') return bg;
      node = node.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  });
}

/** 拿一个真实存在的会话 id，用于详情页。取未归档的第一条，没有就退到任意一条。 */
export async function firstSessionId(baseURL = BASE_URL): Promise<string | undefined> {
  const res = await fetch(`${baseURL}/api/sessions`);
  if (!res.ok) return undefined;
  const list = (await res.json()) as { id: string; archivedAt: string | null }[];
  return (list.find(s => !s.archivedAt) ?? list[0])?.id;
}

export const test = base.extend<{ dock: Page }>({
  dock: async ({ page }, use) => {
    page.setDefaultTimeout(20_000);
    await use(page);
  }
});

export { expect } from '@playwright/test';
