// 改版前后的截图存档。
//
// 服务绑外部主机名而非 loopback，127.0.0.1 会 ERR_CONNECTION_REFUSED。
// 详情页开着 SSE，networkidle 永不触发（实测 30s 超时），所以统一用
// domcontentloaded + 等 DOM 锚点。
//
// 用法：
//   node scripts/shoot-redesign.mjs before   → docs/assets/redesign-before/
//   node scripts/shoot-redesign.mjs after    → docs/assets/redesign-after/
//   node scripts/shoot-redesign.mjs before --botmux   顺带截 botmux dashboard 参照
//
// 命名 {page}-{viewport}-{theme}.png，同一格子的 before/after 文件名完全一致，
// 便于左右并排肉眼复核。

import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.DUTYDECK_E2E_BASE_URL ?? 'http://10.37.33.49:4310';
const BOTMUX = process.env.BOTMUX_DASHBOARD_URL ?? 'http://127.0.0.1:7891';

const tag = process.argv[2] ?? 'before';
const withBotmux = process.argv.includes('--botmux');
const outDir = resolve(ROOT, `docs/assets/redesign-${tag}`);

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

/** React 挂载完 + 过渡结束才截图，否则会拍到过渡中的插值颜色。 */
async function settle(page) {
  await page.waitForSelector('aside', { state: 'attached', timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(2200);
}

async function applyTheme(page, theme) {
  await page.evaluate(t => {
    document.documentElement.setAttribute('data-theme', t);
    try { window.localStorage.setItem('dutydeck.theme', t); } catch {}
  }, theme);
  await page.waitForTimeout(500);
}

async function firstSessionId() {
  try {
    const res = await fetch(`${BASE}/api/sessions`);
    if (!res.ok) return undefined;
    const list = await res.json();
    return (list.find(s => !s.archivedAt) ?? list[0])?.id;
  } catch { return undefined; }
}

const sessionId = await firstSessionId();

// 每个 page 描述一格：怎么到达、到达后还要做什么。
const pages = [
  { name: 'overview', path: '/', prepare: null },
  sessionId
    ? { name: 'session-detail', path: `/sessions/${sessionId}`, prepare: p => p.waitForSelector('h1', { timeout: 20_000 }).catch(() => {}) }
    : null,
  { name: 'settings', path: '/?panel=settings&section=agents', prepare: p => p.waitForSelector('[role="dialog"]', { timeout: 20_000 }).catch(() => {}) },
  {
    name: 'command-palette', path: '/',
    prepare: async p => {
      await p.keyboard.press('Control+k');
      await p.waitForSelector('[role="listbox"]', { timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(600);
    }
  }
].filter(Boolean);

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const manifest = [];

for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
  for (const theme of ['light', 'dark']) {
    for (const spec of pages) {
      const page = await browser.newPage({ viewport, colorScheme: theme });
      const file = `${spec.name}-${vpName}-${theme}.png`;
      try {
        await page.goto(BASE + spec.path, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await settle(page);
        await applyTheme(page, theme);
        if (spec.prepare) await spec.prepare(page);
        await page.screenshot({ path: resolve(outDir, file), fullPage: false });
        manifest.push({ file, page: spec.name, viewport: vpName, theme, url: BASE + spec.path, ok: true });
        console.log('✓', file);
      } catch (err) {
        manifest.push({ file, page: spec.name, viewport: vpName, theme, ok: false, error: String(err).slice(0, 200) });
        console.log('✗', file, '—', String(err).split('\n')[0]);
      }
      await page.close();
    }
  }
}

// botmux 参照：只在服务确实活着时截，没跑就跳过，不去硬启别人的守护进程。
if (withBotmux) {
  let alive = false;
  try { alive = (await fetch(BOTMUX, { signal: AbortSignal.timeout(4000) })).ok; } catch {}
  if (!alive) {
    console.log('— botmux dashboard 未运行，跳过参照截图');
  } else {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      const page = await browser.newPage({ viewport });
      const file = `reference-botmux-${vpName}.png`;
      try {
        await page.goto(BOTMUX, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(4000);
        await page.screenshot({ path: resolve(outDir, file), fullPage: false });
        manifest.push({ file, page: 'reference-botmux', viewport: vpName, theme: 'dark', url: BOTMUX, ok: true });
        console.log('✓', file);
      } catch (err) {
        console.log('✗', file, '—', String(err).split('\n')[0]);
      }
      await page.close();
    }
  }
}

await browser.close();
await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify({ tag, base: BASE, capturedAt: new Date().toISOString(), shots: manifest }, null, 2) + '\n');
console.log(`\n${manifest.filter(m => m.ok).length}/${manifest.length} 张写入 ${outDir}`);
