#!/usr/bin/env node
/**
 * dutydeck 界面功能旅程 e2e —— 改版回归网
 *
 * ## 定位
 *
 * 这不是验收标准，是**回归网**：这些用例在界面改版前后都必须绿。四个团队正在并发
 * 改布局骨架与侧栏结构（色板换靛蓝、新建顶栏、侧栏 292px 恒深色 → 248px 悬浮卡片、
 * 原语尺度校准）。动骨架最容易在「看着对了」的同时把交互弄坏，这份脚本负责在那种
 * 时候亮红灯。
 *
 * 与 Team-Verify 的分工：它断言视觉（颜色 / 尺寸 / 布局），本脚本断言功能
 * （点了有反应、数据真的流动）。因此这里**刻意不写任何像素、颜色、间距断言**——
 * 改版必然改动它们，写了就等于每次改版都要改测试，回归网就失去意义了。
 *
 * ## 选择器策略（决定这份脚本能不能扛过改版）
 *
 * 一律用 role + 可访问名（`getByRole('button', { name: '归档任务' })`），不用 class、
 * 不用 DOM 层级、不用 nth-child。理由：改版换的是 class 和层级，不换语义。用语义
 * 选择器，改版后仍然绿；用 class 选择器，改版后全红且全是假警报。
 *
 * 唯一的例外是两个 toast live region——它们**故意没有 role**（见 ToastViewport.tsx
 * 的注释：加了 role 会让 getByRole('alert') 命中两个常驻空容器），只能按 aria-label
 * 定位。这属于产品刻意的可访问性设计，不是脆弱选择器。
 *
 * ## 隔离
 *
 * 临时端口 + 临时 SQLite + 假 CLI，绝不碰用户 4310 端口上的真实工作，也不读写
 * ~/.dutydeck / ~/.claude。跑完整棵临时目录删掉。
 *
 * ## 用法
 *
 *   node tests/e2e/functional/journeys.mjs
 *   node tests/e2e/functional/journeys.mjs --verbose
 *   node tests/e2e/functional/journeys.mjs --port 14520
 *   node tests/e2e/functional/journeys.mjs --only 6,11    # 只跑指定旅程
 */
import {
  chromium, createCleanupStack, createReporter, waitFor,
  bootIsolatedStack, seedCompletedSession, mainRegionText, waitForMainText, openPage, stopSessionBestEffort,
  DESKTOP_VIEWPORT, MOBILE_VIEWPORT, UI, OVERLAYS
} from './journey-harness.mjs';
import { parseArgs } from '../../../scripts/e2e-harness.mjs';

const { flag, value } = parseArgs();
const VERBOSE = flag('verbose');
// 默认端口避开 4310/14310（开发者实例）、14387（基线冒烟）、14481（产品冒烟）。
const PORT = Number(value('port', '14520'));
const TIMEOUT_MS = Number(value('timeout', '900000'));
const ONLY = value('only', '');
const selected = ONLY ? new Set(ONLY.split(',').map(part => part.trim())) : undefined;

const reporter = createReporter({ verbose: VERBOSE });
const { log, debug, ok, assert, section, count, failures } = reporter;
const { onCleanup, runCleanup } = createCleanupStack({ log });

let journeyNumber = 0;
/** 一条旅程 = 一个可独立失败的单元。失败不中止后续旅程，末尾统一列出。 */
const journey = async (id, title, fn) => {
  journeyNumber += 1;
  if (selected && !selected.has(String(id))) return;
  log(`\n[旅程 ${id}] ${title}`);
  await section(title, fn);
};

const watchdog = setTimeout(async () => {
  log(`\n! 全局超时 ${TIMEOUT_MS}ms，强制清理退出`);
  await runCleanup();
  process.exit(1);
}, TIMEOUT_MS);
watchdog.unref?.();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await runCleanup(); process.exit(1); });
}

