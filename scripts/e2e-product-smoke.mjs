#!/usr/bin/env node
/**
 * dockmux 产品化能力端到端验收
 *
 * 定位：scripts/e2e-smoke.mjs 是发布主链路的基线（42 项断言），本脚本是它的**兄弟脚本**，
 * 专门验收三条新交付的产品化能力，一个都不与基线重叠：
 *   1. 深色模式（三态 / 持久化 / 真实计算色 / 终端跟随）
 *   2. 命令面板（Mod+K 打开、过滤、激活生效、Esc 关闭）
 *   3. 任务检索（英文 / 中文子串 / 全角归一化 / AND 语义）
 *   4. 键盘快捷键（? 帮助、n 新建、输入态抑制、g 和弦）
 *   5. Toast（真实 mutation 产生、Undo 生效、自动消失）
 *   6. 移动端终端快捷键条（≥44px 触控目标、按键真的写进 PTY、桌面不出现）
 *   7. 飞书 slash 命令（识别 / 白名单拒绝 / 能力缺失 unavailable）
 *   8. 飞书卡片按钮（冻结回执零按钮 / 渲染出的按钮回调层一定接受）
 *
 * 为什么另起一个文件而不是往 e2e-smoke.mjs 里加节
 *   基线脚本必须保持字节不变——它是「42 项断言全过」这个事实的载体，
 *   任何为了插入新节而做的重构都可能悄悄改变它的语义。共用的样板
 *   （临时端口 / 临时数据目录 / 前台 server / 假 CLI / 清理栈 / 看门狗）
 *   抽到 scripts/e2e-harness.mjs，两边遵守同一套约定，行为一致但互不影响。
 *
 * 两个执行域
 *   浏览器域（1–6）：真实 Chromium（headless）+ 真实 server + 假 CLI，验证 jsdom 证明不了的东西——
 *     计算样式、xterm 渲染层配色、真实 keydown 派发、真实触控目标尺寸、PTY 字节往返。
 *   模块域（7–8）：用 tsx 直接加载 apps/server/src/lark/*.ts，不发任何飞书消息、不需要任何凭证。
 *     这两项是纯函数契约，起浏览器反而绕远；但它们仍在同一份验收里报数。
 *
 * 假 CLI 与费用
 *   默认（也是唯一）模式为 mock：/tmp 下生成的 Node 脚本冒充 claude，经 DOCKMUX_AGENTS_JSON
 *   覆盖 claude-code 的 command，绝不触碰真实模型，也不会读写开发者的 ~/.dockmux 或 ~/.claude。
 *
 * 清理保证
 *   所有资源注册到 cleanup 栈并在 finally 里逆序释放；server 先 SIGTERM 后 SIGKILL 且杀整个进程组；
 *   全局看门狗（--timeout，默认 600s）到点强制清理退出 1；SIGINT/SIGTERM 同样走清理。
 *   启动前会检查端口是否空闲：同端口上活着的实例会替我们回 /health，导致断言跑在别人的数据上。
 *
 * 用法
 *   node scripts/e2e-product-smoke.mjs
 *   node scripts/e2e-product-smoke.mjs --port 14480 --verbose
 *   node scripts/e2e-product-smoke.mjs --only browser   # 只跑浏览器域
 *   node scripts/e2e-product-smoke.mjs --only lark      # 只跑模块域
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  REPO, assertPortFree, createCleanupStack, createDataDir, createHttp, createReporter,
  loadWebSocket, mockAgentsJson, parseArgs, sleep, startServer, waitFor, writeMockCli
} from './e2e-harness.mjs';

const { flag, value } = parseArgs();
const VERBOSE = flag('verbose');
// 默认端口刻意避开 14310/4310（开发者本地实例）与 14387（基线冒烟脚本）
const PORT = Number(value('port', '14481'));
// 全局超时给 600s：整套跑完实测约 260-300s（含两次 xterm 懒加载、Toast 的 4s 自动消失等待、
// 慢速假 CLI 的 9s 占位轮次）。300s 会在第 8 节把 server 杀掉，表现为 ERR_CONNECTION_REFUSED——
// 那是看门狗砍掉了自己的被测对象，会被误读成产品缺陷。留一倍余量。
const TIMEOUT_MS = Number(value('timeout', '600000'));
const ONLY = value('only', 'all');
const RUN_BROWSER = ONLY === 'all' || ONLY === 'browser';
const RUN_LARK = ONLY === 'all' || ONLY === 'lark';

const BASE = `http://127.0.0.1:${PORT}`;
const reporter = createReporter({ verbose: VERBOSE });
const { log, debug, ok, step, assert, section, setSectionReset } = reporter;
const { onCleanup, runCleanup } = createCleanupStack({ log });
const request = createHttp(BASE);

// 终端输入/回显的两种表示，别混用——混用会让一条本该有效的断言永远不成立。
//
//   写进 PTY：真正的控制字节（ESC = 0x1b，所以方向键上是 0x1b '[' 'A'）。
//   从 PTY 读回：终端行规程开着 ECHOCTL，控制字符被回显成**可打印的插入符记法**，
//                即 4 个字符 '^' '[' '[' 'A'（码位 94,91,91,65），里面一个 0x1b 都没有。
//
// 我在这上面栽过一次：断言写的是 includes(真 ESC 字节)，于是无论键条工作得多好都永远超时，
// 看上去像「有个键没送达」的产品缺陷。实测确认过：↑ 回显 "^[[A"、Esc 回显 "^["、^L 回显 "^L"。
const ARROW_UP = '\u001b[A';        // 写进 PTY 的字节
const ARROW_UP_ECHO = '^[[A';       // PTY 回显出来的插入符记法
const ESC_KEY = '\u001b';
const ESC_KEY_ECHO = '^[';

// 深浅色的判定基准：把 rgb() 解析成亮度。断言「两种主题的实际渲染色不同」时，
// 不比字符串而比亮度——这样即使调色板换了具体色值，只要仍是一深一浅，断言依然成立。
const luminance = color => {
  const parts = /rgba?\(([^)]+)\)/.exec(color ?? '');
  if (!parts) return undefined;
  const [r, g, b] = parts[1].split(',').map(part => Number(part.trim()));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// ── 浏览器域 ───────────────────────────────────────────────────────────────
async function browserAcceptance() {
  const dirs = createDataDir({ onCleanup, prefix: 'dockmux-product-' });

  // 一个假 CLI 文件，两个 agent 定义：默认 claude-code 秒回（各节快速跑到 completed），
  // 慢速那条（id 取 seed —— 与 claude-code 共用同一份 claude-family 实现）每轮 8s，
  // 只有前一轮真的还在跑，后发的指令才会**稳定地**停在 queued 上，Toast 的 Undo 路径才可达。
  // 轮次耗时由 MOCK_TURN_MS 控制，见 e2e-harness.mjs 的 writeMockCli / mockAgentsJson。
  const mockPath = writeMockCli(dirs.binDir);

  step('启动 server（临时端口 + 临时数据目录 + 假 CLI）');
  // 先确认端口没人占：同端口上活着的另一个实例会替我们回 /health，
  // 于是整套断言会跑在别人的数据库上——那种失败极难归因，必须在这里就拦死。
  await assertPortFree(PORT);
  const agentsJson = mockAgentsJson({ mockPath, dirs });
  const server = startServer({ port: PORT, dirs, agentsJson, onCleanup, verbose: VERBOSE });
  await server.waitUntilReady({ base: BASE });
  ok(`GET /health 返回 {ok:true}（端口 ${PORT}，由本次拉起的进程应答）`);
  // 干净起点：新数据库里不该有任何会话。有的话说明数据目录或端口串了。
  const preexisting = (await request('GET', '/api/sessions')).json ?? [];
  assert(preexisting.length === 0,
    `临时数据库是干净的（0 个既有会话，实际 ${preexisting.length}）——后续的检索计数断言才有意义`);

  // 三个目标刻意可区分：一条纯英文、一条纯中文、一条与前两者无共同子串。
  // 中文那条是本节的重点——实现用的是 NFKC + 子串而非分词，这条能证明中文检索真的可用。
  const goals = [
    { key: 'payment', prompt: 'refactor the payment gateway retries' },
    { key: 'cjk', prompt: '重构支付网关的重试逻辑' },
    { key: 'telemetry', prompt: 'clean up telemetry exporter' }
  ];
  step('用真实接口造三个可区分的任务（供检索与命令面板断言）');
  const sessions = {};
  for (const goal of goals) {
    const created = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: dirs.workspace });
    if (created.status !== 200) throw new Error(`创建任务失败：${created.status} ${created.text}`);
    sessions[goal.key] = created.json.id;
    onCleanup(`关闭任务运行 ${created.json.id}`, async () => { await request('POST', `/api/sessions/${created.json.id}/stop`); });
    const sent = await request('POST', `/api/sessions/${created.json.id}/send`, { prompt: goal.prompt, mode: 'queue' });
    if (sent.status !== 202) throw new Error(`派发任务失败：${sent.status} ${sent.text}`);
  }
  // 检索命中的是 run summary 的 prompt，所以必须等服务端把三条摘要都吐出来再进浏览器
  const summaries = await waitFor('三条 run summary 就绪', async () => {
    const response = await request('GET', '/api/sessions/summaries');
    return (response.json ?? []).length >= goals.length ? response.json : undefined;
  }, { timeoutMs: 40_000 });
  assert(goals.every(goal => summaries.some(summary => summary.prompt === goal.prompt)),
    `三个任务目标都已进入 run summary（含中文目标「${goals[1].prompt}」）`);

  let browser = await chromium.launch({ headless: true });
  onCleanup('关闭 Chromium', async () => {
    if (!browser) return;
    await browser.close();
    browser = undefined;
  });

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await desktop.newPage();
  const pageErrors = [];
  page.on('pageerror', error => { pageErrors.push(error.message); debug('browser pageerror', error.message); });

  const visibleDialogLabels = async (target = page) => {
    const labels = [];
    for (const dialog of await target.locator('[role="dialog"]').all()) {
      if (await dialog.isVisible().catch(() => false)) labels.push(await dialog.getAttribute('aria-label'));
    }
    return labels;
  };
  // 按 Escape 逐层收起浮层：浮层没关干净时，下一节的单键快捷键会因 enabled:false 全部沉默，
  // 那样后面的失败就不是被测能力的问题，而是脚本自己留下的脏状态。
  const dismissDialogs = async (target = page) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!(await visibleDialogLabels(target)).length) return;
      await target.keyboard.press('Escape');
      await target.waitForTimeout(350);
    }
    throw new Error(`浮层未能关闭：${JSON.stringify(await visibleDialogLabels(target))}`);
  };
  const gotoHome = async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ state: 'visible', timeout: 20_000 });
    // 等 agents / sessions 查询落地：快捷键的可用性依赖这些数据
    await page.waitForTimeout(2_000);
  };

  // 每节结束后无条件复位：把浮层关干净、把输入框清空。
  //
  // 必须放在 section 的 finally 里，而不是各节自己的结尾——一节在断言处抛出时，
  // 它结尾的清理代码根本不会执行，浮层就被留给了下一节。浮层开着时全套单键快捷键
  // 会被 enabled:false 集体停用，于是下一节报出的失败与它要测的能力毫无关系。
  //
  // 刻意**不**在这里 goto 首页：SPA 首屏重新加载会把懒加载 chunk 的时序问题
  // （样式表、xterm）重新引进来，那正是 44px 那条断言曾经误判的根源。
  // 复位只做「关浮层 + 清输入」这两件确定性的事，路由留给各节自己按需导航。
  setSectionReset(async () => {
    if (!browser) return;                 // 已进入清理阶段
    if (page.isClosed()) return;
    await dismissDialogs();
    // 清空所有可见的文本输入：上一节残留的文字会让下一节的 inputValue 断言看到脏值
    await page.evaluate(() => {
      for (const field of document.querySelectorAll('textarea, input[type="text"], input:not([type])')) {
        if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
          if (!field.value) continue;
          field.value = '';
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
  });

  await page.emulateMedia({ colorScheme: 'light' });
  await gotoHome();

  // ── 1. 深色模式 ─────────────────────────────────────────────────────────
  step('深色模式：三态切换、DOM 契约、持久化、真实计算色');
  const themeState = () => page.evaluate(() => ({
    attribute: document.documentElement.getAttribute('data-theme'),
    stored: window.localStorage.getItem('dockmux.theme'),
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    terminalBackground: getComputedStyle(document.documentElement).getPropertyValue('--terminal-bg').trim()
  }));
  await section('深色模式', async () => {
    const appearance = page.getByRole('radiogroup', { name: '界面外观' });
    await appearance.waitFor({ state: 'visible', timeout: 15_000 });
    const radios = appearance.getByRole('radio');
    assert(await radios.count() === 3, '外观选择是一组 3 个 radio（跟随系统 / 浅色 / 深色）');

    const initial = await themeState();
    assert(initial.attribute === null,
      `默认「跟随系统」时 documentElement 不写 data-theme（实际 ${JSON.stringify(initial.attribute)}）`);
    assert(initial.stored === null, '默认「跟随系统」时 localStorage 不留 dockmux.theme 键');
    assert(await appearance.getByRole('radio', { name: /^跟随系统/ }).getAttribute('aria-checked') === 'true',
      '「跟随系统」的 aria-checked 为 true（当前值不靠颜色单独表意）');

    await appearance.getByRole('radio', { name: /^深色/ }).click();
    const dark = await themeState();
    assert(dark.attribute === 'dark', `选择「深色」后 data-theme="dark"（实际 ${JSON.stringify(dark.attribute)}）`);
    assert(dark.stored === 'dark', '选择「深色」后偏好写入 localStorage.dockmux.theme');

    await appearance.getByRole('radio', { name: /^浅色/ }).click();
    const light = await themeState();
    assert(light.attribute === 'light', `选择「浅色」后 data-theme="light"（实际 ${JSON.stringify(light.attribute)}）`);
    assert(light.stored === 'light', '选择「浅色」后偏好写入 localStorage.dockmux.theme');

    // 这条是 jsdom 拿不到的核心断言：真实 Chromium 的计算背景色必须一深一浅。
    // 比亮度而不比色值字符串，调色板换色也不会让它变成假通过。
    const darkLuminance = luminance(dark.bodyBackground);
    const lightLuminance = luminance(light.bodyBackground);
    assert(darkLuminance !== undefined && lightLuminance !== undefined,
      `body 背景色可解析为 rgb（深色 ${dark.bodyBackground} / 浅色 ${light.bodyBackground}）`);
    assert(darkLuminance + 60 < lightLuminance,
      `深浅色的真实计算背景色显著不同：深色亮度 ${Math.round(darkLuminance)} 明显低于浅色 ${Math.round(lightLuminance)}`);
    assert(dark.terminalBackground !== light.terminalBackground,
      `--terminal-bg 随主题变化（深色 ${dark.terminalBackground} / 浅色 ${light.terminalBackground}）`);

    await appearance.getByRole('radio', { name: /^跟随系统/ }).click();
    const backToSystem = await themeState();
    assert(backToSystem.attribute === null,
      `从显式选择切回「跟随系统」会移除 data-theme（实际 ${JSON.stringify(backToSystem.attribute)}）`);
    assert(backToSystem.stored === null, '切回「跟随系统」会清掉 localStorage 里的偏好');

    // 「跟随系统」必须真的跟随：模拟系统外观翻转，不重载页面
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(500);
    const systemDark = await themeState();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(500);
    const systemLight = await themeState();
    assert(systemDark.attribute === null && systemLight.attribute === null,
      '跟随系统期间始终不写 data-theme（由 prefers-color-scheme 接管）');
    assert(luminance(systemDark.bodyBackground) + 60 < luminance(systemLight.bodyBackground),
      `跟随系统时真实渲染色随系统外观翻转（深 ${systemDark.bodyBackground} / 浅 ${systemLight.bodyBackground}）`);

    // 持久化跨刷新
    await appearance.getByRole('radio', { name: /^深色/ }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ state: 'visible', timeout: 20_000 });
    const afterReload = await themeState();
    assert(afterReload.attribute === 'dark' && afterReload.stored === 'dark',
      '刷新页面后仍是「深色」（偏好真的持久化，不是内存态）');
    assert(luminance(afterReload.bodyBackground) + 60 < lightLuminance,
      `刷新后真实渲染仍为深色（body 背景 ${afterReload.bodyBackground}）`);
    // 恢复默认，避免污染后面的节
    await page.evaluate(() => { window.localStorage.removeItem('dockmux.theme'); });
    await gotoHome();
  });

  // ── 2. 命令面板 ─────────────────────────────────────────────────────────
  step('命令面板：Mod+K 打开、输入过滤、激活生效、Esc 关闭');
  const palette = page.getByRole('dialog', { name: '搜索任务与命令' });
  const paletteInput = palette.getByRole('combobox', { name: '搜索任务与命令' });
  const paletteStatus = palette.getByRole('status');
  await section('命令面板', async () => {
    await page.keyboard.press('Control+k');
    await palette.waitFor({ state: 'visible', timeout: 10_000 });
    assert(await palette.isVisible(), 'Ctrl+K 在真实浏览器里打开了命令面板');
    assert(await paletteInput.evaluate(node => node === document.activeElement),
      '命令面板打开后焦点直接落在搜索框（无需再点一次）');
    const emptyQueryOptions = await palette.getByRole('option').count();
    assert(emptyQueryOptions > goals.length,
      `空查询时同时列出命令与最近任务（${emptyQueryOptions} 项 > ${goals.length} 个任务）`);

    const paletteTexts = async () => (await palette.getByRole('option').allInnerTexts()).join('\n');
    await paletteInput.fill('payment');
    await page.waitForTimeout(300);
    const paymentText = await paletteTexts();
    assert(await palette.getByRole('option').count() === 1,
      `输入「payment」后结果收窄到 1 项（实际 ${await palette.getByRole('option').count()}）`);
    assert(paymentText.includes(goals[0].prompt) && !paymentText.includes(goals[2].prompt),
      '命令面板过滤命中正确的任务，且排除了不相关任务');

    // 激活一个任务结果必须真的导航过去，而不只是关掉面板
    await paletteInput.fill('payment');
    await page.waitForTimeout(250);
    await palette.getByRole('option').first().click();
    await page.waitForURL(url => url.pathname === `/sessions/${sessions.payment}`, { timeout: 15_000 });
    ok(`在命令面板激活任务结果后真的导航到 /sessions/${sessions.payment}`);
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await gotoHome();

    // 激活一个命令结果必须真的执行那个命令
    await page.keyboard.press('Control+k');
    await palette.waitFor({ state: 'visible', timeout: 10_000 });
    await paletteInput.fill('创建');
    await page.waitForTimeout(300);
    const commandOnly = await palette.getByRole('option').allInnerTexts();
    assert(commandOnly.length === 1 && commandOnly[0].includes('创建任务'),
      `输入「创建」只剩「创建任务」这条命令（实际 ${JSON.stringify(commandOnly.map(text => text.split('\n')[0]))}）`);
    await palette.getByRole('option').first().click();
    const createDialog = page.getByRole('dialog', { name: '创建新任务' });
    await createDialog.waitFor({ state: 'visible', timeout: 10_000 });
    assert(await createDialog.isVisible(), '在命令面板激活「创建任务」真的打开了创建任务向导');
    await dismissDialogs();

    // Esc 关闭
    await page.keyboard.press('Control+k');
    await palette.waitFor({ state: 'visible', timeout: 10_000 });
    await page.keyboard.press('Escape');
    await palette.waitFor({ state: 'hidden', timeout: 10_000 });
    assert(!(await palette.isVisible().catch(() => false)), 'Esc 关闭命令面板');
  });

  // ── 3. 检索（含中文与全角） ─────────────────────────────────────────────
  step('任务检索：英文子串、中文子串、全角归一化、AND 语义');
  await section('任务检索', async () => {
    const searchSummary = async query => {
      await page.keyboard.press('Control+k');
      await palette.waitFor({ state: 'visible', timeout: 10_000 });
      await paletteInput.fill(query);
      await page.waitForTimeout(350);
      const result = {
        summary: await paletteStatus.innerText(),
        count: await palette.getByRole('option').count(),
        texts: (await palette.getByRole('option').allInnerTexts()).join('\n')
      };
      await page.keyboard.press('Escape');
      await palette.waitFor({ state: 'hidden', timeout: 10_000 });
      return result;
    };

    // 中文子串：实现刻意不分词，用 NFKC + 子串。这是最值得证明的一条：
    // 分词方案会把「支付网关」切碎从而漏掉这条任务，子串方案不会。
    const cjk = await searchSummary('支付网关');
    assert(cjk.count === 1 && cjk.texts.includes(goals[1].prompt),
      `中文查询「支付网关」命中中文任务（${cjk.summary.trim()}）`);
    const cjkMiddle = await searchSummary('重试逻辑');
    assert(cjkMiddle.count === 1 && cjkMiddle.texts.includes(goals[1].prompt),
      '中文查询命中的是子串而非前缀（「重试逻辑」出现在目标中段也能查到）');

    // 全角归一化：全角 ｐａｙｍｅｎｔ 必须等价于半角 payment
    const fullWidth = await searchSummary('ｐａｙｍｅｎｔ');
    assert(fullWidth.count === 1 && fullWidth.texts.includes(goals[0].prompt),
      '全角查询「ｐａｙｍｅｎｔ」经 NFKC 归一化后命中半角目标');
    const upperCase = await searchSummary('PAYMENT');
    assert(upperCase.count === 1 && upperCase.texts.includes(goals[0].prompt), '检索大小写无关');

    // AND 语义：两个词分别在不同任务里出现时，整体应无命中
    const conjunction = await searchSummary('payment telemetry');
    assert(conjunction.count === 0,
      `多词查询是 AND 语义：「payment telemetry」无命中（实际 ${conjunction.count} 项）`);
    const bothTerms = await searchSummary('payment retries');
    assert(bothTerms.count === 1 && bothTerms.texts.includes(goals[0].prompt),
      '同一任务内同时含两个词时命中（AND 成立而非永远为空）');
    const noMatch = await searchSummary('zzz-nonexistent-goal');
    assert(noMatch.count === 0, '无匹配查询返回空结果（不会回落成「列出全部」）');
  });

  // ── 4. 键盘快捷键 ───────────────────────────────────────────────────────
  step('键盘快捷键：? 帮助、n 新建、输入态抑制、g 和弦');
  const help = page.getByRole('dialog', { name: '键盘快捷键帮助' });
  // 帮助面板是快捷键的唯一说明书，它声称可用的条目必须真的可用。
  // 先把「n / 新建任务运行」在面板里的自述抓下来，下面按下 n 时两者必须一致。
  let helpClaimsCreateTaskUsable;
  await section('? 打开帮助面板', async () => {
    await gotoHome();
    await page.keyboard.press('?');
    await help.waitFor({ state: 'visible', timeout: 10_000 });
    assert(await help.isVisible(), '按 ? 打开快捷键帮助面板');
    const createTaskHelpRow = (await help.locator('li', { hasText: '新建任务' }).innerText()).replace(/\s+/g, ' ');
    helpClaimsCreateTaskUsable = !createTaskHelpRow.includes('当前不可用');
    debug('帮助面板对 n 的自述', createTaskHelpRow);

    // 帮助面板的「不可用」计数必须与作用域一致，不能被面板自身的浮层状态污染。
    //
    // 这条针对一类具体的错：把运行期的 enabled（浮层打开时整套快捷键停用）也喂给展示层。
    // 帮助面板自己就是浮层，一打开 overlayOpen 即为真，于是 21 条里 20 条被标成「当前不可用」——
    // 面板存在的意义正是告诉用户此刻能按什么，那样它每次打开都在撒谎。
    // 在任务中心（没有打开任何任务运行）只有 session 作用域的快捷键该不可用，其余全部可用。
    const unavailableRows = await help.locator('li', { hasText: '当前不可用' }).count();
    const totalRows = await help.locator('li').count();
    // 用「不可用的都必须是 session 作用域」来表达，而不是写死数字：
    // 注册表以后增删快捷键，这条断言仍然成立。
    const sessionScopedUnavailable = await help.locator('li', { hasText: '当前不可用：先打开一个任务' }).count();
    assert(unavailableRows === sessionScopedUnavailable,
      `任务中心打开帮助面板时，标为「当前不可用」的 ${unavailableRows} 条全部是 session 作用域快捷键（共 ${totalRows} 条），全局快捷键没有被面板自身的浮层状态误标`);
    assert(unavailableRows < totalRows / 2,
      `帮助面板不会把大多数快捷键标成不可用（${unavailableRows}/${totalRows} 不可用）`);
    await page.keyboard.press('Escape');
    await help.waitFor({ state: 'hidden', timeout: 10_000 });
    ok('Esc 关闭快捷键帮助面板');
  });

  // g 和弦：g l 打开飞书绑定向导
  await section('g 和弦', async () => {
    await page.keyboard.press('g');
    await page.keyboard.press('l');
    const larkWizard = page.getByRole('dialog', { name: /绑定.*Bot|飞书机器人/ });
    await larkWizard.waitFor({ state: 'visible', timeout: 15_000 });
    assert(await larkWizard.isVisible(), 'g l 和弦打开飞书 Bot 绑定向导');
    await dismissDialogs();
    // 无效和弦必须静默作废，不能让第二个键落到别的单键快捷键上
    await page.keyboard.press('g');
    await page.keyboard.press('z');
    await page.waitForTimeout(600);
    assert((await visibleDialogLabels()).length === 0,
      'g 之后按下不成和弦的键时静默作废（不会误触其它单键快捷键）');
  });

  // n 必须打开创建任务。这条断言不迁就实现：帮助面板把 n 列为可用，那按下去就必须是创建任务。
  await section('n 打开创建任务', async () => {
    await dismissDialogs();
    await page.keyboard.press('n');
    await page.waitForTimeout(900);
    const afterN = await visibleDialogLabels();
    assert(afterN.includes('创建新任务'),
      `在任务中心（整页加载后）按 n 打开创建任务向导（实际打开：${JSON.stringify(afterN)}）`);
  });

  // 帮助面板与实际行为的一致性。这一条与上一条分开，是为了在缺陷报告里把
  // 「n 打不开创建任务」和「按下去反而跑去了别的地方」这两种错分别定位。
  //
  // 注意这里不接受「面板说不可用 + 按下去开了别的浮层」这种组合：
  // shortcutAvailability 判为不可用的快捷键，按下去必须完全惰性（什么都不发生）。
  // 开出一个用户没要求的界面，比什么都不做更糟——那是误触，不是「不可用」。
  await section('帮助面板不撒谎', async () => {
    await dismissDialogs();
    await page.keyboard.press('n');
    await page.waitForTimeout(900);
    const opened = await visibleDialogLabels();
    if (helpClaimsCreateTaskUsable) {
      assert(opened.includes('创建新任务'),
        `帮助面板称 n 可用，按下去就打开创建任务（实际 ${JSON.stringify(opened)}）`);
    } else {
      assert(opened.length === 0,
        `帮助面板称 n 当前不可用，按下去必须完全惰性、不打开任何界面（实际 ${JSON.stringify(opened)}）`);
    }
  });

  // SPA 内导航到任务中心后再按 n —— 与整页加载走的是不同的渲染路径，两条都要成立
  await section('SPA 导航后 n 仍可用', async () => {
    await dismissDialogs();
    await page.goto(`${BASE}/sessions/${sessions.payment}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_500);
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await page.getByRole('heading', { name: '今天需要推进什么？' }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.keyboard.press('n');
    await page.waitForTimeout(900);
    const afterN = await visibleDialogLabels();
    assert(afterN.includes('创建新任务'),
      `经 SPA 导航（g t）回到任务中心后按 n 打开创建任务向导（实际：${JSON.stringify(afterN)}）`);
  });

  // 输入态抑制：在创建向导的输入框里连打单键快捷键的字符，必须一个都不触发。
  //
  // 注意这一节的证明力有限，别把它当成「输入态抑制」的主要证据：创建向导本身是浮层，
  // overlayOpen 为真时整套快捷键已被 enabled:false 全局停用，所以即使 isEditableTarget
  // 那条分支坏掉，这一节仍会通过（我变异验证过：注释掉 editable 判断，这里全绿）。
  // 真正考验 editable 分支的是下面 Composer 那一节——任务详情页没有浮层，
  // 单键快捷键此时是活的，只能靠「目标在输入框内」这一条来沉默。
  await section('输入态抑制单键快捷键（浮层路径）', async () => {
    await dismissDialogs();
    // 用可靠的入口打开创建向导：这一节要测的是输入态抑制，不该被 n 的缺陷挡住
    await page.getByRole('button', { name: '创建任务', exact: true }).first().click();
    const createTaskDialog = page.getByRole('dialog', { name: '创建新任务' });
    await createTaskDialog.waitFor({ state: 'visible', timeout: 10_000 });
    const goalField = createTaskDialog.getByLabel('任务目标');
    await goalField.click();
    await goalField.fill('');
    await page.keyboard.type('n?1te');
    await page.waitForTimeout(600);
    assert(await goalField.inputValue() === 'n?1te',
      `输入框内的字符原样落进输入框（实际 ${JSON.stringify(await goalField.inputValue())}）`);
    assert(!(await help.isVisible().catch(() => false)),
      '在输入框里打字时 ? 不会打开帮助面板（单键快捷键在输入态完全沉默）');
    assert((await visibleDialogLabels()).length === 1,
      '在输入框里打字不会叠出任何新浮层（n / 1 / t / e 全部沉默）');
    await dismissDialogs();
  });

  // 组合键在输入态仍必须可用——这是「沉默」与「瘫痪」的分界
  await section('输入态仍放行组合键', async () => {
    await page.goto(`${BASE}/sessions/${sessions.payment}`, { waitUntil: 'domcontentloaded' });
    // Composer 用 aria-label 定位，不用 locator('textarea').first()：
    // 页面上不止一个 textarea（系统提示词面板等也有），DOM 顺序会随加载时序变，
    // .first() 因此可能取到别的框，让这一节偶发失败在一个与被测能力无关的地方。
    const composer = page.getByLabel('消息', { exact: true });
    await composer.waitFor({ state: 'visible', timeout: 20_000 });
    await composer.click();
    await composer.fill('');
    // 确认焦点真的在 Composer 里再开始打字：焦点不在输入框时，这一节测的就不是输入态了
    await page.waitForFunction(() =>
      document.activeElement instanceof HTMLTextAreaElement
      && document.activeElement.getAttribute('aria-label') === '消息',
      undefined, { timeout: 10_000 });
    await page.keyboard.type('n?te');
    await page.waitForFunction(() => {
      const field = document.querySelector('textarea[aria-label="消息"]');
      return field instanceof HTMLTextAreaElement && field.value === 'n?te';
    }, undefined, { timeout: 10_000 }).catch(() => {});
    assert(await composer.inputValue() === 'n?te', 'Composer 里连打快捷键字符同样原样输入，不被劫持');
    // 这条是「输入态抑制」的核心证据：此刻没有任何浮层，单键快捷键本来是活的，
    // 唯一让它们沉默的就是 isEditableTarget。所以 n / ? / t / e 一个都不能起作用。
    assert((await visibleDialogLabels()).length === 0,
      '在 Composer 里打字时 n / ? / t / e 全部沉默，没有浮层被误开（无浮层环境下由 isEditableTarget 兜住）');
    await page.keyboard.press('Control+k');
    await palette.waitFor({ state: 'visible', timeout: 10_000 });
    assert(await palette.isVisible(), '在 Composer 内按 Ctrl+K 仍能打开命令面板（带修饰键的组合不被抑制）');
  });

  // ── 5. Toast ────────────────────────────────────────────────────────────
  step('Toast：真实 mutation 产生通知、Undo 生效、自动消失');
  await section('Toast 通知', async () => {
    const politeRegion = page.locator('[aria-live="polite"][aria-label="操作结果通知"]');
    const assertiveRegion = page.locator('[aria-live="assertive"][aria-label="失败与注意事项通知"]');
    assert(await politeRegion.count() === 1 && await assertiveRegion.count() === 1,
      '礼貌区与断言区两个 live region 常驻 DOM（读屏才会播报后插入的通知）');

    /**
     * 造一个**真的停在 queued 上**的任务。
     *
     * 这里必须用慢速 agent（每轮 8s），不能复用默认的 claude-code：
     * 默认假 CLI 一轮只要 300ms，先发的占位指令早就跑完了，后发的直接进运行态——
     * 「有一条指令在排队」这个前提根本不成立，取消按钮只在一个随机瞬间存在。
     * 曾经的写法是「先发占位 → 等 1.5s → 再发目标 → 轮询读到 queued 就点按钮」，
     * 但轮询只证明「某一瞬间读到过 queued」，读完到点下去之间它随时会转走，
     * 于是这一节偶发 15s 超时，看上去像产品缺陷。
     * 用慢速轮次把排队状态变成稳定事实，断言测的仍然是真实排队与真实撤销。
     */
    const undoSessionResponse = await request('POST', '/api/sessions', { agentId: 'seed', cwd: dirs.workspace });
    if (undoSessionResponse.status !== 200) throw new Error(`Toast 专用会话创建失败：${undoSessionResponse.status} ${undoSessionResponse.text}`);
    const undoSession = undoSessionResponse.json.id;
    onCleanup(`关闭 Toast 专用会话 ${undoSession}`, async () => { await request('POST', `/api/sessions/${undoSession}/stop`); });

    const undoTarget = 'UNDO_TARGET_TASK';
    await request('POST', `/api/sessions/${undoSession}/send`, { prompt: 'OCCUPIER slow turn', mode: 'queue' });
    // 等占位指令真的进入运行态，之后发的才必然排队（不靠固定 sleep 猜）
    await waitFor('占位指令已在运行（后续指令必然排队）', async () => {
      const tasks = (await request('GET', `/api/sessions/${undoSession}/tasks`)).json ?? [];
      return tasks.some(task => task.prompt === 'OCCUPIER slow turn' && task.status === 'running') ? tasks : undefined;
    }, { timeoutMs: 30_000, intervalMs: 300 });
    await request('POST', `/api/sessions/${undoSession}/send`, { prompt: undoTarget, mode: 'queue' });
    const queuedBefore = await waitFor('出现真正排队的任务', async () => {
      const tasks = (await request('GET', `/api/sessions/${undoSession}/tasks`)).json ?? [];
      return tasks.some(task => task.prompt === undoTarget && task.status === 'queued') ? tasks : undefined;
    }, { timeoutMs: 20_000, intervalMs: 400 });
    debug('tasks', JSON.stringify(queuedBefore.map(task => [task.status, task.prompt])));

    // 页面要停在这条会话上，取消按钮才在视野里
    await page.goto(`${BASE}/sessions/${undoSession}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);

    const cancelQueued = page.getByRole('button', { name: `取消排队：${undoTarget}` });
    await cancelQueued.waitFor({ state: 'visible', timeout: 15_000 });
    await cancelQueued.click();
    const toastCard = politeRegion.locator('.ui-toast');
    await toastCard.first().waitFor({ state: 'visible', timeout: 10_000 });
    const toastText = await politeRegion.innerText();
    assert(toastText.includes('已取消 1 条待执行指令'),
      `真实 mutation 成功后弹出成功通知（实际「${toastText.split('\n').filter(Boolean).slice(0, 2).join(' / ')}」）`);
    assert(toastText.includes('成功'), '通知带「成功」文字标签（不靠颜色单独表意）');
    assert((await request('GET', `/api/sessions/${undoSession}/tasks`)).json
      .some(task => task.prompt === undoTarget && task.status === 'cancelled'),
      '通知对应的服务端状态真的变了（该指令已 cancelled）');

    // Undo：点下去必须真的把指令排回队列
    const undoButton = politeRegion.getByRole('button', { name: '恢复这条指令' });
    assert(await undoButton.isVisible(), '成功通知上带「恢复这条指令」的撤销动作');
    await undoButton.click();
    const restored = await waitFor('撤销后指令重新入队', async () => {
      const tasks = (await request('GET', `/api/sessions/${undoSession}/tasks`)).json ?? [];
      return tasks.filter(task => task.prompt === undoTarget && task.status !== 'cancelled').length > 0 ? tasks : undefined;
    }, { timeoutMs: 20_000, intervalMs: 400 });
    assert(restored.filter(task => task.prompt === undoTarget).length === 2,
      `撤销真的重新下发了这条指令（同名任务 ${restored.filter(task => task.prompt === undoTarget).length} 条：一条 cancelled、一条重新排队）`);
    await politeRegion.locator('.ui-toast').first().waitFor({ state: 'hidden', timeout: 10_000 });
    ok('撤销成功后该通知自动收起（动作完成即退场）');

    /**
     * 本节结束前把这条慢速会话停掉：撤销那一步刚把指令重新排进队列，而这条会话
     * 每轮 8s，放着不管它会带着未跑完的队列一直活到后面的小节。让每节自己清掉
     * 自己造的负载，后面各节的起点才是确定的。
     *
     * ⚠️ 不要把这一行当成「键条那节失败」的修复。那个失败的真因是产品缺陷，
     * 已单独修掉：transcript 定位按 mtime 取最新，而 Claude 的 transcript 目录
     * 只由 cwd 决定，于是同 cwd 的多条会话互相抢同一个文件
     * （见 packages/pty-driver/src/transcript/claude.ts）。
     *
     * 我在这里先后写过两版归因——「PTY 脏了就不回显」和「会话忙着跑轮次就不回显」
     * ——两版都没做实就写成了结论，而且都错。真正把它定位下来的办法是：
     * 给每条会话发独一无二的 prompt，再检查它**收到的** text 里含谁的标记。
     * 只看「有没有失败」永远看不出串台，因为串台的另一种表现是「成功」：
     * 三条会话全报 completed，其中两条显示的是第三条的回答。
     */
    await request('POST', `/api/sessions/${undoSession}/stop`);

    // 自动消失：归档的 success 通知默认 4s，等 6.5s 后必须已经不在
    await dismissDialogs();
    const archiveButton = page.getByRole('button', { name: '归档任务', exact: true });
    await archiveButton.first().click();
    const confirmArchive = page.getByRole('button', { name: '确认归档' });
    await confirmArchive.waitFor({ state: 'visible', timeout: 10_000 });
    await confirmArchive.click();
    await politeRegion.locator('.ui-toast').first().waitFor({ state: 'visible', timeout: 10_000 });
    const archiveToast = await politeRegion.innerText();
    assert(archiveToast.includes('任务已归档'), '归档成功后弹出成功通知');
    await politeRegion.locator('.ui-toast').first().waitFor({ state: 'hidden', timeout: 12_000 });
    ok('无动作的成功通知会自动消失（4s 档位到点自行退场，无需用户关闭）');
  });

  // ── 6. 移动端终端快捷键条 ───────────────────────────────────────────────
  step('移动端终端快捷键条：触控目标尺寸、按键真的写进 PTY、桌面不出现');
  await section('移动端终端快捷键条', async () => {
    // 本节专用的新会话：不复用前面几节用过的 session。
    // 前面的 session 已经历过归档、取消排队、长时间空转，其 PTY 未必还可写；
    // 拿它测键条，失败时无法区分「键条没送到」与「这条 PTY 本来就不通了」。
    // 现开一条并跑完一轮，让 PTY 停在提示符上，起点就是确定的。
    //
    // 顺带记一笔：这一节曾长期不稳定，我两次把原因归到「PTY 脏了」「会话忙」，
    // 两次都是没做实的猜测。真因是 transcript 定位按 mtime 取最新，导致同 cwd
    // 的会话互相抢同一份 transcript（已修，见 transcript/claude.ts）。
    // 所以「本节自建会话」是为了可归因，不是为了绕开那个缺陷。
    const created = await request('POST', '/api/sessions', { agentId: 'claude-code', cwd: dirs.workspace });
    if (created.status !== 200) throw new Error(`键条专用会话创建失败：${created.status} ${created.text}`);
    const keyBarSession = created.json.id;
    onCleanup(`关闭键条专用会话 ${keyBarSession}`, async () => { await request('POST', `/api/sessions/${keyBarSession}/stop`); });
    const primed = await request('POST', `/api/sessions/${keyBarSession}/send`, { prompt: 'terminal key bar probe', mode: 'queue' });
    if (primed.status !== 202) throw new Error(`键条专用会话派发失败：${primed.status} ${primed.text}`);
    await waitFor('键条专用会话跑完一轮', async () => {
      const session = (await request('GET', `/api/sessions/${keyBarSession}`)).json;
      const tasks = (await request('GET', `/api/sessions/${keyBarSession}/tasks`)).json ?? [];
      debug('键条会话', `state=${session?.state} tasks=${JSON.stringify(tasks.map(t => [t.status, t.prompt]))}`);
      return session?.state === 'completed';
    }, { timeoutMs: 60_000, intervalMs: 500 });

    // 桌面视口先取证：宽屏鼠标环境不该出现这一条，否则它只挡内容
    await page.goto(`${BASE}/sessions/${keyBarSession}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);
    await page.getByRole('tab', { name: '终端' }).click();
    await page.waitForTimeout(2_500);
    assert(!(await page.getByRole('toolbar', { name: '终端快捷键' }).isVisible().catch(() => false)),
      '桌面宽视口（1440px，细指针）不渲染终端快捷键条');
    const desktopTerminal = await page.evaluate(() => Boolean(document.querySelector('.xterm-viewport')));
    assert(desktopTerminal, '桌面终端本身已挂载（上一条不是因为终端没起来而假通过）');

    // 终端跟随主题：xterm 把颜色烤进自己的渲染层，页面换 CSS 变量传不进去，
    // 必须验证它真的重刷过。这里在不重挂终端的前提下翻转系统外观。
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(1_200);
    const terminalLight = await page.evaluate(() => getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(1_500);
    const terminalDark = await page.evaluate(() => getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor);
    assert(luminance(terminalDark) + 60 < luminance(terminalLight),
      `终端在不重挂的前提下随主题实时重刷配色（浅 ${terminalLight} → 深 ${terminalDark}）`);
    await page.emulateMedia({ colorScheme: 'light' });

    // 手机视口：真实触屏上下文
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
    const phonePage = await phone.newPage();
    phonePage.on('pageerror', error => debug('mobile pageerror', error.message));
    // 在导航之前挂 websocket 监听：要断言「按键真的被发出去」，就必须抓到页面自己发的那一帧。
    // 这条线索能把「键条没发」与「PTY 没回显」两种失败区分开——否则只看回显，两者长得一样。
    const sentFrames = [];
    let terminalSocketOpen = false;
    phonePage.on('websocket', socket => {
      if (!socket.url().includes('/api/terminal/')) return;
      terminalSocketOpen = true;
      socket.on('close', () => { terminalSocketOpen = false; });
      socket.on('framesent', frame => sentFrames.push(String(frame.payload)));
    });
    await phonePage.goto(`${BASE}/sessions/${keyBarSession}`, { waitUntil: 'domcontentloaded' });
    await phonePage.waitForTimeout(2_500);
    await phonePage.getByRole('tab', { name: '终端' }).click();
    const keyBar = phonePage.getByRole('toolbar', { name: '终端快捷键' });
    await keyBar.waitFor({ state: 'visible', timeout: 15_000 });
    assert(await keyBar.isVisible(), '手机视口（390px + 粗指针）渲染出终端快捷键条');

    const keyButtons = await keyBar.getByRole('button').all();
    assert(keyButtons.length >= 9, `快捷键条至少提供 9 颗按键（实际 ${keyButtons.length} 个可点元素）`);
    // 量尺寸前必须先确认 Tailwind 样式表**已经生效**：终端是懒加载 chunk，
    // 它的样式和 xterm 一起晚到，而 toolbar 可见远早于样式落地。
    // 在样式生效前量，会量到纯内容尺寸（32x32）或有 padding 无 min-* 的中间态（41x32），
    // 那是「样式还没到」，不是「产品把触控目标做小了」——两者必须分开，
    // 否则这条断言会偶发失败并把开发者引向不存在的产品缺陷。
    //
    // 判据取 min-height 这个**由样式表提供**的计算值：它出现即证明 min-h-11 那条规则已应用。
    // 不用 sleep 兜：sleep 只是把窗口拉宽，负载一高照样偶发。
    await phonePage.waitForFunction(() => {
      const bar = document.querySelector('[role="toolbar"][aria-label="终端快捷键"]');
      const button = bar?.querySelector('button');
      if (!button) return false;
      const style = getComputedStyle(button);
      // min-h-11 / min-w-11 = 2.75rem = 44px；只要它已是 44px，说明样式表生效了
      return parseFloat(style.minHeight) >= 44 && parseFloat(style.minWidth) >= 44;
    }, undefined, { timeout: 20_000 });
    ok('键条样式表已生效（首颗按键的 min-height/min-width 计算值已达 44px，可以开始量真实盒子）');
    const undersized = [];
    for (const button of keyButtons) {
      const box = await button.boundingBox();
      const label = await button.getAttribute('aria-label');
      if (!box || box.width < 44 || box.height < 44) undersized.push(`${label}=${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'null'}`);
    }
    assert(undersized.length === 0,
      `每颗按键的真实触控目标都 ≥44×44px（${keyButtons.length} 个全部达标${undersized.length ? `，不达标：${undersized.join(', ')}` : ''}）`);

    // 按键真的写进 PTY：另开一条观察者 WS，看服务端有没有把字节回显出来。
    // 观察者是独立连接，因此它收到的东西证明字节真的到了 PTY，而不只是留在页面里。
    const WebSocketImpl = loadWebSocket();
    const observed = [];
    const observer = new WebSocketImpl(`ws://127.0.0.1:${PORT}/api/terminal/${encodeURIComponent(keyBarSession)}`);
    onCleanup('关闭终端观察者 WS', () => { try { observer.close(); } catch { /* 已关闭 */ } });
    await new Promise((resolve, reject) => {
      observer.on('open', resolve);
      observer.on('error', reject);
      observer.on('unexpected-response', (_request, response) => reject(new Error(`WS 升级被拒：HTTP ${response.statusCode}`)));
    });
    observer.on('message', raw => {
      try {
        const frame = JSON.parse(String(raw));
        if (frame.type === 'data') observed.push(frame.data);
      } catch { /* 非 JSON 帧忽略 */ }
    });
    // 手机页的终端 WS 必须先真的连上：xterm 是懒加载 chunk，连接晚于按钮可见。
    // 不等这一步就点，按下去的字节会掉进还没建立的连接里——那是脚本的时序问题，不是产品缺陷。
    await waitFor('手机端终端 WS 建立', async () => terminalSocketOpen, { timeoutMs: 20_000, intervalMs: 200 });
    await sleep(600);
    ok('手机端终端 WebSocket 已建立（按键有可写入的通道）');

    // 对照写入：先用观察者自己往 PTY 写一个同样的控制序列，确认「写进去 → 回显出来」这条链路此刻是通的。
    // 这一步让下面键条的失败可归因：对照也收不到回显 → 该会话的 PTY 已不可写（例如被桥接进程已退出），
    // 问题不在键条；只有对照通过、键条不通，才是键条自己的缺陷。
    observed.length = 0;
    observer.send(JSON.stringify({ type: 'input', data: ARROW_UP }));
    const ptyWritable = await waitFor('PTY 对照写入回显', async () =>
      observed.join('').includes(ARROW_UP_ECHO) ? observed.join('') : undefined,
      { timeoutMs: 8_000, intervalMs: 200 }).then(() => true).catch(() => false);
    const sessionStateNow = (await request('GET', `/api/sessions/${keyBarSession}`)).json?.state;
    assert(ptyWritable,
      `对照写入证明该会话的 PTY 此刻可写并会回显（会话状态 ${sessionStateNow}）——键条断言因此可归因`);

    // 逐颗验证：↑ 与 Esc 都是无副作用的键（不像 ^C 会杀掉被桥接的 CLI）。
    // 每颗键分两步断言：页面确实发出了对应控制序列 → 独立观察者确实看到 PTY 回显。
    for (const probe of [
      { name: /方向键上/, label: '方向键上', data: ARROW_UP, echo: ARROW_UP_ECHO },
      { name: /发送 Esc/, label: 'Esc', data: ESC_KEY, echo: ESC_KEY_ECHO }
    ]) {
      sentFrames.length = 0;
      observed.length = 0;
      await keyBar.getByRole('button', { name: probe.name }).click();
      const sent = await waitFor(`键条把「${probe.label}」发往终端 WS`, async () =>
        sentFrames.find(frame => frame.includes(JSON.stringify(probe.data).slice(1, -1))),
        { timeoutMs: 10_000, intervalMs: 150 });
      assert(Boolean(sent),
        `点击「${probe.label}」经终端 WS 发出 input 帧（实际 ${sent}）`);
      const echo = await waitFor(`PTY 回显「${probe.label}」`, async () =>
        observed.join('').includes(probe.echo) ? observed.join('') : undefined,
        { timeoutMs: 10_000, intervalMs: 200 });
      assert(echo.includes(probe.echo),
        `「${probe.label}」真的抵达 PTY：独立观察者连接看到了回显（不只是页面本地画上去）`);
    }
  });

  // 未捕获异常单独成节：它是「整段旅程」的汇总结论，不该因为自己失败就掩盖前面已跑完的结果。
  await section('无未捕获页面异常', async () => {
    assert(pageErrors.length === 0,
      `整段浏览器旅程没有未捕获的页面异常（实际 ${pageErrors.length} 条${pageErrors.length ? `：${pageErrors.slice(0, 5).join(' / ')}` : ''}）`);
  });

  await browser.close();
  browser = undefined;
}

