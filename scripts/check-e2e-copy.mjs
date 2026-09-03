import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
  e2e 脚本里的界面文案，必须在 apps/web/src 里真实存在。

  ## 为什么需要它

  2026-09-03 的功能 e2e 排查里挖出 4 处失效断言，全部出自本分支自己的两次改名
  （5babe68「消除自相矛盾的状态口径」、f7a5e10「术语统一为任务与指令两级」）。
  改了产品文案，没同步 e2e 脚本——**靠人记得回来同步，已经失败过两次**。

  其中 `e2e-product-smoke.mjs:403` 是最危险的一种：

      const rows = await help.locator('li', { hasText: '当前不可用：先打开一个任务运行' }).count();
      assert(unavailableRows === rows, '...');

  文案改名后 `hasText` 匹配不到，`count()` 返回 0，而被比较的另一边恰好也是 0，
  于是 `0 === 0` **绿着通过**。它测的东西整个消失了，仪表盘反而更好看。

  这类缺陷的一般形式是：**「找不到」的返回值恰好是一个合法的期望值**——
  `count()` 返回 0、`filter()` 返回空数组、`?.` 短路成 undefined。
  另外四个当日发现的断言 bug 都会让测试变红，红了自然有人查；只有这种绿着说谎。

  ## 为什么是这个检查方式

  它**不看测试结果**，只做字符串存在性回查，所以绿着的谎也躲不掉。
  跑一次 e2e 要拉起浏览器和服务，这个检查是纯文本比对，毫秒级。
*/

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const webSrc = resolve(repoRoot, 'apps/web/src');

/** 被扫描的 e2e 脚本。新增脚本请加进来。 */
const scripts = [
  'scripts/e2e-product-smoke.mjs',
  'scripts/e2e-smoke.mjs',
  'tests/e2e/functional/journeys.mjs'
];

/*
  只取用于定位 DOM 的文案参数。

  1. `hasText:` / `text:` —— Playwright 专有，直接取。
  2. `name:` —— 通用字段名，mock CLI 构造工具调用事件时写的 `name: 'Bash'` 也长这样，
     所以只在**紧跟 getByRole 的选项对象里**才算。

  ## 已知覆盖缺口：`includes('…')` 形式的文本断言

  当日 4 处失效里有 1 处是 `assert(toast.includes('任务运行已归档'))`，**本检查抓不到**。
  我试过把 `includes\('…'\)` 加进正则，结果 9 处误报：`includes('text/html')`
  与 `includes('<div id="root"')` 是 HTTP 响应检查，`ALPHA_MARKER`/`BETA_MARKER`
  是串台测试自己注入的标记——它们都不是界面文案。

  `includes()` 太通用，靠正则分不出「比对界面文本」和「比对响应体」。
  **宁可漏报也不误报**：一条天天误报的检查，三个月内一定会被某个赶时间的人注释掉，
  那时连现在这 3/4 的覆盖也没了。

  想补上这个缺口，正确做法是在 e2e 侧提供一个专用断言（比如
  `assertUiText(actual, '任务已归档')`），让「这是界面文案」变成语法上可识别的，
  而不是继续加正则。留给需要它的人。

  刻意不扫所有字符串：测试数据（任务名、cwd、URL）本就不该在源码里出现，
  扫进来只制造噪音，然后有人为了消噪把整条检查关掉。
*/
const LOCATOR_TEXT = /(?:(?:hasText|text):\s*'([^']{2,})')|(?:getByRole\([^)]*?\bname:\s*'([^']{2,})')/g;

/*
  豁免。每条都要写明理由——这不是「对不上就往里加」的垃圾桶，
  往里加一条之前先确认：真的不是产品文案改名漏同步了吗？
*/
const exempt = new Set([
  // e2e 自己造的测试数据，不来自界面
  'MOCK_REPLY',
  'MOCK_CONTINUED'
]);

/*
  测试夹具（harness）自己创建的数据也算「存在」：Agent 名 `Mock Claude`、
  工具名 `Bash` 这些是 e2e 造出来喂给产品的，界面把它们渲染出来，
  源码里当然搜不到。

  这条比往 exempt 里加名字好：加名字要求每次新增夹具数据都回来改这个文件，
  而人不会记得——这正是本检查存在的原因。把 harness 一起当作事实来源，
  夹具改名时检查自然跟着走。
*/
const fixtures = ['scripts/e2e-harness.mjs', 'tests/e2e/functional/journey-harness.mjs'];

function sourceText() {
  const chunks = [];
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(tsx?|css)$/.test(entry)) continue;
      chunks.push(readFileSync(full, 'utf8'));
    }
  };
  walk(webSrc);
  for (const rel of fixtures) {
    try { chunks.push(readFileSync(resolve(repoRoot, rel), 'utf8')); } catch { /* 夹具可选 */ }
  }
  return chunks.join('\n');
}

const haystack = sourceText();
const stale = [];

for (const rel of scripts) {
  let text;
  try { text = readFileSync(resolve(repoRoot, rel), 'utf8'); }
  catch { continue; }          // 脚本可以不存在，别让检查本身成为障碍
  for (const match of text.matchAll(LOCATOR_TEXT)) {
    const literal = match[1] ?? match[2] ?? match[3];
    if (!literal || exempt.has(literal)) continue;
    // 正则片段（`飞书接入|...`）是刻意的能力探测写法：任一分支命中即算存在
    const alternatives = literal.split('|').map(part => part.trim()).filter(Boolean);
    if (alternatives.some(part => haystack.includes(part))) continue;
    stale.push({ rel, literal });
  }
}

if (stale.length) {
  console.error(`\n✗ ${stale.length} 处 e2e 文案在 apps/web/src 里已不存在：\n`);
  for (const { rel, literal } of stale) console.error(`  ${rel}\n    '${literal}'`);
  console.error(`
这些断言现在要么会超时失败，要么——更糟——**绿着通过但什么都没测**
（locator 找不到时 count() 返回 0，恰好等于期望值时断言恒真）。

修法：去 apps/web/src 找到改名后的新文案，同步过来。
不要通过放宽 locator（改成更短的子串）来"修好"它——那会让下一次改名同样悄无声息。
`);
  process.exit(1);
}

console.log(`✓ e2e 文案回查：${scripts.length} 个脚本的界面文案全部在 apps/web/src 中存在`);