async function main() {
  log(`Dutydeck 界面功能旅程 e2e（端口 ${PORT}，隔离实例 + 假 Agent）`);

  const { dirs, base, request } = await bootIsolatedStack({ port: PORT, onCleanup, verbose: VERBOSE });
  ok(`隔离实例就绪：${base}（临时库 ${dirs.dataDir}）`);
  const preexisting = (await request('GET', '/api/sessions')).json ?? [];
  assert(preexisting.length === 0, `临时数据库是干净的（0 个既有会话，实际 ${preexisting.length}）`);

  const browser = await chromium.launch({ headless: true });
  onCleanup('关闭 Chromium', () => browser.close());

  // 两条同 cwd 的会话：串台只在同 cwd 下才会发生（transcript 目录由 cwd 决定），
  // 所以旅程 6 的前提必须是同 cwd，否则那条断言测不到它想测的东西。
  const alpha = await seedCompletedSession(request, { cwd: dirs.workspace, prompt: 'ALPHA_MARKER 重构支付网关重试' });
  const beta = await seedCompletedSession(request, { cwd: dirs.workspace, prompt: 'BETA_MARKER clean up telemetry exporter' });
  ok(`预置两条同 cwd 会话（串台的必要前提）：${alpha.slice(0, 12)}… / ${beta.slice(0, 12)}…`);

  const allPageErrors = [];

  // ── 旅程 1：打开任务中心 ────────────────────────────────────────────────
  await journey(1, '打开任务中心：列表渲染出真实数据，不是空白也不是骨架卡死', async () => {
    const { page, pageErrors } = await openPage(browser);
    allPageErrors.push(pageErrors);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: UI.overviewTitle }).waitFor({ state: 'visible', timeout: 20_000 });
    ok('任务中心标题渲染完成');

    // 「不是骨架卡死」的可判定形式：任务列表区里出现了真实任务标题。
    // 只断言「标题可见」是不够的——骨架屏时标题同样可见。
    const taskList = page.getByRole('region', { name: '任务列表' });
    await taskList.getByRole('button', { name: /ALPHA_MARKER/ }).waitFor({ state: 'visible', timeout: 20_000 });
    await taskList.getByRole('button', { name: /BETA_MARKER/ }).waitFor({ state: 'visible', timeout: 20_000 });
    ok('任务列表里两条预置任务都渲染出来了（真实数据，非骨架）');

    // 计数芯片必须与真实数据一致：芯片显示 — 表示还在 loading，那就是卡死。
    const overview = page.getByRole('region', { name: '任务筛选' });
    const chipText = await overview.innerText();
    assert(!chipText.includes('—'), `筛选芯片已给出真实计数（不是加载中的「—」）：${chipText.replace(/\n/g, ' ')}`);
    assert(/总览\s*2/.test(chipText.replace(/\s+/g, ' ')), `「总览」计数等于真实会话数 2（实际「${chipText.replace(/\n/g, ' ')}」）`);
    await page.close();
  });

  // ── 旅程 2 + 3：创建任务 → 发指令 → 看到输出回流 ──────────────────────
  await journey(2, '创建任务 → 选 Agent → 提交 → 跳详情页；再发一条指令并看到输出回流', async () => {
    const { page, pageErrors } = await openPage(browser);
    allPageErrors.push(pageErrors);
    const apiCalls = [];
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api')) apiCalls.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    });

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: UI.overviewTitle }).waitFor({ state: 'visible', timeout: 20_000 });
    // 已有任务时主 CTA 是「创建任务」；首次使用时是「创建第一个任务」。两个都接受，
    // 因为本旅程要测的是创建流程，不是空状态文案。
    await page.getByRole('button', { name: UI.createTask, exact: true }).first().click();

    const dialog = page.getByRole('dialog', { name: UI.newTaskDialog });
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    ok('创建任务浮层已打开');

    const goal = 'GAMMA_MARKER 验证创建链路';
    await dialog.getByLabel(UI.taskGoalField).fill(goal);

    // Agent 必须显式选择：默认选中的是 Codex（真实 CLI），不换会打到真实模型上。
    await dialog.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole('option', { name: 'Mock Claude' }).first().click();
    assert((await dialog.locator('button[aria-haspopup="listbox"]').first().textContent())?.includes('Mock Claude'),
      '已在创建浮层选中 Mock Claude');
    const trust = dialog.getByRole('checkbox');
    if (await trust.first().isVisible().catch(() => false)) await trust.first().check();

    await dialog.getByRole('button', { name: UI.submitTask, exact: true }).click();

    // 「跳转详情页」的判定：URL 变成 /sessions/<id>，且主区出现这条任务的目标。
    // 只断言 URL 会漏掉「路由变了但内容没渲染」这一类白屏。
    await page.waitForURL(url => /^\/sessions\/ses_/.test(url.pathname), { timeout: 30_000 });
    const sessionId = new URL(page.url()).pathname.replace('/sessions/', '');
    onCleanup(`停止界面创建的会话 ${sessionId}`, () => stopSessionBestEffort(base, sessionId));
    ok(`提交后跳转到详情页：/sessions/${sessionId.slice(0, 16)}…`);

    const createCall = apiCalls.find(call => call.method === 'POST' && call.path === '/api/sessions');
    const sendCall = apiCalls.find(call => call.method === 'POST' && call.path === `/api/sessions/${sessionId}/send`);
    assert(createCall?.status === 200, `浏览器真的发起了 POST /api/sessions 且返回 200（实际 ${createCall?.status}）`);
    assert(sendCall?.status === 202, `浏览器真的派发了任务目标，POST /send 返回 202（实际 ${sendCall?.status}）`);

    // ★ 最重要的一条：输出真的回流到界面。
    // 断言 Agent 的最终输出 article 里含 MOCK_REPLY —— 这一条同时证明了
    // Agent 进程被真的拉起、transcript 被真的解析、SSE 真的把事件推到了浏览器、
    // 界面真的把它渲染出来了。任何一环断掉这条都过不去。
    const finalOutput = page.getByRole('article', { name: /最终输出$/ });
    await finalOutput.first().waitFor({ state: 'visible', timeout: 60_000 });
    const replyText = await finalOutput.first().innerText();
    assert(replyText.includes('MOCK_REPLY'), `Agent 的回复经 SSE 回流并渲染到界面（前 60 字：${replyText.slice(0, 60).replace(/\n/g, ' ')}）`);
    assert(replyText.includes(goal), '回流的内容对应本次提交的目标（不是别的会话的回答）');

    // 状态落到「已完成」
    await waitForMainText(page, '已完成', { label: '详情页状态变为已完成' });
    ok('首轮执行结束后状态显示「已完成」');

    // ── 第二轮：在详情页 Composer 里发指令，验证 thinking → 输出回流 ──
    const composer = page.getByRole('textbox', { name: UI.composer });
    await composer.waitFor({ state: 'visible', timeout: 15_000 });
    const followUp = 'DELTA_FOLLOWUP 第二轮指令';
    await composer.fill(followUp);
    // 发送按钮在模型就绪前是 disabled 的（aria-label 会变成「模型加载完成后才能发送消息」）。
    // 等它变成「发送消息」再点，否则点了个空。
    const sendButton = page.getByRole('button', { name: UI.send });
    await sendButton.waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor('发送按钮可用', async () => await sendButton.isEnabled().catch(() => false), { timeoutMs: 30_000, intervalMs: 200 });
    await sendButton.click();

    // 状态先进入忙碌态。假 CLI 一轮 300ms，忙碌窗口极短，所以这里不断言
    // 「看到了 thinking 这一帧」——那是在赌调度。改为断言服务端确实产生了这条任务，
    // 以及最终第二轮的回复真的回流。前者证明指令送达，后者证明链路走完。
    await waitFor('服务端收到第二条指令', async () => {
      const tasks = (await request('GET', `/api/sessions/${sessionId}/tasks`)).json ?? [];
      return tasks.some(task => task.prompt?.includes(followUp)) ? tasks : undefined;
    }, { timeoutMs: 20_000, intervalMs: 300 });
    ok('Composer 发出的指令真的到达服务端并入队');

    // MOCK_CONTINUED 前缀证明这是**新的一轮**，不是历史回放。
    await waitForMainText(page, 'MOCK_CONTINUED', { timeoutMs: 60_000, label: '第二轮回复回流到界面' });
    ok('第二轮回复以 MOCK_CONTINUED 前缀回流（证明是新一轮执行，不是历史重放）');
    await page.close();
  });

  // ── 旅程 4：中断执行 ────────────────────────────────────────────────────
  await journey(4, '中断执行：状态正确回落到「已取消」', async () => {
    // 用慢速 agent（每轮 8s），否则 300ms 的轮次里根本来不及点中断按钮。
    const created = await request('POST', '/api/sessions', { agentId: 'seed', cwd: dirs.workspace });
    const slow = created.json.id;
    onCleanup(`停止中断用会话 ${slow}`, () => stopSessionBestEffort(base, slow));
    await request('POST', `/api/sessions/${slow}/send`, { prompt: 'INTERRUPT_TARGET 长轮次', mode: 'queue' });
    await waitFor('会话进入忙碌态', async () => {
      const state = (await request('GET', `/api/sessions/${slow}`)).json?.state;
      return ['thinking', 'running_tool'].includes(state) ? state : undefined;
    }, { timeoutMs: 30_000, intervalMs: 300 });

    const { page, pageErrors } = await openPage(browser);
    allPageErrors.push(pageErrors);
    await page.goto(`${base}/sessions/${slow}`, { waitUntil: 'domcontentloaded' });
    await waitForMainText(page, '思考中', { label: '详情页显示忙碌态「思考中」' });
    ok('忙碌态在界面上显示为「思考中」');

    // exact:true 同旅程 9 的理由：任务标题一旦含「中断当前任务」就会污染子串匹配。
    // 这里正常会命中两个（RunHeader 一个、Composer 一个），点哪个都等价。
    const interrupt = page.getByRole('button', { name: UI.interrupt, exact: true });
    await interrupt.first().waitFor({ state: 'visible', timeout: 15_000 });
    ok('忙碌态下「中断当前任务」按钮出现');
    await interrupt.first().click();

    // 服务端状态真的回落（不是界面自己改了个字）
    await waitFor('服务端状态回落到 interrupted', async () => {
      const state = (await request('GET', `/api/sessions/${slow}`)).json?.state;
      return state === 'interrupted' ? state : undefined;
    }, { timeoutMs: 30_000, intervalMs: 300 });
    ok('中断后服务端状态回落到 interrupted');

    await waitForMainText(page, '已取消', { label: '界面状态回落为「已取消」' });
    ok('界面状态同步回落为「已取消」');

    // 中断后按钮必须消失——否则用户会对着一个已经停下的任务反复点中断。
    await waitFor('中断按钮消失', async () => (await page.getByRole('button', { name: UI.interrupt, exact: true }).count()) === 0,
      { timeoutMs: 15_000, intervalMs: 300 });
    ok('回落后「中断当前任务」按钮消失（不再提供无效操作）');
    await page.close();
  });

  // ── 旅程 5：排队指令 → 取消 → toast + 恢复 ─────────────────────────────
  await journey(5, '排队指令 → 取消 → toast 出现且「恢复这条指令」可用', async () => {
    // 慢速 agent 是这条旅程成立的前提：只有前一轮真的还在跑，后发的指令才会
    // **稳定地**停在 queued 上。用快轮次等于把断言建在一个随机瞬间上。
    const created = await request('POST', '/api/sessions', { agentId: 'seed', cwd: dirs.workspace });
    const queueSession = created.json.id;
    onCleanup(`停止排队用会话 ${queueSession}`, () => stopSessionBestEffort(base, queueSession));
    await request('POST', `/api/sessions/${queueSession}/send`, { prompt: 'OCCUPIER 占位轮次', mode: 'queue' });
    await waitFor('占位指令已在运行', async () => {
      const tasks = (await request('GET', `/api/sessions/${queueSession}/tasks`)).json ?? [];
      return tasks.some(task => task.prompt === 'OCCUPIER 占位轮次' && task.status === 'running') ? tasks : undefined;
    }, { timeoutMs: 30_000, intervalMs: 300 });

    const target = 'QUEUED_TARGET 待取消指令';
    await request('POST', `/api/sessions/${queueSession}/send`, { prompt: target, mode: 'queue' });
    await waitFor('目标指令稳定停在 queued', async () => {
      const tasks = (await request('GET', `/api/sessions/${queueSession}/tasks`)).json ?? [];
      return tasks.some(task => task.prompt === target && task.status === 'queued') ? tasks : undefined;
    }, { timeoutMs: 20_000, intervalMs: 300 });

    const { page, pageErrors } = await openPage(browser);
    allPageErrors.push(pageErrors);
    await page.goto(`${base}/sessions/${queueSession}`, { waitUntil: 'domcontentloaded' });

    const cancel = page.getByRole('button', { name: `取消排队：${target}` });
    await cancel.waitFor({ state: 'visible', timeout: 20_000 });
    ok('排队中的指令在界面上带「取消排队」按钮');
    await cancel.click();

    const polite = page.locator(UI.politeToasts);
    await polite.locator('.ui-toast').first().waitFor({ state: 'visible', timeout: 15_000 });
    const toastText = await polite.innerText();
    assert(toastText.includes('已取消 1 条待执行指令'), `取消后弹出成功 toast（实际「${toastText.replace(/\n+/g, ' / ').slice(0, 80)}」）`);
    assert(toastText.includes('成功'), 'toast 带「成功」文字标签（不靠颜色单独表意）');

    // 服务端状态真的变了——否则 toast 只是个好看的谎言
    const cancelled = (await request('GET', `/api/sessions/${queueSession}/tasks`)).json ?? [];
    assert(cancelled.some(task => task.prompt === target && task.status === 'cancelled'),
      'toast 对应的服务端状态真的变了（该指令已 cancelled）');

    const undo = polite.getByRole('button', { name: UI.undoCancelledCommand });
    assert(await undo.isVisible(), '成功 toast 上带「恢复这条指令」的撤销动作');
    await undo.click();
    const restored = await waitFor('撤销后指令重新入队', async () => {
      const tasks = (await request('GET', `/api/sessions/${queueSession}/tasks`)).json ?? [];
      const same = tasks.filter(task => task.prompt === target);
      return same.length === 2 ? same : undefined;
    }, { timeoutMs: 20_000, intervalMs: 300 });
    assert(restored.filter(task => task.status === 'cancelled').length === 1,
      '撤销真的重新下发了这条指令（一条 cancelled + 一条重新排队）');
    // 这条慢速会话每轮 8s，不停掉会带着队列活到后面各节。走 best-effort：
    // 忙碌会话 + 无 SSE 订阅者时 stop 会挂死（见 journey-harness.mjs 的说明）。
    debug(await stopSessionBestEffort(base, queueSession));
    await page.close();
  });

  // ── 旅程 6：侧栏切换任务不串台 ─────────────────────────────────────────
  await journey(6, '侧栏切换任务：详情内容真的跟着换，且不串台（同 cwd）', async () => {
    const { page, pageErrors } = await openPage(browser);
    allPageErrors.push(pageErrors);
    await page.goto(`${base}/sessions/${alpha}`, { waitUntil: 'domcontentloaded' });
    await waitForMainText(page, 'ALPHA_MARKER', { label: 'A 会话详情渲染' });

    const nav = page.getByRole('complementary', { name: UI.nav });
    await nav.waitFor({ state: 'visible', timeout: 15_000 });

    // 选中态：aria-current 必须落在当前会话那一行。改版会重写侧栏 DOM，
    // 这条断言保证「选中态」这个语义不会在重写中丢掉。
    const alphaRow = nav.getByRole('button', { name: /ALPHA_MARKER/ });
    const betaRow = nav.getByRole('button', { name: /BETA_MARKER/ });
    assert(await alphaRow.getAttribute('aria-current') === 'true', '当前会话那一行带 aria-current=true');
    assert(await betaRow.getAttribute('aria-current') === null, '非当前会话那一行不带 aria-current');

    /**
     * 串台断言的核心：正向 + 反向，缺一不可。
     *
     * commit b2b6ccc 修的那个 bug 里，串台的一支表现为「成功」——会话报 completed，
     * 但显示的是另一条会话的回答。只断言「出现了 B 的标记」抓不到它（B 那条本来就
     * 该出现 B）。必须同时断言「**没有** A 的标记」，才能发现「B 页面上混着 A 的输出」。
     */
    const beforeSwitch = await mainRegionText(page);
    assert(beforeSwitch.includes('ALPHA_MARKER') && !beforeSwitch.includes('BETA_MARKER'),
      'A 的详情页只有 A 的内容，没有混入 B（切换前基线）');

    await betaRow.click();
    await page.waitForURL(url => url.pathname === `/sessions/${beta}`, { timeout: 20_000 });
    await waitForMainText(page, 'BETA_MARKER', { label: '切到 B 后主区出现 B 的内容' });
    const afterSwitch = await mainRegionText(page);
    assert(!afterSwitch.includes('ALPHA_MARKER'),
      '切到 B 后主区不再残留 A 的内容（同 cwd 不串台）');
    assert(afterSwitch.includes('MOCK_REPLY: BETA_MARKER clean up telemetry exporter'.slice(0, 30)) || afterSwitch.includes('BETA_MARKER'),
      'B 页面展示的是 B 自己的回答');
    assert(await betaRow.getAttribute('aria-current') === 'true', '选中态跟着切换到 B 那一行');

    // 再切回 A：单向切换可能靠「首次加载」蒙混过关，来回切才能暴露缓存串台。
    await alphaRow.click();
    await page.waitForURL(url => url.pathname === `/sessions/${alpha}`, { timeout: 20_000 });
    await waitForMainText(page, 'ALPHA_MARKER', { label: '切回 A 后主区出现 A 的内容' });
    const backToAlpha = await mainRegionText(page);
    assert(!backToAlpha.includes('BETA_MARKER'), '切回 A 后主区不残留 B 的内容（来回切换仍不串台）');
    ok('来回切换两条同 cwd 会话，内容各归各位');
    await page.close();
  });

  // ── 旅程 7：四个功能浮层 × Escape × 浏览器后退 ─────────────────────────
  await journey(7, '四个功能浮层：深链打开、Escape 关闭、浏览器后退关闭、URL 同步', async () => {
    const { page, pageErrors } = await openPage(browser);
    allPageErrors.push(pageErrors);

    for (const overlay of OVERLAYS) {
      // 深链直接打开（同事甩链接过来的场景）
      await page.goto(`${base}/${overlay.search}`, { waitUntil: 'domcontentloaded' });
      const dialog = page.getByRole('dialog', { name: overlay.dialog });
      await dialog.waitFor({ state: 'visible', timeout: 25_000 });
      ok(`「${overlay.dialog}」可由 ${overlay.search} 深链打开`);

      // Escape 关闭，并且 URL 上的 panel 参数要被抹掉——否则刷新会把它又打开。
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
      await waitFor(`${overlay.panel} 关闭后 URL 抹掉 panel 参数`, async () =>
        !new URL(page.url()).searchParams.has('panel'), { timeoutMs: 10_000, intervalMs: 200 });
      ok(`「${overlay.dialog}」Escape 可关闭，且 URL 同步清理`);
    }

    // 浏览器后退键：必须关闭浮层，而不是退出站点。
    // 这条只能用「站内点开」的路径测——深链进来时 history 里没有上一条站内记录，
    // back() 本来就该离开站点（app-route.ts 对这两种来路有不同处理）。
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: UI.overviewTitle }).waitFor({ state: 'visible', timeout: 20_000 });
    const settingsEntry = page.getByRole('complementary', { name: UI.nav }).getByRole('button', { name: UI.settingsEntry });
    await settingsEntry.click();
    const settingsDialog = page.getByRole('dialog', { name: 'Dutydeck 设置与接入' });
    await settingsDialog.waitFor({ state: 'visible', timeout: 25_000 });
    assert(new URL(page.url()).searchParams.get('panel') === 'settings', '站内点开设置后 URL 同步为 ?panel=settings');

    await page.goBack();
    await settingsDialog.waitFor({ state: 'hidden', timeout: 15_000 });
    assert(!new URL(page.url()).searchParams.has('panel'), '浏览器后退键关闭浮层且留在站内（不是退出站点）');
    assert(new URL(page.url()).pathname === '/', '后退后仍停在任务中心');
    ok('浏览器后退键关闭浮层，不离开站点');
    await page.close();
  });

  // ── 旅程 8：命令面板 ────────────────────────────────────────────────────
  await journey(8, '命令面板 ⌘K → 搜索 → 跳转', async () => {
    const { page, pageErrors } = await openPage(browser);
    allPageErrors.push(pageErrors);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: UI.overviewTitle }).waitFor({ state: 'visible', timeout: 20_000 });

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: UI.palette });
    await palette.waitFor({ state: 'visible', timeout: 15_000 });
    ok('Mod+K 打开命令面板');

    const options = page.getByRole('option');
    assert(await options.count() > 0, '命令面板默认列出命令与最近任务');

    await page.keyboard.type('BETA_MARKER');
    await waitFor('检索收敛到唯一结果', async () => (await options.count()) === 1, { timeoutMs: 10_000, intervalMs: 200 });
    const hit = await options.first().innerText();
    assert(hit.includes('BETA_MARKER'), `检索命中目标任务（实际「${hit.replace(/\n/g, ' ').slice(0, 60)}」）`);

    // 跳转：Enter 必须真的把页面带到那条会话，并渲染出它的内容。
    await page.keyboard.press('Enter');
    await page.waitForURL(url => url.pathname === `/sessions/${beta}`, { timeout: 20_000 });
    await waitForMainText(page, 'BETA_MARKER', { label: '命令面板跳转后内容渲染' });
    ok('命令面板检索结果可跳转，且目标内容真的渲染出来');

    // Escape 关闭
    await page.keyboard.press('Control+k');
    await palette.waitFor({ state: 'visible', timeout: 15_000 });
    await page.keyboard.press('Escape');
    await palette.waitFor({ state: 'hidden', timeout: 10_000 });
    ok('Escape 关闭命令面板');
    await page.close();
  });

  // ── 旅程 9：归档任务 ────────────────────────────────────────────────────
  await journey(9, '归档任务 → 二次确认 → 变只读（Composer 换成提示条）', async () => {
    /**
     * 任务目标里**不能出现「归档任务」这四个字**。
     *
     * 我第一版写的是「ARCHIVE_MARKER 待归档任务」，结果这一节稳定超时。真因不是产品
     * 缺陷，是选择器自伤：Playwright 的 name 匹配默认是**子串**，侧栏里那一行任务的
     * 可访问名含「待归档任务」，于是 getByRole('button', { name: '归档任务' }) 同时
     * 命中了侧栏行和真正的归档按钮，.first() 抓到的是侧栏行——点它只是切换会话，
     * 确认框当然永远不出现，报错却指向「归档此任务？ 不可见」，看上去像归档坏了。
     *
     * 两层防护：目标文案避开该词组，且下面所有归档按钮一律用 exact 匹配。
     */
    const target = await seedCompletedSession(request, { cwd: dirs.workspace, prompt: 'ARCHIVE_MARKER 这条用于验证只读态' });
    const { page, pageErrors } = await openPage(browser);
    allPageErrors.push(pageErrors);
    await page.goto(`${base}/sessions/${target}`, { waitUntil: 'domcontentloaded' });
    await waitForMainText(page, 'ARCHIVE_MARKER', { label: '待归档任务详情渲染' });

    assert(await page.getByRole('textbox', { name: UI.composer }).isVisible(), '归档前 Composer 可用（可以继续下指令）');

    // exact:true 是必须的，理由见本节开头。
    await page.getByRole('button', { name: UI.archive, exact: true }).click();
    // 二次确认必须是 alertdialog（不可逆操作），不是普通 dialog。
    const confirm = page.getByRole('alertdialog', { name: UI.archiveDialog });
    await confirm.waitFor({ state: 'visible', timeout: 15_000 });
    ok('归档前弹出二次确认（alertdialog，不可逆操作的正确语义）');

    // 取消一次：确认框必须真的能取消，否则「二次确认」是摆设。
    await confirm.getByRole('button', { name: '取消' }).click();
    await confirm.waitFor({ state: 'hidden', timeout: 10_000 });
    assert((await request('GET', `/api/sessions/${target}`)).json?.archivedAt == null,
      '点「取消」后任务确实没有被归档（二次确认真的拦得住）');

    await page.getByRole('button', { name: UI.archive, exact: true }).click();
    await confirm.waitFor({ state: 'visible', timeout: 15_000 });
    await confirm.getByRole('button', { name: UI.archiveConfirm }).click();

    await waitFor('服务端标记为已归档', async () =>
      (await request('GET', `/api/sessions/${target}`)).json?.archivedAt != null, { timeoutMs: 20_000, intervalMs: 300 });
    ok('确认后服务端真的把任务标记为已归档');

    /**
     * 归档成功后界面会跳回任务中心（App.tsx 的 archive.onSuccess 调用了
     * selectSession(undefined)）。所以「Composer 换成提示条」这条要在**重新进入
     * 这条已归档任务**时验证，而不是在归档那一刻的原地页面上——那时候整个详情页
     * 都已经不在了。这不是绕开断言：只读态本来就是「打开一条归档任务时」的属性。
     */
    await page.goto(`${base}/sessions/${target}`, { waitUntil: 'domcontentloaded' });
    await waitForMainText(page, 'ARCHIVE_MARKER', { label: '重新打开已归档任务' });
    await page.getByText(UI.archivedReadOnly).waitFor({ state: 'visible', timeout: 20_000 });
    ok('重新打开已归档任务时，Composer 被只读提示条取代');
    assert((await page.getByRole('textbox', { name: UI.composer }).count()) === 0,
      '已归档任务上没有输入框（真的不能再下指令，不只是提示一句）');
    assert((await page.getByRole('button', { name: UI.archive, exact: true }).count()) === 0,
      '已归档任务上不再提供「归档任务」按钮（不提供无效操作）');
    await waitForMainText(page, '已归档', { label: '状态显示为已归档' });
    ok('状态口径显示为「已归档」');
    await page.close();
  });

  // ── 旅程 10：主题切换持久化 ────────────────────────────────────────────
  await journey(10, '主题切换 → 持久化 → 刷新后仍生效', async () => {
    const { page, pageErrors } = await openPage(browser);
    allPageErrors.push(pageErrors);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: UI.overviewTitle }).waitFor({ state: 'visible', timeout: 20_000 });

    const group = page.getByRole('radiogroup', { name: UI.themeGroup });
    await group.waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByRole('radio', { name: /^深色/ }).click();
    await waitFor('根元素切到深色', async () =>
      (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark',
      { timeoutMs: 10_000, intervalMs: 200 });
    ok('点「深色」后 data-theme=dark 生效');

    const stored = await page.evaluate(() => window.localStorage.getItem('dutydeck.theme'));
    assert(stored === 'dark', `偏好写入 localStorage（dutydeck.theme=${stored}）`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: UI.overviewTitle }).waitFor({ state: 'visible', timeout: 20_000 });
    assert(await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark',
      '刷新后仍是深色（持久化真的生效，不是内存态）');

    // 切回跟随系统：必须把存储清掉，否则「跟随系统」会被上一次的选择永久压住。
    await page.getByRole('radio', { name: /^跟随系统/ }).click();
    await waitFor('跟随系统时清除持久化偏好', async () =>
      (await page.evaluate(() => window.localStorage.getItem('dutydeck.theme'))) === null,
      { timeoutMs: 10_000, intervalMs: 200 });
    ok('切回「跟随系统」会清除持久化偏好（不残留旧选择）');
    await page.close();
  });

  // ── 旅程 11：移动端 390x844 ────────────────────────────────────────────
  await journey(11, '移动端 390x844：汉堡钮开侧栏 → 选任务 → 侧栏自动收起', async () => {
    const { page, pageErrors } = await openPage(browser, { viewport: MOBILE_VIEWPORT, mobile: true });
    allPageErrors.push(pageErrors);
    // 从一条会话详情页出发：这样汉堡钮在导航前后都存在，可以验证焦点归还。
    // 从任务中心出发时汉堡钮会随主区一起被替换掉，焦点归还无从谈起（见旅程末尾说明）。
    await page.goto(`${base}/sessions/${alpha}`, { waitUntil: 'domcontentloaded' });
    await waitForMainText(page, 'ALPHA_MARKER', { label: '移动端详情页渲染' });

    const nav = page.getByRole('complementary', { name: UI.nav });
    assert(!(await nav.isVisible().catch(() => false)), '移动端默认不显示侧栏（内容区拿到整个屏幕）');

    const burger = page.getByRole('button', { name: UI.navOpen });
    await burger.first().waitFor({ state: 'visible', timeout: 15_000 });
    ok('移动端出现「打开工作台导航」汉堡钮');
    await burger.first().click();
    await nav.waitFor({ state: 'visible', timeout: 15_000 });
    ok('点汉堡钮后侧栏展开');

    // 遮罩：移动端抽屉必须有可点关闭的遮罩，否则用户只能靠后退键逃出去。
    assert(await page.getByRole('button', { name: UI.navClose }).isVisible(),
      '展开时出现可点击的关闭遮罩');

    await nav.getByRole('button', { name: /BETA_MARKER/ }).click();
    // 选任务后侧栏必须自动收起——移动端屏幕就这么大，不收起等于选完看不见内容。
    await nav.waitFor({ state: 'hidden', timeout: 15_000 });
    ok('选中任务后侧栏自动收起');
    await page.waitForURL(url => url.pathname === `/sessions/${beta}`, { timeout: 20_000 });
    await waitForMainText(page, 'BETA_MARKER', { label: '移动端切换后内容跟着换' });
    const mobileText = await mainRegionText(page);
    assert(!mobileText.includes('ALPHA_MARKER'), '移动端切换同样不串台');

    // 焦点归还：抽屉关闭后焦点要回到汉堡钮，键盘/读屏用户才不会掉到 body 上。
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '');
    assert(focused === UI.navOpen, `侧栏收起后焦点回到汉堡钮（实际落在「${focused}」）`);
    ok('侧栏收起后焦点正确回到汉堡钮');

    // Escape 也要能关抽屉
    await burger.first().click();
    await nav.waitFor({ state: 'visible', timeout: 15_000 });
    await page.keyboard.press('Escape');
    await nav.waitFor({ state: 'hidden', timeout: 15_000 });
    ok('Escape 同样可以收起移动端侧栏');
    await page.close();
  });

  // ── 旅程 12：侧栏功能导航区（改版新增，当前为前瞻性覆盖）─────────────
  await journey(12, '侧栏功能入口：逐个点击都能打开对应浮层且 URL 同步', async () => {
    const { page, pageErrors } = await openPage(browser);
    allPageErrors.push(pageErrors);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: UI.overviewTitle }).waitFor({ state: 'visible', timeout: 20_000 });
    const nav = page.getByRole('complementary', { name: UI.nav });

    /**
     * 侧栏改版会新增一个功能导航区（设置 / 飞书 / 群配置 / 自动化 / 快捷键，带图标直达）。
     * 那些入口现在还不存在——当前侧栏底部只有一个「Agent 与设置」的合并入口。
     *
     * 所以这条旅程写成**能力探测**而不是硬断言：入口存在就验证它真的打开对应浮层且
     * URL 同步；不存在就跳过并说明。这样改版前后同一份脚本都能跑，且改版落地的当天
     * 这些断言自动开始生效——不需要有人记得回来补。
     *
     * 硬断言只保留一条：当前确实存在的「Agent 与设置」入口必须工作。那是今天就该
     * 绿的东西，不能因为「以后要改」就放过。
     */
    /**
     * 「飞书」那条不能写成 /飞书|Bot/：现有的「Agent 与设置」入口在接入了机器人时
     * 会把「· 2 Bot」拼进自己的可访问名，于是那个正则会**命中设置入口**，然后
     * 断言它打开「绑定飞书 Bot」浮层——失败信息会指向一个根本不存在的问题。
     * 用「绑定/飞书 Bot」这种动宾结构限定，避开纯计数后缀。
     */
    const candidates = [
      { name: UI.settingsEntry, dialog: 'Dutydeck 设置与接入', panel: 'settings', required: true, label: '设置与接入' },
      { name: /飞书接入|绑定.*Bot|飞书 Bot|管理飞书/, dialog: '绑定飞书 Bot', panel: 'lark-setup', required: false, label: '飞书接入' },
      { name: /群配置|群与权限/, dialog: '群配置与权限', panel: 'groups', required: false, label: '群与权限' },
      { name: /定时任务|自动化|Schedule/, dialog: 'Schedule 离线管理', panel: 'automation', required: false, label: '定时任务' },
    ];

    for (const candidate of candidates) {
      const entry = nav.getByRole('button', { name: candidate.name });
      const present = (await entry.count()) > 0 && await entry.first().isVisible().catch(() => false);
      if (!present) {
        if (candidate.required) throw new Error(`侧栏缺少必需入口「${candidate.label}」`);
        log(`   · 侧栏暂无「${candidate.label}」直达入口（改版新增项，落地后本断言自动生效）`);
        continue;
      }
      await entry.first().click();
      const dialog = page.getByRole('dialog', { name: candidate.dialog });
      await dialog.waitFor({ state: 'visible', timeout: 25_000 });
      assert(new URL(page.url()).searchParams.get('panel') === candidate.panel,
        `侧栏「${candidate.label}」入口打开浮层且 URL 同步为 ?panel=${candidate.panel}`);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
    }

    // 侧栏顶部的创建入口（改版会把它挪到新的创建区，但语义必须保留）
    const create = nav.getByRole('button', { name: UI.createTask, exact: true });
    assert(await create.first().isVisible(), '侧栏保留「创建任务」入口');
    await create.first().click();
    const newTask = page.getByRole('dialog', { name: UI.newTaskDialog });
    await newTask.waitFor({ state: 'visible', timeout: 15_000 });
    ok('侧栏「创建任务」入口真的打开创建浮层');
    await page.keyboard.press('Escape');
    await newTask.waitFor({ state: 'hidden', timeout: 10_000 });
    await page.close();
  });

  // ── 收尾：全程无未捕获页面异常 ─────────────────────────────────────────
  await journey(13, '全程无未捕获的页面异常', async () => {
    const errors = allPageErrors.flat();
    assert(errors.length === 0, `所有旅程期间浏览器无未捕获异常（实际 ${errors.length} 条${errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''}）`);
  });
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  log(`\n✗ 致命错误：${error instanceof Error ? error.message : String(error)}`);
  if (VERBOSE && error instanceof Error && error.stack) log(error.stack);
  exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await runCleanup();
}

log(`\n${'─'.repeat(70)}`);
if (failures.length) {
  log(`✗ ${failures.length} 条旅程未通过：`);
  for (const failure of failures) log(`   · 「${failure.section}」：${failure.message}`);
  exitCode = 1;
}
log(`${exitCode === 0 ? '✓ 全部通过' : '✗ 存在失败'}：${count()} 项断言`);
process.exit(exitCode);