// ── 模块域：飞书命令与卡片按钮 ──────────────────────────────────────────────
/**
 * 用 tsx 的运行时 loader 直接加载 TS 源码。
 * 为什么不从 dist 导入：apps/server 的构建是对 src/cli.ts 的单次 esbuild bundle，
 * 两个模块被内联进 dist/cli.js，而那个文件一被 import 就会执行 CLI 的 main() 并 process.exit。
 * 为什么不用 plain node 的类型擦除：service.ts 用了 TS 参数属性，strip-only 模式直接抛
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。tsx 两者都能吃下，且已是仓库既有 devDependency。
 */
async function larkAcceptance() {
  const require = createRequire(join(REPO, 'package.json'));
  const { register } = await import(`file://${require.resolve('tsx/esm/api')}`);
  const unregister = register();
  onCleanup('注销 tsx loader', () => { try { unregister(); } catch { /* 已注销 */ } });

  const commands = await import(`${REPO}/apps/server/src/lark/commands.ts`);
  const cardActions = await import(`${REPO}/apps/server/src/lark/card-actions.ts`);
  const service = await import(`${REPO}/apps/server/src/lark/service.ts`);

  // ── 7. slash 命令 ───────────────────────────────────────────────────────
  step('飞书 slash 命令：识别、白名单拒绝、能力缺失 unavailable');
  const fullCapabilities = {
    getSession: true, send: true, dispatch: true, interrupt: true, cancelQueued: true,
    stop: true, getTasks: true, listAgents: true, listSessions: true
  };
  const context = (overrides = {}) => ({
    capabilities: fullCapabilities,
    operator: { kind: 'user', allowlisted: true },
    ...overrides
  });

  const documented = ['help', 'status', 'cancel', 'retry', 'new'];
  const registered = commands.larkCommandRegistry.map(definition => definition.name);
  assert(documented.every(name => registered.includes(name)),
    `注册表覆盖全部 5 条命令：${registered.join(', ')}`);

  // 识别：每条命令都必须被真的认出来，而不是掉进「非命令原文」
  for (const name of documented) {
    const route = commands.routeLarkCommand(`/${name}`, context());
    assert(route.kind === 'reply' || route.kind === 'intent',
      `/${name} 被识别为可执行命令（kind=${route.kind}${route.command ? `, command=${route.command}` : ''}）`);
  }
  // 别名 /stop 必须落到 cancel 上
  const stopRoute = commands.routeLarkCommand('/stop', context());
  assert(stopRoute.kind === 'intent' && stopRoute.command === 'cancel',
    `别名 /stop 解析为 cancel 命令（实际 command=${stopRoute.command}）`);
  // /help 是唯一自答的命令，且真的把可用命令列进正文
  const helpRoute = commands.routeLarkCommand('/help', context());
  assert(helpRoute.kind === 'reply' && documented.every(name => helpRoute.text.includes(`/${name}`)),
    '/help 直接回一张列出全部可用命令的卡片');
  // 非命令与未知命令必须走不同的两条路，不能都被吞掉
  assert(commands.routeLarkCommand('今天的进度如何', context()).kind === 'not_a_command',
    '普通聊天文本不被误判为命令');
  const unknown = commands.routeLarkCommand('/nope please', context());
  assert(unknown.kind === 'unknown_command' && unknown.promptText.includes(commands.larkPassthroughMarker),
    '未注册的 /xxx 作为普通文字原文转交 Agent（带非命令标记，不静默丢弃）');

  // 权限门禁：非白名单操作者必须被拒，且拒绝早于能力判断——
  // 这样非白名单的人不会通过报错文案反推出运行时缺哪个能力。
  const denied = commands.authorizeLarkCommandText('/cancel', context({ operator: { kind: 'user', allowlisted: false } }));
  assert(denied.recognized === true && denied.decision === 'denied',
    `非白名单操作者执行 /cancel 被拒（decision=${denied.decision}）`);
  assert(typeof denied.reason === 'string' && denied.reason.includes('白名单'),
    '拒绝理由说明是白名单问题并给出下一步（联系管理员）');
  const deniedReadOnly = commands.authorizeLarkCommandText('/help', context({ operator: { kind: 'user', allowlisted: false } }));
  assert(deniedReadOnly.decision === 'denied',
    '连只读的 /help 对非白名单操作者也一律拒绝（白名单是硬门禁，不分读写）');
  // 协作机器人不能执行改变会话状态的命令
  const botDenied = commands.authorizeLarkCommandText('/new', context({ operator: { kind: 'bot', allowlisted: true } }));
  assert(botDenied.decision === 'denied' && botDenied.reason.includes('机器人'),
    '白名单内的协作机器人仍不能执行 mutating 命令（/new 被拒）');
  const botAllowedReadOnly = commands.authorizeLarkCommandText('/status', context({ operator: { kind: 'bot', allowlisted: true } }));
  assert(botAllowedReadOnly.decision === 'allowed',
    '白名单内的机器人仍可执行只读命令（/status 放行，门禁不是一刀切）');

  // 能力缺失：运行时没有对应能力时必须报 unavailable，而不是渲染出一个按下去没反应的动作
  const noCapabilities = commands.larkCommandCapabilities({});
  for (const name of ['status', 'cancel', 'retry', 'new']) {
    const verdict = commands.authorizeLarkCommandText(`/${name}`, context({ capabilities: noCapabilities }));
    assert(verdict.decision === 'unavailable',
      `运行时缺能力时 /${name} 判为 unavailable 而非假装可用（decision=${verdict.decision}）`);
    assert(typeof verdict.reason === 'string' && verdict.reason.length > 0,
      `/${name} 的 unavailable 说明了缺什么能力（「${verdict.reason.slice(0, 28)}…」）`);
  }
  const degradedHelp = commands.renderLarkCommandHelp(noCapabilities);
  assert(degradedHelp.text.includes('/help') && !degradedHelp.text.includes('/retry'),
    '能力缺失时 /help 只列真正可用的命令（不把停用命令写成可用）');
  // 单个能力缺失时只影响对应命令，不牵连别人
  const partial = commands.authorizeLarkCommandText('/status', context({ capabilities: { ...fullCapabilities, getSession: false } }));
  assert(partial.decision === 'unavailable', '只缺 getSession 时 /status 单独停用（能力判定是逐条的）');
  assert(commands.authorizeLarkCommandText('/retry', context({ capabilities: { ...fullCapabilities, getSession: false } })).decision === 'allowed',
    '缺 getSession 不牵连 /retry（不是一处缺失全表停用）');

  // ── 8. 卡片按钮「没有死按钮」 ───────────────────────────────────────────
  step('飞书卡片按钮：冻结回执零按钮、渲染出的按钮回调层必接受');
  const collectButtons = (node, found = []) => {
    if (Array.isArray(node)) node.forEach(item => collectButtons(item, found));
    else if (node && typeof node === 'object') {
      if (node.tag === 'button') found.push(node);
      Object.values(node).forEach(child => collectButtons(child, found));
    }
    return found;
  };
  const capabilities = { canCancelQueued: true, canInterrupt: true, canRetry: true, canRefresh: true };

  // 冻结回执：即使把所有能力和深链都给足，readOnly 也必须让按钮数归零。
  // 遍历所有状态，避免只测一个状态而漏掉某个分支。
  for (const state of service.larkCardStates) {
    const frozen = service.buildLarkCard({
      state, taskId: 't1', readOnly: true, sessionId: 'ses_1', webBaseUrl: 'https://web.example.com',
      capabilities: { ...capabilities, webUrl: 'https://web.example.com/sessions/ses_1' }
    });
    const buttons = collectButtons(frozen);
    assert(buttons.length === 0,
      `冻结回执卡（state=${state}，能力全开且带深链）渲染 0 个按钮（实际 ${buttons.length}）`);
  }
  // 终态但未冻结的卡片仍应给出恢复路径 —— 证明上面的零按钮来自 readOnly，而不是卡片根本不会长按钮
  const completedLive = collectButtons(service.buildLarkCard({ state: 'completed', taskId: 't1', capabilities }));
  const failedLive = collectButtons(service.buildLarkCard({ state: 'failed', taskId: 't1', capabilities }));
  assert(completedLive.length === 0 && failedLive.length === 1 && failedLive[0].element_id === 'retry',
    `终态卡片的按钮取决于是否还有下一步：completed 0 个、failed 1 个（${failedLive.map(button => button.element_id).join(',')}）`);

  // 没有死按钮：任何被渲染出来的回调按钮，其 action 必须同时通过
  // parseLarkCardActionValue（形状）与 isLarkCardActionAvailable（授权）。
  let checkedButtons = 0;
  for (const state of ['queued', 'running', 'interrupting', 'completed', 'failed', 'interrupted']) {
    const context = { state, taskId: 'task-1', turn: 3, capabilities };
    for (const button of collectButtons(cardActions.buildLarkCardActions(context))) {
      const behavior = button.behaviors?.find(entry => entry.type === 'callback');
      if (!behavior) continue; // 链接按钮不走回调层
      const parsed = cardActions.parseLarkCardActionValue(behavior.value);
      assert(parsed !== undefined,
        `state=${state} 渲染的「${button.element_id}」按钮，其 value 能被回调层解析（${JSON.stringify(behavior.value)}）`);
      assert(cardActions.isLarkCardActionAvailable(parsed.action, context),
        `state=${state} 渲染的「${button.element_id}」按钮，回调层在同一上下文中授权通过（没有死按钮）`);
      checkedButtons += 1;
    }
  }
  assert(checkedButtons >= 5,
    `逐一核对了 ${checkedButtons} 个真实渲染的回调按钮（覆盖 cancel/interrupt/retry/refresh 各状态）`);

  // 反向：能力关掉之后按钮必须消失，而不是留一个点了没反应的
  const noRetry = cardActions.buildLarkCardActions({ state: 'failed', taskId: 'task-1', turn: 0, capabilities: { ...capabilities, canRetry: false } });
  assert(collectButtons(noRetry).length === 0,
    '运行时不支持重试时，failed 卡片不渲染重试按钮（能力缺失表现为按钮消失，而非死按钮）');
  // 形状校验必须真的会拒绝坏输入
  assert(cardActions.parseLarkCardActionValue({ action: 'interrupt' }) === undefined
    && cardActions.parseLarkCardActionValue({ action: 'not-an-action', task_id: 't' }) === undefined
    && cardActions.parseLarkCardActionValue('鬼画符') === undefined,
    '回调层拒绝缺 taskId、未知 action 与非法 JSON 的入参（不是把一切都放行）');
}

// ── 入口 ───────────────────────────────────────────────────────────────────
let exitCode = 0;
const watchdog = setTimeout(() => {
  log(`\n✗ 全局超时（${TIMEOUT_MS}ms），强制清理`);
  exitCode = 1;
  runCleanup().finally(() => process.exit(1));
}, TIMEOUT_MS);
watchdog.unref();

const onSignal = signal => { log(`\n收到 ${signal}，清理后退出`); runCleanup().finally(() => process.exit(130)); };
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

try {
  log('dockmux 产品化能力验收 — MOCK（假 CLI，不触碰模型，无需任何凭证）');
  log(`端口 ${PORT} · 全局超时 ${TIMEOUT_MS}ms · 范围 ${ONLY}`);
  if (RUN_BROWSER) await browserAcceptance();
  if (RUN_LARK) await larkAcceptance();
  if (reporter.failures.length) {
    exitCode = 1;
    log(`\n✗ 产品化验收失败：${reporter.count()} 项断言成立，${reporter.failures.length} 项检查未通过`);
    log('\n未通过的检查（每条都是需要产品/开发确认的真实缺陷候选）：');
    for (const [index, failure] of reporter.failures.entries()) {
      log(`  ${index + 1}. 【${failure.section}】${failure.message}`);
    }
  } else {
    log(`\n✓ 产品化验收通过：${reporter.count()} 项断言全部成立`);
  }
} catch (error) {
  exitCode = 1;
  log(`\n✗ 产品化验收中断：${error instanceof Error ? error.message : String(error)}`);
  log(`   （中断前已通过 ${reporter.count()} 项断言）`);
  if (VERBOSE && error instanceof Error && error.stack) log(error.stack);
} finally {
  clearTimeout(watchdog);
  await runCleanup();
}
process.exit(exitCode);
